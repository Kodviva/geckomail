import Foundation

enum LoginOutcome {
    case ok(user: [String: Any])
    case failed(String)
}

enum AccessOutcome {
    case ok(token: String, expiresAt: Int64)
    case gone
    /// Oturum boşta: push sürer, giriş istenir. Belirteç durur, çıkış sunucudaki satırı onunla kapatır (Review Focus 1)
    case idle
    case network
}

enum DeviceOutcome: Equatable {
    case ok(id: Int)
    case unavailable
    case failed
    case auth
}

enum ActionOutcome: Equatable {
    case ok
    case auth
    case failed
}

private let loginReasons: Set<String> = ["bad", "locked", "totpRequired", "totpBad", "totpSetupRequired"]
private let refreshMarginMs: Int64 = 60_000

/// Sunucuyla yerel konuşma: Origin taşımaz, belirteç yalnız seçili sunucuya gider
final class SessionApi {
    private let store: SessionStore
    private let origin: () -> String?
    private let session: URLSession
    private let now: () -> Int64
    private let onSignedOut: () -> Void
    private let cache = AccessCache()

    init(store: SessionStore, origin: @escaping () -> String?, session: URLSession = .shared,
         now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }, onSignedOut: @escaping () -> Void = {}) {
        self.store = store
        self.origin = origin
        self.session = session
        self.now = now
        self.onSignedOut = onSignedOut
    }

    func login(username: String, password: String, totp: String?) async -> LoginOutcome {
        var body = ["username": username, "password": password]
        if let totp { body["totp"] = totp }
        guard let r = await post("/api/mobile/login", bearer: nil, json: body) else { return .failed("network") }
        let data = (try? JSONSerialization.jsonObject(with: r.data)) as? [String: Any]
        if r.status == 200, let token = data?["token"] as? String, let user = data?["user"] as? [String: Any] {
            store.saveToken(token)
            await cache.drop()
            return .ok(user: user)
        }
        if let reason = data?["reason"] as? String, loginReasons.contains(reason) { return .failed(reason) }
        return .failed("network")
    }

    func access(force: Bool) async -> AccessOutcome {
        await cache.get(force: force, now: now()) { [self] in await fetchAccess() }
    }

    func dropAccess() async { await cache.drop() }

    private func fetchAccess() async -> AccessOutcome {
        guard let token = store.token() else { return .gone }
        guard let r = await post("/api/mobile/token", bearer: token, json: nil) else { return .network }
        if r.status == 401 {
            if ((try? JSONSerialization.jsonObject(with: r.data)) as? [String: Any])?["reason"] as? String == "idle" { return .idle }
            store.clear()
            onSignedOut() // bitiş yolu ne olursa olsun push anahtarı ve bildirimler gider
            return .gone
        }
        guard r.status == 200, let d = (try? JSONSerialization.jsonObject(with: r.data)) as? [String: Any],
              let access = d["accessToken"] as? String, let at = (d["expiresAt"] as? NSNumber)?.int64Value else { return .network }
        return .ok(token: access, expiresAt: at)
    }

    /// Önce yerel oturum gider, sonra sunucu: ağ yoksa belirteç bekleyen çıkış olarak kalır (Review Focus 2)
    func logout() async {
        if let t = store.token() { store.setPendingLogout(t) }
        store.clear()
        await cache.drop()
        onSignedOut()
        await retryPendingLogout()
    }

    func retryPendingLogout() async {
        guard let t = store.pendingLogout() else { return }
        guard let r = await post("/api/mobile/logout", bearer: t, json: nil) else { return }
        if r.status == 204 || r.status == 401 { _ = store.takePendingLogout() }
    }

    /// Sunucu değişince bekleyen belirteç yeni sunucuya gitmesin: eski adrese bir kez denenir ve bırakılır
    func abandonSession(oldOrigin: String) async {
        let tokens = [store.token(), store.takePendingLogout()].compactMap { $0 }
        store.clearAll()
        await cache.drop()
        onSignedOut()
        for t in tokens { _ = await post("/api/mobile/logout", bearer: t, json: nil, at: oldOrigin) }
    }

    func notifyAction(messageId: Int, action: String) async -> ActionOutcome {
        var force = false
        for _ in 0..<2 {
            let token: String
            switch await access(force: force) {
            case .ok(let t, _): token = t
            case .gone, .idle: return .auth
            case .network: return .failed
            }
            guard let r = await post("/api/notify/action", bearer: token, json: ["messageId": messageId, "action": action]) else { return .failed }
            if r.status != 401 { return (200..<300).contains(r.status) ? .ok : .failed }
            force = true
        }
        return .auth
    }

    /// Yol burada kurulur, JS adres veremez. Dönüş HTTP durumu (0: ağ hatası); 200'de `dest` yazılmıştır
    func downloadAttachment(messageId: Int, attachmentId: Int, to dest: URL) async -> Int {
        guard let root = origin(), let url = URL(string: "\(root)/api/attachment/\(messageId)/\(attachmentId)") else { return 0 }
        var force = false
        for _ in 0..<2 {
            let token: String
            switch await access(force: force) {
            case .ok(let t, _): token = t
            case .gone, .idle: return 401
            case .network: return 0
            }
            var q = URLRequest(url: url, timeoutInterval: 60)
            q.httpShouldHandleCookies = false
            q.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            guard let (tmp, res) = try? await session.download(for: q, delegate: NoRedirect()), let http = res as? HTTPURLResponse else { return 0 }
            if http.statusCode == 401 {
                force = true
                continue
            }
            guard http.statusCode == 200 else { return http.statusCode }
            do {
                try FileManager.default.moveItem(at: tmp, to: dest)
            } catch {
                return 0
            }
            return 200
        }
        return 401
    }

    func registerDevice(env: String, token: String, p256dh: String, auth: String, label: String?) async -> DeviceOutcome {
        var body: [String: Any] = ["platform": "ios", "env": env, "token": token, "p256dh": p256dh, "auth": auth]
        if let label { body["label"] = label }
        var force = false
        for _ in 0..<2 {
            let access: String
            switch await self.access(force: force) {
            case .ok(let t, _): access = t
            case .gone, .idle: return .auth
            case .network: return .failed
            }
            guard let r = await post("/api/mobile/device", bearer: access, json: body) else { return .failed }
            if r.status == 401 {
                force = true
                continue
            }
            if r.status == 200, let d = (try? JSONSerialization.jsonObject(with: r.data)) as? [String: Any], let id = d["id"] as? Int { return .ok(id: id) }
            return r.status == 409 || r.status == 404 ? .unavailable : .failed
        }
        return .auth
    }

    func unregisterDevice(id: Int) async {
        guard case .ok(let access, _) = await access(force: false) else { return }
        _ = await post("/api/push/devices/\(id)", bearer: access, json: nil, method: "DELETE")
    }

    private func post(_ path: String, bearer: String?, json: [String: Any]?, at base: String? = nil, method: String = "POST") async -> (status: Int, data: Data)? {
        guard let root = base ?? origin(), let url = URL(string: root + path) else { return nil }
        var q = URLRequest(url: url, timeoutInterval: 20)
        q.httpMethod = method
        q.httpShouldHandleCookies = false
        if let bearer { q.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        if let json {
            q.setValue("application/json", forHTTPHeaderField: "Content-Type")
            q.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        guard let (data, res) = try? await session.data(for: q), let http = res as? HTTPURLResponse else { return nil }
        return (http.statusCode, data)
    }
}

/// Belirteç başka adrese taşınmaz
private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Erişim belirteci önbelleği: eşzamanlı çağrılar tek isteğe düşer
private actor AccessCache {
    private var token: String?
    private var expiresAt: Int64 = 0
    private var inflight: Task<AccessOutcome, Never>?
    private var epoch = 0

    func get(force: Bool, now: Int64, load: @escaping @Sendable () async -> AccessOutcome) async -> AccessOutcome {
        if let inflight { return await inflight.value }
        if !force, let token, now < expiresAt - refreshMarginMs { return .ok(token: token, expiresAt: expiresAt) }
        let mine = epoch
        let task = Task { await load() }
        inflight = task
        let r = await task.value
        inflight = nil
        guard mine == epoch else { return .network } // kilit ya da çıkış sürmekte olan yenilemeyi geçersiz kılar
        if case .ok(let t, let at) = r {
            token = t
            expiresAt = at
        } else {
            token = nil
            expiresAt = 0
        }
        return r
    }

    func drop() {
        epoch += 1
        token = nil
        expiresAt = 0
        inflight = nil
    }
}
