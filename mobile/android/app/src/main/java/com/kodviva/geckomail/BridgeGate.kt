package com.kodviva.geckomail

import android.webkit.JavascriptInterface
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.Bridge
import com.getcapacitor.MessageHandler
import org.json.JSONObject

/**
 * Bridge.registerAllPlugins çekirdek eklentileri (CapacitorHttp, CapacitorCookies, WebView, SystemBars) koşulsuz kaydeder;
 * `enabled:false` yalnız fetch yamasını kapatır, JS'ten nativePromise connect-src dışına çıkabilir. Kapı, JS'ten gelen tek girişi
 * ("androidBridge") sarar ve çekirdek eklentilerin doğrudan JS arayüzlerini kaldırır. Yanıt yolu değişmez: alt sınıf MessageHandler'ın kendi dinleyicisini ve yanıt vekilini kullanır.
 */
object BridgeGate {
    /** JS'in çağırabildiği eklentiler; Keyboard yalnız yerelde çalışır. iOS: BridgeGate.swift ile aynı liste */
    val allowedPlugins = setOf("GeckoNative", "App", "SplashScreen", "StatusBar")

    fun allows(json: String?): Boolean {
        val o = try { JSONObject(json ?: return false) } catch (_: Exception) { return false }
        // Android köprüsü olağan iletide type göndermez (native-bridge.js postToNative); MessageHandler bunu eklenti çağrısı sayar
        val type = o.opt("type")
        return (type == null || type == "message") && (o.opt("pluginId") as? String) in allowedPlugins
    }

    /** Eklenti load() içinden, Bridge sayfayı yüklemeden önce çağrılır: yeni dinleyici ilk belgeye girer */
    fun install(bridge: Bridge) {
        val web = bridge.webView
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) WebViewCompat.removeWebMessageListener(web, "androidBridge")
        web.removeJavascriptInterface("androidBridge")
        // ikisi eklenti yüklenirken kurulur ve iletiden geçmez; native-bridge.js yokluğunu "kapalı" sayar
        web.removeJavascriptInterface("CapacitorHttpAndroidInterface")
        web.removeJavascriptInterface("CapacitorCookiesAndroidInterface")
        GatedMessageHandler(bridge)
    }
}

/** Cordova türü kapıdan geçmediği için eklenti yöneticisi gerekmez */
private class GatedMessageHandler(bridge: Bridge) : MessageHandler(bridge, bridge.webView, null) {
    @JavascriptInterface
    override fun postMessage(jsonStr: String?) {
        if (BridgeGate.allows(jsonStr)) super.postMessage(jsonStr)
    }
}
