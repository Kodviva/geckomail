import GeckoPushCore
import LocalAuthentication
import Network
import UIKit
import UserNotifications

/// Eklenti ve sonraki görevlerin bildirim yolu aynı oturumu paylaşır
final class AppServices {
    static let shared = AppServices()

    let store = SessionStore()
    let lock = LockGate()
    var auth: Authenticating = SystemAuthenticator()
    private(set) lazy var api = SessionApi(store: store, origin: { [weak self] in self?.origin }, onSignedOut: { [weak self] in self?.signedOut() })
    private(set) lazy var pushLogin = PushLogin(
        defaults: .standard, enabled: { [weak self] in self?.pushEnabled == true }, token: { [weak self] in self?.pushToken },
        rotate: {
            PushKeys.delete()
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        },
        userChanged: { [weak self] in self?.wipeUserFiles() },
        sync: { [weak self] token in await self?.syncDevice(token: token) ?? .failed },
        unregister: { [weak self] id in await self?.api.unregisterDevice(id: id) ?? false })
    private let monitor = NWPathMonitor()
    let attachments = AttachmentCache(root: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("attachments"))
    let inbox = ShareInbox.shared()
    /// Eklenti bağlıysa arayüze haber verilir; değilse paylaşım takePending ile alınır
    var onShare: (() -> Void)?

    private let originKey = "gecko.server"
    var origin: String? {
        get { UserDefaults.standard.string(forKey: originKey) }
        set { UserDefaults.standard.set(newValue, forKey: originKey) }
    }

    private let pushEnabledKey = "gecko.push.enabled"
    private let pushTokenKey = "gecko.push.token"
    private let pushDeviceKey = "gecko.push.device"
    var pushEnabled: Bool { UserDefaults.standard.bool(forKey: pushEnabledKey) }
    var pushToken: String? { UserDefaults.standard.string(forKey: pushTokenKey) }
    /// Çıkış sürmekte olan kaydı geçersiz kılar: geç gelen yanıt push'u geri açmaz
    private var pushEpoch = 0

    private func wipeUserFiles() {
        attachments.clear()
        inbox?.clear()
    }

    private func signedOut() {
        pushLogin.forget()
        clearPush()
        wipeUserFiles()
        lock.signedOut()
    }

    /// Push anahtarı gider: gelen kutular çözülemez, nötr metin gösterilir. Son kullanıcı kalır: başkası girerse eski verisi silinir
    private func clearPush() {
        pushEpoch += 1
        pushLogin.clearPending()
        let d = UserDefaults.standard
        [pushEnabledKey, pushTokenKey, pushDeviceKey].forEach(d.removeObject(forKey:))
        PushKeys.delete()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }

    private var apnsEnv: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    @discardableResult
    func syncDevice(token: String) async -> DeviceOutcome {
        guard let keys = try? PushKeys.loadOrCreate() else { return .failed }
        let label = await UIDevice.current.model
        let mine = pushEpoch
        // başarısız kayıt da yeni jetonu tutar: oturum gelince ya da ağ dönünce bekleyen iş bunu bildirir (Android ile aynı)
        if pushEnabled { UserDefaults.standard.set(token, forKey: pushTokenKey) }
        let r = await api.registerDevice(env: apnsEnv, token: token, p256dh: keys.p256dh, auth: keys.auth, label: label)
        guard mine == pushEpoch else { return r }
        if case .ok(let id) = r {
            let d = UserDefaults.standard
            d.set(true, forKey: pushEnabledKey)
            d.set(token, forKey: pushTokenKey)
            d.set(id, forKey: pushDeviceKey)
            pushLogin.registered()
        }
        return r
    }

    func disablePush() async {
        let id = UserDefaults.standard.integer(forKey: pushDeviceKey)
        await pushLogin.queueUnregister(id: id)
        clearPush()
    }

    /// Bekleyen paylaşım başka kullanıcıya kalmaz: 24 saatte silinir
    private func sweepFiles() {
        DispatchQueue.global(qos: .utility).async { [self] in
            attachments.purge()
            inbox?.sweep()
        }
    }

    /// Paylaşım eklentisi uygulamayı açamadıysa da etkinleşince görülür
    func checkShares() {
        if inbox?.hasPending() == true { onShare?() }
    }

    func start() {
        store.wipeIfFreshInstall()
        sweepFiles()
        PushKeys.useSharedGroup()
        PushCenter.shared.start()
        if pushEnabled { requestTokenIfAllowed() }
        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.lock.didEnterBackground()
            if self.lock.isLocked() { Task { await self.api.dropAccess() } }
        }
        center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.lock.didBecomeForeground()
            self?.sweepFiles()
            guard let self else { return }
            if self.pushEnabled, self.pushLogin.refreshDue() { self.requestTokenIfAllowed() }
            Task {
                await self.pushLogin.retryUnregister()
                await self.pushLogin.retry()
            }
        }
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied, let self else { return }
            Task {
                await self.api.retryPendingLogout()
                await self.pushLogin.retryUnregister()
                await self.pushLogin.retry()
            }
        }
        monitor.start(queue: .global(qos: .utility))
    }

    /// Jeton yalnız bildirim izni varken istenir: izin sonradan geri alındıysa kurulum APNs'e kaydolmaz
    private func requestTokenIfAllowed() {
        Task {
            let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            guard pushTokenAllowed(status) else { return }
            await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
        }
    }
}

