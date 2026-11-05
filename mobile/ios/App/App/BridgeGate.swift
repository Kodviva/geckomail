import Capacitor
import WebKit

/// Capacitor her çekirdek eklentiyi (CapacitorHttp, CapacitorCookies, WebView, Console, SystemBars) koşulsuz kaydeder,
/// bilinmeyen kimliği NSClassFromString ile sınıf adından da yükler. `enabled:false` yalnız fetch yamasını kapatır: JS'ten
/// nativePromise connect-src dışına çıkabilir. Kapı, JS'ten gelen tek girişi ("bridge" ileti işleyicisi) sarar.
final class BridgeGate: NSObject, WKScriptMessageHandler {
    /// JS'in çağırabildiği eklentiler; Keyboard yalnız yerelde çalışır. Android: BridgeGate.kt ile aynı liste
    static let allowedPlugins: Set<String> = ["GeckoNative", "App", "SplashScreen", "StatusBar"]

    private weak var inner: WebViewDelegationHandler?

    private init(inner: WebViewDelegationHandler) {
        self.inner = inner
    }

    static func allows(_ body: Any, isMainFrame: Bool) -> Bool {
        guard isMainFrame, let dict = body as? [String: Any], dict["type"] as? String == "message",
              let id = dict["pluginId"] as? String else { return false }
        return allowedPlugins.contains(id)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard Self.allows(message.body, isMainFrame: message.frameInfo.isMainFrame) else { return }
        inner?.userContentController(controller, didReceive: message)
    }

    /// Sayfa yüklenmeden çağrılır
    static func install(on handler: WebViewDelegationHandler) {
        let controller = handler.contentController
        controller.removeScriptMessageHandler(forName: "bridge")
        controller.add(BridgeGate(inner: handler), name: "bridge")
    }
}

/// iOS'ta çerez köprüsünün ikinci yolu JS `prompt()`: Capacitor `CapacitorCookies.get/.set` istemlerini eklenti ayarına bakmadan
/// yanıtlar. `isEnabled` sorguları geçer: native-bridge.js açılışta onları sorar ve "false" alır. Geri kalan her şey asıl temsilciye gider.
final class CookiePromptGate: NSObject, WKUIDelegate {
    private weak var inner: WKUIDelegate?

    init(inner: WKUIDelegate) {
        self.inner = inner
    }

    static func refuses(_ prompt: String) -> Bool {
        guard let d = prompt.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d, options: .fragmentsAllowed) as? [String: Any],
              let type = o["type"] as? String else { return false }
        return type == "CapacitorCookies.get" || type == "CapacitorCookies.set"
    }

    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || (inner?.responds(to: selector) ?? false)
    }

    override func forwardingTarget(for selector: Selector!) -> Any? { inner }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard !Self.refuses(prompt), let inner else { return completionHandler(nil) }
        inner.webView?(webView, runJavaScriptTextInputPanelWithPrompt: prompt, defaultText: defaultText, initiatedByFrame: frame, completionHandler: completionHandler)
    }
}
