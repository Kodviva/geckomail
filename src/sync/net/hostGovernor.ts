// Host başına tek otorite: bir mail sunucusuna açılan her yeni login (IMAP poll, interaktif iş,
// SMTP gönderim, cihaz senkronu) buradan izin alır. Amaç sunucu gözünde brute-force imzası
// vermemek: login hızını sınırla, başarısız login'i bütçele, sunucu reddettiğinde tüm şeritlerde sus.
// Saf mantık — saat enjekte edilir, testte sahte zamanla sürülür.

export interface GovernorLimits {
  loginsPerMin: number // jeton dolum hızı
  loginBurst: number // kova kapasitesi
  minGapMs: number // ardışık login'ler arası min boşluk
  maxSessions: number // açık (doğrulanmış) oturum tavanı
  authFailPerHour: number // host genelinde başarısız login bütçesi
  preauthWindowMs: number // ban imzası penceresi
  preauthThreshold: number // pencere içinde bu kadar login-öncesi hata → soğuma
  cooldownBaseMs: number
  cooldownMaxMs: number
  limitCooldownMs: number
  limitShrinkMs: number // limit hatası sonrası oturum tavanı bu süre yarıda kalır
  probeTimeoutMs: number // sonda bu sürede sonuç bildirmezse yenisine izin
}

export const DEFAULT_LIMITS: GovernorLimits = {
  loginsPerMin: 8,
  loginBurst: 4,
  minGapMs: 300,
  maxSessions: 48, // uzun ömürlü oturum login churn'ünden çok daha doğal; Dovecot sınırı kullanıcı+IP başına
  authFailPerHour: 2,
  preauthWindowMs: 3 * 60_000,
  preauthThreshold: 3,
  cooldownBaseMs: 5 * 60_000,
  cooldownMaxMs: 60 * 60_000,
  limitCooldownMs: 10 * 60_000,
  limitShrinkMs: 30 * 60_000,
  probeTimeoutMs: 2 * 60_000
}

// WHM/CSF'de IP'miz beyaz listedeyse (Ayarlar → güvenilir sunucu)
export const TRUSTED_LIMITS: GovernorLimits = {
  ...DEFAULT_LIMITS,
  loginsPerMin: 30,
  loginBurst: 10,
  maxSessions: 150
}

// Login denemesinin sonucu — imapClient.classifyError ile aynı sınıflar
export type LoginFailureKind = 'auth' | 'limit' | 'preauth' | 'net' | 'other'
export type Priority = 'interactive' | 'background'

export type LoginGrant =
  | { ok: true }
  | { ok: false; reason: 'rate' | 'cooldown' | 'probe' | 'auth-budget'; waitMs: number }

export interface CooldownEvent {
  kind: 'cooldown'
  reason: 'blocked' | 'limit'
  until: number
  first: boolean // sağlıklıdan soğumaya ilk geçiş (bildirim yalnız bunda)
}

type State = 'ok' | 'cooldown' | 'probing'

const HOUR = 60 * 60_000

export class HostGovernor {
  private tokens: number
  private lastRefill: number
  private lastLoginAt = -Infinity
  private state: State = 'ok'
  private cooldownUntil = 0
  private cooldownReason: 'blocked' | 'limit' = 'blocked'
  private strikes = 0
  private probeStartedAt = 0
  private preauthFails: number[] = []
  private authFails: number[] = []
  private shrinkUntil = 0

  constructor(
    readonly host: string,
    private limits: GovernorLimits,
    private now: () => number = Date.now
  ) {
    this.tokens = limits.loginBurst
    this.lastRefill = now()
  }

  setLimits(limits: GovernorLimits): void {
    this.refill()
    this.limits = limits
    this.tokens = Math.min(this.tokens, limits.loginBurst)
  }

  maxSessions(): number {
    const base = this.limits.maxSessions
    return this.now() < this.shrinkUntil ? Math.max(1, Math.floor(base / 2)) : base
  }

  /** Soğuma/sonda durumunda (yeni login yok) mı? Açık oturumlar bundan etkilenmez. */
  blockedFor(): number {
    const t = this.now()
    if (this.state === 'cooldown' && t < this.cooldownUntil) return this.cooldownUntil - t
    return 0
  }

  /** Host'un başarısız login bütçesi dolduysa kalan süre: Sieve'de doluyken hiçbir hesap denemez */
  authBudgetWait(): number {
    const t = this.now()
    this.authFails = this.authFails.filter((x) => t - x < HOUR)
    return this.authFails.length >= this.limits.authFailPerHour ? this.authFails[0] + HOUR - t : 0
  }

