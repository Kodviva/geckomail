import XCTest
@testable import App

final class FakeURLProtocol: URLProtocol {
    typealias Handler = (URLRequest) -> (Int, Data?)?
    private static let lock = NSLock()
    private static var _handler: Handler = { _ in (500, nil) }
    private static var _requests: [URLRequest] = []
    static var delay: TimeInterval = 0

    static var handler: Handler {
        get { lock.lock(); defer { lock.unlock() }; return _handler }
        set { lock.lock(); _handler = newValue; _requests = []; lock.unlock() }
    }
    static var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return _requests }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        Self.lock.lock()
        Self._requests.append(request)
        let h = Self._handler
        Self.lock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.delay) { [self] in
            guard let (status, body) = h(request) else {
                client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
                return
            }
            let res = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
            if let body { client?.urlProtocol(self, didLoad: body) }
            client?.urlProtocolDidFinishLoading(self)
        }
    }
}

final class SessionApiTests: XCTestCase {
    private var store: SessionStore!
    private var defaults: UserDefaults!
    private var nowMs: Int64 = 1_000_000
    private var api: SessionApi!
    private var signedOut = 0

    override func setUp() {
        defaults = UserDefaults(suiteName: "SessionApiTests")
        defaults.removePersistentDomain(forName: "SessionApiTests")
        store = SessionStore(service: "com.kodviva.geckomail.apitests", defaults: defaults)
        store.clearAll()
        FakeURLProtocol.delay = 0
        let conf = URLSessionConfiguration.ephemeral
        conf.protocolClasses = [FakeURLProtocol.self]
        api = SessionApi(store: store, origin: { "https://posta.example.com" }, session: URLSession(configuration: conf),
                         now: { [unowned self] in self.nowMs }, onSignedOut: { [unowned self] in self.signedOut += 1 })
    }

    override func tearDown() { store.clearAll() }

    private func tokenResponse(_ token: String = "gma_1", ttl: Int64 = 900_000) -> (Int, Data?) {
        (200, try? JSONSerialization.data(withJSONObject: ["accessToken": token, "expiresAt": nowMs + ttl, "user": ["id": 1]]))
    }

