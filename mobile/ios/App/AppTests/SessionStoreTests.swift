import Security
import XCTest
@testable import App

final class SessionStoreTests: XCTestCase {
    private let service = "com.kodviva.geckomail.tests"
    private var defaults: UserDefaults!
    private var store: SessionStore!

    override func setUp() {
        defaults = UserDefaults(suiteName: "SessionStoreTests")
        defaults.removePersistentDomain(forName: "SessionStoreTests")
        store = SessionStore(service: service, defaults: defaults)
        store.clearAll()
    }

    override func tearDown() { store.clearAll() }

    func testReinstallWipesKeychain() {
        store.wipeIfFreshInstall()
        store.saveToken("eski")
        store.setPendingLogout("bekleyen")
        store.wipeIfFreshInstall()
        XCTAssertEqual(store.token(), "eski", "aynı kurulumda silinmez")
        defaults.removePersistentDomain(forName: "SessionStoreTests") // UserDefaults kaldırılınca gider, Keychain kalır
        store.wipeIfFreshInstall()
        XCTAssertNil(store.token())
        XCTAssertNil(store.pendingLogout())
    }

    func testTokenNotSynchronizableAndThisDeviceOnly() {
        store.saveToken("t")
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "session",
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            kSecReturnAttributes as String: true
        ]
        var out: AnyObject?
        XCTAssertEqual(SecItemCopyMatching(q as CFDictionary, &out), errSecSuccess)
        let a = out as? [String: Any]
        XCTAssertEqual(a?[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertEqual(a?[kSecAttrSynchronizable as String] as? Int ?? 0, 0)
    }

    func testPendingLogoutTakenOnce() {
        store.setPendingLogout("p")
        XCTAssertEqual(store.takePendingLogout(), "p")
        XCTAssertNil(store.takePendingLogout())
    }

    func testClearKeepsPendingLogout() {
        store.saveToken("t")
        store.setPendingLogout("p")
        store.clear()
        XCTAssertNil(store.token())
        XCTAssertEqual(store.pendingLogout(), "p")
    }
}
