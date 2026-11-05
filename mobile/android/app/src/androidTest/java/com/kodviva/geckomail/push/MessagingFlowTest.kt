// Veri mesajı işleyicisi gerçek Keystore, gerçek şifre çözme ve gerçek NotificationManager ile. Gerçek FCM teslimi burada sınanmaz.
package com.kodviva.geckomail.push

import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.runBlocking
import com.kodviva.geckomail.AccessOutcome
import com.kodviva.geckomail.AppServices
import com.kodviva.geckomail.HttpPort
import com.kodviva.geckomail.HttpReply
import com.kodviva.geckomail.LockConfig
import com.kodviva.geckomail.MainActivity
import com.kodviva.geckomail.R
import com.kodviva.geckomail.SessionApi
import com.kodviva.geckomail.TokenStore
import com.kodviva.geckomail.SharedItem
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPrivateKeySpec

/** Her isteğe 401: oturum sunucuda bitti */
private object RefuseAll : HttpPort {
    override suspend fun post(url: String, bearer: String?, json: String?) = HttpReply(401, "")
    override suspend fun delete(url: String, bearer: String?) = HttpReply(401, "")
    override suspend fun download(url: String, bearer: String?, dest: java.io.File) = 401
}

private class Harness(ctx: Context) : GeckoMessagingService() {
    init { attachBaseContext(ctx) }
}

@RunWith(AndroidJUnit4::class)
class MessagingFlowTest {
    private val ctx: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val s get() = AppServices.get(ctx)
    private val nm get() = ctx.getSystemService(NotificationManager::class.java)

    private fun vector(name: String): JSONObject {
        val text = InstrumentationRegistry.getInstrumentation().context.assets.open("push-vectors.json").use { it.readBytes().decodeToString() }
        val a = JSONObject(text).getJSONArray("vectors")
        return (0 until a.length()).map(a::getJSONObject).first { it.getString("name") == name }
    }

    private fun bytes(v: JSONObject, k: String) = base64UrlDecode(v.getString(k))!!

    private fun install(v: JSONObject) {
        val p = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
        val spec = ECPrivateKeySpec(BigInteger(1, bytes(v, "uaPrivate")), p.getParameterSpec(ECParameterSpec::class.java))
        s.pushKeys.save(Material(bytes(v, "uaPublic"), bytes(v, "auth"), KeyFactory.getInstance("EC").generatePrivate(spec)))
    }

    private fun deliver(box: String) = Harness(ctx).onMessageReceived(RemoteMessage.Builder("test@fcm.googleapis.com").addData("c", box).build())

    private fun waitFor(check: () -> Boolean): Boolean {
        repeat(50) {
            if (check()) return true
            Thread.sleep(100)
        }
        return check()
    }

    @Before fun setUp() {
        InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("pm grant ${ctx.packageName} android.permission.POST_NOTIFICATIONS").close()
        Thread.sleep(300)
        nm.cancelAll()
        s.foreground = false
    }

    @After fun tearDown() {
        nm.cancelAll()
        s.pushKeys.delete()
    }

    @Test fun keysRoundTripThroughKeystore() {
        val made = s.pushKeys.loadOrCreate()
        val again = s.pushKeys.load()!!
        assertEquals(made.p256dh, again.p256dh)
        assertEquals(made.auth, again.auth)
        assertEquals(65, base64UrlDecode(made.p256dh)!!.size)
        assertEquals(16, base64UrlDecode(made.auth)!!.size)
        s.pushKeys.delete()
        assertNull(s.pushKeys.load())
    }

    @Test fun dataMessagePostsDecryptedNotification() {
        val v = vector("gecko-normal-turkish")
        install(v)
        deliver(v.getString("body"))
        assertTrue(waitFor { nm.activeNotifications.any { !it.notification.group.isNullOrEmpty() && it.id == NOTIFICATION_MESSAGE } })
        val n = nm.activeNotifications.first { it.id == NOTIFICATION_MESSAGE }
        val shown = JSONObject(bytes(v, "plaintext").decodeToString().trim())
        assertEquals(shown.getString("title"), n.notification.extras.getCharSequence("android.title").toString())
        assertEquals(shown.getString("body"), n.notification.extras.getCharSequence("android.text").toString())
        assertEquals("mail_normal", n.notification.channelId)
        assertEquals("acct-3", n.notification.group)
        assertEquals(3, n.notification.actions.size)
        assertTrue(nm.activeNotifications.any { it.id == NOTIFICATION_GROUP && it.notification.group == "acct-3" })
    }

