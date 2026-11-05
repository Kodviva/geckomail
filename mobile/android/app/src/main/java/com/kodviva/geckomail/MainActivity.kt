package com.kodviva.geckomail

import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.widget.TextView
import androidx.webkit.WebViewFeature
import com.getcapacitor.BridgeActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import com.kodviva.geckomail.push.OpenRequest

/** Köprü WebView'e belge başında girmeli: bu özellik yoksa Capacitor betiği HTML'e gömer, script-src 'self' onu engeller. */
class MainActivity : BridgeActivity() {
    /** BridgeActivity.load başlangıç niyetini onNewIntent'e verir: işleme tek yerden. Yeniden kurulan etkinlik eski isteği tekrarlamaz */
    private var restored = false

    override fun onCreate(savedInstanceState: Bundle?) {
        restored = savedInstanceState != null
        registerPlugin(GeckoNativePlugin::class.java)
        super.onCreate(savedInstanceState)
        applySecureFlag(AppServices.get(this).lock.config.enabled)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (restored) restored = false else handle(intent)
    }

    private fun handle(i: Intent) {
        val s = AppServices.get(this)
        if (IncomingIntents.isShare(i)) {
            val items = IncomingIntents.sharedItems(i, this)
            val text = IncomingIntents.sharedText(i)
            s.scope.launch(Dispatchers.IO) {
                if (s.shares.accept(items, text)) s.shareArrived()
            }
            return
        }
        // dışa açık etkinlik: yalnız doğrulanmış derin bağlantı, ek alanlara güvenilmez (bildirim NotificationOpenActivity'den gelir)
        if (i.action == Intent.ACTION_VIEW) i.data?.let(::parseDeepLink)?.let { s.opens.add(OpenRequest(it.messageId, null, it.reply)) }
    }

    override fun onStart() {
        super.onStart()
        val s = AppServices.get(this)
        s.foreground = true
        s.lock.didBecomeForeground()
        s.sweepFiles()
        s.scope.launch { s.registrar.retryPendingRegister() }
    }

    override fun onStop() {
        val s = AppServices.get(this)
        s.foreground = false
        s.lock.didEnterBackground()
        if (s.lock.isLocked()) s.api.dropAccess()
        super.onStop()
    }

    override fun load() {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            super.load()
            // Bridge istemciyi eklentilerden sonra kurar: burada değişir. Çoklu pencere yoksa target=_blank çerçevede kalır, CSP keser
            bridge.webView.settings.setSupportMultipleWindows(true)
            bridge.webView.webChromeClient = LinkChromeClient(bridge)
            return
        }
        val pad = (24 * resources.displayMetrics.density).toInt()
        setContentView(
            TextView(this).apply {
                setText(R.string.webview_update)
                gravity = Gravity.CENTER
                setPadding(pad, pad, pad, pad)
            }
        )
    }
}
