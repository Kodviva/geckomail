package com.kodviva.geckomail

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeGateTest {
    private fun msg(id: String, type: String = "message") = """{"type":"$type","pluginId":"$id","methodName":"x","callbackId":"1"}"""

    @Test fun allowlistedPluginPasses() {
        for (id in listOf("GeckoNative", "App", "SplashScreen", "StatusBar")) assertTrue(id, BridgeGate.allows(msg(id)))
    }

    @Test fun androidMessageWithoutTypePasses() {
        assertTrue(BridgeGate.allows("""{"pluginId":"GeckoNative","methodName":"x","callbackId":"1"}"""))
        assertFalse(BridgeGate.allows("""{"pluginId":"CapacitorHttp","methodName":"request","callbackId":"1"}"""))
    }

    @Test fun otherPluginsRefused() {
        for (id in listOf("CapacitorHttp", "CapacitorCookies", "WebView", "SystemBars", "Keyboard", "Console", "")) assertFalse(id, BridgeGate.allows(msg(id)))
    }

    @Test fun cordovaAndErrorTypesRefused() {
        assertFalse(BridgeGate.allows(msg("GeckoNative", "cordova")))
        assertFalse(BridgeGate.allows(msg("GeckoNative", "js.error")))
    }

    @Test fun malformedRefused() {
        assertFalse(BridgeGate.allows("not json"))
        assertFalse(BridgeGate.allows(null))
        assertFalse(BridgeGate.allows("""{"type":"other","pluginId":"CapacitorHttp"}"""))
        assertFalse(BridgeGate.allows("""{"type":"message","pluginId":1}"""))
    }

    @Test fun duplicateKeyLastWins() {
        assertFalse(BridgeGate.allows("""{"type":"message","pluginId":"GeckoNative","pluginId":"CapacitorHttp"}"""))
    }
}
