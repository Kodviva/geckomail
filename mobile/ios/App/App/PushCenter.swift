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
final class PushCenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushCenter(actions: { AppServices.shared.api }, posting: SystemPosting(), limit: 25, locked: { AppServices.shared.lock.isLocked() })

    private static let readId = "gecko.action.read"
    private static let archiveId = "gecko.action.archive"
    private static let replyId = "gecko.action.reply"
    private static let tokenWaitNs: UInt64 = 15_000_000_000

    private let actions: () -> ActionPoster
    private let posting: NotificationPosting
    private let limit: TimeInterval
    private let locked: () -> Bool
    private let guardLock = NSLock()
    private var opens: [[String: Any]] = []
    private var tokenWaiters: [(String?) -> Void] = []
    /// Eklenti bağlıyken yeni açılış olayı
    var onOpen: (([String: Any]) -> Void)?

    init(actions: @escaping () -> ActionPoster, posting: NotificationPosting, limit: TimeInterval, locked: @escaping () -> Bool) {
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

    /// Süre dolarsa tamamlanır: istek arkada sürse de sistem beklemez
    private func post(messageId: Int, action: String, id: String) async {
        let poster = actions()
        let posting = posting
        let limit = limit
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                switch await poster.notifyAction(messageId: messageId, action: action) {
                case .ok: posting.removeDelivered(id)
                case .auth: posting.showRelogin()
                case .failed: break
                }
            }
            group.addTask { try? await Task.sleep(nanoseconds: UInt64(limit * 1_000_000_000)) }
            await group.next()
            group.cancelAll()
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

    func deviceToken() async -> String? {
        await withTaskGroup(of: String?.self) { group in
            group.addTask { await self.awaitToken() }
            group.addTask {
                try? await Task.sleep(nanoseconds: Self.tokenWaitNs)
                return nil
            }
            let r = await group.next() ?? nil
            group.cancelAll()
            return r
        }
    }

    private func awaitToken() async -> String? {
        await withCheckedContinuation { c in
            guardLock.lock()
            tokenWaiters.append { c.resume(returning: $0) }
            guardLock.unlock()
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    /// AppDelegate'ten; nil: kayıt başarısız. Jeton değişti ve bildirim açıksa sunucuya yeniden bildirilir
    func tokenArrived(_ token: String?) {
        guardLock.lock()
        let waiting = tokenWaiters
        tokenWaiters = []
        guardLock.unlock()
        waiting.forEach { $0(token) }
        let s = AppServices.shared
        guard let token, waiting.isEmpty, s.pushEnabled, token != s.pushToken else { return }
        Task { await s.syncDevice(token: token) }
    }
}
