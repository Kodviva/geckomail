import CryptoKit
import GeckoPushCore
import UserNotifications
import XCTest
@testable import App

final class NotificationServiceTests: XCTestCase {
    private struct Vector: Decodable { let name, uaPrivate, auth, body: String }

    private func vector() throws -> Vector {
        struct File: Decodable { let vectors: [Vector] }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../testdata/push-vectors.json").standardized
        return try XCTUnwrap(JSONDecoder().decode(File.self, from: Data(contentsOf: url)).vectors.first { $0.name != "rfc8291-appendix-a" })
    }

    private func keys(_ v: Vector) throws -> PushKeys {
        PushKeys(privateKey: try .init(rawRepresentation: XCTUnwrap(Data(base64URL: v.uaPrivate))), authSecret: try XCTUnwrap(Data(base64URL: v.auth)))
    }

    private func request(_ box: String?) -> UNNotificationRequest {
        let c = UNMutableNotificationContent()
        c.body = "PUSH_FALLBACK"
        c.userInfo = box.map { ["c": $0] } ?? [:]
        return UNNotificationRequest(identifier: "x", content: c, trigger: nil)
    }

    private func deliver(_ s: NotificationService, _ r: UNNotificationRequest) -> UNNotificationContent? {
        let got = expectation(description: "teslim")
        var out: UNNotificationContent?
        s.didReceive(r) {
            out = $0
            got.fulfill()
        }
        wait(for: [got], timeout: 5)
        return out
    }

    func testDecryptsNativePayload() throws {
        let v = try vector()
        let s = NotificationService()
        s.keys = { try? self.keys(v) }
        let c = try XCTUnwrap(deliver(s, request(v.body)))
        XCTAssertFalse(c.title.isEmpty)
        XCTAssertNotEqual(c.body, "PUSH_FALLBACK")
    }

    /// Motor çıktısı ve yerel çözücü aynı baytlarla: engine-chain.json gerçek sunucu ve imzalı röleden yakalandı
    func testEngineChainPayload() throws {
        struct Chain: Decodable {
            struct Expected: Decodable { let title, body: String; let messageId: Int }
            struct Apns: Decodable { let c: String }
            struct Device: Decodable { let uaPrivate, auth: String; let provider: String; let body: Apns }
            let expected: Expected
            let ios: Device
        }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../testdata/engine-chain.json").standardizedFileURL
        let chain = try JSONDecoder().decode(Chain.self, from: Data(contentsOf: url))
        XCTAssertEqual(chain.ios.provider, "apns")
        let device = PushKeys(privateKey: try .init(rawRepresentation: XCTUnwrap(Data(base64URL: chain.ios.uaPrivate))), authSecret: try XCTUnwrap(Data(base64URL: chain.ios.auth)))
        let s = NotificationService()
        s.keys = { device }
        let c = try XCTUnwrap(deliver(s, request(chain.ios.body.c)))
        XCTAssertEqual(c.title, chain.expected.title)
        XCTAssertEqual(c.body, chain.expected.body)
        XCTAssertEqual(c.userInfo["messageId"] as? Int, chain.expected.messageId)
    }

    func testBadCiphertextShowsFallback() throws {
        let v = try vector()
        let s = NotificationService()
        s.keys = { try? self.keys(v) }
        let c = try XCTUnwrap(deliver(s, request(String(v.body.dropLast(4)))))
        XCTAssertEqual(c.title, "")
        XCTAssertFalse(c.body.isEmpty)
        XCTAssertTrue(c.userInfo.isEmpty)
    }

    func testChangedKeyShowsFallback() throws {
        let v = try vector()
        let s = NotificationService()
        s.keys = { PushKeys(privateKey: .init(), authSecret: Data(count: 16)) }
        XCTAssertEqual(try XCTUnwrap(deliver(s, request(v.body))).title, "")
    }

    func testMissingKeyAndBoxShowFallback() throws {
        let s = NotificationService()
        s.keys = { nil }
        XCTAssertEqual(try XCTUnwrap(deliver(s, request(nil))).categoryIdentifier, "gecko.none")
    }

    func testNoCiphertextInDeliveredContent() throws {
        let v = try vector()
        let s = NotificationService()
        s.keys = { try? self.keys(v) }
        for box in [v.body, "bozuk"] {
            let c = try XCTUnwrap(deliver(s, request(box)))
            XCTAssertNil(c.userInfo["c"])
            XCTAssertFalse(c.body.contains(String(v.body.prefix(16))))
        }
    }

    func testTimeoutShowsFallbackOnce() throws {
        let v = try vector()
        let hold = DispatchSemaphore(value: 0)
        let s = NotificationService()
        s.keys = {
            hold.wait()
            return try? self.keys(v)
        }
        var count = 0
        var out: UNNotificationContent?
        s.didReceive(request(v.body)) {
            count += 1
            out = $0
        }
        s.serviceExtensionTimeWillExpire()
        XCTAssertEqual(out?.title, "")
        hold.signal()
        let late = expectation(description: "geç çözme")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { late.fulfill() }
        wait(for: [late], timeout: 2)
        XCTAssertEqual(count, 1)
    }
}

final class PushKeychainTests: XCTestCase {
    func testSessionTokenNotInSharedGroup() {
        let store = SessionStore(service: "com.kodviva.geckomail.grouptest", defaults: UserDefaults(suiteName: "PushKeychainTests")!)
        store.saveToken("t")
        defer { store.clearAll() }
        let prefix = Bundle.main.object(forInfoDictionaryKey: "GeckoKeychainPrefix") as? String ?? ""
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.kodviva.geckomail.grouptest",
            kSecAttrAccessGroup as String: prefix + "com.kodviva.geckomail.push"
        ]
        XCTAssertEqual(SecItemCopyMatching(q as CFDictionary, nil), errSecItemNotFound)
        XCTAssertEqual(store.token(), "t")
    }

    func testPushKeyInSharedGroupSessionNot() throws {
        PushKeys.useSharedGroup()
        PushKeys.delete()
        let a = try PushKeys.loadOrCreate()
        XCTAssertEqual(PushKeys.load()?.p256dh, a.p256dh)
        PushKeys.delete()
        XCTAssertNil(PushKeys.load())
    }
}
