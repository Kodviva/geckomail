import Foundation
import UserNotifications

public enum PayloadError: Error { case unsupported }

public enum NotificationContentBuilder {
    public static func decode(_ json: Data) throws -> NativePayload {
        let p = try JSONDecoder().decode(NativePayload.self, from: json)
        guard p.v == 1, p.level == "normal" || p.level == "urgent" else { throw PayloadError.unsupported }
        return p
    }

    public static func apply(_ p: NativePayload, to c: UNMutableNotificationContent) {
        c.title = p.title
        c.body = p.body
        let urgent = p.level == "urgent"
        c.interruptionLevel = urgent ? .timeSensitive : .active
        c.relevanceScore = urgent ? 1.0 : 0.5
        c.threadIdentifier = p.accountId.map { "acct-\($0)" } ?? "summary"
        c.categoryIdentifier = categoryIdentifier(for: p.actions)
        var info: [String: Any] = [:]
        if let id = p.messageId { info["messageId"] = id }
        if let id = p.accountId { info["accountId"] = id }
        c.userInfo = info
    }

    /// Şifreli metin ya da boş bildirim gösterilmez
    public static func applyFallback(to c: UNMutableNotificationContent) {
        c.title = ""
        c.subtitle = ""
        c.body = NSLocalizedString("PUSH_FALLBACK", comment: "")
        c.categoryIdentifier = categoryIdentifier(for: [])
        c.threadIdentifier = "summary"
        c.userInfo = [:]
    }
}

/// Üye başka hesapta yalnız `read` alabilir; `reply` tek başına kategori açmaz (sunucu her zaman `read` ile yollar)
public func categoryIdentifier(for actions: [String]) -> String {
    if actions.contains("archive") { return "gecko.full" }
    return actions.contains("read") ? "gecko.read" : "gecko.none"
}
