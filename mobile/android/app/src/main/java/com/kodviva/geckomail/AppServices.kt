package com.kodviva.geckomail

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import com.kodviva.geckomail.push.DeviceRegistrar
import com.kodviva.geckomail.push.NotificationPoster
import com.kodviva.geckomail.push.PendingOpens
import com.kodviva.geckomail.push.PushHandler
import com.kodviva.geckomail.push.PushKeys
import com.kodviva.geckomail.push.StoredPushPrefs
import com.kodviva.geckomail.push.SystemFcm
import java.io.File
import kotlin.coroutines.resume

/** Eklenti ve sonraki görevlerin bildirim yolu aynı oturumu paylaşır */
class AppServices private constructor(ctx: Context) {
    val store = SessionStore(ctx.applicationContext)
    val lock = LockGate(store)
    val api = SessionApi(store, UrlHttp(), onSignedOut = ::signedOut)
    val poster = NotificationPoster(ctx)
    val pushKeys = PushKeys(KeystoreBox("gecko.push"), ctx.applicationContext)
    val attachments = AttachmentCache(File(ctx.applicationContext.cacheDir, "attachments"))
    val shares = ShareInbox(File(ctx.applicationContext.filesDir, "shares"))
    val registrar = DeviceRegistrar(api, pushKeys, StoredPushPrefs(ctx.applicationContext), Build.MODEL, SystemFcm(ctx.applicationContext), poster::clearAll, ::wipeUserFiles)
    val opens = PendingOpens()
    /** Etkinlik görünürken bildirim gösterilmez */
    @Volatile var foreground = false
    val pushHandler = PushHandler(pushKeys::load, poster, { foreground })
    /** Yalnız testte dolu: gerçek istem testi bekletir */
    var authOverride: Authenticating? = null
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** Eklenti bağlıysa arayüze haber verilir; değilse paylaşım takePending ile alınır */
    @Volatile var onShare: (() -> Unit)? = null
    fun shareArrived() { onShare?.invoke() }

    /** Bekleyen paylaşım başka kullanıcıya kalmaz: 24 saatte silinir */
    fun sweepFiles() {
        scope.launch(Dispatchers.IO) {
            attachments.purge()
            shares.sweep()
        }
    }

    init {
        sweepFiles()
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                scope.launch {
                    api.retryPendingLogout()
                    registrar.retryPendingUnregister()
                    registrar.retryPendingRegister()
                }
            }
        })
    }

    private fun wipeUserFiles() {
        attachments.clear()
        shares.clear()
    }

    private fun signedOut() {
        registrar.clear()
        wipeUserFiles()
        lock.signedOut()
    }

    companion object {
        @Volatile private var instance: AppServices? = null
        fun get(ctx: Context): AppServices = instance ?: synchronized(this) { instance ?: AppServices(ctx).also { instance = it } }
    }
}

/** Cihaz parolası da kabul edilir: biyometrisi olmayan cihazda kilit yine çalışır */
class SystemAuthenticator(private val activity: FragmentActivity) : Authenticating {
    private val kinds = BIOMETRIC_WEAK or DEVICE_CREDENTIAL

    override fun available() = BiometricManager.from(activity).canAuthenticate(kinds) == BiometricManager.BIOMETRIC_SUCCESS

    override suspend fun prompt(reason: String): Boolean = suspendCancellableCoroutine { done ->
        val cb = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = done.resume(true)
            override fun onAuthenticationError(code: Int, msg: CharSequence) = done.resume(false)
        }
        val info = BiometricPrompt.PromptInfo.Builder().setTitle(reason).setAllowedAuthenticators(kinds).build()
        BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), cb).authenticate(info)
    }
}
