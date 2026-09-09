package com.dsharnessmobile.shell

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.util.DisplayMetrics
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicInteger

/**
 * 设备控制无障碍服务（0.13.5 W4，PRD-0.13.2 §3.3 B1/B2）。
 *
 * 定位：**语义控制面**——按需取当前窗口的节点快照（与 uiautomator XML 同构的
 * attrs 形状，故引擎侧复用同一剪枝/引用层），并用 performAction 做点击/输入/滚动/
 * 全局动作。相比 ADB 通道：一次系统开关即用、不受 uiautomator 的 idle 阻塞（坑 F1）、
 * setText 原子写入（绕开 IME 切换与丢字 F5）。
 *
 * 轻载原则：
 *  - 事件只用于**失效标记**（窗口状态/内容变化 + 200ms 节流），不做事件流处理；
 *  - 快照按需重建（每次 snapshot 请求一次遍历，约数百节点）；
 *  - 队列轮询只在引擎侧有活时进行（ControlPoller 读 pollHintMs）。
 *
 * 安全边界：
 *  - 只服务本应用引擎（127.0.0.1:3080）的请求，且请求必须带共享令牌；
 *  - 动作按**路径回指**（不是持久节点引用）：路径失效即失败关闭，绝不猜测性点击；
 *  - 不做账号接管/验证码/支付；不隐藏自动化信号。
 */
class DeviceControlService : AccessibilityService() {

  companion object {
    private const val TAG = "dsh-a11y"
    const val PREFS = "dsh-adb"
    const val KEY_A11Y = "a11yEnabled"
    const val KEY_TOKEN = "controlToken"
    /** 0.13.5 W4：轮询心跳（epoch ms）——进程被 force-stop 时 onDestroy 不保证执行，
     *  prefs 里的 a11yEnabled 会变成「僵尸 true」；引擎侧只认新鲜心跳。 */
    const val KEY_HEARTBEAT = "controlHeartbeat"
    private const val MAX_NODES = 4000
    private const val MAX_DEPTH = 40
    private const val TOKEN_BYTES = 18

    @Volatile
    private var instance: DeviceControlService? = null

    fun connected(): Boolean = instance != null

    /** 设置页展示用的状态 JSON（不含令牌本身）。 */
    fun statusJson(context: Context): String {
      val enabled = connected()
      val restricted = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
      return JSONObject()
        .put("enabled", enabled)
        .put("label", "DSH 设备控制")
        .put("sdk", Build.VERSION.SDK_INT)
        .put("restrictedSettingsApplies", restricted)
        .put(
          "hint",
          if (enabled) "无障碍服务已开启：设备控制走无障碍通道（语义树 + performAction）"
          else "未开启：到 系统设置 → 无障碍 → 已下载的服务 里开启「DSH 设备控制」",
        )
        .put("tokenConfigured", !context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_TOKEN, null).isNullOrEmpty())
        .toString()
    }

    /**
     * 控制队列共享令牌（壳生成一次、持久化到 dsh-adb.xml；引擎插件 live 读）。
     * 只在服务连接后可见——未开启无障碍时引擎侧拿不到令牌，控制路由自然失败关闭。
     */
    fun token(context: Context): String {
      val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val existing = prefs.getString(KEY_TOKEN, null)
      if (!existing.isNullOrEmpty()) return existing
      val random = ByteArray(TOKEN_BYTES)
      SecureRandom().nextBytes(random)
      val fresh = android.util.Base64.encodeToString(random, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
      prefs.edit().putString(KEY_TOKEN, fresh).apply()
      return fresh
    }

    private fun setEnabledFlag(context: Context, enabled: Boolean) {
      val editor = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit().putBoolean(KEY_A11Y, enabled)
      if (enabled) editor.putLong(KEY_HEARTBEAT, System.currentTimeMillis())
      else editor.remove(KEY_HEARTBEAT)
      editor.apply()
    }

    /** 轮询心跳：每次取活/空轮都刷新，引擎侧据此判断服务是否真的活着。 */
    fun heartbeat(context: Context) {
      context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit().putLong(KEY_HEARTBEAT, System.currentTimeMillis()).apply()
    }
  }

