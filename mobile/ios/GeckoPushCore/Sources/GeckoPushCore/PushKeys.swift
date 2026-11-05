import CryptoKit
import Foundation
import Security

public protocol PushKeyStorage {
    func read() -> Data?
    func write(_ d: Data) -> Bool
    func remove()
}

/// Paylaşılan erişim grubu yalnız push anahtarını tutar: NSE şifre çözer, oturum belirtecini göremez
public struct KeychainPushKeyStorage: PushKeyStorage {
    public var group: String?
    private let service = "com.kodviva.geckomail.push"

    public init(group: String?) {
        self.group = group
    }

    private var query: [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "key"]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    public func read() -> Data? {
        var q = query
        q[kSecReturnData as String] = true
        var out: AnyObject?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    public func write(_ d: Data) -> Bool {
        remove()
        var q = query
        q[kSecValueData as String] = d
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        q[kSecAttrSynchronizable as String] = false
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    public func remove() {
        SecItemDelete(query as CFDictionary)
    }
}

public enum PushKeysError: Error { case storage }

public struct PushKeys {
    /// Uygulama ve NSE açılışta paylaşılan grubu verir
    public static var storage: PushKeyStorage = KeychainPushKeyStorage(group: nil)

    /// Bundle Info.plist `GeckoKeychainPrefix` = $(AppIdentifierPrefix); uygulama ve NSE açılışta çağırır
    public static func useSharedGroup(bundle: Bundle = .main) {
        let prefix = bundle.object(forInfoDictionaryKey: "GeckoKeychainPrefix") as? String ?? ""
        storage = KeychainPushKeyStorage(group: prefix + "com.kodviva.geckomail.push")
    }

    private static let privateBytes = 32
    private static let authBytes = 16

    public let privateKey: P256.KeyAgreement.PrivateKey
    public let authSecret: Data

    public init(privateKey: P256.KeyAgreement.PrivateKey, authSecret: Data) {
        self.privateKey = privateKey
        self.authSecret = authSecret
    }

    public var p256dh: String { privateKey.publicKey.x963Representation.base64URL }
    public var auth: String { authSecret.base64URL }

    /// NSE anahtar üretmez: kayıtsız cihazda yeni anahtar hiçbir şeyi çözemez
    public static func load() -> PushKeys? {
        guard let d = storage.read(), d.count == privateBytes + authBytes,
              let key = try? P256.KeyAgreement.PrivateKey(rawRepresentation: d.prefix(privateBytes)) else { return nil }
        return PushKeys(privateKey: key, authSecret: Data(d.suffix(authBytes)))
    }

    public static func loadOrCreate() throws -> PushKeys {
        if let k = load() { return k }
        let key = P256.KeyAgreement.PrivateKey()
        var secret = Data(count: authBytes)
        let ok = secret.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, authBytes, $0.baseAddress!) } == errSecSuccess
        guard ok, storage.write(key.rawRepresentation + secret) else { throw PushKeysError.storage }
        return PushKeys(privateKey: key, authSecret: secret)
    }

    public static func delete() {
        storage.remove()
    }
}
