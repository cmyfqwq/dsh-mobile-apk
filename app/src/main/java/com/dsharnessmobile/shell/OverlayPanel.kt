package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** 展开面板协作类：视图构建（buildUnit 会话选择器/状态行/输入行）与渲染（updateBallOnly/updateClock/
 *  状态模板 template_thinking/template_tool）+ 待答卡（MuxClient 提问/审批官方风格卡片渲染 + POST /api/respond 应答）。 */
class OverlayPanel(private val svc: OverlayService) {

  // 主题（色板/明暗判定在 OverlayTheme，构造注入服务即 Context）
  private val theme = OverlayTheme(svc)
  private fun isDarkTheme() = theme.isDarkTheme()
  private fun themeColors() = theme.themeColors()

  // ── 展开态控件句柄 ────────────────────────────────────────────────
  internal var unitView: View? = null            // 展开合体圆角矩形（默认 GONE）
  internal var statusText: TextView? = null
  private var toolChip: TextView? = null
  private var clockText: TextView? = null
  private var closeView: ImageView? = null       // 展开态收起按钮（✕，会话选择行右端）
  private var dividerView: View? = null
  private var sendBtn: View? = null
  private var stopBtn: View? = null
  internal var inputBox: EditText? = null
  private var sessionPicker: Spinner? = null      // 展开态目标会话选择器（#3）
  private var pendingBox: LinearLayout? = null   // 待处理卡容器（divider 与输入行之间）

  // ── 会话选择器缓存（session.list 投影） ──────────────────────────
  private var pickerAdapter: ArrayAdapter<String>? = null
  private val pickerLabels = ArrayList<String>()   // 「新会话」+ 会话标题/简短 id
  private val pickerIds = ArrayList<String>()      // 与 pickerLabels 平行；空 = 新会话
  private var pickerInit = false                   // 首次填充防 onItemSelected 误触发

  // 协议（0.1.2-rc.1 dsh-api-gateway/lib/{index,client}.js 核实，0.13.3 W3）：
  // WS /api/remote.mux 上 open `$events` 流；服务端 item value 帧形：
  //   ready = {type:"ready",clientId,host:{home}}（clientId 应答必须回带）；
  //   waterfall = {type:"waterfall",event,eventId,agentId,request}（approval/request 与
  //     user-questions/request）；
  //   emit = {type:"emit",event,args}（api-session/status → args:[agentId,running] 忙态锚点）。
  // 应答统一 POST /api/$events/result，client-request 信封 payload={args:{clientId,eventId,outcome}}：
  //   审批 outcome={kind:"result",value:"allowed-once"|"rejected"}（值=审批词汇原字符串）；
  //   提问 outcome={kind:"result",value:{answers:[{id,selected:[label,…],custom?}]}}（selected 数组）；
  //   提问跳过 outcome={kind:"rejected",error:{name,message}}；审批无取消通道。
  private var mux: MuxClient? = null
  @Volatile private var eventsClientId: String = ""   // ready 帧分配；应答与流实例绑定
  internal val pendingApprovals = LinkedHashMap<String, PendingApproval>()
  internal val pendingQuestions = LinkedHashMap<String, PendingQuestion>()
  private val multiSel = HashMap<String, ArrayList<String>>()   // 多选暂存：questionId → labels
  private val qSingle = HashMap<String, String>()               // 单选暂存：questionId → label
  private val qCustom = HashMap<String, String>()               // 自定义答案：questionId → text
  private var qPage = 0                                          // 多问分页（官方卡 1/N 风格）
  private var pendingKey = ""                                    // 当前卡指纹（kind:eventId），变化即清作答态
  private var renderedCardKey = ""                               // 卡片已渲染指纹（防 live 流重绘打断输入）

  /** 服务 onDestroy 联动：关闭 mux 长连接（原 mux?.close(); mux = null）。 */
  internal fun destroy() {
    mux?.close(); mux = null
  }

  internal fun startMux() {
    mux = MuxClient("127.0.0.1", 3080, "/api/remote.mux") { text -> handleMuxFrame(text) }
  }

  private fun handleMuxFrame(text: String) {
    val j = try { JSONObject(text) } catch (_: Exception) { return }
    when (j.optString("type")) {
      "item" -> {
        val value = j.optJSONObject("value") ?: return
        handleEventValue(value)
      }
      // 流被服务端终止（end）或出错（error）：重连由 MuxClient 重连循环处理
      // （检测不到对端断开时 iframe 也会因 end 后无数据而 idle，这里主动重建连接）。
      "end", "error" -> {
        mux?.close()
        mux = null
        startMux()
      }
    }
  }

