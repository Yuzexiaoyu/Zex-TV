package com.zex.tv

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast

// 电视端拉起外部播放器。
//
// 为什么不能只发 ACTION_VIEW + http URL（opener 插件的老做法）：
//   纯 data 意图只有「声明了 http scheme 且不带 mimeType」的 Activity 能接——
//   也就是浏览器；电视上没有浏览器，必然 No Activity found。
//   播放器（MX/VLC/Just…）注册的都是 http(s) + video/*，必须 setDataAndType
//   挂上 MIME 才匹配得上。
//
// 匹配链（TVBox 类电视应用的标准做法）：
//   1) 已知播放器包名逐个点名尝试——startActivity 对包内无匹配会同步抛
//      ActivityNotFoundException，捕获后换下一个；
//   2) 兜底：不点名，交给系统解析任意能接的播放器（电视自带播放器等）；
//   3) 全部失败返回错误文案（由 Rust 侧转成「拉起播放器失败」弹给前端）。
//
// MIME 链：文件真实容器类型（Rust 侧按扩展名算好，如 video/mp4）优先，
//   video/* 通配兜底。Android 意图匹配只认「过滤器侧」通配——intent 带具体
//   类型时，过滤器声明 video/* 或该具体类型的播放器都接得住；intent 带
//   video/* 时，只声明具体类型（电视自带常见）的播放器匹配不上。
//
// 诊断：每次成功拉起都 Toast + Logcat（tag=ZEXPlayer）报出实际接收的组件。
// 若「Toast 出现了但播放器画面没出现」= 该组件打不开我们的 URL，把 Toast
// 里的组件名记下来反馈。
object PlayerLauncher {
  private const val TAG = "ZEXPlayer"

  private val KNOWN_PACKAGES = listOf(
    "org.videolan.vlc",           // VLC
    "com.mxtech.videoplayer.pro", // MX Player Pro
    "com.mxtech.videoplayer.ad",  // MX Player 免费版
    "com.brouken.player",         // Just Player
    "is.xyz.mpv",                 // mpv-android
    "org.courville.nova",         // Nova Video Player
  )

  // 返回 null = 已拉起；返回 String = 给用户的失败原因
  @JvmStatic
  fun launch(context: Context, url: String, mime: String): String? {
    val data = Uri.parse(url)
    val app = context.applicationContext ?: context

    val mimeChain =
      if (mime.isBlank() || mime == "video/*") listOf("video/*")
      else listOf(mime, "video/*")

    for (m in mimeChain) {
      for (pkg in KNOWN_PACKAGES) {
        val intent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(data, m)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          setPackage(pkg)
        }
        Log.i(TAG, "尝试已知播放器：$pkg (mime=$m)")
        try {
          context.startActivity(intent)
          report(app, "已拉起播放器：$pkg")
          return null
        } catch (e: Throwable) {
          // ActivityNotFoundException=未装；SecurityException 等=换下一个
          Log.i(TAG, "$pkg 不可用（${e.javaClass.simpleName}），试下一个")
        }
      }

      val generic = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(data, m)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      val matched: ComponentName? = try {
        generic.resolveActivity(app.packageManager)
      } catch (_: Exception) {
        null
      }
      Log.i(TAG, "通用意图匹配组件（mime=$m）：$matched")
      try {
        context.startActivity(generic)
        report(
          app,
          "已拉起播放器：${matched?.flattenToShortString() ?: "系统默认"}" +
            "（若画面没出现，请记下此名称反馈）",
        )
        return null
      } catch (e: Throwable) {
        Log.i(TAG, "通用意图失败（mime=$m，${e.javaClass.simpleName}）")
      }
    }

    val msg = "未找到可用的视频播放器，请在电视上安装（如 VLC、MX Player、Just Player）"
    Log.w(TAG, msg)
    return msg
  }

  private fun report(context: Context, text: String) {
    Log.i(TAG, text)
    Handler(Looper.getMainLooper()).post {
      Toast.makeText(context, text, Toast.LENGTH_LONG).show()
    }
  }
}
