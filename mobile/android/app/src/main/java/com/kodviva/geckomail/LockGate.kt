package com.kodviva.geckomail

import android.os.SystemClock

data class LockConfig(val enabled: Boolean, val timeoutMs: Int)

val LOCK_TIMEOUTS = listOf(0, 60_000, 300_000, 900_000)

interface LockPrefs { var config: LockConfig }

interface Authenticating {
    fun available(): Boolean
    suspend fun prompt(reason: String): Boolean
}

/** Kilit kararının yerel kaynağı: JS'e güvenilmez, erişim belirteci buradan geçer (T14). elapsedRealtime tekdüzedir, uykuda da sayar */
class LockGate(private val prefs: LockPrefs, private val clock: () -> Long = SystemClock::elapsedRealtime) {
    private var current = prefs.config
    private var locked = current.enabled
    private var backgroundedAt: Long? = null
    private var prompting = 0

    @get:Synchronized val config: LockConfig get() = current
    val uptimeMs: Long get() = clock()

    @Synchronized fun isLocked(): Boolean {
        val at = backgroundedAt
        if (!locked && current.enabled && at != null) {
            val now = clock()
            locked = now < at || now - at >= current.timeoutMs
        }
        return locked
    }

    @Synchronized fun didEnterBackground() {
        if (prompting == 0 && backgroundedAt == null) backgroundedAt = clock()
    }

    @Synchronized fun didBecomeForeground() {
        isLocked()
        backgroundedAt = null
    }

    /** Parola ekranı etkinliği durdurur: arka plana gitmek sayılmaz */
    @Synchronized fun beginPrompt() { prompting++ }
    @Synchronized fun endPrompt() { prompting-- }

    @Synchronized fun unlocked() {
        locked = false
        backgroundedAt = null
    }

    /** Oturum silindi. Kilitliyken yapılan çıkış kilidi de kapatır: açılamayan kilit yeni girişi tutmasın. Kilit açıkken ayar korunur */
    @Synchronized fun signedOut() {
        if (!isLocked()) return
        backgroundedAt = null
        apply(current.copy(enabled = false))
    }

    @Synchronized fun weakens(next: LockConfig): Boolean = current.enabled && (!next.enabled || next.timeoutMs > current.timeoutMs)

    /** Kilit açmak o anki oturumu kilitlemez; kapatmak açık kilidi kaldırır */
    @Synchronized fun apply(next: LockConfig) {
        current = next
        if (!next.enabled) locked = false
        prefs.config = next
    }
}

suspend fun authenticate(gate: LockGate, auth: Authenticating, reason: String): Boolean {
    gate.beginPrompt()
    val ok = try { auth.prompt(reason) } finally { gate.endPrompt() }
    if (ok) gate.unlocked()
    return ok
}

/** Doğrulama yerel katmanda: zayıflatma JS'in ayrıca sormasına bağlı değildir */
suspend fun setLock(next: LockConfig, gate: LockGate, auth: Authenticating, reason: String): Boolean {
    if (next.timeoutMs !in LOCK_TIMEOUTS) return false
    if (gate.weakens(next) && !authenticate(gate, auth, reason)) return false
    gate.apply(next)
    return true
}
