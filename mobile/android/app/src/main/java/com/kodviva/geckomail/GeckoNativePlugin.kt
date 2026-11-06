package com.kodviva.geckomail

import android.Manifest
import android.net.Uri
import android.util.Base64
import android.view.WindowManager
import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PermissionState
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.kodviva.geckomail.push.RegisterOutcome
import com.kodviva.geckomail.push.needsNotificationPermission

private const val NOTIFY_PERMISSION = "notifications"

/** JS yüzeyi. Uzun ömürlü oturum belirteci hiçbir yöntemden dönmez; erişim belirteci yalnız kilit açıkken verilir (T14) */
@CapacitorPlugin(name = "GeckoNative", permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = NOTIFY_PERMISSION)])
class GeckoNativePlugin : Plugin() {
    private val s get() = AppServices.get(context)
    private val auth get() = s.authOverride ?: SystemAuthenticator(activity)
    private val reason get() = context.getString(R.string.faceid_reason)

    /** Bridge burada henüz sayfayı yüklemedi: kapı ilk belgeden önce kurulur */
    override fun load() {
        BridgeGate.install(bridge)
        s.opens.setListener { notifyListeners("open", it.toJs(), true) }
        s.onShare = { notifyListeners("share", JSObject(), true) }
    }

    private fun result(vararg pairs: Pair<String, Any?>) = JSObject().apply { pairs.forEach { (k, v) -> put(k, v) } }

    @PluginMethod fun getServer(call: PluginCall) = call.resolve(result("origin" to (s.store.origin ?: org.json.JSONObject.NULL)))

    @PluginMethod fun setServer(call: PluginCall) {
        val origin = call.getString("origin")
        if (origin == null || !allowedServer(origin)) return call.reject("origin")
        val old = s.store.origin
        s.store.origin = origin
        if (old == null || old == origin) return call.resolve()
        s.scope.launch {
            s.api.abandonSession(old)
            call.resolve()
        }
    }

    @PluginMethod fun login(call: PluginCall) {
        val username = call.getString("username")
        val password = call.getString("password")
        if (username == null || password == null) return call.reject("invalid")
        s.scope.launch {
            when (val r = s.api.login(username, password, call.getString("totp"))) {
                is LoginOutcome.Ok -> {
                    s.registrar.signedIn(r.user.optLong("id", 0))
                    s.registrar.reregisterAfterLogin()
                    s.registrar.retryPendingUnregister()
                    call.resolve(result("ok" to true, "user" to r.user))
                }
                is LoginOutcome.Failed -> call.resolve(result("ok" to false, "reason" to r.reason))
            }
        }
    }

    @PluginMethod fun accessToken(call: PluginCall) {
        s.scope.launch {
            if (s.lock.isLocked()) {
                s.api.dropAccess()
                return@launch call.resolve(result("status" to "locked"))
            }
            val r = s.api.access(call.getBoolean("force", false) == true)
            if (s.lock.isLocked()) { // yenileme sürerken kilitlendi
                s.api.dropAccess()
                return@launch call.resolve(result("status" to "locked"))
            }
            call.resolve(
                when (r) {
                    is AccessOutcome.Ok -> result("status" to "ok", "token" to r.token, "expiresAt" to r.expiresAt)
                    AccessOutcome.Gone, AccessOutcome.Idle -> result("status" to "gone") // arayüz için ikisi de giriş ekranı
                    AccessOutcome.Network -> result("status" to "network")
                }
            )
        }
    }

    @PluginMethod fun logout(call: PluginCall) {
        s.scope.launch {
            s.api.logout()
            activity.applySecureFlag(s.lock.config.enabled)
            call.resolve()
        }
    }

    @PluginMethod fun registerPush(call: PluginCall) {
        if (!s.registrar.available()) return call.resolve(result("status" to "unavailable"))
        if (needsNotificationPermission && getPermissionState(NOTIFY_PERMISSION) != PermissionState.GRANTED) {
            return requestPermissionForAlias(NOTIFY_PERMISSION, call, "notifyPermissionAnswered")
        }
        enablePush(call)
    }

    @PermissionCallback private fun notifyPermissionAnswered(call: PluginCall) {
        if (getPermissionState(NOTIFY_PERMISSION) == PermissionState.GRANTED) enablePush(call) else call.resolve(result("status" to "denied"))
    }

    private fun enablePush(call: PluginCall) {
        s.scope.launch {
            val status = when (s.registrar.enable()) {
                is RegisterOutcome.Ok -> "on"
                RegisterOutcome.Unavailable -> "unavailable"
                RegisterOutcome.Failed, RegisterOutcome.Auth -> "failed"
            }
            call.resolve(result("status" to status))
        }
    }

