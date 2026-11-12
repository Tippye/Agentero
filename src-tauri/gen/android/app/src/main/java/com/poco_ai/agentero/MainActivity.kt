package com.poco_ai.agentero

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    super.onCreate(savedInstanceState)
  }

  // Wry installs its WebView through setContentView(View) after Rust startup,
  // after onWebViewCreate. Fit its containing frame, never WebView internal padding.
  override fun setContentView(view: View?) {
    super.setContentView(view)
    fitSystemInsets()
  }

  override fun setContentView(view: View?, params: ViewGroup.LayoutParams?) {
    super.setContentView(view, params)
    fitSystemInsets()
  }

  private fun fitSystemInsets() {
    val content = findViewById<View>(android.R.id.content) ?: return
    ViewCompat.setOnApplyWindowInsetsListener(content) { target, insets ->
      // Union takes the maximum on each edge: the IME replaces the navigation
      // obstruction rather than adding its height a second time. Includes side
      // navigation bars and cutouts in landscape, in physical Android pixels.
      val safe = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      target.setPadding(safe.left, safe.top, safe.right, safe.bottom)
      // The actual WebView viewport is now safe. Do not forward the same insets
      // into WebView env(safe-area-inset-*) or let descendants apply them again.
      WindowInsetsCompat.CONSUMED
    }
    WindowCompat.getInsetsController(window, content).show(WindowInsetsCompat.Type.systemBars())
    if (ViewCompat.isAttachedToWindow(content)) {
      ViewCompat.requestApplyInsets(content)
    } else {
      content.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(view: View) {
          view.removeOnAttachStateChangeListener(this)
          ViewCompat.requestApplyInsets(view)
        }
        override fun onViewDetachedFromWindow(view: View) = Unit
      })
    }
  }
}