func pushTokenAllowed(_ status: UNAuthorizationStatus) -> Bool {
    status == .authorized || status == .provisional || status == .ephemeral
}

/// Push kaydının girişe bağlı kuralları (Android: DeviceRegistrar)
final class PushLogin {
    private let userKey = "gecko.push.user"
    private let pendingKey = "gecko.push.pending"
    private let registeredAtKey = "gecko.push.registeredAt"
    private let pendingUnregisterKey = "gecko.push.pendingUnregister"
    /// Röle motor başına saatte 60 kayıt kabul eder: yenileme günde en çok bir kez
    private let refreshInterval: TimeInterval = 86_400
    private let defaults: UserDefaults
    private let enabled: () -> Bool
    private let token: () -> String?
    private let rotate: () -> Void
    private let userChanged: () -> Void
    private let sync: (String) async -> DeviceOutcome
    private let unregister: (Int) async -> Bool
    private let now: () -> Date

    init(defaults: UserDefaults, enabled: @escaping () -> Bool, token: @escaping () -> String?, rotate: @escaping () -> Void,
         userChanged: @escaping () -> Void, sync: @escaping (String) async -> DeviceOutcome,
         unregister: @escaping (Int) async -> Bool = { _ in true }, now: @escaping () -> Date = Date.init) {
        self.defaults = defaults
        self.enabled = enabled
        self.token = token
        self.rotate = rotate
        self.userChanged = userChanged
        self.sync = sync
        self.unregister = unregister
        self.now = now
    }

    /// Giriş kaydından önce çağrılır. Başka kullanıcı girdiyse önceki kullanıcının görünen bildirimleri ve push anahtarı gider,
    /// bildirim tercihi kalır: sonraki kayıt yeni anahtarı bildirir. Aynı kullanıcıda hiçbir şey değişmez.
    /// Önceki kullanıcı biliniyorsa (boşta kalmış oturum) bekleyen paylaşımları ve ek önbelleği de gider; çıkıştan sonra
    /// yapılan paylaşım kimsenin değildir, kalır
    func signedIn(userId: Int) {
        let last = defaults.object(forKey: userKey) as? Int
        defaults.set(userId, forKey: userKey)
        guard last != userId else { return }
        rotate()
        if last != nil { userChanged() }
    }

    /// Yeniden girişte aynı cihaz yeni oturuma geçer (Görev 3 reregister after idle). Bekleme denemeden önce yazılır:
    /// süreç deneme sırasında ölse de sonraki açılış tamamlar
    func reregister() async {
        guard enabled(), token() != nil else { return }
        defaults.set(true, forKey: pendingKey)
        await retry()
    }

    /// Ağ hatasında bekleme sürer; röle kapalıysa yeniden denemenin anlamı yok. Oturum yoksa sıradaki giriş yine kaydeder
    func retry() async {
        guard defaults.bool(forKey: pendingKey) else { return }
        guard enabled(), let token = token() else { return defaults.removeObject(forKey: pendingKey) }
        switch await sync(token) {
        case .ok, .unavailable: defaults.removeObject(forKey: pendingKey)
        case .failed, .auth: break
        }
    }

    func clearPending() {
        defaults.removeObject(forKey: pendingKey)
    }

    /// Sunucu satırı silmiş olabilir (röle `gone`, süresi dolan kayıt): bildirim açıksa kayıt günde en çok bir kez yinelenir.
    /// Saat geri alındıysa da yenilenir
    func refreshDue() -> Bool {
        let last = defaults.object(forKey: registeredAtKey) as? Date ?? .distantPast
        let since = now().timeIntervalSince(last)
        return since < 0 || since >= refreshInterval
    }

    /// Her jeton geldiğinde çağrılır: değişmediyse ve zamanı gelmediyse sunucuya gidilmez
    func refresh(token fresh: String) async {
        guard enabled(), fresh != token() || refreshDue() else { return }
        defaults.set(true, forKey: pendingKey)
        switch await sync(fresh) {
        case .ok, .unavailable: defaults.removeObject(forKey: pendingKey)
        case .failed, .auth: break
        }
    }

    /// Başarılı kayıttan sonra: zaman yazılır, bildirim yeniden açıldıysa bekleyen silme düşer
    func registered() {
        defaults.set(now(), forKey: registeredAtKey)
        defaults.removeObject(forKey: pendingUnregisterKey)
    }

    /// Bekleme denemeden önce yazılır: ağ yoksa ya da süreç ölürse satır sonraki açılışta silinir
    func queueUnregister(id: Int) async {
        if id > 0 { defaults.set(id, forKey: pendingUnregisterKey) }
        await retryUnregister()
    }

    func retryUnregister() async {
        let id = defaults.integer(forKey: pendingUnregisterKey)
        guard id > 0, await unregister(id), defaults.integer(forKey: pendingUnregisterKey) == id else { return }
        defaults.removeObject(forKey: pendingUnregisterKey)
    }

    /// Yalnız gerçek çıkışta: bildirimi kapatmak son kullanıcıyı unutturmaz
    func forget() {
        defaults.removeObject(forKey: userKey)
        clearPending()
    }
}

/// Cihaz parolası da kabul edilir: biyometrisi olmayan cihazda kilit yine çalışır
final class SystemAuthenticator: Authenticating {
    func available() -> Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    func prompt(reason: String) async -> Bool {
        (try? await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) == true
    }
}