    @PluginMethod fun unregisterPush(call: PluginCall) {
        s.scope.launch {
            s.registrar.disable()
            call.resolve()
        }
    }

    /** İzin hiç sorulmadıysa "denied" değildir: anahtar açılınca sorulur */
    @PluginMethod fun pushStatus(call: PluginCall) {
        val allowed = NotificationManagerCompat.from(context).areNotificationsEnabled()
        val state = if (needsNotificationPermission) getPermissionState(NOTIFY_PERMISSION) else null
        val denied = state == PermissionState.DENIED || (!allowed && (state == null || state == PermissionState.GRANTED))
        val status = when {
            !s.registrar.available() -> "unavailable"
            denied -> "denied"
            s.registrar.enabled -> "on"
            else -> "off"
        }
        call.resolve(result("status" to status))
    }

    @PluginMethod fun biometricAvailable(call: PluginCall) = call.resolve(result("available" to auth.available()))

    @PluginMethod fun promptBiometric(call: PluginCall) {
        val text = call.getString("reason") ?: reason
        s.scope.launch { call.resolve(result("ok" to authenticate(s.lock, auth, text))) }
    }

    @PluginMethod fun getLock(call: PluginCall) {
        val c = s.lock.config
        call.resolve(result("enabled" to c.enabled, "timeoutMs" to c.timeoutMs, "locked" to s.lock.isLocked(), "uptimeMs" to s.lock.uptimeMs))
    }

    @PluginMethod fun setLock(call: PluginCall) {
        val enabled = call.getBoolean("enabled")
        val timeoutMs = call.getInt("timeoutMs")
        if (enabled == null || timeoutMs == null) return call.reject("invalid")
        s.scope.launch {
            if (setLock(LockConfig(enabled, timeoutMs), s.lock, auth, reason)) {
                activity.applySecureFlag(enabled)
                call.resolve()
            } else call.reject("denied")
        }
    }

    /** Yol ve sunucu yerelde kurulur, istekten adres alınmaz (T4) */
    @PluginMethod fun openAttachment(call: PluginCall) {
        val messageId = call.data.optLong("messageId")
        val attachmentId = call.data.optLong("attachmentId")
        if (messageId <= 0 || attachmentId <= 0) return call.reject("invalid")
        if (s.lock.isLocked()) return call.reject("locked")
        s.scope.launch {
            val file = s.attachments.newFile(call.getString("name") ?: "")
            val status = s.api.downloadAttachment(messageId, attachmentId, file)
            when {
                status != 200 -> call.reject("status:$status")
                s.lock.isLocked() -> { // indirme sürerken kilitlendi
                    file.delete()
                    call.reject("locked")
                }
                activity.viewFile(file) -> call.resolve()
                else -> call.reject("noApp")
            }
        }
    }

    @PluginMethod fun saveBytes(call: PluginCall) {
        val data = call.getString("base64")?.let { try { Base64.decode(it, Base64.DEFAULT) } catch (_: IllegalArgumentException) { null } }
            ?: return call.resolve(result("ok" to false))
        s.scope.launch {
            val file = s.attachments.newFile(call.getString("name") ?: "")
            withContext(Dispatchers.IO) { file.writeBytes(data) }
            call.resolve(result("ok" to activity.shareFile(file)))
        }
    }

    @PluginMethod fun takePending(call: PluginCall) {
        val opens = JSArray()
        s.opens.take().forEach { opens.put(it.toJs()) }
        s.scope.launch {
            val shares = JSArray()
            withContext(Dispatchers.IO) { s.shares.take() }.forEach { shares.put(shareJs(it)) }
            call.resolve(result("opens" to opens, "shares" to shares))
        }
    }

    @PluginMethod fun sharesDone(call: PluginCall) {
        s.scope.launch {
            withContext(Dispatchers.IO) { s.shares.finish() }
            call.resolve()
        }
    }

    private fun shareJs(sh: Share): JSObject {
        val files = JSArray()
        sh.files.forEach { f -> files.put(result("name" to f.name, "uploadPath" to sh.uploadPath(f), "mime" to (f.mime ?: org.json.JSONObject.NULL))) }
        return result("files" to files, "text" to (sh.text ?: org.json.JSONObject.NULL), "skipped" to sh.skipped)
    }

    private fun allowedServer(origin: String): Boolean {
        val u = Uri.parse(origin)
        if (u.host.isNullOrEmpty() || !u.path.isNullOrEmpty() || u.query != null || u.userInfo != null) return false
        if (BuildConfig.DEBUG && u.scheme == "http" && (u.host == "localhost" || u.host == "10.0.2.2")) return true
        return u.scheme == "https"
    }
}

fun android.app.Activity.applySecureFlag(on: Boolean) {
    if (on) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
}
