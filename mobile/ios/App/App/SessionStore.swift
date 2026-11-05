import Foundation
import Security

/// Uzun ömürlü mobil oturum belirteci yalnız burada, JS'e hiç verilmez. Erişim grubu belirtilmez: varsayılan grup uygulamaya
/// özeldir, NSE görmez. Görev 8'de entitlement listesinde uygulama grubu paylaşılan gruptan önce gelmelidir.
final class SessionStore {
    private let service: String
    private let defaults: UserDefaults
    private let installedKey = "gecko.installed"

    init(service: String = "com.kodviva.geckomail.session", defaults: UserDefaults = .standard) {
        self.service = service
        self.defaults = defaults
    }

    /// iOS Keychain uygulama silinince kalır, UserDefaults kalmaz: önceki kurulumun belirteci yeni kurulumda çalışmasın (T11)
    func wipeIfFreshInstall() {
        guard !defaults.bool(forKey: installedKey) else { return }
        clearAll()
        defaults.set(true, forKey: installedKey)
    }

    func saveToken(_ t: String) { write("session", t) }
    func token() -> String? { read("session") }
    func clear() { remove("session") }

    func setPendingLogout(_ t: String) { write("pendingLogout", t) }
    func pendingLogout() -> String? { read("pendingLogout") }

    func takePendingLogout() -> String? {
        let t = pendingLogout()
        remove("pendingLogout")
        return t
    }

    func clearAll() {
        remove("session")
        remove("pendingLogout")
    }

    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    private func write(_ account: String, _ value: String) {
        remove(account)
        var q = query(account)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        q[kSecAttrSynchronizable as String] = false
        SecItemAdd(q as CFDictionary, nil)
    }

    private func read(_ account: String) -> String? {
        var q = query(account)
        q[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    private func remove(_ account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }
}
