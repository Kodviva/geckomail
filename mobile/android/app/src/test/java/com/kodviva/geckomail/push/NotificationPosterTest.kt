package com.kodviva.geckomail.push

import kotlinx.coroutines.test.runTest
import com.kodviva.geckomail.ActionOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.PrivateKey

private fun payload(
    level: String = "normal", accountId: Long? = 3, messageId: Long? = 42, actions: List<String> = listOf("read", "archive", "reply")
) = NativePayload(1, "Başlık", "Gövde", accountId, messageId, level, "t1", 1, 1_800_000_000_000, actions)

private class FakePosting : Posting {
    val posted = mutableListOf<NativePayload>()
    var fallbacks = 0
    var relogins = 0
    val removed = mutableListOf<String>()
    override fun post(p: NativePayload) { posted += p }
    override fun postFallback() { fallbacks++ }
    override fun postRelogin() { relogins++ }
    override fun postLocked() {}
    override fun remove(tag: String) { removed += tag }
}

private class FakeKeys(var material: Material? = null) : PushKeySource {
    var deleted = 0
    override fun loadOrCreate(): Material = material ?: Material(ByteArray(65) { 4 }, ByteArray(16) { 7 }, object : PrivateKey {
        override fun getAlgorithm() = "EC"
        override fun getFormat() = null
        override fun getEncoded() = null
    }).also { material = it }
    override fun load() = material
    override fun delete() { deleted++; material = null }
}

private class FakeDevices(var outcome: RegisterOutcome = RegisterOutcome.Ok(9)) : DevicePort {
    val registered = mutableListOf<String>()
    val removed = mutableListOf<Long>()
    override suspend fun registerDevice(token: String, p256dh: String, auth: String, label: String?): RegisterOutcome {
        registered += token
        return outcome
    }
    override suspend fun unregisterDevice(id: Long) { removed += id }
}

private class MemoryPushPrefs : PushPrefs {
    override var enabled = false
    override var deviceToken: String? = null
    override var deviceId = 0L
    override var userId = 0L
    override var pendingRegister = false
}

private class FakeGateway(var ready: Boolean, var value: String? = "fcm-token") : FcmGateway {
    override fun available() = ready
    override suspend fun token() = value
}

class NotificationPosterTest {
    @Test fun urgentUsesUrgentChannel() {
        assertEquals("mail_urgent", planFor(payload(level = "urgent")).channel)
        assertEquals("msg", planFor(payload(level = "urgent")).category)
        assertEquals("mail_normal", planFor(payload()).channel)
        assertNull(planFor(payload()).category)
    }

    @Test fun groupedByAccount() {
        assertEquals("acct-3", planFor(payload()).group)
        assertEquals("summary", planFor(payload(accountId = null, messageId = null)).group)
    }

    @Test fun summaryHasNoActions() {
        assertEquals(emptyList<String>(), planFor(payload(messageId = null)).actions)
    }

    @Test fun memberReadOnlyGetsReadActionOnly() {
        assertEquals(listOf("read"), planFor(payload(actions = listOf("read"))).actions)
        assertEquals(listOf("read", "archive", "reply"), planFor(payload()).actions)
        assertEquals(emptyList<String>(), planFor(payload(actions = listOf("reply"))).actions)
    }

    private fun handler(p: Posting, fg: Boolean = false, keys: Material? = null, parse: (ByteArray, Material) -> ByteArray = { _, _ -> error("açılamaz") }) =
        PushHandler({ keys }, p, { fg }, parse)

    @Test fun badCiphertextShowsFallback() {
        val p = FakePosting()
        handler(p, keys = FakeKeys().loadOrCreate()).handle("bozuk-kutu")
        handler(p, keys = FakeKeys().loadOrCreate()).handle("!!!")
        handler(p).handle("AAAA") // anahtar yok
        handler(p).handle(null)
        assertEquals(4, p.fallbacks)
        assertTrue(p.posted.isEmpty())
    }

