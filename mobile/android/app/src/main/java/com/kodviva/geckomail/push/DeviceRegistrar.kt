package com.kodviva.geckomail.push

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

private const val TOKEN_WAIT_MS = 15_000L
private const val REFRESH_MS = 24 * 3_600_000L

sealed interface RegisterOutcome {
    data class Ok(val id: Long) : RegisterOutcome
    data object Unavailable : RegisterOutcome
    data object Failed : RegisterOutcome
    data object Auth : RegisterOutcome
}

interface DevicePort {
    suspend fun registerDevice(token: String, p256dh: String, auth: String, label: String?): RegisterOutcome
    /** false: sunucuya ulaşılamadı, satır duruyor olabilir */
    suspend fun unregisterDevice(id: Long): Boolean
}

interface PushPrefs {
    var enabled: Boolean
    var deviceToken: String?
    var deviceId: Long
    /** Son giriş yapan kullanıcı; boşta oturumdan sonra başkası girerse önceki kullanıcının izi silinir */
    var userId: Long
    /** Girişten sonraki kayıt sunucuya ulaşmadı: açılışta ve ağ dönünce yeniden denenir */
    var pendingRegister: Boolean
    /** Son başarılı kaydın zamanı: yenileme günde en çok bir kez */
    var lastRegisterAt: Long
    /** Bildirim kapatıldı ama satır sunucuda silinemedi: bu kimlik yeniden denenir */
    var pendingUnregister: Long
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
    override var lastRegisterAt: Long
        get() = prefs.getLong("lastRegisterAt", 0)
        set(v) = prefs.edit().putLong("lastRegisterAt", v).apply()
    override var pendingUnregister: Long
        get() = prefs.getLong("pendingUnregister", 0)
        set(v) = prefs.edit().putLong("pendingUnregister", v).apply()
}

interface FcmGateway {
    fun available(): Boolean
    suspend fun token(): String?
    /** Kapalıyken Firebase kendiliğinden jeton üretmez (manifest varsayılanı); kullanıcı bildirimi açınca etkinleşir */
    fun autoInit(on: Boolean)
}

/** google-services.json yoksa FirebaseApp başlamaz: bildirim yok ama uygulama çökmez */
class SystemFcm(private val ctx: Context) : FcmGateway {
    override fun available(): Boolean = try { FirebaseApp.getApps(ctx).isNotEmpty() } catch (_: Exception) { false }

    override suspend fun token(): String? = withTimeoutOrNull(TOKEN_WAIT_MS) {
        suspendCancellableCoroutine { c ->
            FirebaseMessaging.getInstance().token.addOnCompleteListener { t -> c.resume(if (t.isSuccessful) t.result else null) }
        }
    }

    override fun autoInit(on: Boolean) {
        if (available()) FirebaseMessaging.getInstance().isAutoInitEnabled = on
    }
}

class DeviceRegistrar(
    private val api: DevicePort,
    private val keys: PushKeySource,
    private val prefs: PushPrefs,
    private val label: String?,
    private val gateway: FcmGateway,
    private val onCleared: () -> Unit = {},
    private val onUserChanged: () -> Unit = {},
    private val now: () -> Long = System::currentTimeMillis
) {
    /** Çıkış sürmekte olan kaydı geçersiz kılar: geç gelen yanıt push'u geri açmaz */
    @Volatile private var epoch = 0

    fun available() = gateway.available()
    val enabled get() = prefs.enabled

    suspend fun enable(): RegisterOutcome {
        if (!gateway.available()) return RegisterOutcome.Unavailable
        gateway.autoInit(true)
        val r = gateway.token()?.let { register(it) } ?: RegisterOutcome.Failed
        if (!prefs.enabled) gateway.autoInit(false)
        return r
    }

    suspend fun register(token: String): RegisterOutcome {
        val m = try { keys.loadOrCreate() } catch (_: Exception) { return RegisterOutcome.Failed }
        val mine = epoch
        val r = api.registerDevice(token, m.p256dh, m.auth, label)
        if (r is RegisterOutcome.Ok && mine == epoch) {
            prefs.enabled = true
            prefs.deviceToken = token
            prefs.deviceId = r.id
            prefs.lastRegisterAt = now()
            prefs.pendingUnregister = 0
        }
        return r
    }

    /** Oturum yoksa jeton saklanır, girişte bildirilir */
    suspend fun tokenChanged(token: String) {
        if (!prefs.enabled || token == prefs.deviceToken) return
        prefs.deviceToken = token
        prefs.pendingRegister = true
        retryPendingRegister()
    }

    /** Sunucu satırı silmiş olabilir (röle `gone`, süresi dolan kayıt). Bildirim açıksa kayıt günde en çok bir kez yinelenir:
     *  röle motor başına saatte 60 kayıt kabul eder. Saat geri alındıysa da yenilenir */
    suspend fun refreshIfDue() {
        val since = now() - prefs.lastRegisterAt
        if (prefs.enabled && prefs.deviceToken != null && (since < 0 || since >= REFRESH_MS)) {
            if (gateway.available()) {
                gateway.autoInit(true) // önceki sürümden gelen açık kurulum
                gateway.token()?.let { prefs.deviceToken = it }
            }
            prefs.pendingRegister = true
        }
        retryPendingRegister()
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

    /** Bekleme denemeden önce yazılır: ağ yoksa ya da süreç ölürse satır sonraki açılışta silinir */
    suspend fun disable() {
        val id = prefs.deviceId
        if (id > 0) prefs.pendingUnregister = id
        retryPendingUnregister()
        gateway.autoInit(false)
        clearPush()
    }

    /** Bu arada bildirim yeniden açıldıysa kayıt bekleyen işi siler */
    suspend fun retryPendingUnregister() {
        val id = prefs.pendingUnregister
        if (id > 0 && api.unregisterDevice(id) && prefs.pendingUnregister == id) prefs.pendingUnregister = 0
    }

    /** Çıkışta push anahtarı gider, son kullanıcı unutulur */
    fun clear() {
        prefs.userId = 0
        gateway.autoInit(false)
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
