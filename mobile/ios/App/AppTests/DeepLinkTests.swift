import GeckoPushCore
import XCTest
@testable import App

final class DeepLinkTests: XCTestCase {
    private func parse(_ s: String) -> NativeOpenRequest? { URL(string: s).flatMap(parseDeepLink) }

    func testOpensMessage() {
        XCTAssertEqual(parse("geckomail://open?m=1"), NativeOpenRequest(messageId: 1, reply: false))
        XCTAssertEqual(parse("geckomail://open?reply=42"), NativeOpenRequest(messageId: 42, reply: true))
        XCTAssertEqual(parse("geckomail://open?m=9007199254740991")?.messageId, 9_007_199_254_740_991)
    }

    func testDeepLinkCannotChangeServer() {
        for u in ["geckomail://open?server=https://evil.example", "geckomail://open?m=1&server=https://evil.example", "geckomail://evil/open?m=1",
                  "geckomail://evil?m=1", "geckomail://open/x?m=1", "geckomail://user@open?m=1", "geckomail://open:8080?m=1", "https://open?m=1",
                  "geckomail://open?m=1&reply=2", "geckomail://open?m=1&m=2", "geckomail://open?m=1#x", "GECKOMAIL://open?m=1", "geckomail://open"] {
            XCTAssertNil(parse(u), u)
        }
    }

    func testNonNumericIdRejected() {
        for id in ["abc", "-1", "0", "1.5", "+1", "1e3", "0x10", "01", "", "%31", "%D9%A1"] { XCTAssertNil(parse("geckomail://open?m=\(id)"), id) }
    }

    func testHugeIdRejected() {
        XCTAssertNil(parse("geckomail://open?m=9007199254740992"))
        XCTAssertNil(parse("geckomail://open?m=99999999999999999999999"))
    }

    func testDeepLinkQueuedForApp() {
        let c = PushCenter(actions: { fatalError() }, posting: NoPosting(), limit: 1, locked: { false })
        XCTAssertFalse(c.openLink(URL(string: "geckomail://open?server=x")!))
        XCTAssertTrue(c.takeOpens().isEmpty)
        XCTAssertTrue(c.openLink(URL(string: "geckomail://open?reply=5")!))
        let o = c.takeOpens().first
        XCTAssertEqual(o?["messageId"] as? Int, 5)
        XCTAssertEqual(o?["reply"] as? Bool, true)
    }

    func testAttachmentCacheClearedOnLogout() async throws {
        let s = AppServices.shared
        let f = s.attachments.newFile(name: "../../x.pdf")
        try FileManager.default.createDirectory(at: f.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("veri".utf8).write(to: f)
        XCTAssertEqual(f.lastPathComponent, "x.pdf")
        await s.api.logout()
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.path))
    }

    func testAttachmentCachePurgedAfterDay() throws {
        var now: Int64 = 5_000
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let c = AttachmentCache(root: root, now: { now })
        let f = c.newFile(name: "a")
        try Data("v".utf8).write(to: f)
        now += ShareInbox.dayMs - 1
        c.purge()
        XCTAssertTrue(FileManager.default.fileExists(atPath: f.path))
        now += 2
        c.purge()
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.path))
    }
}

private struct NoPosting: NotificationPosting {
    func removeDelivered(_ id: String) {}
    func showRelogin() {}
    func showLocked() {}
}
