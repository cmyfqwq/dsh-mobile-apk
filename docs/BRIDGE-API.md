# BRIDGE-API.md — 桥协议权威登记

> 职责：页面与原生之间的全部通道——window.androidBridge（31 个 @JavascriptInterface 方法）、consoleBridge（6 个）、原生→页面回调（window.__* 共 7 个）、悬浮球 MuxClient 协议与引擎 HTTP RPC 信封。锚点为 2026-09-05 当场 grep 行号；源码根 `app/src/main/java/com/dsharnessmobile/shell/`。页面侧类型见 dsh-client-ui-responsive 的 android-bridge.ts。

## 1. window.androidBridge（协议 v1，AndroidBridge.kt）

注册点 MainActivity.kt:394-457（接口名 `"androidBridge"`）；构造注入各 lambda（:396-454）为唯一接线面。共 **31** 个 @JavascriptInterface 方法（注解行 60-233，逐条 grep 核对）。

| 方法（行号） | 参数 | 返回通道 |
|---|---|---|
| version()(:60) | — | 同步返回 BuildConfig.VERSION_NAME |
| getSystemDark()(:65) | — | 同步 Boolean（H1：首帧主题走真 uiMode） |
| checkEngine()(:68) | — | 同步 JSON 字符串（EngineProbe.check） |
| keepScreenOn(enable)(:71) | Boolean | 无返回（WakeLock，MainActivity :577） |
| showNotification(title,text)(:76) | String×2 | 无返回（NotifyCenter） |
| pickDirectory(callbackId)(:81) | String | 异步：`__dshBridge.onDirectoryPicked(callbackId, path\|null)` |
| pickImage(callbackId)(:86) | String | 异步：`__dshBridge.onImagePicked(callbackId, json\|null)` |
| setTextZoom(percent)(:92) | Int | 无返回（textZoom 50-200 持久化） |
| setImmersiveMode(enable)(:98) | Boolean | 无返回（沉浸式持久化） |
| copyText(text)(:108) | String | 同步 Boolean（WebView Clipboard API 恒被拒的原生兜底） |
| downloadDebugLogs()(:112) | — | 无返回（结果经 `__dshExportResult` 弹窗） |
| exportConfig()(:122) | — | 同步 JSON {ok, path?, error?} |
| importConfig()(:126) | — | 同步 JSON 同上（导入前留 import-backup） |
| hasAllFilesAccess()(:130) | — | 同步 Boolean（isExternalStorageManager 仅 API 30+，:133 分支） |
| requestAllFilesAccess()(:138) | — | 无返回（跳系统授权页） |
| getPickToken()(:144) | — | 同步 String?（目录选择一次性 token；进程级共享 MainActivity.kt:56-58） |
| restartEngine()(:148) | — | 无返回（kill 后看门狗拉回） |
| shutdownToGuide()(:154) | — | 无返回（停引擎回引导页） |
| reloadWebUI()(:160) | — | 无返回（webView.reload + 通知） |
| openConsole()(:166) | — | 无返回（startActivity ConsoleActivity） |
| getDevLogEnabled()(:172) | — | 同步 Boolean |
| setDevLogEnabled(enabled)(:176) | Boolean | 无返回（LogCollector 起停） |
| openNativePath(path)(:189) | String | 同步 Boolean（ACTION_VIEW + FileProvider，issue #52；false 时页面回退引擎 RPC） |
| adbShell(cmd)(:194) | String | 同步 JSON {ok, stdout?, stderr?, guidance?}（未授权 fail-closed） |
| getAdbState()(:198) | — | 同步 JSON {fullAccess, allowSwitch, paired, wirelessDebugOn, message}（:439 顺带 ADB 预热） |
| setAdbAllow(enable)(:202) | Boolean | 无返回（门2 人门开关） |
| setAdbPair(code,pairPort,connectPort)(:213) | String,Int,Int | 同步 JSON {ok, reason, message}（F3 结构化；码值只进 argv 不入日志） |
| revokeAdbPair()(:218) | — | 无返回（R6 显式回收+审计） |
| discoverAdbPorts()(:225) | — | 同步 JSON {pair, connect, candidates[]}（缓存优先 :454） |
| getOverlayEnabled()(:229) | — | 同步 Boolean（悬浮球开关态） |
| setOverlayEnabled(enable)(:233) | Boolean | 同步 Boolean（是否已启动；权限引导走 OverlayController :33-38） |

另：companion `resolvePickedPath(uri)`（AndroidBridge.kt:245，非桥方法）——SAF tree URI → /storage/emulated/0 真实路径，含 `..` 清洗（M5）。

## 2. consoleBridge（ConsoleActivity.kt）

注册点 ConsoleActivity.kt:105；共 **6** 个方法：

