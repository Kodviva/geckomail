package com.kodviva.geckomail

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Message
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import com.getcapacitor.Bridge
import com.getcapacitor.BridgeWebChromeClient

private val EXTERNAL_SCHEMES = setOf("http", "https", "mailto")

/** Posta içi bağlantıdan yalnız bunlar dışarı çıkar: intent:, file:, content: uygulama içindeki etkinlikleri açamaz */
fun isExternalLink(url: String): Boolean = url.substringBefore(':', "").lowercase() in EXTERNAL_SCHEMES

/** target=_blank: Capacitor pencere isteğini yanıtlamaz, dokunuş boşa gider (iOS'ta createWebViewWith karşılar). Adres sistem
 *  tarayıcısına verilir; yeni pencere yüklenmez, script-src'nin dışında sayfa açılmaz. Kullanıcı dokunuşu şarttır. */
class LinkChromeClient(bridge: Bridge) : BridgeWebChromeClient(bridge) {
    override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
        if (!isUserGesture) return false
        val probe = WebView(view.context)
        probe.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                open(view.context, request.url.toString())
                v.destroy()
                return true
            }
        }
        (resultMsg.obj as WebView.WebViewTransport).webView = probe
        resultMsg.sendToTarget()
        return true
    }

    private fun open(ctx: Context, url: String) {
        if (!isExternalLink(url)) return
        try {
            ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            // açacak uygulama yok: posta görünümü olduğu gibi kalır
        }
    }
}
