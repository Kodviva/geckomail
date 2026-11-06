import GeckoPushCore
import UIKit
import UserNotifications

protocol ActionPoster {
    func notifyAction(messageId: Int, action: String) async -> ActionOutcome
}

extension SessionApi: ActionPoster {}

protocol NotificationPosting {
    func removeDelivered(_ id: String)
    func showRelogin()
    func showLocked()
}

private struct SystemPosting: NotificationPosting {
    func removeDelivered(_ id: String) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [id])
    }

    /// Bildirim eylemi oturum bulamadı: dokunmak uygulamayı açar, giriş orada istenir
    func showRelogin() { show("mobile.push.relogin") }

    /// Eylem kilit yüzünden yapılmadı. Arka plan eylemi uygulamayı öne getiremez: dokunmak açar, Android API 31+ ile aynı
    func showLocked() { show("mobile.lock.title") }

    private func show(_ key: String) {
        let c = UNMutableNotificationContent()
        c.body = NSLocalizedString(key, comment: "")
        c.categoryIdentifier = "gecko.none"
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
    }
}

/// Kategoriler, bildirim eylemleri ve cihaz kaydı. `read`/`archive` arka planda yerel oturumla gider, tamamlama 25 sn içinde çağrılır.
final class PushCenter: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let shared = PushCenter(actions: { AppServices.shared.api }, posting: SystemPosting(), limit: 25, locked: { AppServices.shared.lock.isLocked() })

    private static let readId = "gecko.action.read"
    private static let archiveId = "gecko.action.archive"
    private static let replyId = "gecko.action.reply"

    private let actions: () -> ActionPoster
    private let posting: NotificationPosting
    private let limit: TimeInterval
    private let locked: () -> Bool
    private let guardLock = NSLock()
    private var opens: [[String: Any]] = []
    private var tokenWaiters: [UUID: (String?) -> Void] = [:]
    private let tokenWait: TimeInterval
    private let requestToken: () -> Void
    /// Eklenti bağlıyken yeni açılış olayı
    var onOpen: (([String: Any]) -> Void)?

    init(actions: @escaping () -> ActionPoster, posting: NotificationPosting, limit: TimeInterval, locked: @escaping () -> Bool, tokenWait: TimeInterval = 15,
         requestToken: @escaping () -> Void = { UIApplication.shared.registerForRemoteNotifications() }) {
        self.tokenWait = tokenWait
        self.requestToken = requestToken
        self.actions = actions
        self.posting = posting
        self.limit = limit
        self.locked = locked
    }

    static func categories() -> Set<UNNotificationCategory> {
        func text(_ k: String) -> String { NSLocalizedString(k, comment: "") }
        let read = UNNotificationAction(identifier: readId, title: text("sync.notify.action.read"), options: [.authenticationRequired])
        let archive = UNNotificationAction(identifier: archiveId, title: text("sync.notify.action.archive"), options: [.destructive, .authenticationRequired])
        let reply = UNNotificationAction(identifier: replyId, title: text("sync.notify.action.reply"), options: [.foreground])
        func category(_ id: String, _ a: [UNNotificationAction]) -> UNNotificationCategory {
            UNNotificationCategory(identifier: id, actions: a, intentIdentifiers: [])
        }
        return [category("gecko.none", []), category("gecko.read", [read]), category("gecko.full", [read, archive, reply])]
    }

    func start() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(Self.categories())
    }

    func process(action: String, id: String, info: [AnyHashable: Any]) async {
        let messageId = info["messageId"] as? Int
        switch action {
        case Self.readId, Self.archiveId:
            guard let messageId else { return }
            if locked() { return posting.showLocked() } // kilit LockGate'ten: arka plan eylemi kilidi aşmaz
            await post(messageId: messageId, action: action == Self.readId ? "read" : "archive", id: id)
        case Self.replyId, UNNotificationDefaultActionIdentifier:
            guard messageId != nil || info["accountId"] != nil else { return }
            deliver(["messageId": messageId ?? NSNull(), "accountId": info["accountId"] as? Int ?? NSNull(), "reply": action == Self.replyId])
        default:
            break
        }
    }

    private func deliver(_ open: [String: Any]) {
        guardLock.lock()
        let live = onOpen
        if live == nil { opens.append(open) }
        guardLock.unlock()
        live?(open)
    }

    /// Dış bağlantı: geçersizse hiçbir şey olmaz (T10)
    @discardableResult
    func openLink(_ url: URL) -> Bool {
        guard let r = parseDeepLink(url) else { return false }
        deliver(["messageId": r.messageId, "accountId": NSNull(), "reply": r.reply])
        return true
    }

    /// Süre dolarsa tamamlanır: istek arkada sürse de sistem beklemez. Görev grubu çocuklarını beklerdi, iptali dinlemeyen iş süreyi aşardı
    private func post(messageId: Int, action: String, id: String) async {
        let poster = actions()
        let posting = posting
        let limit = limit
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let finish = Once { c.resume() }
            let work = Task {
                switch await poster.notifyAction(messageId: messageId, action: action) {
                case .ok: posting.removeDelivered(id)
                case .auth: posting.showRelogin()
                case .failed: break
                }
                finish.run()
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + limit) {
                work.cancel()
                finish.run()
            }
        }
    }

    func takeOpens() -> [[String: Any]] {
        guardLock.lock()
        defer { guardLock.unlock() }
        let out = opens
        opens = []
        return out
    }

    /// async temsilci sürümleri kullanılmaz: tamamlama ana iş parçacığı dışında çağrılır, UIKit süreci düşürür
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        DispatchQueue.main.async {
            completionHandler(UIApplication.shared.applicationState == .active ? [] : [.banner, .list, .sound])
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let n = response.notification.request
        handle(action: response.actionIdentifier, id: n.identifier, info: n.content.userInfo, completion: completionHandler)
    }

    func handle(action: String, id: String, info: [AnyHashable: Any], completion: @escaping () -> Void) {
        Task {
            await process(action: action, id: id, info: info)
            DispatchQueue.main.async(execute: completion)
        }
    }

    // MARK: Cihaz belirteci

    /// Süre dolunca nil: bekleme kaydı yanıtla ya da süreyle bir kez çıkar, APNs hiç dönmese de registerPush biter
    func deviceToken() async -> String? {
        await withCheckedContinuation { (c: CheckedContinuation<String?, Never>) in
            let id = UUID()
            guardLock.lock()
            tokenWaiters[id] = { c.resume(returning: $0) }
            guardLock.unlock()
            DispatchQueue.main.async(execute: requestToken)
            DispatchQueue.global().asyncAfter(deadline: .now() + tokenWait) { [self] in
                guardLock.lock()
                let expired = tokenWaiters.removeValue(forKey: id)
                guardLock.unlock()
                expired?(nil)
            }
        }
    }

    /// AppDelegate'ten; nil: kayıt başarısız. Bildirim açıksa jeton değişince ya da günlük yenileme zamanı gelince sunucuya bildirilir
    func tokenArrived(_ token: String?) {
        guardLock.lock()
        let waiting = tokenWaiters
        tokenWaiters = [:]
        guardLock.unlock()
        waiting.values.forEach { $0(token) }
        guard let token, waiting.isEmpty else { return }
        Task { await AppServices.shared.pushLogin.refresh(token: token) }
    }
}

/// Tamamlama iki yoldan gelebilir (iş ve süre): yalnız ilki çalışır
private final class Once {
    private let lock = NSLock()
    private var body: (() -> Void)?

    init(_ body: @escaping () -> Void) { self.body = body }

    func run() {
        lock.lock()
        let b = body
        body = nil
        lock.unlock()
        b?()
    }
}
