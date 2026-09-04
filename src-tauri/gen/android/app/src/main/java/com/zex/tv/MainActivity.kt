package com.zex.tv

import android.os.Bundle
import android.view.KeyEvent
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) webView?.requestFocus() // 电视上 Activity 重新获焦时把焦点还给 WebView
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    // Android TV 标准要求：WebView 必须显式可聚焦并持有焦点，否则 D-pad
    // 被系统当原生导航消费，根本不会产生网页 keydown
    webView.isFocusable = true
    webView.isFocusableInTouchMode = true
    webView.requestFocus()
  }

  // 遥控器按键接管：把原生 KeyEvent 转发进 Chromium，页面收到 isTrusted 的真
  // keydown —— 系统级管线，无兜底通道（之前 60ms 验证窗口的兜底补发正是双触发
  // 根源：evaluateJavascript 回调偶发超时就把已送达的事件误判成 miss 再补发一次）
  //
  // Back 键不能直接转发：Chromium 把 KEYCODE_BACK 当历史后退（BrowserBack），
  // 页面收不到 Escape；放给系统默认则直接退出 App。这里改造成 KEYCODE_ESCAPE
  // 送进同一管线——前端 service.ts 把 Escape 映射为焦点栈弹层（返回上一层：
  // 弹窗 → 关弹窗，详情 → 回库）。此前设想的 AppPlugin "back-button" 事件
  // 从未落地，前端那个监听一直是空转，已删
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.keyCode == KeyEvent.KEYCODE_BACK) {
      // 长按产生的系统 repeat 全部丢弃：一次 Back 只弹一层
      if (event.repeatCount > 0) return true
      // 保留原事件的时间/设备信息，只换键码
      val esc = KeyEvent(
        event.downTime, event.eventTime, event.action,
        KeyEvent.KEYCODE_ESCAPE, 0, event.metaState,
        event.deviceId, event.scanCode, event.flags,
      )
      when (event.action) {
        KeyEvent.ACTION_DOWN -> {
          // 与方向键同策略：每次按键把焦点抢回 WebView（海信上可能被系统导航偷走）
          webView?.requestFocus()
          webView?.dispatchKeyEvent(esc)
        }
        KeyEvent.ACTION_UP -> webView?.dispatchKeyEvent(esc)
        else -> return super.dispatchKeyEvent(event)
      }
      return true
    }

    when (event.keyCode) {
      KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN,
      KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
      KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> Unit
      else -> return super.dispatchKeyEvent(event)
    }

    when (event.action) {
      KeyEvent.ACTION_DOWN -> {
        // 系统 repeat（repeatCount>0）全部丢弃：连发由前端 REPEAT 定时器管
        if (event.repeatCount > 0) return true
        // 每次按键都把焦点抢回 WebView：海信电视上焦点可能被系统导航偷走
        webView?.requestFocus()
        webView?.dispatchKeyEvent(event)
        return true
      }
      KeyEvent.ACTION_UP -> {
        webView?.dispatchKeyEvent(event)
        return true
      }
      else -> return super.dispatchKeyEvent(event)
    }
  }
}
