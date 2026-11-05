import UserNotifications
import XCTest
@testable import App

private final class FakeActions: ActionPoster {
    var outcome = ActionOutcome.ok
    var hang = false
    var calls: [(Int, String)] = []
    func notifyAction(messageId: Int, action: String) async -> ActionOutcome {
        calls.append((messageId, action))
        if hang { try? await Task.sleep(nanoseconds: 5_000_000_000) }
        return outcome
    }
}

private final class FakeCenter: NotificationPosting {
    var removed: [String] = []
    var reloginShown = 0
    var lockedShown = 0
    func removeDelivered(_ id: String) { removed.append(id) }
    func showRelogin() { reloginShown += 1 }
    func showLocked() { lockedShown += 1 }
}

final class PushCenterDelegateTests: XCTestCase {
    /// Capacitor'ın NotificationRouter'ı açılışta temsilciyi ele geçirirse dokunuş ve eylemler buraya hiç gelmez
    func testPushCenterKeepsDelegate() {
        XCTAssertTrue(UNUserNotificationCenter.current().delegate === PushCenter.shared)
    }
}

final class PushCenterTests: XCTestCase {
    private let actions = FakeActions()
    private let posting = FakeCenter()
    private var center: PushCenter!
    private var locked = false

    override func setUp() {
        center = PushCenter(actions: { [unowned self] in self.actions }, posting: posting, limit: 0.2, locked: { [unowned self] in self.locked })
    }

    func testLockedActionRefusedAndOpensApp() async {
        locked = true
        for action in ["gecko.action.read", "gecko.action.archive"] {
            await center.process(action: action, id: "n1", info: ["messageId": 7])
        }
        XCTAssertTrue(actions.calls.isEmpty)
        XCTAssertEqual(posting.lockedShown, 2)
        XCTAssertTrue(posting.removed.isEmpty)
    }

    func testLockedReplyStillOpens() async {
        locked = true
        await center.process(action: "gecko.action.reply", id: "n1", info: ["messageId": 7])
        XCTAssertEqual(center.takeOpens().count, 1)
        XCTAssertEqual(posting.lockedShown, 0)
    }

    func testReadActionRemovesNotification() async {
        await center.process(action: "gecko.action.read", id: "n1", info: ["messageId": 7, "accountId": 1])
        XCTAssertEqual(actions.calls.first?.0, 7)
        XCTAssertEqual(actions.calls.first?.1, "read")
        XCTAssertEqual(posting.removed, ["n1"])
    }

    func testArchiveAction() async {
        await center.process(action: "gecko.action.archive", id: "n1", info: ["messageId": 7])
        XCTAssertEqual(actions.calls.first?.1, "archive")
    }

    func testAction401OpensApp() async {
        actions.outcome = .auth
        await center.process(action: "gecko.action.read", id: "n1", info: ["messageId": 7])
        XCTAssertEqual(posting.reloginShown, 1)
        XCTAssertTrue(posting.removed.isEmpty)
    }

    func testFailedActionKeepsNotification() async {
        actions.outcome = .failed
        await center.process(action: "gecko.action.read", id: "n1", info: ["messageId": 7])
        XCTAssertTrue(posting.removed.isEmpty)
        XCTAssertEqual(posting.reloginShown, 0)
    }

    func testCompletesWithinLimit() async {
        actions.hang = true
        let started = Date()
        await center.process(action: "gecko.action.read", id: "n1", info: ["messageId": 7])
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
    }

    func testTapQueuesOpen() async {
        await center.process(action: UNNotificationDefaultActionIdentifier, id: "n1", info: ["messageId": 7, "accountId": 2])
        let p = center.takeOpens()
        XCTAssertEqual(p.count, 1)
        XCTAssertEqual(p[0]["messageId"] as? Int, 7)
        XCTAssertEqual(p[0]["reply"] as? Bool, false)
        XCTAssertTrue(center.takeOpens().isEmpty)
        XCTAssertTrue(actions.calls.isEmpty)
    }

    func testReplyOpensComposer() async {
        await center.process(action: "gecko.action.reply", id: "n1", info: ["messageId": 7])
        XCTAssertEqual(center.takeOpens()[0]["reply"] as? Bool, true)
    }

    func testTapWithoutMessageOpensNothing() async {
        await center.process(action: UNNotificationDefaultActionIdentifier, id: "n1", info: [:])
        XCTAssertTrue(center.takeOpens().isEmpty)
    }

    func testCompletionRunsOnMainThread() {
        let done = expectation(description: "tamam")
        center.handle(action: "gecko.action.read", id: "n1", info: ["messageId": 7]) {
            XCTAssertTrue(Thread.isMainThread) // UIKit başka iş parçacığında süreci düşürür
            done.fulfill()
        }
        wait(for: [done], timeout: 2)
    }

    func testCategories() {
        let c = PushCenter.categories()
        XCTAssertEqual(Set(c.map(\.identifier)), ["gecko.none", "gecko.read", "gecko.full"])
        let full = c.first { $0.identifier == "gecko.full" }!
        let by = Dictionary(uniqueKeysWithValues: full.actions.map { ($0.identifier, $0.options) })
        XCTAssertTrue(by["gecko.action.read"]!.contains(.authenticationRequired))
        XCTAssertTrue(by["gecko.action.archive"]!.contains([.destructive, .authenticationRequired]))
        XCTAssertTrue(by["gecko.action.reply"]!.contains(.foreground))
    }
}