  private fun handleEventValue(value: JSONObject) {
    when (value.optString("type")) {
      "ready" -> {
        eventsClientId = value.optString("clientId", "")
      }
      "waterfall" -> {
        val event = value.optString("event")
        val eventId = value.optString("eventId")
        val agentId = value.optString("agentId")
        val request = value.optJSONObject("request") ?: return
        when (event) {
          "approval/request" -> svc.main.post {
            pendingApprovals[eventId] = PendingApproval(eventId, agentId, request.optString("toolName", ""), request.optString("reason", ""))
            onPendingChanged()
          }
          "user-questions/request" -> svc.main.post {
            pendingQuestions[eventId] = PendingQuestion(eventId, agentId, request.optJSONArray("questions") ?: org.json.JSONArray())
            onPendingChanged()
          }
        }
      }
      "emit" -> {
        when (value.optString("event")) {
          // 0.13.3 D6：api-session/status（args=[agentId, running]）= 官方忙态锚点，
          // 替代旧 turn_start 专门行（bridge 0.1.4 起退役该行）。
          "api-session/status" -> {
            val args = value.optJSONArray("args") ?: return
            if (args.length() >= 2) {
              val agentId = args.optString(0)
              val running = args.optBoolean(1)
              svc.main.post { svc.applyAgentStatus(agentId, running) }
            }
          }
        }
      }
    }
  }

  /** 当前会话（未选目标 = 全部）的第一条待处理；审批优先。 */
  private fun currentPending(): Pair<String, Any>? {
    val sid = svc.activeSessionId
    val ok = { s: String -> sid.isEmpty() || s == sid }
    pendingApprovals.values.firstOrNull { ok(it.agentId) }?.let { return "approval" to it }
    pendingQuestions.values.firstOrNull { ok(it.agentId) }?.let { return "question" to it }
    return null
  }

  internal fun onPendingChanged() {
    val key = currentPending()?.let { "${it.first}:${(it.second as? PendingApproval)?.eventId ?: (it.second as? PendingQuestion)?.eventId ?: ""}" } ?: ""
    if (key != pendingKey) {
      pendingKey = key
      multiSel.clear(); qSingle.clear(); qCustom.clear(); qPage = 0; renderedCardKey = ""
    }
    updateBallOnly()
  }