    func testLoginStoresTokenAndHidesIt() async {
        FakeURLProtocol.handler = { _ in (200, #"{"token":"gms_x","user":{"id":1,"username":"ada"}}"#.data(using: .utf8)) }
        guard case .ok(let user) = await api.login(username: "ada", password: "p", totp: nil) else { return XCTFail("giriş") }
        XCTAssertEqual(store.token(), "gms_x")
        XCTAssertNil(user["token"])
        let r = FakeURLProtocol.requests[0]
        XCTAssertEqual(r.url?.absoluteString, "https://posta.example.com/api/mobile/login")
        XCTAssertNil(r.value(forHTTPHeaderField: "Origin"))
    }

    func testLoginReasons() async {
        FakeURLProtocol.handler = { _ in (401, #"{"reason":"bad"}"#.data(using: .utf8)) }
        guard case .failed("bad") = await api.login(username: "a", password: "p", totp: nil) else { return XCTFail("bad") }
        FakeURLProtocol.handler = { _ in (500, nil) }
        guard case .failed("network") = await api.login(username: "a", password: "p", totp: nil) else { return XCTFail("500") }
        FakeURLProtocol.handler = { _ in nil }
        guard case .failed("network") = await api.login(username: "a", password: "p", totp: nil) else { return XCTFail("ağ") }
    }

    func testAccessCachedUntilExpiry() async {
        store.saveToken("t")
        FakeURLProtocol.handler = { [unowned self] _ in self.tokenResponse() }
        _ = await api.access(force: false)
        nowMs += 900_000 - 60_001
        _ = await api.access(force: false)
        XCTAssertEqual(FakeURLProtocol.requests.count, 1)
        nowMs += 1
        _ = await api.access(force: false)
        XCTAssertEqual(FakeURLProtocol.requests.count, 2)
        _ = await api.access(force: true)
        XCTAssertEqual(FakeURLProtocol.requests.count, 3)
        XCTAssertEqual(FakeURLProtocol.requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer t")
    }

    func testConcurrentAccessSingleRequest() async {
        store.saveToken("t")
        FakeURLProtocol.delay = 0.1
        FakeURLProtocol.handler = { [unowned self] _ in self.tokenResponse() }
        async let a = api.access(force: false)
        async let b = api.access(force: false)
        async let c = api.access(force: false)
        _ = await (a, b, c)
        XCTAssertEqual(FakeURLProtocol.requests.count, 1)
    }

    func testTokenRefusedEndsLocalSession() async {
        store.saveToken("gms_x")
        FakeURLProtocol.handler = { _ in (401, nil) }
        _ = await api.access(force: false)
        XCTAssertNil(store.token())
        XCTAssertEqual(signedOut, 1)
    }

    func testIdleKeepsSessionAndPush() async {
        store.saveToken("gms_x")
        FakeURLProtocol.handler = { [unowned self] _ in self.tokenResponse() }
        _ = await api.access(force: false)
        FakeURLProtocol.handler = { _ in (401, #"{"reason":"idle"}"#.data(using: .utf8)) }
        guard case .idle = await api.access(force: true) else { return XCTFail("idle") }
        XCTAssertEqual(signedOut, 0) // push anahtarı ve bildirimler silinmez
        XCTAssertEqual(store.token(), "gms_x") // çıkış sunucudaki satırı bu belirteçle kapatır
        FakeURLProtocol.handler = { [unowned self] _ in self.tokenResponse() }
        guard case .ok = await api.access(force: false) else { return XCTFail("önbellek silinmeliydi") }
        XCTAssertEqual(FakeURLProtocol.requests.count, 1) // erişim belirteci önbellekten dönmedi
    }

    func testGoneReasonWipes() async {
        store.saveToken("gms_x")
        FakeURLProtocol.handler = { _ in (401, #"{"reason":"gone"}"#.data(using: .utf8)) }
        guard case .gone = await api.access(force: false) else { return XCTFail("gone") }
        XCTAssertNil(store.token())
        XCTAssertEqual(signedOut, 1)
    }

    func testIdleActionAsksRelogin() async {
        store.saveToken("gms_x")
        FakeURLProtocol.handler = { _ in (401, #"{"reason":"idle"}"#.data(using: .utf8)) }
        let r = await api.notifyAction(messageId: 1, action: "read")
        XCTAssertEqual(r, .auth)
        XCTAssertEqual(signedOut, 0)
    }

    func testLogoutAfterIdleClosesSession() async {
        store.saveToken("gms_x")
        FakeURLProtocol.handler = { _ in (401, #"{"reason":"idle"}"#.data(using: .utf8)) }
        _ = await api.access(force: false)
        FakeURLProtocol.handler = { _ in (204, nil) }
        await api.logout()
        XCTAssertEqual(FakeURLProtocol.requests.first?.url?.path, "/api/mobile/logout")
        XCTAssertEqual(signedOut, 1)
    }

    func test401ReturnsGone() async {
        store.saveToken("t")
        FakeURLProtocol.handler = { _ in (401, nil) }
        guard case .gone = await api.access(force: false) else { return XCTFail("gone") }
        XCTAssertNil(store.token())
    }

    func testNoTokenIsGoneWithoutRequest() async {
        FakeURLProtocol.handler = { _ in (200, nil) }
        guard case .gone = await api.access(force: false) else { return XCTFail("gone") }
        XCTAssertTrue(FakeURLProtocol.requests.isEmpty)
    }

    func testNetworkFailure() async {
        store.saveToken("t")
        FakeURLProtocol.handler = { _ in nil }
        guard case .network = await api.access(force: false) else { return XCTFail("network") }
        XCTAssertEqual(store.token(), "t")
    }

    func testDropAccessForcesNewRequest() async {
        store.saveToken("t")
        FakeURLProtocol.handler = { [unowned self] _ in self.tokenResponse() }
        _ = await api.access(force: false)
        await api.dropAccess()
        _ = await api.access(force: false)
        XCTAssertEqual(FakeURLProtocol.requests.count, 2)
    }

    func testOfflineLogoutRetries() async {
        store.saveToken("t")
        FakeURLProtocol.handler = { _ in nil }
        await api.logout()
        XCTAssertNil(store.token(), "yerel oturum hemen gider")
        XCTAssertEqual(signedOut, 1)
        XCTAssertEqual(store.pendingLogout(), "t")
        FakeURLProtocol.handler = { _ in (204, nil) }
        await api.retryPendingLogout()
        XCTAssertNil(store.pendingLogout())
        let r = FakeURLProtocol.requests[0]
        XCTAssertEqual(r.url?.path, "/api/mobile/logout")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer t")
    }

    func testServerErrorKeepsPendingLogout() async {
        store.setPendingLogout("t")
        FakeURLProtocol.handler = { _ in (503, nil) }
        await api.retryPendingLogout()
        XCTAssertEqual(store.pendingLogout(), "t")
    }

    func testNotifyAction() async {
        store.saveToken("t")
        FakeURLProtocol.handler = { [unowned self] r in r.url?.path == "/api/mobile/token" ? self.tokenResponse() : (204, nil) }
        let ok = await api.notifyAction(messageId: 7, action: "read")
        XCTAssertEqual(ok, .ok)
        XCTAssertEqual(FakeURLProtocol.requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer gma_1")
    }

    func testNotifyActionAuthWhenSessionGone() async {
        store.saveToken("t")
        FakeURLProtocol.handler = { _ in (401, nil) }
        let r = await api.notifyAction(messageId: 7, action: "read")
        XCTAssertEqual(r, .auth)
    }

    func testNotifyActionRefreshesOnce() async {
        store.saveToken("t")
        FakeURLProtocol.handler = { [unowned self] r in r.url?.path == "/api/mobile/token" ? self.tokenResponse() : (401, nil) }
        let r = await api.notifyAction(messageId: 7, action: "read")
        XCTAssertEqual(r, .auth)
        XCTAssertEqual(FakeURLProtocol.requests.filter { $0.url?.path == "/api/notify/action" }.count, 2)
    }

    func testNotifyActionNetworkFailed() async {
        store.saveToken("t")
        FakeURLProtocol.handler = { _ in nil }
        let r = await api.notifyAction(messageId: 7, action: "read")
        XCTAssertEqual(r, .failed)
    }
}

final class DeviceRegistrationTests: XCTestCase {
    private var store: SessionStore!
    private var api: SessionApi!

    override func setUp() {
        let defaults = UserDefaults(suiteName: "DeviceRegistrationTests")!
        store = SessionStore(service: "com.kodviva.geckomail.devtests", defaults: defaults)
        store.clearAll()
        store.saveToken("t")
        let conf = URLSessionConfiguration.ephemeral
        conf.protocolClasses = [FakeURLProtocol.self]
        api = SessionApi(store: store, origin: { "https://posta.example.com" }, session: URLSession(configuration: conf))
    }

    override func tearDown() { store.clearAll() }

    private func reply(_ device: Int, _ body: String?) {
        FakeURLProtocol.handler = { r in
            r.url?.path == "/api/mobile/token"
                ? (200, try? JSONSerialization.data(withJSONObject: ["accessToken": "gma_1", "expiresAt": Int64(Date().timeIntervalSince1970 * 1000) + 900_000]))
                : (device, body?.data(using: .utf8))
        }
    }

    func testRegisterDevicePostsKeysWithAccessToken() async throws {
        reply(200, #"{"id":5}"#)
        let r = await api.registerDevice(env: "sandbox", token: "abcd", p256dh: "p", auth: "a", label: "iPhone")
        XCTAssertEqual(r, .ok(id: 5))
        let q = try XCTUnwrap(FakeURLProtocol.requests.last)
        XCTAssertEqual(q.url?.path, "/api/mobile/device")
        XCTAssertEqual(q.value(forHTTPHeaderField: "Authorization"), "Bearer gma_1")
    }

    func testRelayOffIsUnavailable() async {
        reply(409, #"{"reason":"relayOff"}"#)
        let r = await api.registerDevice(env: "sandbox", token: "abcd", p256dh: "p", auth: "a", label: nil)
        XCTAssertEqual(r, .unavailable)
    }

    func testRelayDownFails() async {
        reply(502, nil)
        let r = await api.registerDevice(env: "sandbox", token: "abcd", p256dh: "p", auth: "a", label: nil)
        XCTAssertEqual(r, .failed)
    }

    func testUnregisterDeletes() async throws {
        reply(204, nil)
        await api.unregisterDevice(id: 5)
        let q = try XCTUnwrap(FakeURLProtocol.requests.last)
        XCTAssertEqual(q.httpMethod, "DELETE")
        XCTAssertEqual(q.url?.path, "/api/push/devices/5")
    }
}

final class PushLoginTests: XCTestCase {
    private var defaults: UserDefaults!
    private var enabled = true
    private var token: String? = "t"
    private var rotated = 0
    private var filesWiped = 0
    private var synced: [String] = []
    private var outcome = DeviceOutcome.ok(id: 5)
    private var login: PushLogin!

    override func setUp() {
        defaults = UserDefaults(suiteName: "PushLoginTests")
        defaults.removePersistentDomain(forName: "PushLoginTests")
        login = PushLogin(defaults: defaults, enabled: { [unowned self] in self.enabled }, token: { [unowned self] in self.token },
                          rotate: { [unowned self] in self.rotated += 1 },
                          userChanged: { [unowned self] in self.filesWiped += 1 },
                          sync: { [unowned self] t in self.synced.append(t); return self.outcome })
    }

    func testDifferentUserAfterIdleWipesAndRotates() async {
        login.signedIn(userId: 1)
        rotated = 0
        login.signedIn(userId: 2)
        XCTAssertEqual(rotated, 1)
        await login.reregister()
        XCTAssertEqual(synced, ["t"]) // bildirim tercihi kalır, yeni anahtar bildirilir
    }

    func testDifferentUserWipesLocalFilesOfOldUser() {
        login.signedIn(userId: 1)
        login.signedIn(userId: 2)
        XCTAssertEqual(filesWiped, 1)
    }

    func testFirstLoginAndSameUserKeepPendingShares() {
        login.signedIn(userId: 1) // çıkışta unutuldu: bekleyen paylaşım eski kullanıcının değil
        login.signedIn(userId: 1)
        XCTAssertEqual(filesWiped, 0)
    }

    func testSameUserKeepsNotificationsAndKey() {
        login.signedIn(userId: 1)
        rotated = 0
        login.signedIn(userId: 1)
        XCTAssertEqual(rotated, 0)
    }

    func testDisableKeepsLastUserSoAnotherLoginStillWipes() {
        login.signedIn(userId: 1)
        rotated = 0
        login.clearPending() // disablePush bunu çağırır, forget'ı değil
        login.signedIn(userId: 2)
        XCTAssertEqual(rotated, 1)
        XCTAssertEqual(filesWiped, 1)
    }

    func testForgetClearsUserAndPending() async {
        login.signedIn(userId: 1)
        outcome = .failed
        await login.reregister()
        login.forget()
        synced = []
        await login.retry()
        XCTAssertTrue(synced.isEmpty)
        XCTAssertNil(defaults.object(forKey: "gecko.push.user"))
    }

    func testReregisterRetriesAfterNetworkError() async {
        outcome = .failed
        await login.reregister()
        await login.retry() // ağ hâlâ yok: bekleme sürer
        XCTAssertEqual(synced.count, 2)
        outcome = .ok(id: 9)
        await login.retry()
        XCTAssertEqual(synced.count, 3)
        await login.retry() // bekleyen yok: istek gitmez
        XCTAssertEqual(synced.count, 3)
    }

    func testPendingSurvivesRestart() async {
        outcome = .failed
        await login.reregister()
        let next = PushLogin(defaults: defaults, enabled: { true }, token: { "t" }, rotate: {}, userChanged: {}, sync: { [unowned self] t in self.synced.append(t); return .ok(id: 1) })
        await next.retry()
        XCTAssertEqual(synced.count, 2)
    }

    func testRetryStopsWhenRelayOff() async {
        outcome = .failed
        await login.reregister()
        outcome = .unavailable
        await login.retry()
        await login.retry()
        XCTAssertEqual(synced.count, 2)
    }

    func testRetryDoesNothingWhenPushOff() async {
        outcome = .failed
        await login.reregister()
        synced = []
        enabled = false
        await login.retry()
        XCTAssertTrue(synced.isEmpty)
        enabled = true
        await login.retry()
        XCTAssertTrue(synced.isEmpty) // bekleme silindi
    }
}
