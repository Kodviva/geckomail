import Foundation

struct LockConfig: Equatable {
    var enabled: Bool
    var timeoutMs: Int
}

let lockTimeouts = [0, 60_000, 300_000, 900_000]

protocol Authenticating {
    func available() -> Bool
    func prompt(reason: String) async -> Bool
}

/// Kilit kararının yerel kaynağı: JS'e güvenilmez, erişim belirteci buradan geçer (T14). Saat tekdüzedir, cihaz saatiyle oynanamaz.
final class LockGate {
    private let defaults: UserDefaults
    private let clock: () -> Int64
    private let guardLock = NSLock()
    private var current: LockConfig
    private var locked: Bool
    private var backgroundedAt: Int64?
    private var prompting = 0

    /// CLOCK_MONOTONIC uykuda da sayar; systemUptime uykuda durur ve süreyi kısa ölçerdi
    static func monotonicMs() -> Int64 { Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000) }

    init(defaults: UserDefaults = .standard, clock: @escaping () -> Int64 = LockGate.monotonicMs) {
        self.defaults = defaults
        self.clock = clock
        current = LockConfig(enabled: defaults.bool(forKey: "gecko.lock.enabled"), timeoutMs: defaults.integer(forKey: "gecko.lock.timeoutMs"))
        locked = current.enabled
    }

    var config: LockConfig {
        guardLock.lock()
        defer { guardLock.unlock() }
        return current
    }

    var uptimeMs: Int64 { clock() }

    func isLocked() -> Bool {
        guardLock.lock()
        defer { guardLock.unlock() }
        if !locked, current.enabled, let at = backgroundedAt {
            let now = clock()
            locked = now < at || now - at >= Int64(current.timeoutMs)
        }
        return locked
    }

    func didEnterBackground() {
        guardLock.lock()
        defer { guardLock.unlock() }
        if prompting == 0, backgroundedAt == nil { backgroundedAt = clock() }
    }

    func didBecomeForeground() {
        _ = isLocked()
        guardLock.lock()
        backgroundedAt = nil
        guardLock.unlock()
    }

    /// Kimlik sorusu uygulamayı etkin olmayan duruma düşürür: arka plana gitmek sayılmaz
    func beginPrompt() {
        guardLock.lock()
        prompting += 1
        guardLock.unlock()
    }

    func endPrompt() {
        guardLock.lock()
        prompting -= 1
        guardLock.unlock()
    }

    func unlocked() {
        guardLock.lock()
        locked = false
        backgroundedAt = nil
        guardLock.unlock()
    }

    /// Oturum silindi. Kilitliyken yapılan çıkış kilidi de kapatır: açılamayan kilit yeni girişi tutmasın. Kilit açıkken ayar korunur
    func signedOut() {
        guard isLocked() else { return }
        guardLock.lock()
        backgroundedAt = nil
        let next = LockConfig(enabled: false, timeoutMs: current.timeoutMs)
        guardLock.unlock()
        apply(next)
    }

    func weakens(_ next: LockConfig) -> Bool {
        let c = config
        guard c.enabled else { return false }
        return !next.enabled || next.timeoutMs > c.timeoutMs
    }

    /// Kilit açmak o anki oturumu kilitlemez; kapatmak açık kilidi kaldırır
    func apply(_ next: LockConfig) {
        guardLock.lock()
        defer { guardLock.unlock() }
        current = next
        if !next.enabled { locked = false }
        defaults.set(next.enabled, forKey: "gecko.lock.enabled")
        defaults.set(next.timeoutMs, forKey: "gecko.lock.timeoutMs")
    }
}

/// Doğrulama yerel katmanda: zayıflatma JS'in ayrıca sormasına bağlı değildir
func authenticate(gate: LockGate, auth: Authenticating, reason: String) async -> Bool {
    gate.beginPrompt()
    let ok = await auth.prompt(reason: reason)
    gate.endPrompt()
    if ok { gate.unlocked() }
    return ok
}

func setLock(_ next: LockConfig, gate: LockGate, auth: Authenticating, reason: String) async -> Bool {
    guard lockTimeouts.contains(next.timeoutMs) else { return false }
    if gate.weakens(next), !(await authenticate(gate: gate, auth: auth, reason: reason)) { return false }
    gate.apply(next)
    return true
}
