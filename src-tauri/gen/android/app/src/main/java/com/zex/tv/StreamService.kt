package com.zex.tv

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

// 播放期间的前台服务。
//
// 为什么需要：ZEX 拉起系统播放器后自己退到后台变「缓存进程」，这台海信开了激进
// 冻结（persist.vt.hi_freeze_mode=1）会把 ZEX 冻住（实测 cgroup.freeze=1）——
// 而视频是靠 ZEX 内部的 127.0.0.1 SMB→HTTP 流代理（stream_server.rs）喂给播放器的，
// 进程一冻，代理线程停摆：播放器放完开头那点缓冲后再要数据就拿不到 → 无限加载。
// 前台服务把进程优先级抬到「前台」，冻结器/LMK 不再动它，代理得以持续供流。
// 播放器退回 App（app-resumed，见 lib.rs RunEvent::Resumed）时停掉。
//
// Rust 侧经 JNI 调 StreamServiceCtl.start/stop（见 stream_server.rs），返回
// null=成功 / String=失败文案，与 PlayerLauncher 一致。
object StreamServiceCtl {
  private const val TAG = "ZEXStream"

  @JvmStatic
  fun start(context: Context, title: String): String? {
    return try {
      val app = context.applicationContext ?: context
      val i = Intent(app, StreamService::class.java).putExtra("title", title)
      // 由 play_episode 在 ZEX 仍前台时调用 → 允许前台启动 FGS（targetSdk 34+ 禁止后台启动）
      app.startForegroundService(i)
      null
    } catch (e: Throwable) {
      Log.w(TAG, "启动前台服务失败：${e.javaClass.simpleName} ${e.message}")
      "启动前台服务失败：${e.message}"
    }
  }

  @JvmStatic
  fun stop(context: Context): String? {
    return try {
      val app = context.applicationContext ?: context
      app.stopService(Intent(app, StreamService::class.java))
      null
    } catch (e: Throwable) {
      Log.w(TAG, "停止前台服务失败：${e.javaClass.simpleName} ${e.message}")
      "停止前台服务失败：${e.message}"
    }
  }
}

class StreamService : Service() {
  companion object {
    private const val CHANNEL = "zex_stream"
    private const val NOTIF_ID = 4711
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra("title") ?: "正在投送"
    ensureChannel()
    val notif: Notification = Notification.Builder(this, CHANNEL)
      .setContentTitle("ZEX TV")
      .setContentText(title)
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setOngoing(true)
      .build()
    // startForegroundService 后必须 5s 内 startForeground，否则系统抛 ANR/崩溃
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(NOTIF_ID, notif)
    }
    return START_NOT_STICKY // 被杀不自动重建：播放会话结束就该没了
  }

  private fun ensureChannel() {
    val nm = getSystemService(NotificationManager::class.java)
    if (nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL, "播放中", NotificationManager.IMPORTANCE_LOW)
      )
    }
  }
}