    @Test fun badPayloadShowsFallback() {
        val p = FakePosting()
        handler(p, keys = FakeKeys().loadOrCreate(), parse = { _, _ -> """{"v":1,"level":"silent"}""".toByteArray() }).handle("AAAA")
        assertEquals(1, p.fallbacks)
    }

    @Test fun decryptedPayloadPosted() {
        val v = vectors().first { it.getString("name") == "gecko-normal-turkish" }
        val p = FakePosting()
        handler(p, keys = FakeKeys().loadOrCreate(), parse = { _, _ -> b64(v, "plaintext") }).handle("AAAA")
        assertEquals(1, p.posted.size)
        assertEquals(3L, p.posted[0].accountId)
        assertEquals(42L, p.posted[0].messageId)
    }

    @Test fun foregroundSuppresses() {
        val p = FakePosting()
        handler(p, fg = true).handle("bozuk")
        assertEquals(0, p.fallbacks)
        assertTrue(p.posted.isEmpty())
    }

    @Test fun action401OpensApp() = runTest {
        val p = FakePosting()
        ActionHandler({ _, _ -> ActionOutcome.Auth }, p).run(42, "read", "t1")
        assertEquals(1, p.relogins)
        assertTrue(p.removed.isEmpty())
    }

    @Test fun lockedDeviceRefusedBelowApi31Only() {
        assertTrue(refusesAction(30, deviceLocked = true, appLocked = false))
        assertFalse(refusesAction(31, deviceLocked = true, appLocked = false)) // sistem kimlik ister
        assertFalse(refusesAction(30, deviceLocked = false, appLocked = false))
    }

    @Test fun appLockRefusedOnEveryVersion() {
        assertTrue(refusesAction(30, deviceLocked = false, appLocked = true))
        assertTrue(refusesAction(36, deviceLocked = false, appLocked = true))
    }

    @Test fun actionOkRemovesNotification() = runTest {
        val p = FakePosting()
        var seen: Pair<Long, String>? = null
        ActionHandler({ id, a -> seen = id to a; ActionOutcome.Ok }, p).run(42, "archive", "t1")
        assertEquals(42L to "archive", seen)
        assertEquals(listOf("t1"), p.removed)
    }

    @Test fun actionFailureKeepsNotification() = runTest {
        val p = FakePosting()
        ActionHandler({ _, _ -> ActionOutcome.Failed }, p).run(42, "read", "t1")
        assertEquals(0, p.relogins)
        assertTrue(p.removed.isEmpty())
    }

    @Test fun actionTimeoutEnds() = runTest {
        val p = FakePosting()
        ActionHandler({ _, _ -> kotlinx.coroutines.awaitCancellation() }, p, limitMs = 9_000).run(42, "read", "t1")
        assertEquals(0, p.relogins)
    }

    @Test fun missingFirebaseReturnsUnavailable() = runTest {
        val r = DeviceRegistrar(FakeDevices(), FakeKeys(), MemoryPushPrefs(), null, FakeGateway(false))
        assertEquals(RegisterOutcome.Unavailable, r.enable())
    }

    @Test fun enableRegistersAndRemembers() = runTest {
        val api = FakeDevices()
        val prefs = MemoryPushPrefs()
        assertEquals(RegisterOutcome.Ok(9), DeviceRegistrar(api, FakeKeys(), prefs, "Pixel", FakeGateway(true)).enable())
        assertTrue(prefs.enabled)
        assertEquals(9L, prefs.deviceId)
        assertEquals("fcm-token", prefs.deviceToken)
    }

    @Test fun noFcmTokenFails() = runTest {
        val r = DeviceRegistrar(FakeDevices(), FakeKeys(), MemoryPushPrefs(), null, FakeGateway(true, null))
        assertEquals(RegisterOutcome.Failed, r.enable())
    }

    @Test fun tokenStoredWithoutSession() = runTest {
        val api = FakeDevices(RegisterOutcome.Auth)
        val prefs = MemoryPushPrefs().apply { enabled = true; deviceToken = "eski" }
        val r = DeviceRegistrar(api, FakeKeys(), prefs, null, FakeGateway(true))
        r.tokenChanged("yeni")
        assertEquals("yeni", prefs.deviceToken)
        api.outcome = RegisterOutcome.Ok(11)
        r.reregisterAfterLogin()
        assertEquals(listOf("yeni", "yeni"), api.registered)
        assertEquals(11L, prefs.deviceId)
    }

