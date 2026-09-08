package com.dsharnessmobile.shell

import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 无障碍控制队列客户端（0.13.5 W4，PRD-0.13.2 §3.3 B2）。
 *
 * 方向：引擎侧是服务端（`/api/android/ui/pending` + `/api/android/ui/result`），
 * 本类在壳侧**长轮询**取活并回填结果。长轮询（默认 5s）比 500ms 短轮询更轻：
 * 空闲时每 5 秒一次请求，有活时引擎侧立即唤醒 → 延迟接近 0。
 *
 * 失败关闭：取活/回填任何异常只记录并退避重试，不猜测、不重放动作。
 * 引擎未起时退避到 10s，避免空转耗电。
 */
class ControlPoller(private val service: DeviceControlService) {

  companion object {
    private const val TAG = "dsh-a11y"
    private const val BASE = "http://127.0.0.1:3080"
    private const val LONG_POLL_MS = 5000
    private const val CONNECT_TIMEOUT_MS = 2000
    private const val READ_TIMEOUT_MS = 9000
    private const val IDLE_BACKOFF_MS = 1000L
    private const val MAX_BACKOFF_MS = 10_000L
  }

  private val running = AtomicBoolean(false)
  private var thread: Thread? = null

  fun start() {
    if (!running.compareAndSet(false, true)) return
    thread = Thread({ loop() }, "dsh-control-poller").also {
      it.isDaemon = true
      it.start()
    }
  }

  fun stop() {
    running.set(false)
    thread?.interrupt()
    thread = null
  }

  private fun loop() {
    var backoff = IDLE_BACKOFF_MS
    val token = DeviceControlService.token(service)
    while (running.get()) {
      try {
        val poll = post(
          "/api/android/ui/pending",
          JSONObject().put("token", token).put("waitMs", LONG_POLL_MS),
        )
        if (poll == null || !poll.optBoolean("ok", false)) {
          sleep(backoff)
          backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
          continue
        }
        backoff = IDLE_BACKOFF_MS
        // 心跳：证明「服务活着 + 轮询在跑」——引擎侧只认新鲜心跳，避免僵尸 a11yEnabled
        DeviceControlService.heartbeat(service)
        val request = poll.optJSONObject("req") ?: continue
        execute(token, request)
      } catch (interrupted: InterruptedException) {
        return
      } catch (_: Exception) {
        sleep(backoff)
        backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
      }
    }
  }

  private fun execute(token: String, request: JSONObject) {
    val reqId = request.optString("reqId", "")
    if (reqId.isEmpty()) return
    val op = request.optString("op", "")
    val args = request.optJSONObject("args") ?: JSONObject()
    val outcome: JSONObject = try {
      val result = service.handle(op, args)
      val err = result.optString("__error", "")
      if (err.isNotEmpty()) JSONObject().put("ok", false).put("error", err)
      else JSONObject().put("ok", true).put("data", result)
    } catch (error: Throwable) {
      JSONObject().put("ok", false).put("error", "壳侧执行异常：" + (error.message ?: error.javaClass.simpleName))
    }
    try {
      post(
        "/api/android/ui/result",
        JSONObject()
          .put("token", token)
          .put("reqId", reqId)
          .put("ok", outcome.optBoolean("ok", false))
          .put("data", outcome.opt("data"))
          .put("error", outcome.optString("error", "")),
      )
    } catch (error: Exception) {
      LogCollector.log(TAG, "result post failed for $op: ${error.message}")
    }
  }

  /** POST JSON 并解析响应；非 2xx 或解析失败返回 null（调用方退避）。 */
  private fun post(path: String, body: JSONObject): JSONObject? {
    val connection = URL(BASE + path).openConnection(Proxy.NO_PROXY) as HttpURLConnection
    return try {
      connection.requestMethod = "POST"
      connection.doOutput = true
      connection.connectTimeout = CONNECT_TIMEOUT_MS
      connection.readTimeout = READ_TIMEOUT_MS
      connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
      OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { it.write(body.toString()) }
      val code = connection.responseCode
      if (code !in 200..299) {
        connection.errorStream?.close()
        null
      } else {
        val text = BufferedReader(InputStreamReader(connection.inputStream, Charsets.UTF_8)).use { it.readText() }
        if (text.isEmpty()) JSONObject() else JSONObject(text)
      }
    } finally {
      connection.disconnect()
    }
  }

  private fun sleep(ms: Long) {
    try {
      Thread.sleep(ms)
    } catch (interrupted: InterruptedException) {
      Thread.currentThread().interrupt()
    }
  }
}
