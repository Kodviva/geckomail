package com.kodviva.geckomail

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class MemoryStore(override var origin: String? = "https://posta.example.com") : TokenStore {
    var tok: String? = null
    var pending: String? = null
    override fun saveToken(t: String) { tok = t }
    override fun token() = tok
    override fun clear() { tok = null }
    override fun setPendingLogout(t: String) { pending = t }
    override fun pendingLogout() = pending
    override fun takePendingLogout() = pending.also { pending = null }
}

private data class Req(val url: String, val bearer: String?, val json: String?)

private class FakeHttp(var reply: suspend (Req) -> HttpReply?) : HttpPort {
    val requests = mutableListOf<Req>()
    override suspend fun post(url: String, bearer: String?, json: String?): HttpReply? {
        val r = Req(url, bearer, json)
        requests += r
        return reply(r)
    }
    override suspend fun delete(url: String, bearer: String?): HttpReply? = post(url, bearer, null)
    var downloads = mutableListOf<Pair<String, String?>>()
    var downloadStatus: () -> Int? = { 200 }
    override suspend fun download(url: String, bearer: String?, dest: java.io.File): Int? {
        downloads += url to bearer
        return downloadStatus()
    }
}

class SessionApiTest {
    private val store = MemoryStore()
    private var now = 1_000_000L
    private var signedOut = 0
    private val http = FakeHttp { HttpReply(500, "") }
    private val api = SessionApi(store, http, { now }, { signedOut++ })

    private fun tokenReply(ttl: Long = 900_000) = HttpReply(200, """{"accessToken":"gma_1","expiresAt":${now + ttl},"user":{"id":1}}""")

    @Test fun tokenRefusedEndsLocalSession() = runTest {
        store.tok = "gms_x"
        http.reply = { HttpReply(401, "") }
        assertEquals(AccessOutcome.Gone, api.access(false))
        assertNull(store.tok)
        assertEquals(1, signedOut)
    }

    @Test fun idleKeepsSessionAndPush() = runTest {
        store.tok = "gms_x"
        http.reply = { tokenReply() }
        api.access(false)
        http.reply = { HttpReply(401, """{"reason":"idle"}""") }
        assertEquals(AccessOutcome.Idle, api.access(true))
        assertEquals(0, signedOut) // push anahtarı ve bildirimler silinmez
        assertEquals("gms_x", store.tok) // çıkış sunucudaki satırı bu belirteçle kapatır
        http.requests.clear()
        http.reply = { tokenReply() }
        assertTrue(api.access(false) is AccessOutcome.Ok)
        assertEquals(1, http.requests.size) // erişim belirteci önbellekten dönmedi
    }

    @Test fun goneReasonWipes() = runTest {
        store.tok = "gms_x"
        http.reply = { HttpReply(401, """{"reason":"gone"}""") }
        assertEquals(AccessOutcome.Gone, api.access(false))
        assertNull(store.tok)
        assertEquals(1, signedOut)
    }

    @Test fun idleActionAsksRelogin() = runTest {
        store.tok = "gms_x"
        http.reply = { HttpReply(401, """{"reason":"idle"}""") }
        assertEquals(ActionOutcome.Auth, api.notifyAction(1, "read"))
        assertEquals(0, signedOut)
    }

    @Test fun logoutAfterIdleClosesSession() = runTest {
        store.tok = "gms_x"
        http.reply = { HttpReply(401, """{"reason":"idle"}""") }
        api.access(false)
        http.requests.clear()
        http.reply = { HttpReply(204, "") }
        api.logout()
        assertTrue(http.requests.first().url.endsWith("/api/mobile/logout"))
        assertEquals(1, signedOut)
    }

    @Test fun networkErrorKeepsSession() = runTest {
        store.tok = "gms_x"
        http.reply = { null }
        api.access(false)
        assertEquals("gms_x", store.tok)
        assertEquals(0, signedOut)
    }

    @Test fun attachmentDownloadUsesStoredOriginAndAccess() = runTest {
        store.tok = "gms_x"
        http.reply = { tokenReply() }
        assertEquals(200, api.downloadAttachment(7, 9, java.io.File("/dev/null")))
        assertEquals("https://posta.example.com/api/attachment/7/9" to "gma_1", http.downloads.single())
    }

    @Test fun attachmentDownload401RefreshesOnce() = runTest {
        store.tok = "gms_x"
        http.reply = { tokenReply() }
        val codes = ArrayDeque(listOf(401, 200))
        http.downloadStatus = { codes.removeFirst() }
        assertEquals(200, api.downloadAttachment(7, 9, java.io.File("/dev/null")))
        assertEquals(2, http.downloads.size)
    }

    @Test fun attachmentDownloadWithoutSession() = runTest {
        assertEquals(401, api.downloadAttachment(7, 9, java.io.File("/dev/null")))
        assertTrue(http.downloads.isEmpty())
    }