    @Test fun tokenIgnoredWhenOff() = runTest {
        val api = FakeDevices()
        DeviceRegistrar(api, FakeKeys(), MemoryPushPrefs(), null, FakeGateway(true)).tokenChanged("yeni")
        assertTrue(api.registered.isEmpty())
    }

    @Test fun signOutWipesKey() = runTest {
        val keys = FakeKeys()
        val prefs = MemoryPushPrefs().apply { enabled = true; deviceToken = "t"; deviceId = 9 }
        DeviceRegistrar(FakeDevices(), keys, prefs, null, FakeGateway(true)).clear()
        assertEquals(1, keys.deleted)
        assertEquals(false, prefs.enabled)
        assertNull(prefs.deviceToken)
        assertEquals(0L, prefs.deviceId)
    }

    @Test fun disableUnregistersThenWipes() = runTest {
        val api = FakeDevices()
        val keys = FakeKeys()
        val prefs = MemoryPushPrefs().apply { enabled = true; deviceId = 9 }
        DeviceRegistrar(api, keys, prefs, null, FakeGateway(true)).disable()
        assertEquals(listOf(9L), api.removed)
        assertEquals(1, keys.deleted)
    }

    @Test fun differentUserAfterIdleWipesAndRotates() = runTest {
        val keys = FakeKeys()
        val first = keys.loadOrCreate()
        var wiped = 0
        val api = FakeDevices()
        val prefs = MemoryPushPrefs().apply { enabled = true; deviceToken = "t"; deviceId = 9; userId = 1 }
        val r = DeviceRegistrar(api, keys, prefs, null, FakeGateway(true), { wiped++ })
        r.signedIn(2)
        assertEquals(1, wiped)
        assertEquals(1, keys.deleted)
        assertEquals(2L, prefs.userId)
        assertTrue(prefs.enabled) // bildirim tercihi kalır, yalnız anahtar döner
        r.reregisterAfterLogin()
        assertEquals(listOf("t"), api.registered)
        assertFalse(first === keys.material)
    }

    @Test fun differentUserWipesLocalFilesOfOldUser() = runTest {
        var filesWiped = 0
        val prefs = MemoryPushPrefs().apply { userId = 1 }
        DeviceRegistrar(FakeDevices(), FakeKeys(), prefs, null, FakeGateway(true), {}, { filesWiped++ }).signedIn(2)
        assertEquals(1, filesWiped)
    }

    @Test fun firstLoginAndSameUserKeepPendingShares() = runTest {
        var filesWiped = 0
        val prefs = MemoryPushPrefs().apply { userId = 0 } // çıkışta unutuldu: bekleyen paylaşım eski kullanıcının değil, çıkışta zaten silindi
        val r = DeviceRegistrar(FakeDevices(), FakeKeys(), prefs, null, FakeGateway(true), {}, { filesWiped++ })
        r.signedIn(1)
        r.signedIn(1)
        assertEquals(0, filesWiped)
    }

    @Test fun disableKeepsLastUserSoAnotherLoginStillWipes() = runTest {
        var filesWiped = 0
        var cleared = 0
        val prefs = MemoryPushPrefs().apply { enabled = true; deviceToken = "t"; deviceId = 9; userId = 1 }
        val r = DeviceRegistrar(FakeDevices(), FakeKeys(), prefs, null, FakeGateway(true), { cleared++ }, { filesWiped++ })
        r.disable()
        assertEquals(1L, prefs.userId)
        assertEquals(1, cleared)
        r.signedIn(2)
        assertEquals(1, filesWiped)
        assertEquals(2, cleared) // önceki kullanıcının görünen bildirimleri de gider
    }

