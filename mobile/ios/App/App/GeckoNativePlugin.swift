import Capacitor
import Foundation
import UserNotifications

/// JS yüzeyi. Uzun ömürlü oturum belirteci hiçbir yöntemden dönmez; erişim belirteci yalnız kilit açıkken verilir (T14).
@objc(GeckoNativePlugin)
public class GeckoNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GeckoNativePlugin"
    public let jsName = "GeckoNative"
    public let pluginMethods: [CAPPluginMethod] = [
        "getServer", "setServer", "login", "accessToken", "logout", "registerPush", "unregisterPush", "pushStatus",
        "biometricAvailable", "promptBiometric", "getLock", "setLock", "openAttachment", "saveBytes", "takePending", "sharesDone"
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    private var s: AppServices { .shared }
    private var faceIdReason: String { NSLocalizedString("mobile.faceid.reason", comment: "") }

    @objc func getServer(_ call: CAPPluginCall) {
        if let origin = s.origin { call.resolve(["origin": origin]) } else { call.resolve(["origin": NSNull()]) }
    }

    @objc func setServer(_ call: CAPPluginCall) {
        guard let origin = call.getString("origin"), isAllowedServer(origin) else { return call.reject("origin") }
        let old = s.origin
        s.origin = origin
        guard let old, old != origin else { return call.resolve() }
        Task {
            await s.api.abandonSession(oldOrigin: old)
            call.resolve()
        }
    }

    @objc func login(_ call: CAPPluginCall) {
        guard let username = call.getString("username"), let password = call.getString("password") else { return call.reject("invalid") }
        Task {
            switch await s.api.login(username: username, password: password, totp: call.getString("totp")) {
            case .ok(let user):
                s.pushLogin.signedIn(userId: (user["id"] as? NSNumber)?.intValue ?? 0)
                await s.pushLogin.reregister()
                call.resolve(["ok": true, "user": user])
            case .failed(let reason): call.resolve(["ok": false, "reason": reason])
            }
        }
    }

    @objc func accessToken(_ call: CAPPluginCall) {
        Task {
            if s.lock.isLocked() {
                await s.api.dropAccess()
                return call.resolve(["status": "locked"])
            }
            let r = await s.api.access(force: call.getBool("force") ?? false)
            if s.lock.isLocked() { // yenileme sürerken kilitlendi
                await s.api.dropAccess()
                return call.resolve(["status": "locked"])
            }
            switch r {
            case .ok(let token, let expiresAt): call.resolve(["status": "ok", "token": token, "expiresAt": expiresAt])
            case .gone, .idle: call.resolve(["status": "gone"]) // arayüz için ikisi de giriş ekranı
            case .network: call.resolve(["status": "network"])
            }
        }
    }

    @objc func logout(_ call: CAPPluginCall) {
        Task {
            await s.api.logout()
            call.resolve()
        }
    }

    @objc func registerPush(_ call: CAPPluginCall) {
        Task {
            let center = UNUserNotificationCenter.current()
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            guard granted else { return call.resolve(["status": "denied"]) }
            guard let token = await PushCenter.shared.deviceToken() else { return call.resolve(["status": "failed"]) }
            switch await s.syncDevice(token: token) {
            case .ok: call.resolve(["status": "on"])
            case .unavailable: call.resolve(["status": "unavailable"])
            case .failed, .auth: call.resolve(["status": "failed"])
            }
        }
    }

    @objc func unregisterPush(_ call: CAPPluginCall) {
        Task {
            await s.disablePush()
            call.resolve()
        }
    }

    @objc func pushStatus(_ call: CAPPluginCall) {
        Task {
            let denied = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus == .denied
            call.resolve(["status": denied ? "denied" : s.pushEnabled ? "on" : "off"])
        }
    }

    @objc func biometricAvailable(_ call: CAPPluginCall) { call.resolve(["available": s.auth.available()]) }

    @objc func promptBiometric(_ call: CAPPluginCall) {
        let reason = call.getString("reason") ?? faceIdReason
        Task {
            let ok = await authenticate(gate: s.lock, auth: s.auth, reason: reason)
            call.resolve(["ok": ok])
        }
    }

    @objc func getLock(_ call: CAPPluginCall) {
        let c = s.lock.config
        call.resolve(["enabled": c.enabled, "timeoutMs": c.timeoutMs, "locked": s.lock.isLocked(), "uptimeMs": s.lock.uptimeMs])
    }

    @objc func setLock(_ call: CAPPluginCall) {
        guard let enabled = call.getBool("enabled"), let timeoutMs = call.getInt("timeoutMs") else { return call.reject("invalid") }
        Task {
            let done = await App.setLock(LockConfig(enabled: enabled, timeoutMs: timeoutMs), gate: s.lock, auth: s.auth, reason: faceIdReason)
            if done { call.resolve() } else { call.reject("denied") }
        }
    }

    /// Yol ve sunucu yerelde kurulur, istekten adres alınmaz (T4)
    @objc func openAttachment(_ call: CAPPluginCall) {
        guard let messageId = call.getInt("messageId"), let attachmentId = call.getInt("attachmentId"), messageId > 0, attachmentId > 0 else { return call.reject("invalid") }
        if s.lock.isLocked() { return call.reject("locked") }
        let file = s.attachments.newFile(name: call.getString("name") ?? "")
        Task {
            let status = await s.api.downloadAttachment(messageId: messageId, attachmentId: attachmentId, to: file)
            guard status == 200 else { return call.reject("status:\(status)") }
            if s.lock.isLocked() { // indirme sürerken kilitlendi
                try? FileManager.default.removeItem(at: file)
                return call.reject("locked")
            }
            await MainActor.run {
                guard let vc = self.bridge?.viewController else { return call.reject("noApp") }
                AttachmentPreview.present(file, from: vc)
                call.resolve()
            }
        }
    }

    /// Dışa aktarma paylaşım sayfasıyla: kullanıcı nereye kaydedeceğini kendisi seçer
    @objc func saveBytes(_ call: CAPPluginCall) {
        guard let b64 = call.getString("base64"), let data = Data(base64Encoded: b64) else { return call.resolve(["ok": false]) }
        let file = s.attachments.newFile(name: call.getString("name") ?? "")
        guard (try? data.write(to: file)) != nil else { return call.resolve(["ok": false]) }
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else { return call.resolve(["ok": false]) }
            AttachmentPreview.share(file, from: vc) { call.resolve(["ok": $0]) }
        }
    }

    @objc func takePending(_ call: CAPPluginCall) {
        let shares: [[String: Any]] = (s.inbox?.take() ?? []).map { share in
            let files: [[String: Any]] = share.files.map { f in
                let path = f.url.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? f.url.path
                return ["name": f.name, "uploadPath": "/_capacitor_file_" + path, "mime": f.mime ?? NSNull()]
            }
            return ["files": files, "text": share.text ?? NSNull(), "skipped": share.skipped]
        }
        call.resolve(["opens": PushCenter.shared.takeOpens(), "shares": shares])
    }

    @objc func sharesDone(_ call: CAPPluginCall) {
        s.inbox?.finish()
        call.resolve()
    }

    override public func load() {
        PushCenter.shared.onOpen = { [weak self] in self?.notifyListeners("open", data: $0, retainUntilConsumed: true) }
        s.onShare = { [weak self] in self?.notifyListeners("share", data: [:], retainUntilConsumed: true) }
    }

    private func isAllowedServer(_ origin: String) -> Bool {
        guard let u = URLComponents(string: origin), u.host != nil, u.path.isEmpty, u.query == nil, u.user == nil else { return false }
        #if DEBUG
        if u.scheme == "http", u.host == "localhost" || u.host == "127.0.0.1" { return true }
        #endif
        return u.scheme == "https"
    }
}
