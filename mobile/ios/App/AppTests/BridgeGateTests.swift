import XCTest
@testable import App

final class BridgeGateTests: XCTestCase {
    func testAllowlistedPluginPasses() {
        for id in ["GeckoNative", "App", "SplashScreen", "StatusBar"] {
            XCTAssertTrue(BridgeGate.allows(["type": "message", "pluginId": id, "methodName": "x"], isMainFrame: true), id)
        }
    }

    func testOtherPluginsRefused() {
        for id in ["CapacitorHttp", "CapacitorCookies", "CAPHttpPlugin", "CAPCookiesPlugin", "WebView", "Console", "SystemBars", "Keyboard", ""] {
            XCTAssertFalse(BridgeGate.allows(["type": "message", "pluginId": id], isMainFrame: true), id)
        }
    }

    func testCordovaAndErrorTypesRefused() {
        XCTAssertFalse(BridgeGate.allows(["type": "cordova", "service": "GeckoNative", "pluginId": "GeckoNative"], isMainFrame: true))
        XCTAssertFalse(BridgeGate.allows(["type": "js.error", "pluginId": "GeckoNative"], isMainFrame: true))
    }

    func testMalformedRefused() {
        XCTAssertFalse(BridgeGate.allows("GeckoNative", isMainFrame: true))
        XCTAssertFalse(BridgeGate.allows(["type": "message", "pluginId": 1], isMainFrame: true))
        XCTAssertFalse(BridgeGate.allows(["pluginId": "GeckoNative"], isMainFrame: true))
    }

    func testSubframeRefused() {
        XCTAssertFalse(BridgeGate.allows(["type": "message", "pluginId": "GeckoNative"], isMainFrame: false))
    }
}
