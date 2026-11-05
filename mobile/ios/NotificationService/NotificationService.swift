import Foundation
import GeckoPushCore
import UserNotifications

/// Rölenin opak kutusunu cihaz anahtarıyla çözer. Çözülemezse (anahtar değişti, bozuk kutu, süre doldu) nötr metin gösterilir;
/// şifreli metin ya da boş bildirim hiçbir yolda çıkmaz.
class NotificationService: UNNotificationServiceExtension {
    var keys: () -> PushKeys? = {
        PushKeys.useSharedGroup()
        return PushKeys.load()
    }

    private let guardLock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        guard let c = request.content.mutableCopy() as? UNMutableNotificationContent else { return contentHandler(request.content) }
        guardLock.lock()
        handler = contentHandler
        content = c
        guardLock.unlock()
        let box = request.content.userInfo["c"] as? String
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            let payload = decode(box)
            finish { fresh in
                if let payload { NotificationContentBuilder.apply(payload, to: fresh) } else { NotificationContentBuilder.applyFallback(to: fresh) }
            }
        }
    }

    override func serviceExtensionTimeWillExpire() {
        finish { NotificationContentBuilder.applyFallback(to: $0) }
    }

    private func decode(_ box: String?) -> NativePayload? {
        guard let box, let body = Data(base64URL: box), let k = keys(),
              let plain = try? PushCrypto.decrypt(body, privateKey: k.privateKey, auth: k.authSecret) else { return nil }
        return try? NotificationContentBuilder.decode(plain)
    }

    /// İlk gelen teslim eder: süre dolduktan sonra biten çözme ikinci kez çağırmaz
    private func finish(_ fill: (UNMutableNotificationContent) -> Void) {
        guardLock.lock()
        let h = handler
        let c = content
        handler = nil
        content = nil
        guardLock.unlock()
        guard let h, let c else { return }
        fill(c)
        h(c)
    }
}
