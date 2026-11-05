package com.kodviva.geckomail

import kotlinx.coroutines.CompletableDeferred
import com.kodviva.geckomail.push.DevicePort
import com.kodviva.geckomail.push.RegisterOutcome
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

sealed interface LoginOutcome {
    data class Ok(val user: JSONObject) : LoginOutcome
    data class Failed(val reason: String) : LoginOutcome
}

sealed interface AccessOutcome {
    data class Ok(val token: String, val expiresAt: Long) : AccessOutcome
    data object Gone : AccessOutcome
    /** Oturum boşta: push sürer, giriş istenir. Belirteç durur, çıkış sunucudaki satırı onunla kapatır (Review Focus 1) */
    data object Idle : AccessOutcome
    data object Network : AccessOutcome
}

enum class ActionOutcome { Ok, Auth, Failed }

data class HttpReply(val status: Int, val body: String)

/** null: ağ hatası */
interface HttpPort {
    suspend fun post(url: String, bearer: String?, json: String?): HttpReply?
    suspend fun delete(url: String, bearer: String?): HttpReply?
    /** Gövde dosyaya yazılır; hata gövdesi yazılmaz. Dönen HTTP durumu, null: ağ hatası */
    suspend fun download(url: String, bearer: String?, dest: File): Int?
}

private val LOGIN_REASONS = setOf("bad", "locked", "totpRequired", "totpBad", "totpSetupRequired")
private const val REFRESH_MARGIN_MS = 60_000L

