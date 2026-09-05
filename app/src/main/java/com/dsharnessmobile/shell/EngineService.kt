package com.dsharnessmobile.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Foreground service owning the embedded engine lifecycle: keeps the app
 * process alive while backgrounded (user-visible notification) and restarts
 * the engine process when it dies (watchdog). M2 keep-alive, no root needed.
 */
class EngineService : Service() {

  private lateinit var engineManager: EngineManager
  private var watchdog: ScheduledExecutorService? = null

  override fun onCreate() {
    super.onCreate()
    // C1: reuse the process-level pick token (auth survives watchdog engine restarts, never blank-allow).
    engineManager = EngineManager(this, EngineManager.ensurePickToken())
    instance = this
    startForeground(NOTIFICATION_ID, buildNotification())
    // Dev log toggle on: persistent collection (logcat + engine.log → dshdata/log/, daily).
    if (MainActivity.DevLogPrefs.isEnabled(this)) LogCollector.start(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!userShutdown) ensureEngine() else {
      watchdog?.shutdownNow(); watchdog = null
      // 用户停机/划掉关闭后的 START_STICKY 重投递：不再常驻（撤前台通知、允许进程结束）。
      if (intent == null) { stopSelf(); return START_NOT_STICKY }
    }
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  /** 任务移除（生命周期礼仪 F5.3）：不启动任何隐藏复活（不反弹）。
   *  ADB-F9 修复（2026-09-05 用户拍板语义）：划掉后台 = 主动关闭——完整停机，不保活。
   *  保活（前台服务 + 看门狗）只服务「App 仍在后台未划掉」的场景。撤悬浮球 UI +
   *  requestShutdown（userShutdown 标记 + 停看门狗 + 停引擎）+ stopSelf（撤前台通知，
   *  onDestroy 释放 wakelock / 停日志）；START_STICKY 重投递被 userShutdown 门拦截。 */
  override fun onTaskRemoved(rootIntent: Intent?) {
    try {
      FileIncoming.cleanupTmp(this)
    } catch (_: Exception) {
    }
    try {
      stopService(Intent(this, OverlayService::class.java))
    } catch (_: Exception) {
    }
    requestShutdown()
    stopSelf()
    LogCollector.log("dsh-file-open", "onTaskRemoved: full shutdown (swipe-away = user close)")
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    watchdog?.shutdownNow()
    watchdog = null
    WatchdogV2.releaseWakeLock()
    if (instance === this) instance = null
    // Log collection stops when the service exits (in-process idempotent singleton; also stopped when the toggle is off).
    LogCollector.stop()
    super.onDestroy()
  }

  /** User-requested shutdown: stop the watchdog + engine (no auto-restart). */
  fun requestShutdown() {
    userShutdown = true
    watchdog?.shutdownNow()
    watchdog = null
    try { engineManager.stopEngine() } catch (_: Exception) {
    }
  }

  /**
   * Start the engine if not running, then arm the watchdog. v2 (PRD F2-4):
   * the watchdog is installed in EVERY state — the previous early return for a
   * running engine left no watcher, so a later process death went unnoticed
   * until the user interacted. The tick also feeds the update-v2 confirmation/
   * rollback state machine (PRD F3.2/F1.10).
   */
  private fun ensureEngine() {
    if (!engineManager.engineReady) return
    if (watchdog == null) {
      WatchdogV2.acquireWakeLock(this)
      watchdog = Executors.newSingleThreadScheduledExecutor().also { exec ->
        exec.scheduleWithFixedDelay({
          // 深度探活（PRD F2-5）：HTTP + 插件端点 + 引擎日志异常；熔断退避（F2-6/7）。
          if (WatchdogV2.tripped()) {
            // 熔断：暂停重启尝试（界面提示由 GuideChrome 状态区显示）；用户交互复位。
            LogCollector.log("dsh-watchdog", "watchdog tripped: consecutive failure burst; paused")
            return@scheduleWithFixedDelay
          }
          val healthy = WatchdogV2.deepProbe(this)
          engineManager.onEngineProbe(healthy)
          WatchdogV2.recordProbe(healthy)
          // 唤醒锁续期：engine 常驻超过 30min 后半段无锁（acquire 定时释放）
          WatchdogV2.refreshWakeLock(this)
          if (!healthy && engineManager.engineReady) {
            engineManager.startEngine()
            // F3 自动回撤（D6 方案 a）：看门狗连续失败达到阈值（熔断前）时，
            // 触发急救 CLI 恢复最后良好快照；UndoGate 幂等 + 防循环。
            if (UndoGate.onProbeFailure(this, WatchdogV2.consecutiveFailures)) {
              LogCollector.log("dsh-watchdog", "auto-undo trigger: cons_fail=" + WatchdogV2.consecutiveFailures)
              Thread {
                val result = UndoGate.execute(this, engineManager)
                if (result.executed) {
                  LogCollector.log("dsh-watchdog", "auto-undo ok -> " + (result.snapshotId ?: "?"))
                  engineManager.resetCooldown()
                  engineManager.startEngine()
                } else {
                  LogCollector.log("dsh-watchdog", "auto-undo not executed: " + result.summary.take(160))
                }
              }.start()
            }
            LogCollector.log("dsh-watchdog", "restart attempt after failure #" + WatchdogV2.consecutiveFailures + " (backoff: " + WatchdogV2.nextDelayMs() + "ms advisory)")
          }
        }, 5, 5, TimeUnit.SECONDS)
      }
    }
  }

  private fun buildNotification(): android.app.Notification {
    val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel("engine", "dsh 引擎", NotificationManager.IMPORTANCE_LOW))
    }
    val pending = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, "engine")
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle("DeepCode 引擎运行中")
      .setContentText("DeepCode 正在后台工作")
      .setContentIntent(pending)
      .setOngoing(true)
      .build()
  }

  companion object {
    private const val NOTIFICATION_ID = 2
    /** User-requested shutdown flag: after shutdown the watchdog/onStartCommand no longer raises the engine; the user must start it manually. */
    @Volatile
    var userShutdown = false
    /** Currently running service instance (MainActivity's "Shut down" stops the watchdog via requestShutdown). */
    @Volatile
    var instance: EngineService? = null
  }
}