    @Test fun urgentUsesUrgentChannel() {
        val v = vector("gecko-urgent-emoji")
        install(v)
        deliver(v.getString("body"))
        assertTrue(waitFor { nm.activeNotifications.any { it.id == NOTIFICATION_MESSAGE } })
        assertEquals("mail_urgent", nm.activeNotifications.first { it.id == NOTIFICATION_MESSAGE }.notification.channelId)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, nm.getNotificationChannel("mail_urgent").importance)
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, nm.getNotificationChannel("mail_normal").importance)
    }

    @Test fun badCiphertextShowsFallback() {
        val v = vector("gecko-normal-turkish")
        install(v)
        val body = bytes(v, "body")
        body[body.size - 1] = (body[body.size - 1] + 1).toByte()
        deliver(base64UrlEncode(body))
        assertTrue(waitFor { nm.activeNotifications.isNotEmpty() })
        val n = nm.activeNotifications.single().notification
        assertEquals(ctx.getString(R.string.push_fallback), n.extras.getCharSequence("android.text").toString())
        assertNull(n.extras.getCharSequence("android.title"))
        assertNull(n.actions)
    }

    @Test fun foregroundSuppresses() {
        val v = vector("gecko-normal-turkish")
        install(v)
        s.foreground = true
        deliver(v.getString("body"))
        Thread.sleep(500)
        assertEquals(0, nm.activeNotifications.size)
    }

    @Test fun logoutWipesPushKeyAndNotifications() {
        val v = vector("gecko-normal-turkish")
        install(v)
        deliver(v.getString("body"))
        assertTrue(waitFor { nm.activeNotifications.isNotEmpty() })
        val cached = s.attachments.newFile("x.pdf").apply { writeText("veri") }
        s.shares.accept(listOf(SharedItem("a", null) { "v".byteInputStream() }), null)
        runBlocking { s.api.logout() }
        assertNull(s.pushKeys.load())
        assertFalse(cached.exists())
        assertFalse(s.shares.hasPending())
        assertTrue(waitFor { nm.activeNotifications.isEmpty() })
    }

    private fun seen(run: () -> Unit): List<OpenRequest> {
        val out = java.util.concurrent.CopyOnWriteArrayList<OpenRequest>()
        s.opens.observer = { out += it }
        try { run() } finally { s.opens.observer = null }
        return out.toList()
    }

    @Test fun launcherIgnoresOpenExtras() {
        val i = Intent(ctx, MainActivity::class.java).setAction(Intent.ACTION_MAIN)
        OpenRequest(7, 3, true).writeTo(i)
        assertTrue(seen { ActivityScenario.launch<MainActivity>(i).close() }.isEmpty())
    }

    private fun started(i: Intent): List<OpenRequest> = seen {
        ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        Thread.sleep(1_500)
    }

    @Test fun deepLinkYieldsValidatedOpen() {
        val good = Intent(Intent.ACTION_VIEW, Uri.parse("geckomail://open?reply=7"), ctx, MainActivity::class.java)
        assertEquals(listOf(OpenRequest(7, null, true)), started(good))
        val evil = Intent(Intent.ACTION_VIEW, Uri.parse("geckomail://open?server=https://evil.example"), ctx, MainActivity::class.java)
        OpenRequest(7, 3, true).writeTo(evil) // ek alanlar da yok sayılır
        assertTrue(started(evil).isEmpty())
    }

    @Test fun trampolineIsPrivateAndDeliversOpen() {
        assertFalse(ctx.packageManager.getActivityInfo(ComponentName(ctx, NotificationOpenActivity::class.java), 0).exported)
        val i = Intent(ctx, NotificationOpenActivity::class.java)
        OpenRequest(7, 3, true).writeTo(i)
        assertEquals(listOf(OpenRequest(7, 3, true)), seen { ActivityScenario.launch<NotificationOpenActivity>(i).close() })
    }

    @Test fun appLockRefusesActionAndOffersApp() {
        s.lock.apply(LockConfig(true, 0))
        s.lock.didEnterBackground()
        try {
            assertTrue(s.lock.isLocked())
            val i = Intent("read").putExtra(EXTRA_MESSAGE, 7L).putExtra(EXTRA_TAG, "t1")
            NotificationActionReceiver().onReceive(ctx, i) // reddedilmezse goAsync bu çağrıda düşerdi
            assertTrue(waitFor { nm.activeNotifications.any { it.tag == "locked" } })
        } finally {
            s.lock.apply(LockConfig(false, 0))
            s.lock.unlocked()
        }
    }

    @Test fun refusedTokenWipesPushKey() {
        val v = vector("gecko-normal-turkish")
        install(v)
        deliver(v.getString("body"))
        assertTrue(waitFor { nm.activeNotifications.isNotEmpty() })
        val store = object : TokenStore {
            override var origin: String? = "https://posta.example.com"
            private var t: String? = "gms_x"
            override fun saveToken(t: String) { this.t = t }
            override fun token() = t
            override fun clear() { t = null }
            override fun setPendingLogout(t: String) {}
            override fun pendingLogout(): String? = null
            override fun takePendingLogout(): String? = null
        }
        val api = SessionApi(store, RefuseAll, onSignedOut = { s.registrar.clear() })
        assertEquals(AccessOutcome.Gone, runBlocking { api.access(false) })
        assertNull(s.pushKeys.load())
        assertTrue(waitFor { nm.activeNotifications.isEmpty() })
    }

    @Test fun missingFirebaseReturnsUnavailable() {
        // google-services.json eklenince bu sınama yerini gerçek cihaz denemesine bırakır
        assumeTrue(ctx.resources.getIdentifier("google_app_id", "string", ctx.packageName) == 0)
        assertFalse(SystemFcm(ctx).available())
        assertEquals(RegisterOutcome.Unavailable, runBlocking { s.registrar.enable() })
    }
}