/** Sunucuyla yerel konuşma: Origin taşımaz, belirteç yalnız seçili sunucuya gider */
class SessionApi(
    private val store: TokenStore,
    private val http: HttpPort,
    private val now: () -> Long = System::currentTimeMillis,
    private val onSignedOut: () -> Unit = {}
) : DevicePort {
    private val guard = Any()
    private var cached: AccessOutcome.Ok? = null
    private var inflight: CompletableDeferred<AccessOutcome>? = null
    private var epoch = 0

    private suspend fun post(path: String, bearer: String?, json: JSONObject?, base: String? = store.origin): HttpReply? =
        base?.let { http.post(it + path, bearer, json?.toString()) }

    suspend fun login(username: String, password: String, totp: String?): LoginOutcome {
        val body = JSONObject().put("username", username).put("password", password)
        if (totp != null) body.put("totp", totp)
        val r = post("/api/mobile/login", null, body) ?: return LoginOutcome.Failed("network")
        val data = try { JSONObject(r.body) } catch (_: Exception) { null }
        val token = data?.opt("token") as? String
        val user = data?.optJSONObject("user")
        if (r.status == 200 && token != null && user != null) {
            store.saveToken(token)
            dropAccess()
            return LoginOutcome.Ok(user)
        }
        val reason = data?.opt("reason") as? String
        return LoginOutcome.Failed(if (reason in LOGIN_REASONS) reason!! else "network")
    }

    /** Eşzamanlı çağrılar tek isteğe düşer */
    suspend fun access(force: Boolean): AccessOutcome {
        val mine = CompletableDeferred<AccessOutcome>()
        var other: CompletableDeferred<AccessOutcome>? = null
        var hit: AccessOutcome.Ok? = null
        var mineEpoch = 0
        synchronized(guard) {
            other = inflight
            val c = cached
            if (other == null) {
                if (!force && c != null && now() < c.expiresAt - REFRESH_MARGIN_MS) hit = c
                else {
                    inflight = mine
                    mineEpoch = epoch
                }
            }
        }
        other?.let { return it.await() }
        hit?.let { return it }
        val r = fetchAccess()
        // kilit ya da çıkış sürmekte olan yenilemeyi geçersiz kılar
        val out = synchronized(guard) {
            if (inflight === mine) inflight = null
            if (mineEpoch != epoch) AccessOutcome.Network
            else {
                cached = r as? AccessOutcome.Ok
                r
            }
        }
        mine.complete(out)
        return out
    }

    fun dropAccess() = synchronized(guard) {
        epoch++
        inflight = null
        cached = null
    }

    private suspend fun fetchAccess(): AccessOutcome {
        val token = store.token() ?: return AccessOutcome.Gone
        val r = post("/api/mobile/token", token, null) ?: return AccessOutcome.Network
        if (r.status == 401) {
            val reason = try { JSONObject(r.body).opt("reason") } catch (_: Exception) { null }
            if (reason == "idle") return AccessOutcome.Idle
            store.clear()
            onSignedOut() // kilit dışında: bitiş yolu ne olursa olsun push anahtarı ve bildirimler gider
            return AccessOutcome.Gone
        }
        if (r.status != 200) return AccessOutcome.Network
        val d = try { JSONObject(r.body) } catch (_: Exception) { return AccessOutcome.Network }
        val access = d.opt("accessToken") as? String ?: return AccessOutcome.Network
        val at = d.optLong("expiresAt", 0)
        return if (at > 0) AccessOutcome.Ok(access, at) else AccessOutcome.Network
    }

    /** Önce yerel oturum gider, sonra sunucu: ağ yoksa belirteç bekleyen çıkış olarak kalır */
    suspend fun logout() {
        store.token()?.let(store::setPendingLogout)
        store.clear()
        dropAccess()
        onSignedOut()
        retryPendingLogout()
    }

    suspend fun retryPendingLogout() {
        val t = store.pendingLogout() ?: return
        val r = post("/api/mobile/logout", t, null) ?: return
        if (r.status == 204 || r.status == 401) store.takePendingLogout()
    }

    /** Sunucu değişince bekleyen belirteç yeni sunucuya gitmesin: eski adrese bir kez denenir ve bırakılır */
    suspend fun abandonSession(oldOrigin: String) {
        val tokens = listOfNotNull(store.token(), store.takePendingLogout())
        store.clear()
        dropAccess()
        onSignedOut()
        for (t in tokens) post("/api/mobile/logout", t, null, oldOrigin)
    }

    suspend fun notifyAction(messageId: Long, action: String): ActionOutcome {
        var force = false
        repeat(2) {
            val token = when (val a = access(force)) {
                is AccessOutcome.Ok -> a.token
                AccessOutcome.Gone, AccessOutcome.Idle -> return ActionOutcome.Auth
                AccessOutcome.Network -> return ActionOutcome.Failed
            }
            val body = JSONObject().put("messageId", messageId).put("action", action)
            val r = post("/api/notify/action", token, body) ?: return ActionOutcome.Failed
            if (r.status != 401) return if (r.status in 200..299) ActionOutcome.Ok else ActionOutcome.Failed
            force = true
        }
        return ActionOutcome.Auth
    }

    /** Yol burada kurulur, JS adres veremez. Dönüş HTTP durumu; 200'de `dest` yazılmıştır */
    suspend fun downloadAttachment(messageId: Long, attachmentId: Long, dest: File): Int {
        val base = store.origin ?: return 0
        var force = false
        repeat(2) {
            val token = when (val a = access(force)) {
                is AccessOutcome.Ok -> a.token
                AccessOutcome.Gone, AccessOutcome.Idle -> return 401
                AccessOutcome.Network -> return 0
            }
            val status = http.download("$base/api/attachment/$messageId/$attachmentId", token, dest) ?: return 0
            if (status != 401) return status
            force = true
        }
        return 401
    }

    override suspend fun registerDevice(token: String, p256dh: String, auth: String, label: String?): RegisterOutcome {
        val body = JSONObject().put("platform", "android").put("env", "production").put("token", token).put("p256dh", p256dh).put("auth", auth)
        if (label != null) body.put("label", label)
        var force = false
        repeat(2) {
            val access = when (val a = access(force)) {
                is AccessOutcome.Ok -> a.token
                AccessOutcome.Gone, AccessOutcome.Idle -> return RegisterOutcome.Auth
                AccessOutcome.Network -> return RegisterOutcome.Failed
            }
            val r = post("/api/mobile/device", access, body) ?: return RegisterOutcome.Failed
            if (r.status != 401) {
                val id = try { JSONObject(r.body).optLong("id", 0) } catch (_: Exception) { 0 }
                return when {
                    r.status == 200 && id > 0 -> RegisterOutcome.Ok(id)
                    r.status == 409 || r.status == 404 -> RegisterOutcome.Unavailable
                    else -> RegisterOutcome.Failed
                }
            }
            force = true
        }
        return RegisterOutcome.Auth
    }

    override suspend fun unregisterDevice(id: Long) {
        val a = access(false) as? AccessOutcome.Ok ?: return
        store.origin?.let { http.delete("$it/api/push/devices/$id", a.token) }
    }
}

class UrlHttp : HttpPort {
    override suspend fun post(url: String, bearer: String?, json: String?) = send("POST", url, bearer, json)

    override suspend fun delete(url: String, bearer: String?) = send("DELETE", url, bearer, null)

    override suspend fun download(url: String, bearer: String?, dest: File): Int? = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.connectTimeout = 20_000
            c.readTimeout = 60_000
            c.instanceFollowRedirects = false
            if (bearer != null) c.setRequestProperty("Authorization", "Bearer $bearer")
            val status = c.responseCode
            if (status == 200) c.inputStream.use { input -> dest.outputStream().use(input::copyTo) }
            status
        } catch (_: IOException) {
            dest.delete()
            null
        }
    }

    private suspend fun send(method: String, url: String, bearer: String?, json: String?): HttpReply? = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.requestMethod = method
            c.connectTimeout = 20_000
            c.readTimeout = 20_000
            c.instanceFollowRedirects = false // belirteç başka adrese taşınmaz
            if (bearer != null) c.setRequestProperty("Authorization", "Bearer $bearer")
            if (json != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(json.toByteArray()) }
            }
            val status = c.responseCode
            val stream = if (status < 400) c.inputStream else c.errorStream
            HttpReply(status, stream?.use { it.readBytes().decodeToString() } ?: "")
        } catch (_: IOException) {
            null
        }
    }
}
