// Uçtan uca: mobile/scripts/e2e-stack.mjs açıkken ilk açılış, sunucu, giriş + TOTP, gelen kutusu, ileti, posta içi betik.
// Yığın kapalıysa atlanır. Adımlar mobile/e2e/README.md'de.
import XCTest

final class SmokeUITests: XCTestCase {
    private let control = "http://localhost:9102"
    private let server = "http://localhost:9100"
    private let wait: TimeInterval = 15

    private func controlGet(_ path: String) async throws -> [String: Any]? {
        guard let url = URL(string: control + path) else { return nil }
        var q = URLRequest(url: url, timeoutInterval: 3)
        q.httpMethod = path == "/idle" || path == "/revoke" ? "POST" : "GET"
        let (data, _) = try await URLSession.shared.data(for: q)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func requireStack() async throws {
        guard (try? await controlGet("/totp")) != nil else { throw XCTSkip("e2e-stack kapalı") }
    }

    private func field(_ app: XCUIApplication, _ labels: [String]) -> XCUIElement? {
        for l in labels {
            for q in [app.textFields[l], app.secureTextFields[l]] where q.exists { return q }
        }
        return nil
    }

    @MainActor private func type(_ el: XCUIElement, _ text: String) {
        el.tap()
        el.typeText(text)
    }

    @MainActor private func signIn(_ app: XCUIApplication) async throws {
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: wait))
        if web.buttons["Devam"].waitForExistence(timeout: 3) { web.buttons["Devam"].tap() }
        let address = web.textFields.firstMatch
        if web.staticTexts["Sunucunuza bağlanın"].waitForExistence(timeout: 3) {
            type(address, server + "\n")
        }
        if web.staticTexts["Betikli ileti"].waitForExistence(timeout: 3) { return }
        XCTAssertTrue(web.buttons["Giriş Yap"].waitForExistence(timeout: wait), app.debugDescription)
        type(web.textFields.firstMatch, "deneme")
        type(web.secureTextFields.firstMatch, "deneme-parola-1\n")
        XCTAssertTrue(web.staticTexts["İki adımlı doğrulama"].waitForExistence(timeout: wait))
        let code = try await controlGet("/totp")?["code"] as? String
        type(web.textFields.firstMatch, try XCTUnwrap(code) + "\n")
    }

    @MainActor func testFirstRunToMessage() async throws {
        try await requireStack()
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(tr)", "-AppleLocale", "tr_TR"]
        app.launch()
        try await signIn(app)
        let web = app.webViews.firstMatch
        let row = web.staticTexts["Betikli ileti"]
        XCTAssertTrue(row.waitForExistence(timeout: wait))
        row.tap()
        XCTAssertTrue(web.staticTexts["Merhaba"].waitForExistence(timeout: wait))
        XCTAssertFalse(web.staticTexts["BETIK CALISTI"].exists) // T9: posta içi betik çalışmaz
    }
}
