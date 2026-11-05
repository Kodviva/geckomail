import XCTest
@testable import App

final class LockGateTests: XCTestCase {
    private var now: Int64 = 1_000
    private var defaults: UserDefaults!

    override func setUp() {
        defaults = UserDefaults(suiteName: "LockGateTests")
        defaults.removePersistentDomain(forName: "LockGateTests")
    }

    private func gate() -> LockGate { LockGate(defaults: defaults, clock: { [unowned self] in self.now }) }

    func testColdStartLockedWhenEnabled() {
        let a = gate()
        a.apply(.init(enabled: true, timeoutMs: 60_000))
        XCTAssertTrue(gate().isLocked())
    }

    func testColdStartOpenWhenDisabled() {
        XCTAssertFalse(gate().isLocked())
    }

    func testSignOutWhileLockedTurnsLockOff() {
        gate().apply(.init(enabled: true, timeoutMs: 60_000))
        let locked = gate()
        XCTAssertTrue(locked.isLocked())
        locked.signedOut()
        XCTAssertFalse(locked.isLocked())
        XCTAssertFalse(locked.config.enabled)
        XCTAssertEqual(locked.config.timeoutMs, 60_000)
        XCTAssertFalse(gate().isLocked()) // yeniden açılışta da kilit yok
    }

    func testSignOutWhileUnlockedKeepsSetting() {
        let g = gate()
        g.apply(.init(enabled: true, timeoutMs: 60_000))
        g.signedOut()
        XCTAssertTrue(g.config.enabled)
        XCTAssertTrue(gate().config.enabled)
    }

    func testTimeoutBoundary() {
        let g = gate()
        g.apply(.init(enabled: true, timeoutMs: 60_000))
        g.didEnterBackground()
        now += 59_999
        XCTAssertFalse(g.isLocked())
        now += 1
        XCTAssertTrue(g.isLocked())
    }

    func testClockBackwardsLocks() {
        let g = gate()
        g.apply(.init(enabled: true, timeoutMs: 900_000))
        g.didEnterBackground()
        now -= 1
        XCTAssertTrue(g.isLocked())
    }

    func testForegroundKeepsLockUntilUnlocked() {
        let g = gate()
        g.apply(.init(enabled: true, timeoutMs: 0))
        g.didEnterBackground()
        g.didBecomeForeground()
        XCTAssertTrue(g.isLocked())
        g.unlocked()
        XCTAssertFalse(g.isLocked())
    }

    func testPromptIsNotBackground() {
        let g = gate()
        g.apply(.init(enabled: true, timeoutMs: 0))
        g.beginPrompt()
        g.didEnterBackground()
        g.endPrompt()
        XCTAssertFalse(g.isLocked())
    }

    func testWeakening() {
        let g = gate()
        g.apply(.init(enabled: true, timeoutMs: 60_000))
        XCTAssertTrue(g.weakens(.init(enabled: false, timeoutMs: 60_000)))
        XCTAssertTrue(g.weakens(.init(enabled: true, timeoutMs: 300_000)))
        XCTAssertFalse(g.weakens(.init(enabled: true, timeoutMs: 0)))
        XCTAssertFalse(g.weakens(.init(enabled: true, timeoutMs: 60_000)))
        g.apply(.init(enabled: false, timeoutMs: 0))
        XCTAssertFalse(g.weakens(.init(enabled: true, timeoutMs: 900_000)))
    }

    func testEnablingDoesNotLockCurrentSession() {
        let g = gate()
        g.apply(.init(enabled: true, timeoutMs: 0))
        XCTAssertFalse(g.isLocked())
    }
}

private final class FakeAuth: Authenticating {
    var answer = false
    var prompts = 0
    func available() -> Bool { true }
    func prompt(reason: String) async -> Bool {
        prompts += 1
        return answer
    }
}

final class LockSettingTests: XCTestCase {
    private var defaults: UserDefaults!
    private let auth = FakeAuth()
    private var gate: LockGate!

    override func setUp() {
        defaults = UserDefaults(suiteName: "LockSettingTests")
        defaults.removePersistentDomain(forName: "LockSettingTests")
        gate = LockGate(defaults: defaults, clock: { 1 })
        gate.apply(.init(enabled: true, timeoutMs: 60_000))
        gate = LockGate(defaults: defaults, clock: { 1 })
    }

    func testWeakeningRefusedWithoutAuthentication() async {
        let ok = await setLock(.init(enabled: false, timeoutMs: 0), gate: gate, auth: auth, reason: "r")
        XCTAssertFalse(ok)
        XCTAssertEqual(auth.prompts, 1)
        XCTAssertTrue(gate.config.enabled)
    }

    func testWeakeningAppliesAfterAuthentication() async {
        auth.answer = true
        let ok = await setLock(.init(enabled: true, timeoutMs: 900_000), gate: gate, auth: auth, reason: "r")
        XCTAssertTrue(ok)
        XCTAssertEqual(gate.config.timeoutMs, 900_000)
    }

    func testStrengtheningNeedsNoPrompt() async {
        let ok = await setLock(.init(enabled: true, timeoutMs: 0), gate: gate, auth: auth, reason: "r")
        XCTAssertTrue(ok)
        XCTAssertEqual(auth.prompts, 0)
    }

    func testUnknownTimeoutRefused() async {
        auth.answer = true
        let ok = await setLock(.init(enabled: true, timeoutMs: 1), gate: gate, auth: auth, reason: "r")
        XCTAssertFalse(ok)
    }
}