  /**
   * Yeni bir login için izin. `knownGood`: hesap bu şifreyle daha önce başarıyla girdi mi —
   * auth bütçesi aşıldığında yalnızca bunlara izin verilir.
   */
  tryTakeLogin(priority: Priority, knownGood: boolean): LoginGrant {
    const t = this.now()
    this.refill()

    if (this.state === 'cooldown') {
      if (t < this.cooldownUntil) return { ok: false, reason: 'cooldown', waitMs: this.cooldownUntil - t }
      this.state = 'probing'
      this.probeStartedAt = 0
    }
    if (this.state === 'probing') {
      if (this.probeStartedAt && t - this.probeStartedAt < this.limits.probeTimeoutMs) {
        return { ok: false, reason: 'probe', waitMs: 5000 }
      }
      // tek sonda: jeton/boşluk kontrolü yok, sonucu onLoginSuccess/onLoginFailure belirler
      this.probeStartedAt = t
      this.lastLoginAt = t
      return { ok: true }
    }

    if (!knownGood) {
      this.authFails = this.authFails.filter((x) => t - x < HOUR)
      if (this.authFails.length >= this.limits.authFailPerHour) {
        return { ok: false, reason: 'auth-budget', waitMs: this.authFails[0] + HOUR - t }
      }
    }

    const gap = this.lastLoginAt + this.limits.minGapMs - t
    if (gap > 0) return { ok: false, reason: 'rate', waitMs: gap }

    // arka plan son jetonu alamaz: interaktif iş (kullanıcının tıklaması) her zaman öne geçer
    const need = priority === 'background' ? 2 : 1
    if (this.tokens < need) {
      const perMs = this.limits.loginsPerMin / 60_000
      return { ok: false, reason: 'rate', waitMs: Math.ceil((need - this.tokens) / perMs) }
    }
    this.tokens -= 1
    this.lastLoginAt = t
    return { ok: true }
  }

  onLoginSuccess(): void {
    this.strikes = 0
    this.preauthFails = []
    this.state = 'ok'
    this.probeStartedAt = 0
  }

  onLoginFailure(kind: LoginFailureKind): CooldownEvent | null {
    const t = this.now()
    if (kind === 'auth') {
      this.authFails.push(t)
      // sunucu cevap verdi → erişilebilir; ban durumu çözülür
      if (this.state === 'probing') this.onReachable()
      return null
    }
    if (kind === 'limit') {
      this.shrinkUntil = t + this.limits.limitShrinkMs
      return this.enterCooldown('limit', this.limits.limitCooldownMs)
    }
    if (kind === 'preauth' || kind === 'net') {
      if (this.state === 'probing') {
        this.strikes++
        return this.enterCooldown('blocked', this.strikeDuration())
      }
      this.preauthFails = this.preauthFails.filter((x) => t - x < this.limits.preauthWindowMs)
      this.preauthFails.push(t)
      if (this.state === 'ok' && this.preauthFails.length >= this.limits.preauthThreshold) {
        this.strikes = 1
        return this.enterCooldown('blocked', this.strikeDuration())
      }
      return null
    }
    // 'other': sunucu bir şey söyledi → erişilebilir
    if (this.state === 'probing') this.onReachable()
    return null
  }

  /**
   * İnternet geri geldi: kesinti sırasında biriken login-öncesi hatalar ve onların açtığı ilk kademe
   * "olası IP engeli" soğuması affedilir (yanlış alarm). Gerçek engel sürüyorsa sıradaki denemeler
   * yeniden eşiğe ulaşır. Sunucunun "limit" bildirimi ve tekrarlayan kademeler dokunulmaz.
   */
  forgiveNetwork(): boolean {
    this.preauthFails = []
    if (this.state === 'cooldown' && this.cooldownReason === 'blocked' && this.strikes <= 1) {
      this.state = 'ok'
      this.strikes = 0
      this.cooldownUntil = 0
      return true
    }
    return false
  }

  snapshot(): { state: State; cooldownUntil: number; reason: 'blocked' | 'limit'; strikes: number; now: number } {
    return { state: this.state, cooldownUntil: this.cooldownUntil, reason: this.cooldownReason, strikes: this.strikes, now: this.now() }
  }

  private onReachable(): void {
    this.state = 'ok'
    this.strikes = 0
    this.preauthFails = []
    this.probeStartedAt = 0
  }

  private strikeDuration(): number {
    return Math.min(this.limits.cooldownBaseMs * 2 ** (this.strikes - 1), this.limits.cooldownMaxMs)
  }

  private enterCooldown(reason: 'blocked' | 'limit', ms: number): CooldownEvent {
    const first = this.state === 'ok'
    this.state = 'cooldown'
    this.cooldownReason = reason
    this.cooldownUntil = this.now() + ms
    this.probeStartedAt = 0
    this.preauthFails = []
    return { kind: 'cooldown', reason, until: this.cooldownUntil, first }
  }

  private refill(): void {
    const t = this.now()
    const perMs = this.limits.loginsPerMin / 60_000
    this.tokens = Math.min(this.limits.loginBurst, this.tokens + (t - this.lastRefill) * perMs)
    this.lastRefill = t
  }
}
