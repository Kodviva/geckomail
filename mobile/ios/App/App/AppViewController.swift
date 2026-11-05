import Capacitor
import UIKit
import WebKit

class AppViewController: CAPBridgeViewController {
    private var shield: UIView?
    private var promptGate: CookiePromptGate? // WKWebView temsilciyi zayıf tutar

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(GeckoNativePlugin())
        guard let handler = webView?.navigationDelegate as? WebViewDelegationHandler else {
            fatalError("köprü kapısı kurulamadı") // kapısız köprüyle açılmaktansa açılmaz
        }
        BridgeGate.install(on: handler)
        promptGate = CookiePromptGate(inner: handler)
        webView?.uiDelegate = promptGate
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(hideContent), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(showContent), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    /// Kilit açıkken uygulama değiştirici görüntüsünde içerik görünmez
    @objc private func hideContent() {
        guard AppServices.shared.lock.config.enabled, shield == nil else { return }
        let cover = UIView(frame: view.bounds)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = .systemBackground
        view.addSubview(cover)
        shield = cover
    }

    @objc private func showContent() {
        shield?.removeFromSuperview()
        shield = nil
    }
}