| 方法（行号） | 说明 |
|---|---|
| submit(command)(:134) | 命令写入 stdin 管道 |
| engineStatus()(:139) | 同步 JSON（EngineProbe.check） |
| close()(:142) | finish 当前 Activity |
| restart()(:147) | 重启 bash 会话 |
| copyText(text)(:154) | 同步 Boolean（独立剪贴板写入） |
| ready()(:165) | 同步 Boolean（session.isAlive） |

## 3. 原生 → 页面回调通道全集（evaluateJavascript 逐点 grep）

| 通道 | 签名 | 发射点 |
|---|---|---|
| `__dshBridge.onDirectoryPicked` | (callbackId, path\|null) | ConfigTransfer.kt:120,126,143,169,180,285（SAF 结果/取消/权限缺失全路径） |
| `__dshBridge.onPermissionRequired` | () | ConfigTransfer.kt:244（All Files Access 引导信号） |
| `__dshBridge.onImagePicked` | (callbackId, dataUrlJson\|null) | ConfigTransfer.kt:346,363,368,392（原生读图→base64 data URL） |
| `__dshThemeBridge.setDark` | (dark:Boolean) | MainActivity.kt:517,523 + WebUiChrome.kt:155,161（含 800ms 延迟重推） |
| `__dshExportResult` | ({ok,title,detail}) | MainActivity.kt:640、DownloadSaver.kt:61（导出结果软件内弹窗） |
| `__consoleAppend` | (text) | ConsoleActivity.kt:42（bash 输出增量） |
| `__consoleStatus` | (text) | ConsoleActivity.kt:59（状态/退出码；onPageFinished 重放 :101） |
| `__consoleInsets` | (top,bottom,ime) | ConsoleActivity.kt:65（insets，页内守卫存在才调） |
| CSS 变量注入 | `--dsh-android-system-bottom` / `--dsh-android-ime-bottom` | MainActivity.kt:553-558（insets 投影 CSS px） |
| 悬浮球避让帧 | body padding JS（当前恒为归零帧） | OverlayService.kt:586,593 → frameConsumer（MainActivity.kt:197 注册/:284 注销） |

哨兵约定：目录选择显式拒绝时 path 传 `__dsh_pick_refused__:<reason>`（reason=permission-denied|android-10，MainActivity.kt:93，#120 协议）。

## 4. MuxClient 协议（悬浮球待答通道，MuxClient.kt:12-26 协议注释）

- 下行：手写 WS 连 `ws://127.0.0.1:3080/api/events.mux`（GET 握手 :77-80，SHA-1 accept 校验 :102-105）；**downlink-only**——客户端发业务帧会被引擎 close(1008)，本端只回 pong/close 控制帧（sendFrame :168-184）。
- 帧处理：仅认 `type:"server-request"`（OverlayPanel.handleMuxFrame OverlayPanel.kt:74-102），方法四种：`approval/requested`、`approval/resolved`、`question/requested`、`question/resolved`；断线 1s 起步指数退避重连上限 10s（MuxClient.kt:53-69），重连后引擎自动重放全部仍 pending 帧（rpcId 不变）。
- 应答：HTTP `POST /api/respond`（OverlayPanel.kt:587），信封 `{"type":"client-response","rpcId":<原样回显>,"result":{...}}`（:580-581）；accepted 判定 = HTTP 200 且 body 含 `"accepted":true`（:597）。
  - 审批 result：`{ok:true, value:{sessionId, approvalId, outcome:"allowed-once"|"rejected"}}`（respondApproval :603-615）。
  - 提问 result：`{ok:true, value:{sessionId, answer:{answers:[{id, selected:[选项label], custom?}]}}}`——answers 与 questions 原序配对、selected 用 label、单选 custom 与 selected 互斥（respondQuestion :617-642）。
  - 跳过提问：`{ok:false, error:{code:"cancelled", ...}}`（审批无取消通道，dismissQuestion :644-654）。

## 5. 壳侧直连的引擎 HTTP RPC（Proxy.NO_PROXY 直连 127.0.0.1:3080）

- 请求信封（OverlayService.postRpc OverlayService.kt:463-468）：`{"type":"client-request","rpcId":"overlay-<ts>","method":M,"payload":{...}}`。
- 已用方法：`session.prompt`（mode=steer 插话/queue 空闲，content 为 text 数组，:503-509）、`session.create`（新会话自动建，:524）、`session.list`（目标会话选择器投影，title 取 `projections.values.title` 且判 NULL，OverlayPanel.kt:711-731）、`session.cancel`（:491）、`respond`（§4）。
- 探活：EngineProbe.check/portReachable（EngineProbe.kt:38,72）——非 RPC 信封，独立 GET 探测，error 区分 timeout/refused。