    @Test fun loginStoresTokenAndHidesIt() = runTest {
        http.reply = { HttpReply(200, """{"token":"gms_x","user":{"id":1,"username":"ada"}}""") }
        val r = api.login("ada", "p", null) as LoginOutcome.Ok
        assertEquals("gms_x", store.tok)
        assertFalse(r.user.has("token"))
        assertEquals("https://posta.example.com/api/mobile/login", http.requests[0].url)
    }

    @Test fun loginReasons() = runTest {
        http.reply = { HttpReply(401, """{"reason":"bad"}""") }
        assertEquals(LoginOutcome.Failed("bad"), api.login("a", "p", null))
        http.reply = { HttpReply(500, "") }
        assertEquals(LoginOutcome.Failed("network"), api.login("a", "p", null))
        http.reply = { null }
        assertEquals(LoginOutcome.Failed("network"), api.login("a", "p", null))
    }

    @Test fun accessCachedUntilExpiry() = runTest {
        store.tok = "t"
        http.reply = { tokenReply() }
        api.access(false)
        now += 900_000 - 60_001
        api.access(false)
        assertEquals(1, http.requests.size)
        now += 1
        api.access(false)
        assertEquals(2, http.requests.size)
        api.access(true)
        assertEquals(3, http.requests.size)
        assertEquals("t", http.requests[0].bearer)
    }

    @Test fun concurrentAccessSingleRequest() = runTest {
        store.tok = "t"
        http.reply = {
            delay(100)
            tokenReply()
        }
        (1..3).map { async { api.access(false) } }.awaitAll()
        assertEquals(1, http.requests.size)
    }

    @Test fun unauthorizedReturnsGone() = runTest {
        store.tok = "t"
        http.reply = { HttpReply(401, "") }
        assertEquals(AccessOutcome.Gone, api.access(false))
        assertNull(store.tok)
    }

    @Test fun noTokenIsGoneWithoutRequest() = runTest {
        assertEquals(AccessOutcome.Gone, api.access(false))
        assertTrue(http.requests.isEmpty())
    }

    @Test fun networkFailureKeepsToken() = runTest {
        store.tok = "t"
        http.reply = { null }
        assertEquals(AccessOutcome.Network, api.access(false))
        assertEquals("t", store.tok)
    }

    @Test fun dropAccessForcesNewRequest() = runTest {
        store.tok = "t"
        http.reply = { tokenReply() }
        api.access(false)
        api.dropAccess()
        api.access(false)
        assertEquals(2, http.requests.size)
    }

    @Test fun offlineLogoutRetries() = runTest {
        store.tok = "t"
        http.reply = { null }
        api.logout()
        assertNull(store.tok)
        assertEquals(1, signedOut)
        assertEquals("t", store.pending)
        http.reply = { HttpReply(204, "") }
        http.requests.clear()
        api.retryPendingLogout()
        assertNull(store.pending)
        assertEquals("https://posta.example.com/api/mobile/logout", http.requests[0].url)
        assertEquals("t", http.requests[0].bearer)
    }

    @Test fun serverErrorKeepsPendingLogout() = runTest {
        store.pending = "t"
        http.reply = { HttpReply(503, "") }
        api.retryPendingLogout()
        assertEquals("t", store.pending)
    }

    @Test fun abandonSessionGoesToOldServerOnly() = runTest {
        store.tok = "t"
        store.pending = "p"
        http.reply = { HttpReply(204, "") }
        store.origin = "https://yeni.example.com"
        api.abandonSession("https://eski.example.com")
        assertNull(store.tok)
        assertNull(store.pending)
        assertTrue(http.requests.all { it.url.startsWith("https://eski.example.com/") })
        assertEquals(setOf("t", "p"), http.requests.map { it.bearer }.toSet())
    }

    @Test fun notifyAction() = runTest {
        store.tok = "t"
        http.reply = { if (it.url.endsWith("/api/mobile/token")) tokenReply() else HttpReply(204, "") }
        assertEquals(ActionOutcome.Ok, api.notifyAction(7, "read"))
        assertEquals("gma_1", http.requests.last().bearer)
    }

    @Test fun notifyActionAuthWhenSessionGone() = runTest {
        store.tok = "t"
        http.reply = { HttpReply(401, "") }
        assertEquals(ActionOutcome.Auth, api.notifyAction(7, "read"))
    }

    @Test fun notifyActionRefreshesOnce() = runTest {
        store.tok = "t"
        http.reply = { if (it.url.endsWith("/api/mobile/token")) tokenReply() else HttpReply(401, "") }
        assertEquals(ActionOutcome.Auth, api.notifyAction(7, "read"))
        assertEquals(2, http.requests.count { it.url.endsWith("/api/notify/action") })
    }

    @Test fun notifyActionNetworkFailed() = runTest {
        store.tok = "t"
        http.reply = { null }
        assertEquals(ActionOutcome.Failed, api.notifyAction(7, "read"))
    }
}
