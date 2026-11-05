// Köprü ölçümü: gerçek WKWebView ve gerçek Capacitor köprüsü. Aynı JS yeni bir yerel dinleyiciye istek atmayı dener.
import Network
import WebKit
import XCTest
@testable import App

private final class Probe {
    private let listener: NWListener
    private let lock = NSLock()
    private var hits = 0
    private(set) var port: UInt16 = 0

    init() throws {
        listener = try NWListener(using: .tcp, on: .any)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
        listener.newConnectionHandler = { [weak self] c in
            self?.lock.lock()
            self?.hits += 1
            self?.lock.unlock()
            c.start(queue: .global())
            c.send(content: Data("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".utf8), completion: .contentProcessed { _ in c.cancel() })
        }
        listener.start(queue: .global())
        _ = ready.wait(timeout: .now() + 5)
        port = listener.port?.rawValue ?? 0
    }

    var count: Int { lock.lock(); defer { lock.unlock() }; return hits }
    func stop() { listener.cancel() }
}

private final class DeniedAuth: Authenticating {
    func available() -> Bool { true }
    func prompt(reason: String) async -> Bool { false }
}

@MainActor
final class BridgeLiveTests: XCTestCase {
    private func webView() async throws -> WKWebView {
        for _ in 0..<100 {
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            if let vc = scene?.windows.first?.rootViewController as? AppViewController, let web = vc.webView, !web.isLoading {
                let ready = try await web.evaluateJavaScript("typeof Capacitor !== 'undefined' && !!Capacitor.nativePromise") as? Bool
                if ready == true { return web }
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw XCTSkip("web görünümü hazır değil")
    }

    /** 'ok:…', 'err:…' ya da yanıt gelmezse 'timeout' */
    private func call(_ web: WKWebView, _ js: String) async throws -> String {
        let body = """
        const r = await Promise.race([
          (\(js)).then((v) => 'ok:' + JSON.stringify(v), (e) => 'err:' + (e && e.message)),
          new Promise((res) => setTimeout(() => res('timeout'), 2500))
        ]);
        return r;
        """
        return try await web.callAsyncJavaScript(body, arguments: [:], in: nil, contentWorld: .page) as? String ?? "nil"
    }

    func testSaveBytesOpensShareSheet() async throws {
        let web = try await webView()
        web.evaluateJavaScript("Capacitor.nativePromise('GeckoNative','saveBytes',{name:'../deneme.txt',base64:'bWVyaGFiYQ=='}).then((r) => { window.__saved = r })", completionHandler: nil)
        var sheet: UIActivityViewController?
        for _ in 0..<50 where sheet == nil {
            sheet = web.window?.rootViewController?.presentedViewController as? UIActivityViewController
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let shown = try XCTUnwrap(sheet)
        await shown.dismiss(animated: false)
    }

    /// Oturum açıkken de çalıştırılır (mobile/e2e/README.md): belirteç JS deposuna hiç girmez
    func testNoTokenInWebStorage() async throws {
        let web = try await webView()
        let dump = try await call(web, """
        (async () => {
          const out = [JSON.stringify(Object.entries(localStorage)), JSON.stringify(Object.entries(sessionStorage)), document.cookie];
          for (const d of await indexedDB.databases()) {
            const db = await new Promise((ok, no) => { const r = indexedDB.open(d.name); r.onsuccess = () => ok(r.result); r.onerror = no });
            for (const name of db.objectStoreNames) {
              out.push(await new Promise((ok) => { const r = db.transaction(name).objectStore(name).getAll(); r.onsuccess = () => ok(JSON.stringify(r.result).slice(0, 200000)); r.onerror = () => ok('') }));
            }
            db.close();
          }
          return out.join(' ');
        })()
        """)
        print("OLCUM iOS web deposu boyut=\(dump.count)")
        XCTAssertTrue(dump.hasPrefix("ok:"), dump)
        for prefix in ["gms_", "gma_", "gmt_"] { XCTAssertFalse(dump.contains(prefix), prefix) }
    }

    func testCapacitorHttpBlocked() async throws {
        let web = try await webView()
        let probe = try Probe()
        defer { probe.stop() }
        let r = try await call(web, "Capacitor.nativePromise('CapacitorHttp','request',{url:'http://127.0.0.1:\(probe.port)/sizinti',method:'GET'})")
        print("OLCUM iOS CapacitorHttp sonuc=\(r) dinleyici=\(probe.count)")
        XCTAssertEqual(probe.count, 0, r)
        XCTAssertEqual(r, "timeout")
    }

    func testClassNameRouteBlocked() async throws {
        let web = try await webView()
        let probe = try Probe()
        defer { probe.stop() }
        let r = try await call(web, "Capacitor.nativePromise('CAPHttpPlugin','request',{url:'http://127.0.0.1:\(probe.port)/sizinti',method:'GET'})")
        print("OLCUM iOS CAPHttpPlugin sonuc=\(r) dinleyici=\(probe.count)")
        XCTAssertEqual(probe.count, 0, r)
    }

    func testRawMessageHandlerBlocked() async throws {
        let web = try await webView()
        let probe = try Probe()
        defer { probe.stop() }
        _ = try await call(web, """
        (async () => { window.webkit.messageHandlers.bridge.postMessage({type:'message',pluginId:'CapacitorHttp',methodName:'request',callbackId:'9',options:{url:'http://127.0.0.1:\(probe.port)/ham',method:'GET'}}); await new Promise((r)=>setTimeout(r,1500)); return 1 })()
        """)
        print("OLCUM iOS ham-mesaj dinleyici=\(probe.count)")
        XCTAssertEqual(probe.count, 0)
    }

    func testCapacitorCookiesBlocked() async throws {
        let web = try await webView()
        let r = try await call(web, "Capacitor.nativePromise('CapacitorCookies','getCookies',{})")
        print("OLCUM iOS CapacitorCookies sonuc=\(r)")
        XCTAssertEqual(r, "timeout")
    }

    func testCookiePromptBlocked() async throws {
        let web = try await webView()
        let set = try await call(web, "Promise.resolve(prompt(JSON.stringify({type:'CapacitorCookies.set',domain:'capacitor://localhost',action:'sizinti=1; path=/'})))")
        let get = try await call(web, "Promise.resolve(prompt(JSON.stringify({type:'CapacitorCookies.get'})))")
        print("OLCUM iOS cerez-prompt set=\(set) get=\(get)")
        XCTAssertEqual(set, "ok:null")
        XCTAssertEqual(get, "ok:null")
    }

    func testCookieFlagPromptStillAnswers() async throws {
        let web = try await webView()
        let r = try await call(web, "Promise.resolve(prompt(JSON.stringify({type:'CapacitorCookies.isEnabled'})))")
        XCTAssertEqual(r, "ok:\"false\"")
    }

    func testAllowlistedPluginsStillWork() async throws {
        let web = try await webView()
        let a = try await call(web, "Capacitor.nativePromise('GeckoNative','getServer',{})")
        let b = try await call(web, "Capacitor.nativePromise('App','getInfo',{})")
        print("OLCUM iOS izinli GeckoNative=\(a) App=\(b.prefix(40))")
        XCTAssertTrue(a.hasPrefix("ok:"), a)
        XCTAssertTrue(b.hasPrefix("ok:"), b)
    }

    func testAccessTokenRefusedWhileLocked() async throws {
        let web = try await webView()
        let gate = AppServices.shared.lock
        gate.apply(.init(enabled: true, timeoutMs: 0))
        defer {
            gate.apply(.init(enabled: false, timeoutMs: 0))
            gate.unlocked()
        }
        gate.didEnterBackground()
        gate.didBecomeForeground()
        let r = try await call(web, "Capacitor.nativePromise('GeckoNative','accessToken',{})")
        let lock = try await call(web, "Capacitor.nativePromise('GeckoNative','getLock',{})")
        print("OLCUM iOS kilitli accessToken=\(r)")
        XCTAssertEqual(r, #"ok:{"status":"locked"}"#)
        XCTAssertTrue(lock.contains(#""locked":true"#), lock)
    }

    func testJsCannotWeakenLock() async throws {
        let web = try await webView()
        let gate = AppServices.shared.lock
        gate.apply(.init(enabled: true, timeoutMs: 60_000))
        let real = AppServices.shared.auth
        AppServices.shared.auth = DeniedAuth() // gerçek istem testi bekletir
        defer {
            AppServices.shared.auth = real
            gate.apply(.init(enabled: false, timeoutMs: 0))
        }
        let r = try await call(web, "Capacitor.nativePromise('GeckoNative','setLock',{enabled:false,timeoutMs:0})")
        print("OLCUM iOS JS zayıflatma=\(r)")
        XCTAssertTrue(r.hasPrefix("err:"), r)
        XCTAssertTrue(gate.config.enabled)
    }

    func testHttpInterceptorPathClosed() async throws {
        let web = try await webView()
        let probe = try Probe()
        defer { probe.stop() }
        let r = try await call(web, "fetch('/_capacitor_http_interceptor_?u=' + encodeURIComponent('http://127.0.0.1:\(probe.port)/yol')).then((x) => x.status)")
        print("OLCUM iOS interceptor sonuc=\(r) dinleyici=\(probe.count)")
        XCTAssertEqual(probe.count, 0, r)
    }
}
