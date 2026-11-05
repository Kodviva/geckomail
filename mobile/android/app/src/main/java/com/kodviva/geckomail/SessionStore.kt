package com.kodviva.geckomail

import android.content.Context
import android.util.Base64

interface TokenStore {
    var origin: String?
    fun saveToken(t: String)
    fun token(): String?
    fun clear()
    fun setPendingLogout(t: String)
    fun pendingLogout(): String?
    fun takePendingLogout(): String?
}

/** Uzun ömürlü mobil oturum belirteci yalnız mühürlü blob olarak SharedPreferences'ta, JS'e hiç verilmez */
class SessionStore(ctx: Context) : TokenStore, LockPrefs {
    private val prefs = ctx.getSharedPreferences("gecko.session", Context.MODE_PRIVATE)
    private val box = KeystoreBox()

    override var origin: String?
        get() = prefs.getString("server", null)
        set(v) = prefs.edit().putString("server", v).apply()

    override var config: LockConfig
        get() = LockConfig(prefs.getBoolean("lock.enabled", false), prefs.getInt("lock.timeoutMs", 0))
        set(v) = prefs.edit().putBoolean("lock.enabled", v.enabled).putInt("lock.timeoutMs", v.timeoutMs).apply()

    override fun saveToken(t: String) = write("token", t)
    override fun token(): String? = read("token")
    override fun clear() = prefs.edit().remove("token").apply()
    override fun setPendingLogout(t: String) = write("pendingLogout", t)
    override fun pendingLogout(): String? = read("pendingLogout")
    override fun takePendingLogout(): String? = pendingLogout().also { prefs.edit().remove("pendingLogout").apply() }

    private fun write(key: String, value: String) {
        // commit: belirteç süreç ölümünde kaybolmasın
        prefs.edit().putString(key, Base64.encodeToString(box.seal(value.toByteArray()), Base64.NO_WRAP)).commit()
    }

    private fun read(key: String): String? {
        val blob = prefs.getString(key, null) ?: return null
        return box.open(Base64.decode(blob, Base64.NO_WRAP))?.let { String(it) }
    }
}