  /** 最近一次快照：路径 → 节点/边界。节点对象不跨快照使用（页面变化即失效）。 */
  private class Snapshot(
    val gen: Int,
    val rotation: Int,
    val width: Int,
    val height: Int,
    val nodes: LinkedHashMap<String, AccessibilityNodeInfo>,
    val bounds: HashMap<String, Rect>,
  )

  private val lock = Any()
  private var snapshot: Snapshot? = null
  private val generation = AtomicInteger(0)

  @Volatile
  private var invalidated = true

  @Volatile
  private var lastInvalidateAt = 0L

  private var poller: ControlPoller? = null

  /** 主线程 Handler：无障碍 API 的回调都在主线程（takeScreenshot 需要 Executor）。 */
  private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

  override fun onServiceConnected() {
    super.onServiceConnected()
    instance = this
    setEnabledFlag(this, true)
    token(this)
    invalidated = true
    val p = ControlPoller(this)
    poller = p
    p.start()
    LogCollector.log(TAG, "accessibility service connected; control channel online")
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    // 只做失效标记：窗口/内容变化后旧快照的路径与坐标都不再可信。
    val type = event?.eventType ?: return
    if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED || type == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED ||
      type == AccessibilityEvent.TYPE_VIEW_SCROLLED
    ) {
      val now = System.currentTimeMillis()
      if (now - lastInvalidateAt >= 200) {
        lastInvalidateAt = now
        invalidated = true
      }
    }
  }

  override fun onInterrupt() {
    // 系统要求实现；本服务不响应中断语义。
  }

  override fun onUnbind(intent: Intent?): Boolean {
    teardown()
    return super.onUnbind(intent)
  }

  override fun onDestroy() {
    teardown()
    super.onDestroy()
  }

  private fun teardown() {
    poller?.stop()
    poller = null
    instance = null
    synchronized(lock) { snapshot = null }
    setEnabledFlag(this, false)
    LogCollector.log(TAG, "accessibility service disconnected; control channel offline")
  }

  // ── 快照 ──────────────────────────────────────────────────────────────

  private fun buildSnapshot(force: Boolean): Snapshot? {
    synchronized(lock) {
      val current = snapshot
      if (!force && !invalidated && current != null) return current
      val root = rootInActiveWindow ?: return null
      val nodes = LinkedHashMap<String, AccessibilityNodeInfo>()
      val bounds = HashMap<String, Rect>()
      var count = 0
      fun walk(node: AccessibilityNodeInfo?, path: String, depth: Int) {
        if (node == null || depth > MAX_DEPTH || count >= MAX_NODES) return
        val rect = Rect()
        node.getBoundsInScreen(rect)
        if (rect.width() > 0 && rect.height() > 0) {
          nodes[path] = node
          bounds[path] = rect
          count++
        }
        for (i in 0 until node.childCount) {
          walk(node.getChild(i), if (path.isEmpty()) i.toString() else "$path.$i", depth + 1)
        }
      }
      walk(root, "", 0)
      val metrics = screenSize()
      val fresh = Snapshot(generation.incrementAndGet(), rotation(), metrics.first, metrics.second, nodes, bounds)
      snapshot = fresh
      invalidated = false
      return fresh
    }
  }

  private fun screenSize(): Pair<Int, Int> {
    val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val b = wm.currentWindowMetrics.bounds
      b.width() to b.height()
    } else {
      val metrics = DisplayMetrics()
      @Suppress("DEPRECATION")
      wm.defaultDisplay.getRealMetrics(metrics)
      metrics.widthPixels to metrics.heightPixels
    }
  }

  private fun rotation(): Int {
    val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      wm.defaultDisplay?.rotation ?: 0
    } else {
      @Suppress("DEPRECATION")
      wm.defaultDisplay.rotation
    }
  }

  /** 按路径重新定位节点（不复用快照里的节点对象——页面可能已重建）。 */
  private fun nodeAtPath(path: String): AccessibilityNodeInfo? {
    if (path.isEmpty()) return null
    var node: AccessibilityNodeInfo? = rootInActiveWindow ?: return null
    for (segment in path.split('.')) {
      val index = segment.toIntOrNull() ?: return null
      val current = node ?: return null
      if (index < 0 || index >= current.childCount) return null
      node = current.getChild(index)
    }
    return node
  }

  // ── 动作 ──────────────────────────────────────────────────────────────

  /** 执行一个队列请求；返回 null 表示成功（数据由调用方组装）。 */
  fun handle(op: String, args: JSONObject): JSONObject {
    return when (op) {
      "snapshot" -> handleSnapshot()
      "click" -> handleClick(args)
      "setText" -> handleSetText(args)
      "scroll" -> handleScroll(args)
      "global" -> handleGlobal(args)
      "screenshot" -> handleScreenshot(args)
      "state" -> handleState()
      else -> error("未知操作 $op")
    }
  }

  /**
   * 无障碍截屏（API 30+，`AccessibilityService.takeScreenshot`，需 `canTakeScreenshot="true"`）。
   * 返回 PNG 私有路径 + 物理尺寸；限频约 333ms，FLAG_SECURE 窗口会被系统拒绝。
   * API <30 无此能力 → 明确报错引导走 ADB 通道（见 docs/A11Y-CONTROL-DESIGN.md §2.2/§4）。
   */
  private fun handleScreenshot(args: JSONObject): JSONObject {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      return error("无障碍截屏需要 Android 11（API 30）及以上；本机 API ${Build.VERSION.SDK_INT}——请改用 ADB 通道（screencap）")
    }
    val displayId = args.optInt("displayId", android.view.Display.DEFAULT_DISPLAY)
    val latch = java.util.concurrent.CountDownLatch(1)
    var payload: JSONObject? = null
    val executor = java.util.concurrent.Executor { command -> mainHandler.post(command) }
    takeScreenshot(displayId, executor, object : TakeScreenshotCallback {
      override fun onSuccess(screenshot: ScreenshotResult) {
        try {
          val bitmap = android.graphics.Bitmap.wrapHardwareBuffer(screenshot.hardwareBuffer, screenshot.colorSpace)
          if (bitmap == null) {
            payload = error("截屏位图解码为空")
          } else {
            // 落引擎可读目录（EngineManager 把 TMPDIR 设为 files/home/tmp，管理插件
            // 的 dsh-tmp 同源）——此前落在 files/control-shots，引擎 read_image 打不开
            // （issue #127）。工具层读完即删，这里只留 LRU 兜底清理。
            val dir = java.io.File(java.io.File(filesDir, "home/tmp"), "dsh-tmp").apply { mkdirs() }
            val file = java.io.File(dir, "shot-${System.currentTimeMillis()}.png")
            java.io.FileOutputStream(file).use { out ->
              bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)
            }
            val width = bitmap.width
            val height = bitmap.height
            bitmap.recycle()
            pruneShots(dir, keep = 8)
            payload = JSONObject().put("path", file.absolutePath).put("width", width).put("height", height)
          }
        } catch (t: Throwable) {
          payload = error("截屏处理失败：" + (t.message ?: t.javaClass.simpleName))
        } finally {
          try { screenshot.hardwareBuffer.close() } catch (_: Throwable) { /* 忽略 */ }
          latch.countDown()
        }
      }

      override fun onFailure(errorCode: Int) {
        val hint = when (errorCode) {
          ERROR_TAKE_SCREENSHOT_INTERNAL_ERROR -> "内部错误"
          ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS -> "无障碍访问未就绪"
          ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT -> "调用过频（需间隔约 333ms）"
          ERROR_TAKE_SCREENSHOT_INVALID_DISPLAY -> "无效的显示 id"
          ERROR_TAKE_SCREENSHOT_SECURE_WINDOW -> "当前窗口禁止截屏（FLAG_SECURE）"
          else -> "错误码 $errorCode"
        }
        payload = error("截屏失败：$hint")
        latch.countDown()
      }
    })
    latch.await(12, java.util.concurrent.TimeUnit.SECONDS)
    return payload ?: error("截屏超时")
  }

  private fun error(message: String): JSONObject = JSONObject().put("__error", message)

  private fun handleSnapshot(): JSONObject {
    val snap = buildSnapshot(force = true) ?: return error("无法获取当前窗口（rootInActiveWindow 为空）——请确认屏幕已点亮且有无障碍可读窗口")
    val nodes = JSONArray()
    for ((path, node) in snap.nodes) {
      val rect = snap.bounds[path] ?: continue
      val attrs = JSONObject()
        .put("bounds", "[${rect.left},${rect.top}][${rect.right},${rect.bottom}]")
        .put("class", node.className?.toString() ?: "")
        .put("text", node.text?.toString() ?: "")
        .put("content-desc", node.contentDescription?.toString() ?: "")
        .put("resource-id", node.viewIdResourceName ?: "")
        .put("clickable", node.isClickable.toString())
        .put("scrollable", node.isScrollable.toString())
        .put("editable", node.isEditable.toString())
        .put("checked", node.isChecked.toString())
        .put("visible-to-user", node.isVisibleToUser.toString())
        .put("focused", node.isFocused.toString())
        .put("selected", node.isSelected.toString())
        .put("enabled", node.isEnabled.toString())
        .put("depth", path.count { it == '.' })
        .put("package", node.packageName?.toString() ?: "")
        .put("window-id", node.windowId.toString())
      nodes.put(JSONObject().put("id", path).put("parentId", path.substringBeforeLast('.', "")).put("attrs", attrs))
    }
    return JSONObject()
      .put("gen", snap.gen)
      .put("rotation", snap.rotation)
      .put("screen", JSONObject().put("w", snap.width).put("h", snap.height))
      .put("nodes", nodes)
  }

  /** 校验 gen（页面已变化时失败关闭）并返回目标节点。 */
  private fun requireFresh(args: JSONObject): JSONObject? {
    val requested = if (args.has("gen")) args.optInt("gen", -1) else -1
    if (requested >= 0) {
      val current = synchronized(lock) { snapshot?.gen ?: -1 }
      if (current != requested) return error("控件清单已过期（gen=$requested，当前=$current）——请重新 android_ui_dump")
    }
    return null
  }

  private fun handleClick(args: JSONObject): JSONObject {
    requireFresh(args)?.let { return it }
    val path = args.optString("path", "")
    if (path.isNotEmpty()) {
      var node = nodeAtPath(path) ?: return error("路径 $path 已不存在（页面已变化）——请重新 android_ui_dump")
      // 自身不可点 → 沿父链找可点祖先（与引擎侧回退策略一致的第二道保险）
      var hops = 0
      while (!node.isClickable && hops < 12) {
        node = node.parent ?: break
        hops++
      }
      if (node.isClickable) {
        val ok = node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        if (ok) {
          val rect = Rect()
          node.getBoundsInScreen(rect)
          return JSONObject().put("clicked", path).put("via", "ACTION_CLICK")
            .put("x", rect.exactCenterX().toDouble()).put("y", rect.exactCenterY().toDouble())
        }
        return error("ACTION_CLICK 被目标拒绝（path=$path）")
      }
      val rect = Rect()
      node.getBoundsInScreen(rect)
      return tapAt(rect.exactCenterX(), rect.exactCenterY(), "gesture-fallback")
    }
    if (args.has("nx") && args.has("ny")) {
      val metrics = screenSize()
      val x = (args.optDouble("nx") * metrics.first).toFloat()
      val y = (args.optDouble("ny") * metrics.second).toFloat()
      return tapAt(x, y, "gesture-norm")
    }
    return error("需要 path 或 nx/ny")
  }

  private fun tapAt(x: Float, y: Float, via: String): JSONObject {
    val path = Path().apply { moveTo(x, y) }
    val gesture = GestureDescription.Builder()
      .addStroke(GestureDescription.StrokeDescription(path, 0, 60))
      .build()
    val latch = java.util.concurrent.CountDownLatch(1)
    var ok = false
    val dispatched = dispatchGesture(gesture, object : GestureResultCallback() {
      override fun onCompleted(description: GestureDescription?) { ok = true; latch.countDown() }
      override fun onCancelled(description: GestureDescription?) { latch.countDown() }
    }, null)
    if (!dispatched) return error("手势派发失败（无障碍服务未就绪）")
    latch.await(3, java.util.concurrent.TimeUnit.SECONDS)
    return if (ok) JSONObject().put("clicked", "($x,$y)").put("via", via)
      .put("x", x.toDouble()).put("y", y.toDouble())
    else error("手势点击未完成（被系统取消）")
  }

  /**
   * 便宜的状态读数（不建树）：当前快照代次 + 是否已被窗口/内容事件失效。
   * 供工具层做「点击是否生效」校验（issue #129）：点后等待再读一次，
   * 代次变化或 invalidated=true 即界面确实变了。
   */
  private fun handleState(): JSONObject = JSONObject()
    .put("gen", synchronized(lock) { snapshot?.gen ?: -1 })
    .put("invalidated", invalidated)
    .put("enabled", true)

  /** 截图目录 LRU 兜底（工具层读完即删，这里只防异常路径堆积）。 */
  private fun pruneShots(dir: java.io.File, keep: Int) {
    try {
      val shots = dir.listFiles { f -> f.isFile && f.name.startsWith("shot-") }?.sortedByDescending { it.lastModified() } ?: return
      for (f in shots.drop(keep)) {
        try { f.delete() } catch (_: Throwable) { /* 忽略 */ }
      }
    } catch (_: Throwable) { /* 忽略 */ }
  }

  private fun handleSetText(args: JSONObject): JSONObject {
    requireFresh(args)?.let { return it }
    val text = args.optString("text", "")
    val clear = args.optBoolean("clear", false)
    val path = args.optString("path", "")
    val node: AccessibilityNodeInfo = if (path.isNotEmpty()) {
      nodeAtPath(path) ?: return error("路径 $path 已不存在（页面已变化）")
    } else {
      findFocusedEditable() ?: return error("没有聚焦的输入框——请先点击目标输入框，或用 ref 指定")
    }
    if (!node.isEditable) {
      // 允许在容器上尝试一次（部分实现把 editable 标在子节点）
      val child = (0 until node.childCount).mapNotNull { node.getChild(it) }.firstOrNull { it.isEditable }
      if (child == null) return error("目标不是可编辑节点")
      return commitText(child, text, clear)
    }
    return commitText(node, text, clear)
  }

  private fun commitText(node: AccessibilityNodeInfo, text: String, clear: Boolean): JSONObject {
    node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
    val value = if (clear) text else (node.text?.toString() ?: "") + text
    val bundle = Bundle().apply {
      putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
    }
    val ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)
    return if (ok) JSONObject().put("setText", value.length).put("cleared", clear)
    else error("ACTION_SET_TEXT 被目标拒绝")
  }

  private fun findFocusedEditable(): AccessibilityNodeInfo? {
    val root = rootInActiveWindow ?: return null
    fun walk(node: AccessibilityNodeInfo?, depth: Int): AccessibilityNodeInfo? {
      if (node == null || depth > MAX_DEPTH) return null
      if (node.isFocused && node.isEditable) return node
      for (i in 0 until node.childCount) walk(node.getChild(i), depth + 1)?.let { return it }
      return null
    }
    return walk(root, 0)
  }

  private fun handleScroll(args: JSONObject): JSONObject {
    requireFresh(args)?.let { return it }
    val direction = args.optString("direction", "")
    if (direction !in listOf("up", "down", "left", "right")) return error("未知方向 $direction")
    val path = args.optString("path", "")
    val target: AccessibilityNodeInfo? = if (path.isNotEmpty()) {
      var node = nodeAtPath(path) ?: return error("路径 $path 已不存在（页面已变化）")
      var hops = 0
      while (!node.isScrollable && hops < 12) {
        node = node.parent ?: break
        hops++
      }
      node
    } else {
      findFirstScrollable()
    }
    val action = when (direction) {
      "down" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
      "up" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
      else -> null
    }
    if (target != null && target.isScrollable) {
      // 先试旧版成对动作（兼容性最好），再试方向化动作（API 21+ 的 AccessibilityAction）
      val legacy = when (direction) {
        "down" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        "up" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        else -> null
      }
      if (legacy != null && target.performAction(legacy)) {
        return JSONObject().put("scrolled", direction).put("via", "ACTION_SCROLL")
      }
      // 方向化动作（API 21+ 的 AccessibilityAction；取其 id 走 performAction(int) 重载）
      val directional: Int? = when (direction) {
        "down" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.id
        "up" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.id
        "left" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.id
        "right" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.id
        else -> null
      }
      if (directional != null && target.performAction(directional)) {
        return JSONObject().put("scrolled", direction).put("via", "ACTION_SCROLL_DIRECTIONAL")
      }
    }
    // 兜底：整屏手势滑动（fraction 默认 0.6）
    val fraction = args.optDouble("fraction", 0.6).coerceIn(0.1, 1.0).toFloat()
    val metrics = screenSize()
    val w = metrics.first.toFloat()
    val h = metrics.second.toFloat()
    val (x1, y1, x2, y2) = when (direction) {
      "down" -> listOf(w / 2, h * (0.5f + fraction / 2), w / 2, h * (0.5f - fraction / 2))
      "up" -> listOf(w / 2, h * (0.5f - fraction / 2), w / 2, h * (0.5f + fraction / 2))
      "right" -> listOf(w * (0.5f - fraction / 2), h / 2, w * (0.5f + fraction / 2), h / 2)
      else -> listOf(w * (0.5f + fraction / 2), h / 2, w * (0.5f - fraction / 2), h / 2)
    }
    val stroke = Path().apply { moveTo(x1, y1); lineTo(x2, y2) }
    val gesture = GestureDescription.Builder()
      .addStroke(GestureDescription.StrokeDescription(stroke, 0, 220))
      .build()
    val latch = java.util.concurrent.CountDownLatch(1)
    var ok = false
    val dispatched = dispatchGesture(gesture, object : GestureResultCallback() {
      override fun onCompleted(description: GestureDescription?) { ok = true; latch.countDown() }
      override fun onCancelled(description: GestureDescription?) { latch.countDown() }
    }, null)
    if (!dispatched) return error("滚动手势派发失败")
    latch.await(4, java.util.concurrent.TimeUnit.SECONDS)
    return if (ok) JSONObject().put("scrolled", direction).put("via", "gesture").put("fraction", fraction)
    else error("滚动手势未完成")
  }

  private fun findFirstScrollable(): AccessibilityNodeInfo? {
    val root = rootInActiveWindow ?: return null
    fun walk(node: AccessibilityNodeInfo?, depth: Int): AccessibilityNodeInfo? {
      if (node == null || depth > MAX_DEPTH) return null
      if (node.isScrollable) return node
      for (i in 0 until node.childCount) walk(node.getChild(i), depth + 1)?.let { return it }
      return null
    }
    return walk(root, 0)
  }

  private fun handleGlobal(args: JSONObject): JSONObject {
    val action = when (args.optString("action", "")) {
      "back" -> GLOBAL_ACTION_BACK
      "home" -> GLOBAL_ACTION_HOME
      "recents" -> GLOBAL_ACTION_RECENTS
      "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
      else -> return error("未知全局动作")
    }
    val ok = performGlobalAction(action)
    return if (ok) JSONObject().put("global", args.optString("action")) else error("全局动作被系统拒绝")
  }
}
