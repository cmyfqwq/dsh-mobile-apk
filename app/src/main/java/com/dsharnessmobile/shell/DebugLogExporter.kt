package com.dsharnessmobile.shell

import java.io.File

/**
 * 调试日志导出（2026-08-16，自 MainActivity 拆出）：引擎日志 + 环境信息打包 zip。
 * 入口：加号菜单「导出调试日志」→ androidBridge.downloadDebugLogs()。
 * 优先写 Documents/dshdata/exports/（MANAGE_EXTERNAL_STORAGE 已授），
 * 未授权回退 MediaStore.Downloads；落盘复用 DownloadSaver 通道，
 * 结果复用导出弹窗（同 session 下载，经 DownloadSaver.pushExportResult）。
 */
internal class DebugLogExporter(
  private val activity: MainActivity,
  private val dshDataDir: File,
  private val homeDir: File,
  private val saver: DownloadSaver,
) {

  private val debugLogging = java.util.concurrent.atomic.AtomicBoolean(false)

  fun downloadDebugLogs() {
    if (!debugLogging.compareAndSet(false, true)) return
    Thread {
      try {
        val ts = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US)
          .format(java.util.Date())
        val filename = "dsh-debug-logs-$ts.zip"
        // 先写私有缓存，成功后再落最终位置（跨挂载只能 copy）。
        val cacheFile = File(activity.cacheDir, filename)
        java.util.zip.ZipOutputStream(java.io.FileOutputStream(cacheFile)).use { zos ->
          val log = File(activity.filesDir, "engine.log")
          if (log.exists()) {
            zos.putNextEntry(java.util.zip.ZipEntry("engine.log"))
            log.inputStream().use { it.copyTo(zos) }
            zos.closeEntry()
          }
          zos.putNextEntry(java.util.zip.ZipEntry("info.txt"))
          zos.write(buildDebugInfoText().toByteArray(Charsets.UTF_8))
          zos.closeEntry()
        }
        val saved = if (android.os.Build.VERSION.SDK_INT >= 30 &&
          android.os.Environment.isExternalStorageManager()
        ) {
          val exportDir = File(dshDataDir, "exports").apply { mkdirs() }
          File(dshDataDir, ".nomedia").writeText("")
          val target = saver.uniqueExportFile(exportDir, filename)
          val tmp = File(exportDir, "." + target.name + ".tmp")
          cacheFile.inputStream().use { input -> java.io.FileOutputStream(tmp).use { out -> input.copyTo(out) } }
          if (!tmp.renameTo(target)) throw java.io.IOException("rename failed")
          "文档/dshdata/exports/" + target.name
        } else {
          cacheFile.inputStream().use { input -> saver.saveToDownloadsStreamed(filename, input) }
          "下载/" + filename
        }
        saver.pushExportResult(true, "已保存到 $saved")
      } catch (t: Throwable) {
        saver.pushExportResult(false, t.message ?: "导出失败")
      } finally {
        debugLogging.set(false)
      }
    }.start()
  }

  /** 调试日志附带的环境信息（不含任何密钥；版本/设备/布局/插件摘要）。 */
  private fun buildDebugInfoText(): String {
    val sb = StringBuilder()
    sb.append("dsh-mobile debug info\n")
    sb.append("time: ").append(java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US)
      .format(java.util.Date())).append('\n')
    val pkg = try { activity.packageManager.getPackageInfo(activity.packageName, 0) } catch (_: Exception) { null }
    sb.append("app version: ").append(pkg?.versionName ?: "?").append(" (").append(pkg?.longVersionCode ?: 0).append(")\n")
    sb.append("android: ").append(android.os.Build.VERSION.RELEASE).append(" / SDK ").append(android.os.Build.VERSION.SDK_INT).append('\n')
    sb.append("device: ").append(android.os.Build.MANUFACTURER).append(' ').append(android.os.Build.MODEL).append('\n')
    sb.append("engine: ").append(EngineProbe.check().toString()).append('\n')
    sb.append("dshdata: ").append(dshDataDir.absolutePath)
      .append(" (nomedia=").append(File(dshDataDir, ".nomedia").exists())
      .append(", private-layout=").append(File(File(homeDir, ".dsh"), ".private-layout").exists())
      .append(")\n")
    return sb.toString()
  }
}
