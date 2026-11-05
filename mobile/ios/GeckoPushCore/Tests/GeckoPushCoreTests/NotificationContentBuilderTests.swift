import Foundation
import UserNotifications
import XCTest
@testable import GeckoPushCore

final class NotificationContentBuilderTests: XCTestCase {
    private func payload(level: String = "normal", accountId: Int? = 3, actions: [String] = ["read", "archive", "reply"]) throws -> NativePayload {
        let d: [String: Any] = [
            "v": 1, "title": "Ada", "body": "Merhaba 🌍", "accountId": accountId ?? NSNull(), "messageId": 7, "level": level,
            "tag": "t", "count": 1, "ts": 1_700_000_000_000, "actions": actions
        ]
        return try JSONDecoder().decode(NativePayload.self, from: JSONSerialization.data(withJSONObject: d))
    }

    func testUrgentMapsToTimeSensitive() throws {
        let c = UNMutableNotificationContent()
        NotificationContentBuilder.apply(try payload(level: "urgent"), to: c)
        XCTAssertEqual(c.interruptionLevel, .timeSensitive)
        XCTAssertEqual(c.relevanceScore, 1.0)
    }

    func testNormalMapsToActive() throws {
        let c = UNMutableNotificationContent()
        NotificationContentBuilder.apply(try payload(), to: c)
        XCTAssertEqual(c.interruptionLevel, .active)
        XCTAssertEqual(c.relevanceScore, 0.5)
    }

    func testContentIsPlainAndUserInfoMinimal() throws {
        let c = UNMutableNotificationContent()
        c.userInfo = ["c": "şifreli", "aps": ["x": 1]]
        NotificationContentBuilder.apply(try payload(), to: c)
        XCTAssertEqual(c.title, "Ada")
        XCTAssertEqual(c.body, "Merhaba 🌍")
        XCTAssertEqual(c.threadIdentifier, "acct-3")
        XCTAssertEqual(Set(c.userInfo.keys.compactMap { $0 as? String }), ["messageId", "accountId"])
    }

    func testSummaryThread() throws {
        let c = UNMutableNotificationContent()
        NotificationContentBuilder.apply(try payload(accountId: nil, actions: []), to: c)
        XCTAssertEqual(c.threadIdentifier, "summary")
    }

    func testActionsSelectCategory() {
        XCTAssertEqual(categoryIdentifier(for: []), "gecko.none")
        XCTAssertEqual(categoryIdentifier(for: ["read"]), "gecko.read")
        XCTAssertEqual(categoryIdentifier(for: ["read", "archive", "reply"]), "gecko.full")
        XCTAssertEqual(categoryIdentifier(for: ["read", "reply"]), "gecko.read")
    }

    func testFallbackHidesEverything() {
        let c = UNMutableNotificationContent()
        c.userInfo = ["c": "şifreli"]
        c.title = "x"
        NotificationContentBuilder.applyFallback(to: c)
        XCTAssertEqual(c.title, "")
        XCTAssertFalse(c.body.isEmpty)
        XCTAssertTrue(c.userInfo.isEmpty)
        XCTAssertEqual(c.categoryIdentifier, "gecko.none")
    }

    func testDecodeRejectsUnknownVersionAndLevel() throws {
        XCTAssertNil(try? NotificationContentBuilder.decode(JSONSerialization.data(withJSONObject: ["v": 2])))
        var d = try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload())) as! [String: Any]
        d["level"] = "silent"
        XCTAssertNil(try? NotificationContentBuilder.decode(JSONSerialization.data(withJSONObject: d)))
    }

    func testPaddedPayloadDecodes() throws {
        let json = try JSONEncoder().encode(payload()) + Data(repeating: 0x20, count: 500)
        XCTAssertEqual(try NotificationContentBuilder.decode(json).title, "Ada")
    }

    func testNativeVectorPayloadDecodes() throws {
        let plain = try vectors().filter { $0.name != "rfc8291-appendix-a" }.map { b64u($0.plaintext) }
        for p in plain { XCTAssertEqual(try NotificationContentBuilder.decode(p).v, 1) }
    }
}