  /** 展开合体圆角矩形（上区状态 + 下区输入，radius 30dp）。 */
  internal fun buildUnit(): View {
    val dp = svc.resources.displayMetrics.density
    val width = (svc.resources.displayMetrics.widthPixels - (64 * dp).toInt() - (32 * dp).toInt()).coerceAtMost((400 * dp).toInt())
    val c = themeColors()

    // 目标会话选择器（#3：发消息前可明确选对话；Spinner 下拉）。默认第一项 = 「新会话」。
    // simple_spinner_item 默认深色文字在暗色面板不可见 → 自定义 adapter 按主题着色。
    val pickerSpinner = Spinner(svc).apply {
      tag = "overlay-sessionpicker"
      contentDescription = "选择发送对话"
      // 下拉弹出层 = 独立 popup 窗口，默认方形背景 + item 各自涂底 → 圆角无从谈起。
      // 解法：popup 窗口背景给圆角渐变底（用户要求「圆角矩形」），item 底色改透明。
      // 注意：Spinner.popupBackground 在 Kotlin 侧是只读合成属性（无 setter 配对名），必须显式调用。
      setPopupBackgroundDrawable(GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = 16 * dp
        setColor(if (isDarkTheme()) 0xFF1E1F24.toInt() else 0xFFFFFFFF.toInt())
        setStroke((1 * dp).toInt(), themeColors().unitStroke)
      })
      adapter = object : ArrayAdapter<String>(svc, android.R.layout.simple_spinner_item, pickerLabels) {
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
          val tv = (convertView as? TextView) ?: TextView(context).apply { textSize = 13f }
          tv.setTextColor(themeColors().idleText)
          tv.text = getItem(position) ?: ""
          return tv
        }
        override fun getDropDownView(position: Int, convertView: View?, parent: ViewGroup): View {
          val tv = (convertView as? TextView) ?: TextView(context).apply {
            textSize = 13f
            setPadding((12 * dp).toInt(), (8 * dp).toInt(), (12 * dp).toInt(), (8 * dp).toInt())
          }
          val dark = isDarkTheme()
          tv.setTextColor(if (dark) 0xFFE8EAED.toInt() else 0xFF202124.toInt())
          tv.setBackgroundColor(Color.TRANSPARENT)   // 圆角由 popupBackground 提供（方形涂底会盖圆角）
          tv.text = getItem(position) ?: ""
          return tv
        }
      }.also { pickerAdapter = it }
      onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
        override fun onItemSelected(parent: AdapterView<*>?, v: View?, pos: Int, id: Long) {
          // pickerInit 防首帧误触发；用户切换时更新发送目标（空 = 新会话）
          if (pickerInit && pos >= 0 && pos < pickerIds.size) {
            svc.activeSessionId = pickerIds[pos]
            if (svc.activeSessionId.isEmpty()) svc.sessionBusy = false
            svc.renderPanelOnly()
          }
        }
        override fun onNothingSelected(parent: AdapterView<*>?) {}
      }
    }
    sessionPicker = pickerSpinner

    val status = ShimmerTextView(svc).apply {
      text = "空闲"
      textSize = 13f
      setTypeface(null, android.graphics.Typeface.BOLD)
      setTextColor(c.idleText)
    }
    statusText = status

    val chip = TextView(svc).apply {
      tag = "overlay-toolchip"
      text = ""
      textSize = 11f
      setTextColor(Color.WHITE)
      background = GradientDrawable().apply { setColor(0xFF4176E6.toInt()); cornerRadius = 10 * dp }
      setPadding((8 * dp).toInt(), (2 * dp).toInt(), (8 * dp).toInt(), (2 * dp).toInt())
      visibility = View.GONE
    }
    toolChip = chip

    val clock = TextView(svc).apply {
      tag = "overlay-clock"
      text = ""
      textSize = 12f
      setTextColor(c.clockText)
      setTypeface(null, android.graphics.Typeface.NORMAL)
      visibility = View.GONE
    }
    clockText = clock

    // 收起按钮（✕）：放顶行（会话选择行）右端。旧版收起箭头在状态行、与 Spinner 下拉
    // 三角同为三角且下拉展开后被列表盖住（视觉引导错误，用户实测）——✕ 与下拉三角可区分
    // 且位于下拉弹出层之上，永不被盖。
    val close = ImageView(svc).apply {
      setImageResource(R.drawable.dsh_ic_close)
      setColorFilter(c.chevron)
      contentDescription = "收起面板"
      isClickable = true
      setOnClickListener { svc.hidePanel() }
    }
    closeView = close

    // 会话选择行（独立一行，向下箭头 Spinner）+ 右端 ✕ 收起
    val pickerRow = LinearLayout(svc).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((12 * dp).toInt(), (10 * dp).toInt(), (12 * dp).toInt(), (2 * dp).toInt())
      addView(pickerSpinner, LinearLayout.LayoutParams(0, (26 * dp).toInt(), 1f))
      addView(close, LinearLayout.LayoutParams((20 * dp).toInt(), (20 * dp).toInt()).apply { marginStart = (8 * dp).toInt() })
    }

    // 状态行：状态文字 + 工具×N + 时钟（收起按钮已移至顶行 ✕）
    val row1 = LinearLayout(svc).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((12 * dp).toInt(), (4 * dp).toInt(), (12 * dp).toInt(), (10 * dp).toInt())
      addView(status, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      addView(chip)
      addView(clock, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = (8 * dp).toInt() })
    }

    // 输入行：输入框 + 蓝圆发送（白箭头 IconSendOutline16）+ 红圆停止（白方块 rx=3）
    val input = EditText(svc).apply {
      hint = "发消息可插话…"
      textSize = 13f
      isSingleLine = true
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
      imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_SEND
      setOnEditorActionListener { _, actionId, _ ->
        if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_SEND) { svc.requestSend(); true } else false
      }
      setTextColor(c.inputText)
      setHintTextColor(c.inputHint)
      background = GradientDrawable().apply {
        setColor(c.inputBg); cornerRadius = 17 * dp
        setStroke((1 * dp).toInt(), c.inputStroke)
      }
      setPadding((14 * dp).toInt(), 0, (14 * dp).toInt(), 0)
    }
    inputBox = input

    val send = FrameLayout(svc).apply {
      val inner = ImageView(svc).apply { setImageResource(R.drawable.dsh_ic_send) }
      addView(inner, FrameLayout.LayoutParams((16 * dp).toInt(), (16 * dp).toInt(), Gravity.CENTER))
      background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFF4176E6.toInt()) }
      isClickable = true
      setOnClickListener { svc.requestSend() }
      tag = "overlay-send"
    }
    sendBtn = send

    val stop = FrameLayout(svc).apply {
      val inner = ImageView(svc).apply { setImageResource(R.drawable.dsh_ic_stop) }
      addView(inner, FrameLayout.LayoutParams((12 * dp).toInt(), (12 * dp).toInt(), Gravity.CENTER))
      background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFFE04848.toInt()) }
      isClickable = true
      setOnClickListener { svc.requestStop() }
      tag = "overlay-stop"
    }
    stopBtn = stop

    val row2 = LinearLayout(svc).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((8 * dp).toInt(), (8 * dp).toInt(), (8 * dp).toInt(), (8 * dp).toInt())
      addView(input, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      addView(send, LinearLayout.LayoutParams((36 * dp).toInt(), (36 * dp).toInt()).apply { marginStart = (8 * dp).toInt() })
      addView(stop, LinearLayout.LayoutParams((36 * dp).toInt(), (36 * dp).toInt()).apply { marginStart = (8 * dp).toInt() })
    }

    val unit = LinearLayout(svc).apply {
      orientation = LinearLayout.VERTICAL
      background = GradientDrawable().apply {
        setColor(c.unitBg)
        cornerRadius = 30 * dp
        setStroke((1 * dp).toInt(), c.unitStroke)
      }
      addView(pickerRow)
      addView(row1)
      val divider = View(svc).apply { setBackgroundColor(c.divider) }
      dividerView = divider
      addView(divider, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1))
      addView(buildPendingBox(dp))
      addView(row2)
    }
    unitView = unit
    return unit
  }

  /** 按当前主题刷新展开态配色（unit 背景/描边、状态文字、输入框、分隔线、箭头）。 */
  internal fun applyThemeColors() {
    val c = themeColors()
    val u = unitView ?: return
    val dp = svc.resources.displayMetrics.density
    (u.background as? GradientDrawable)?.apply {
      setColor(c.unitBg)
      setStroke((1 * dp).toInt(), c.unitStroke)
    }
    statusText?.setTextColor(c.idleText)
    clockText?.setTextColor(c.clockText)
    val st = statusText
    if (st != null && !svc.sessionBusy) {
      ShimmerTextView::class.java.cast(st).setShimmering(false)
      st.setTextColor(if (!svc.engineRunning) c.offText else c.idleText)
    }
    closeView?.setColorFilter(c.chevron)
    inputBox?.apply {
      setTextColor(c.inputText)
      setHintTextColor(c.inputHint)
      (background as? GradientDrawable)?.apply {
        setColor(c.inputBg)
        setStroke((1 * dp).toInt(), c.inputStroke)
      }
    }
    dividerView?.setBackgroundColor(c.divider)
  }

  // ── 状态显示模板（模板化设置：占位符 {tool}/{summary}，SharedPreferences 可覆写，后续接设置面板）──

  private fun displayPrefs() = svc.getSharedPreferences("overlay_display", Context.MODE_PRIVATE)

  private fun templateThinking(): String =
    displayPrefs().getString("template_thinking", "Deep diving...") ?: "Deep diving..."

  private fun templateTool(): String =
    displayPrefs().getString("template_tool", "{tool} · {summary}") ?: "{tool} · {summary}"

  // ── 待处理卡（AI 提问 / 权限审批：WS 收帧 + POST /api/respond 应答——用户拍板「几乎所有操作直接在悬浮球上完成」）──

  /** 待处理卡容器（divider 与输入行之间，默认 GONE）。 */
  private fun buildPendingBox(dp: Float): LinearLayout = LinearLayout(svc).apply {
    orientation = LinearLayout.VERTICAL
    setPadding((12 * dp).toInt(), (2 * dp).toInt(), (12 * dp).toInt(), (6 * dp).toInt())
    visibility = View.GONE
    pendingBox = this
  }

  private fun pendingChip(label: String, filled: Boolean, red: Boolean, dp: Float, onClick: () -> Unit): TextView = TextView(svc).apply {
    text = label
    textSize = 12f
    maxLines = 2
    setTextColor(if (filled || red) Color.WHITE else themeColors().inputText)
    background = GradientDrawable().apply {
      cornerRadius = 14 * dp
      setColor(if (red) 0xFFE04848.toInt() else if (filled) 0xFF4176E6.toInt() else 0x22808080)
      if (!filled && !red) setStroke((1 * dp).toInt(), themeColors().inputStroke)
    }
    setPadding((12 * dp).toInt(), (6 * dp).toInt(), (12 * dp).toInt(), (6 * dp).toInt())
    isClickable = true
    setOnClickListener { onClick() }
  }

  private fun lpChip(dp: Float) = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
    marginEnd = (8 * dp).toInt()
  }

  /** 渲染卡片（官方提问卡风格）：header 行（灰标签 + ✕ 关闭）、问题加粗、编号徽章选项行
   *  （label + 灰 description）、✎「输入你的答案」自定义行、页脚 ‹1/N› 翻页 + 跳过本题 + 下一题/提交。
   *  force=false 时防 live 流重绘打断输入焦点。 */
  private fun renderPendingCard(force: Boolean = false) {
    val box = pendingBox ?: return
    val cur = currentPending()
    if (cur == null) { box.visibility = View.GONE; return }
    val key = "$pendingKey@$qPage"
    if (!force && renderedCardKey == key && box.visibility == View.VISIBLE && box.childCount > 0) return
    box.removeAllViews()
    renderedCardKey = key
    val dp = svc.resources.displayMetrics.density
    val dark = isDarkTheme()
    val textColor = if (dark) 0xFFE8EAED.toInt() else 0xFF202124.toInt()
    val subColor = if (dark) 0xFF9AA0A6.toInt() else 0xFF5F6368.toInt()
    if (cur.first == "approval") {
      val a = cur.second as PendingApproval
      val title = TextView(svc).apply {
        textSize = 12f
        setTextColor(0xFFB8860B.toInt())
        setTypeface(null, android.graphics.Typeface.BOLD)
        text = "权限审批"
      }
      box.addView(title)
      val body = TextView(svc).apply {
        textSize = 13f
        setTextColor(textColor)
        text = listOf("工具 ${a.toolName}", a.reason).filter { it.isNotBlank() }.joinToString("：")
      }
      box.addView(body)
      val buttonRow = LinearLayout(svc).apply { orientation = LinearLayout.HORIZONTAL }
      buttonRow.addView(pendingChip("批准一次", filled = true, red = false, dp) { respondApproval(a, "allowed-once") }, lpChip(dp))
      buttonRow.addView(pendingChip("拒绝", filled = false, red = true, dp) { respondApproval(a, "rejected") }, lpChip(dp))
      box.addView(buttonRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        setMargins(0, (6 * dp).toInt(), 0, 0)
      })
      box.visibility = View.VISIBLE
      return
    }
    val qe = cur.second as PendingQuestion
    val n = qe.items.length()
    if (n == 0) { box.visibility = View.GONE; return }
    qPage = qPage.coerceIn(0, n - 1)
    val item = qe.items.optJSONObject(qPage) ?: return
    val qid = item.optString("id")
    val multi = item.optBoolean("multiSelect", false)
    // header 行：灰色标签（官方 header 字段）+ 右侧 ✕（取消整问）
    val header = LinearLayout(svc).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    header.addView(TextView(svc).apply {
      textSize = 11f
      setTextColor(subColor)
      text = item.optString("header", "").ifBlank { "问题 ${qPage + 1}" }
    }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    header.addView(TextView(svc).apply {
      text = "✕"
      textSize = 13f
      setTextColor(subColor)
      setPadding((6 * dp).toInt(), 0, (6 * dp).toInt(), 0)
      isClickable = true
      setOnClickListener { dismissQuestion(qe) }
    })
    box.addView(header)
    // 问题（加粗）
    box.addView(TextView(svc).apply {
      textSize = 13f
      setTextColor(textColor)
      setTypeface(null, android.graphics.Typeface.BOLD)
      text = item.optString("question", "")
    }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
      setMargins(0, (2 * dp).toInt(), 0, (4 * dp).toInt())
    })
    // 选项行：[编号徽章] 标签(粗) + 描述(灰)，选中淡蓝底
    val opts = item.optJSONArray("options")
    if (opts != null) {
      for (oi in 0 until opts.length().coerceAtMost(6)) {
        val o = opts.optJSONObject(oi) ?: continue
        val label = o.optString("label").ifBlank { "选项${oi + 1}" }
        val on = if (multi) multiSel[qid]?.contains(label) == true else qSingle[qid] == label
        val row = LinearLayout(svc).apply {
          orientation = LinearLayout.HORIZONTAL
          gravity = Gravity.CENTER_VERTICAL
          setPadding((6 * dp).toInt(), (7 * dp).toInt(), (6 * dp).toInt(), (7 * dp).toInt())
          background = GradientDrawable().apply { cornerRadius = 10 * dp; setColor(if (on) 0x334176E6 else if (dark) 0x14FFFFFF else 0x0D000000) }
          isClickable = true
          setOnClickListener {
            if (multi) {
              val sel = multiSel.getOrPut(qid) { ArrayList() }
              if (on) sel.remove(label) else sel.add(label)
            } else {
              qSingle[qid] = label; qCustom.remove(qid)
              if (n == 1) { respondQuestion(qe); return@setOnClickListener }
            }
            renderPendingCard(true)
          }
        }
        row.addView(TextView(svc).apply {
          text = (oi + 1).toString()
          textSize = 11f
          setTextColor(if (on) Color.WHITE else subColor)
          gravity = Gravity.CENTER
          background = GradientDrawable().apply { cornerRadius = 5 * dp; setColor(if (on) 0xFF4176E6.toInt() else 0x33808080) }
        }, LinearLayout.LayoutParams((18 * dp).toInt(), (18 * dp).toInt()).apply { marginEnd = (8 * dp).toInt() })
        row.addView(TextView(svc).apply {
          text = label
          textSize = 13f
          setTextColor(textColor)
          setTypeface(null, android.graphics.Typeface.BOLD)
        })
        val desc = o.optString("description", "")
        if (desc.isNotBlank()) row.addView(TextView(svc).apply {
          text = desc
          textSize = 11f
          setTextColor(subColor)
          maxLines = 1
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = (8 * dp).toInt() })
        box.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
          setMargins(0, 0, 0, (4 * dp).toInt())
        })
      }
    }
    // ✎ 自定义答案行（单选与选项互斥——协议约束）
    val customRow = LinearLayout(svc).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((6 * dp).toInt(), (4 * dp).toInt(), (6 * dp).toInt(), (4 * dp).toInt())
      background = GradientDrawable().apply {
        cornerRadius = 10 * dp
        setColor(if (qCustom[qid]?.isNotBlank() == true) 0x334176E6 else if (dark) 0x14FFFFFF else 0x0D000000)
      }
    }
    customRow.addView(TextView(svc).apply {
      text = "✎"
      textSize = 11f
      setTextColor(subColor)
      gravity = Gravity.CENTER
      background = GradientDrawable().apply { cornerRadius = 5 * dp; setColor(0x33808080) }
    }, LinearLayout.LayoutParams((18 * dp).toInt(), (18 * dp).toInt()).apply { marginEnd = (8 * dp).toInt() })
    val edit = EditText(svc).apply {
      hint = "输入你的答案"
      textSize = 13f
      isSingleLine = true
      setTextColor(textColor)
      setHintTextColor(subColor)
      background = null
      setText(qCustom[qid] ?: "")
      addTextChangedListener(object : android.text.TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, st: Int, c: Int, a: Int) {}
        override fun onTextChanged(s: CharSequence?, st: Int, b: Int, c: Int) {}
        override fun afterTextChanged(s: android.text.Editable?) {
          val t = s?.toString()?.trim() ?: ""
          if (t.isEmpty()) qCustom.remove(qid) else {
            qCustom[qid] = t
            if (!multi) { qSingle.remove(qid); } else { }
          }
        }
      })
      setOnEditorActionListener { _, actionId, _ ->
        if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_DONE) {
          if (n == 1) respondQuestion(qe) else { qPage = (qPage + 1).coerceAtMost(n - 1); renderPendingCard(true) }
          true
        } else false
      }
      imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_DONE
    }
    customRow.addView(edit, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    box.addView(customRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
      setMargins(0, (2 * dp).toInt(), 0, (4 * dp).toInt())
    })
    // 页脚：‹ 1/N › +（跳过本题）+ 下一题/提交
    val foot = LinearLayout(svc).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    if (n > 1) {
      foot.addView(TextView(svc).apply {
        text = "‹ ${qPage + 1}/$n ›"
        textSize = 12f
        setTextColor(subColor)
        setPadding((4 * dp).toInt(), (6 * dp).toInt(), (4 * dp).toInt(), (6 * dp).toInt())
        isClickable = true
        setOnClickListener { qPage = (qPage + 1) % n; renderPendingCard(true) }
      })
      foot.addView(View(svc), LinearLayout.LayoutParams(0, 1, 1f))
      if (qPage > 0) {
        foot.addView(pendingChip("跳过本题", filled = false, red = false, dp) {
          qSingle.remove(qid); qCustom.remove(qid); multiSel.remove(qid)
          qPage = (qPage + 1).coerceAtMost(n - 1)
          renderPendingCard(true)
        }, lpChip(dp))
      }
      val last = qPage == n - 1
      foot.addView(pendingChip(if (last) "提交" else "下一题", filled = true, red = false, dp) {
        if (!last) { qPage++; renderPendingCard(true); return@pendingChip }
        respondQuestion(qe)
      }, lpChip(dp))
    } else {
      foot.addView(View(svc), LinearLayout.LayoutParams(0, 1, 1f))
      // 单问多选无自动提交路径 → 给「提交」；单选点选项即答、自定义走键盘 DONE 即答
      if (multi) foot.addView(pendingChip("提交", filled = true, red = false, dp) { respondQuestion(qe) }, lpChip(dp))
      foot.addView(pendingChip("跳过", filled = false, red = false, dp) { dismissQuestion(qe) }, lpChip(dp))
    }
    box.addView(foot, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    box.visibility = View.VISIBLE
  }

  // ── 应答（0.13.3 W3：POST /api/$events/result，{clientId,eventId,outcome}）──

  /**
   * 网关 RemoteEventResult：outcome = {kind:"result",value}（审批=词汇原字符串；
   * 提问={answers:[…]}）或 {kind:"rejected",error:{name,message}}（提问跳过）。
   * clientId 来自 ready 帧——应答与流实例绑定，未就绪（流未 ready）时直接报失败。
   */
  private fun postEventResult(eventId: String, outcome: JSONObject, onAccepted: (Boolean) -> Unit) {
    Thread {
      var accepted = false
      try {
        val payload = JSONObject()
          .put("args", JSONObject()
            .put("clientId", eventsClientId)
            .put("eventId", eventId)
            .put("outcome", outcome))
        val envelope = JSONObject()
          .put("type", "client-request")
          .put("rpcId", "overlay-event-" + System.currentTimeMillis())
          .put("method", "\$events/result")
          .put("payload", payload)
        var code = -1
        for (attempt in 0..1) {
          val conn = URL("http://127.0.0.1:3080/api/\$events/result").openConnection(java.net.Proxy.NO_PROXY) as HttpURLConnection
          conn.requestMethod = "POST"
          conn.doOutput = true
          conn.connectTimeout = 3000
          conn.readTimeout = 8000
          conn.setRequestProperty("content-type", "application/json")
          EngineAuth.attach(svc.applicationContext, conn)
          conn.outputStream.use { it.write(envelope.toString().toByteArray(Charsets.UTF_8)) }
          code = conn.responseCode
          if (code == 401 && attempt == 0) {
            conn.disconnect()
            EngineAuth.handleUnauthorized(svc.applicationContext)
            continue
          }
          conn.disconnect()
          break
        }
        accepted = code == 200 && eventsClientId.isNotEmpty()
      } catch (_: Exception) {}
      svc.main.post { onAccepted(accepted) }
    }.start()
  }

  private fun respondApproval(a: PendingApproval, outcome: String) {
    val outcomeJson = JSONObject().put("kind", "result").put("value", outcome)
    postEventResult(a.eventId, outcomeJson) { accepted ->
      if (accepted) {
        pendingApprovals.remove(a.eventId)
        // 批准后轮次继续（工具真正执行），下个 live 事件前先亮工作态（同发送空窗逻辑）
        svc.markBusyOptimistic()
        svc.flashStatus(if (outcome == "allowed-once") "已批准" else "已拒绝")
        onPendingChanged()
      } else svc.flashStatus("应答失败")
    }
  }

  /** 提问作答：answers 按 questions 原序配对（协议硬约束）；单选 custom 与 selected 互斥。
   *  0.1.2-rc.1：selected 由旧协议的单 label 字符串改为 label 数组。 */
  private fun respondQuestion(qe: PendingQuestion) {
    val arr = org.json.JSONArray()
    for (i in 0 until qe.items.length()) {
      val item = qe.items.optJSONObject(i) ?: continue
      val qid = item.optString("id")
      val custom = qCustom[qid]?.trim().orEmpty()
      val sel = ArrayList<String>()
      if (item.optBoolean("multiSelect", false)) multiSel[qid]?.let { sel.addAll(it) }
      else if (custom.isEmpty()) qSingle[qid]?.let { sel.add(it) }
      val entry = JSONObject().put("id", qid).put("selected", org.json.JSONArray(sel))
      if (custom.isNotEmpty()) entry.put("custom", custom)
      arr.put(entry)
    }
    val value = JSONObject().put("answers", arr)
    val outcomeJson = JSONObject().put("kind", "result").put("value", value)
    postEventResult(qe.eventId, outcomeJson) { accepted ->
      if (accepted) {
        pendingQuestions.remove(qe.eventId)
        // 作答后轮次继续，下个 live 事件前先亮工作态（同发送空窗逻辑）
        svc.markBusyOptimistic()
        svc.flashStatus("已回答")
        onPendingChanged()
      } else svc.flashStatus("应答失败")
    }
  }

  /** 跳过提问 = 拒绝该 waterfall（outcome rejected；审批无取消通道）。 */
  private fun dismissQuestion(qe: PendingQuestion) {
    val outcomeJson = JSONObject().put("kind", "rejected").put(
      "error",
      JSONObject().put("name", "UserQuestionError").put("message", "dismissed from overlay").put("code", "cancelled"),
    )
    postEventResult(qe.eventId, outcomeJson) { accepted ->
      if (accepted) {
        pendingQuestions.remove(qe.eventId)
        svc.flashStatus("已跳过")
        onPendingChanged()
      } else svc.flashStatus("应答失败")
    }
  }

  /** 只更新球（光环/工作示意），不改窗口结构。 */
  internal fun updateBallOnly() {
    // 会话维状态 → 光环；引擎维由探活驱动。PENDING（提问/审批待处理）优先于 WORKING（黄色占先）。
    svc.pendingKind = currentPending()?.first ?: ""
    svc.setHalo(svc.deriveHalo())
    if (svc.expanded) {
      statusText?.let {
        if (svc.pendingKind == "question") {
          (it as ShimmerTextView).setShimmering(false)
          it.setTextColor(0xFFB8860B.toInt())
          it.text = "等待你的回答…"
        } else if (svc.pendingKind == "approval") {
          (it as ShimmerTextView).setShimmering(false)
          it.setTextColor(0xFFB8860B.toInt())
          it.text = "等待权限审批…"
        } else if (svc.sessionBusy) {
          if (svc.currentToolName.isNotBlank()) {
            // 模板化（用户拍板）：调工具 → 工具类型 + 概览；思考 → Deep diving 扫光。
            it.text = templateTool()
              .replace("{tool}", svc.currentToolName)
              .replace("{summary}", svc.currentToolSummary)
            (it as ShimmerTextView).setShimmering(false)
            it.setTextColor(themeColors().idleText)
          } else {
            it.text = templateThinking()
            (it as ShimmerTextView).setShimmering(true)
          }
        } else {
          (it as ShimmerTextView).setShimmering(false)
          it.setTextColor(0xFF8A8F98.toInt())
          it.text = if (svc.engineRunning) "空闲" else "引擎离线"
        }
      }
      toolChip?.let {
        if (svc.toolCount > 0) { it.text = "工具 ×${svc.toolCount}"; it.visibility = View.VISIBLE }
        else it.visibility = View.GONE
      }
      updateClock()
      stopBtn?.alpha = if (svc.sessionBusy) 1f else 0.35f
      renderPendingCard()
    }
  }

  private fun updateClock() {
    val ct = clockText ?: return
    if (!svc.sessionBusy) { ct.visibility = View.GONE; return }
    val elapsed = System.currentTimeMillis() - svc.turnStartedAt
    if (elapsed < 15_000) { ct.visibility = View.GONE; return }
    ct.visibility = View.VISIBLE
    val sec = elapsed / 1000
    ct.text = if (sec >= 60) "${sec / 60}分%02d秒".format(sec % 60) else "${sec}s"
  }

  /** 拉取 session.list → 刷新「目标会话」下拉（第一项恒为「新会话」）。 */
  internal fun refreshSessionPicker() {
    svc.postRpc("session/list", JSONObject().put("_request", JSONObject())) { code, body ->
      val sp = sessionPicker ?: return@postRpc
      val ad = pickerAdapter ?: return@postRpc
      pickerLabels.clear(); pickerIds.clear()
      pickerLabels.add("＋ 新会话"); pickerIds.add("")
      if (code == 200) {
        try {
          val arr = JSONObject(body).optJSONObject("result")
            ?.optJSONObject("value")?.optJSONArray("items")
          if (arr != null) {
            for (i in 0 until arr.length()) {
              val it = arr.optJSONObject(i) ?: continue
              val sid = it.optString("sessionId", "")
              if (sid.isEmpty()) continue
              val titleObj = it.optJSONObject("projections")?.optJSONObject("values")?.opt("title")
              val title = if (titleObj == null || titleObj === JSONObject.NULL) "" else titleObj.toString()
                .ifBlank { "（第 ${i + 1} 个会话）" }
              // 已选当前目标：置顶展示，便于核对
              val label = if (sid == svc.activeSessionId) "$title（当前）" else title
              pickerLabels.add(label); pickerIds.add(sid)
            }
          }
        } catch (_: Exception) {}
      }
      ad.notifyDataSetChanged()
      // 回填当前目标会话在列表中的位置（找不到则回到「新会话」）
      val idx = pickerIds.indexOf(svc.activeSessionId).let { if (it >= 0) it else 0 }
      pickerInit = false
      try { sp.setSelection(idx, false) } catch (_: Exception) {}
      pickerInit = true
    }
  }
}

/** 权限审批待处理项（0.1.2-rc.1 $events waterfall 帧投影；eventId 关联键、agentId=目标会话 id）。 */
internal data class PendingApproval(val eventId: String, val agentId: String, val toolName: String, val reason: String)

/** AI 提问待处理项（$events waterfall 帧投影，request.questions 原始 JSONArray）。 */
internal data class PendingQuestion(val eventId: String, val agentId: String, val items: org.json.JSONArray)