    @Test fun sameUserKeepsNotificationsAndKey() = runTest {
        val keys = FakeKeys()
        val first = keys.loadOrCreate()
        var wiped = 0
        val prefs = MemoryPushPrefs().apply { enabled = true; deviceToken = "t"; userId = 1 }
        DeviceRegistrar(FakeDevices(), keys, prefs, null, FakeGateway(true), { wiped++ }).signedIn(1)
        assertEquals(0, wiped)
        assertEquals(0, keys.deleted)
        assertTrue(first === keys.material)
    }

    @Test fun signOutForgetsUserAndPending() = runTest {
        val prefs = MemoryPushPrefs().apply { enabled = true; userId = 1; pendingRegister = true }
        DeviceRegistrar(FakeDevices(), FakeKeys(), prefs, null, FakeGateway(true)).clear()
        assertEquals(0L, prefs.userId)
        assertFalse(prefs.pendingRegister)
    }

    @Test fun reregisterRetriesAfterNetworkError() = runTest {
        val api = FakeDevices(RegisterOutcome.Failed)
        val prefs = MemoryPushPrefs().apply { enabled = true; deviceToken = "t"; deviceId = 4 }
        val r = DeviceRegistrar(api, FakeKeys(), prefs, null, FakeGateway(true))
        r.reregisterAfterLogin()
        assertTrue(prefs.pendingRegister)
        assertEquals(4L, prefs.deviceId)
        r.retryPendingRegister() // ağ hâlâ yok: bekleme sürer
        assertTrue(prefs.pendingRegister)
        api.outcome = RegisterOutcome.Ok(11)
        r.retryPendingRegister()
        assertFalse(prefs.pendingRegister)
        assertEquals(11L, prefs.deviceId)
        assertEquals(listOf("t", "t", "t"), api.registered)
        r.retryPendingRegister() // bekleyen yok: istek gitmez
        assertEquals(3, api.registered.size)
    }

    @Test fun retryStopsWhenRelayOff() = runTest {
        val api = FakeDevices(RegisterOutcome.Unavailable)
        val prefs = MemoryPushPrefs().apply { enabled = true; deviceToken = "t"; pendingRegister = true }
        DeviceRegistrar(api, FakeKeys(), prefs, null, FakeGateway(true)).retryPendingRegister()
        assertFalse(prefs.pendingRegister)
    }

    @Test fun retryDoesNothingWhenPushOff() = runTest {
        val api = FakeDevices()
        val prefs = MemoryPushPrefs().apply { deviceToken = "t"; pendingRegister = true }
        DeviceRegistrar(api, FakeKeys(), prefs, null, FakeGateway(true)).retryPendingRegister()
        assertTrue(api.registered.isEmpty())
        assertFalse(prefs.pendingRegister)
    }

    @Test fun lateRegisterDoesNotReviveAfterSignOut() = runTest {
        lateinit var r: DeviceRegistrar
        val prefs = MemoryPushPrefs().apply { enabled = true; deviceToken = "t"; pendingRegister = true }
        val api = object : DevicePort {
            override suspend fun registerDevice(token: String, p256dh: String, auth: String, label: String?): RegisterOutcome {
                r.clear() // kayıt sürerken çıkış
                return RegisterOutcome.Ok(11)
            }
            override suspend fun unregisterDevice(id: Long) {}
        }
        r = DeviceRegistrar(api, FakeKeys(), prefs, null, FakeGateway(true))
        r.retryPendingRegister()
        assertFalse(prefs.enabled)
        assertNull(prefs.deviceToken)
        assertEquals(0L, prefs.deviceId)
    }

    @Test fun nativePayloadRejectsSilentAndBadJson() {
        assertNull(NativePayload.parse("{}".toByteArray()))
        assertNull(NativePayload.parse("değil".toByteArray()))
        assertNull(NativePayload.parse("""{"v":1,"title":"a","body":"b","accountId":null,"messageId":null,"level":"silent","tag":"t","count":1,"ts":1,"actions":[]}""".toByteArray()))
        val ok = NativePayload.parse("""{"v":1,"title":"a","body":"b","accountId":null,"messageId":null,"level":"normal","tag":"t","count":1,"ts":1,"actions":[]}     """.toByteArray())!!
        assertNull(ok.accountId)
        assertNull(ok.messageId)
    }
}
