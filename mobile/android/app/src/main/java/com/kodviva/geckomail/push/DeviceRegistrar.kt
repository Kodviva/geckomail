package com.kodviva.geckomail.push

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

private const val TOKEN_WAIT_MS = 15_000L

sealed interface RegisterOutcome {
    data class Ok(val id: Long) : RegisterOutcome
    data object Unavailable : RegisterOutcome
    data object Failed : RegisterOutcome
    data object Auth : RegisterOutcome
}

interface DevicePort {
    suspend fun registerDevice(token: String, p256dh: String, auth: String, label: String?): RegisterOutcome
    suspend fun unregisterDevice(id: Long)
}

interface PushPrefs {
    var enabled: Boolean
    var deviceToken: String?
    var deviceId: Long
    /** Son giriş yapan kullanıcı; boşta oturumdan sonra başkası girerse önceki kullanıcının izi silinir */
    var userId: Long
    /** Girişten sonraki kayıt sunucuya ulaşmadı: açılışta ve ağ dönünce yeniden denenir */
    var pendingRegister: Boolean
}

class StoredPushPrefs(ctx: Context) : PushPrefs {
    private val prefs = ctx.getSharedPreferences("gecko.push", Context.MODE_PRIVATE)
    override var enabled: Boolean
        get() = prefs.getBoolean("enabled", false)
        set(v) = prefs.edit().putBoolean("enabled", v).apply()
    override var deviceToken: String?
        get() = prefs.getString("deviceToken", null)
        set(v) = prefs.edit().putString("deviceToken", v).apply()
    override var deviceId: Long
        get() = prefs.getLong("deviceId", 0)
        set(v) = prefs.edit().putLong("deviceId", v).apply()
    override var userId: Long
        get() = prefs.getLong("userId", 0)
        set(v) = prefs.edit().putLong("userId", v).apply()
    override var pendingRegister: Boolean
        get() = prefs.getBoolean("pendingRegister", false)
        set(v) = prefs.edit().putBoolean("pendingRegister", v).apply()
}

interface FcmGateway {
    fun available(): Boolean
    suspend fun token(): String?
}

/** google-services.json yoksa FirebaseApp başlamaz: bildirim yok ama uygulama çökmez */
class SystemFcm(private val ctx: Context) : FcmGateway {
    override fun available(): Boolean = try { FirebaseApp.getApps(ctx).isNotEmpty() } catch (_: Exception) { false }

    override suspend fun token(): String? = withTimeoutOrNull(TOKEN_WAIT_MS) {
        suspendCancellableCoroutine { c ->
            FirebaseMessaging.getInstance().token.addOnCompleteListener { t -> c.resume(if (t.isSuccessful) t.result else null) }
        }
    }
}

class DeviceRegistrar(
    private val api: DevicePort,
    private val keys: PushKeySource,
    private val prefs: PushPrefs,
    private val label: String?,
    private val gateway: FcmGateway,
    private val onCleared: () -> Unit = {},
    private val onUserChanged: () -> Unit = {}
) {
    /** Çıkış sürmekte olan kaydı geçersiz kılar: geç gelen yanıt push'u geri açmaz */
    @Volatile private var epoch = 0

    fun available() = gateway.available()
    val enabled get() = prefs.enabled

    suspend fun enable(): RegisterOutcome {
        if (!gateway.available()) return RegisterOutcome.Unavailable
        return register(gateway.token() ?: return RegisterOutcome.Failed)
    }

    suspend fun register(token: String): RegisterOutcome {
        val m = try { keys.loadOrCreate() } catch (_: Exception) { return RegisterOutcome.Failed }
        val mine = epoch
        val r = api.registerDevice(token, m.p256dh, m.auth, label)
        if (r is RegisterOutcome.Ok && mine == epoch) {
            prefs.enabled = true
            prefs.deviceToken = token
            prefs.deviceId = r.id
        }
        return r
    }

    /** Oturum yoksa jeton saklanır, girişte bildirilir */
    suspend fun tokenChanged(token: String) {
        if (!prefs.enabled || token == prefs.deviceToken) return
        prefs.deviceToken = token
        register(token)
    }

    /** Giriş kaydından önce çağrılır. Başka kullanıcı girdiyse önceki kullanıcının görünen bildirimleri ve push anahtarı gider,
     *  bildirim tercihi kalır: sonraki kayıt yeni anahtarı bildirir. Aynı kullanıcıda hiçbir şey değişmez.
     *  Önceki kullanıcı biliniyorsa (boşta kalmış oturum) bekleyen paylaşımları ve ek önbelleği de gider; çıkıştan sonra
     *  yapılan paylaşım kimsenin değildir, kalır */
    fun signedIn(userId: Long) {
        val last = prefs.userId
        prefs.userId = userId
        if (last == userId) return
        keys.delete()
        onCleared()
        if (last != 0L) onUserChanged()
    }

    /** Yeniden girişte aynı cihaz yeni oturuma geçer (Görev 3 reregister after idle). Bekleme denemeden önce yazılır:
     *  süreç deneme sırasında ölse de sonraki açılış tamamlar */
    suspend fun reregisterAfterLogin() {
        if (!prefs.enabled || prefs.deviceToken == null) return
        prefs.pendingRegister = true
        retryPendingRegister()
    }

    /** Ağ hatasında bekleme sürer; röle kapalıysa yeniden denemenin anlamı yok. Oturum yoksa sıradaki giriş yine kaydeder */
    suspend fun retryPendingRegister() {
        if (!prefs.pendingRegister) return
        val token = prefs.deviceToken
        if (!prefs.enabled || token == null) {
            prefs.pendingRegister = false
            return
        }
        when (register(token)) {
            is RegisterOutcome.Ok, RegisterOutcome.Unavailable -> prefs.pendingRegister = false
            RegisterOutcome.Failed, RegisterOutcome.Auth -> Unit
        }
    }

    suspend fun disable() {
        val id = prefs.deviceId
        if (id > 0) api.unregisterDevice(id)
        clearPush()
    }

    /** Çıkışta push anahtarı gider, son kullanıcı unutulur */
    fun clear() {
        prefs.userId = 0
        clearPush()
    }

    /** Push anahtarı gider: gelen kutular çözülemez, nötr metin gösterilir. Son kullanıcı kalır: başkası girerse eski verisi silinir */
    private fun clearPush() {
        epoch++
        prefs.pendingRegister = false
        prefs.enabled = false
        prefs.deviceToken = null
        prefs.deviceId = 0
        keys.delete()
        onCleared()
    }
}
