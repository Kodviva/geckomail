import { isOAuthAccount } from './oauth'
import type { ImapFlow } from 'imapflow'
import type { AccountStatus, ConnectionStats } from '../shared/rpc'
import type { AccountRow, Queries } from './db/queries'
import { classifyError, describeError, openConnection } from './imapClient'
import { backfillFolder, pollAccount } from './imapPoll'
import { DEFAULT_LIMITS, HostGovernor, TRUSTED_LIMITS, type CooldownEvent } from './net/hostGovernor'
import { Connectivity, type NetState } from './net/connectivity'
import { LoginDeniedError, OfflineError, PoolDeferred, SessionPool } from './net/sessionPool'
import { isVaultUnlocked } from './vault/state'
import { fmtTime, t } from '../shared/i18n'
import { inProcessLocale } from './sessionLocale'
import { AUTH_PAUSED_KEY, isAuthPausedDetail } from '../shared/accountStatus'

// Sunucu gözünden bir ofis NAT'ının arkasındaki sıradan bir mail istemcisi gibi görün:
// az login (oturumlar havuzda yaşar), başarısız login'de hemen dur, sunucu reddederse tüm şeritlerde sus.
// Login hızı/soğuma/auth bütçesi → net/hostGovernor, oturum yeniden kullanımı → net/sessionPool.
export const CFG = {
  pollSlotsPerHost: 4,
  trustedPollSlotsPerHost: 10,
  idleSetMax: 5,
  trustedIdleSetMax: 20,
  pollIntervalMs: 120_000,
  viewedPollIntervalMs: 60_000,
  idleSafetyPollMs: 10 * 60_000, // canlı IDLE oturumu olan hesap: push var, bu yalnız güvenlik ağı
  quietMaxFactor: 3, // değişiklik görmeyen soğuk hesabın aralığı en fazla bu kat uzar
  jitterMs: 20_000,
  connectTimeoutMs: 15_000,
  socketTimeoutMs: 60_000,
  connectWatchdogMs: 35_000,
  backoffMaxMs: 30 * 60_000,
  authPauseMs: 20 * 60_000, // 1. başarısız login sonrası tek yeniden deneme bu kadar sonra
  authFailsToStop: 2, // ardışık bu kadar başarısız login → auth_failed (kullanıcı eylemine kadar dur)
  sessionLostRepollMs: 30_000,
  startupSpreadMs: 60_000,
  hotHeadroom: 16 // sunucu: ana makine başına oturum tavanından sıcak kümeye ayrılmayan pay (sıcak olmayan yoklamalar)
}

interface AcctRt {
  id: number
  nextPollAt: number
  pollSeq: number
  backoffMs: number
  netFails: number
  authFails: number
  authPausedUntil: number
  verified: boolean // bu şifreyle başarılı login görüldü (governor auth bütçesi için)
  quietPolls: number
  sessionUpAt: number
  sessionLosses: number // kısa ömürlü oturum kayıpları (sıcak hesap yeniden bağlanma geri çekilmesi)
  hotRetryAt: number
  status: AccountStatus
  enabled: boolean
  polling: boolean
}

export interface SchedulerEvents {
  emitStatus(accountId: number, status: AccountStatus, detail: string | null): void
  emitChanged(accountId: number): void
  onNewMail(accountId: number): void
  onHostAlert?(host: string, message: string): void
  onHostHealth?(host: string, state: 'ok' | 'cooldown' | 'probing', until: number | null, message: string | null): void
  /** cihazın internet durumu değişti */
  onNetwork?(state: 'online' | 'offline'): void
  /** Açık oturumla küçük gövdeleri önceden çek (arama indeksi için); değişiklik olduysa true */
  prefetchBodies?(row: AccountRow, client: ImapFlow): Promise<boolean>
}

/** 1. şifre reddi duraklaması: metni dilden bağımsız tanınır (shared/accountStatus) */
const authPausedMsg = (until: number): string => t(AUTH_PAUSED_KEY, { time: fmtTime(until) })

/** Sunucu modu: IDLE sıcak kümesi bildirim alan hesaplara genişler (en çok `max`, GECKO_IDLE_MAX). Masaüstünde verilmez. */
export interface ServerIdleOptions {
  max: number
  /** en az bir uygun kullanıcının susturmadığı hesaplar; rule: etkin bildirim kuralı var, lastDate: son ileti */
  eligible(): { id: number; rule: boolean; lastDate: number }[]
}

export class Scheduler {
  private accounts = new Map<number, AcctRt>()
  private governors = new Map<string, HostGovernor>()
  private hostsInCooldown = new Set<string>()
  private pollsInFlight = new Map<string, number>()
  private viewed = new Set<number>()
  private hot = new Set<number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private prefCadenceMs = CFG.pollIntervalMs
  private prefTrusted = false
  private tickCount = 0
  private pool: SessionPool<ImapFlow>

  constructor(
    private q: Queries,
    private creds: Map<number, string>,
    private ev: SchedulerEvents,
    readonly net: Connectivity = new Connectivity(),
    private serverIdle?: ServerIdleOptions
  ) {
    // internet dönünce: kesintide biriken yanlış "IP engeli" soğumalarını affet, hemen yokla
    net.onChange((state) => this.onNetChange(state))
    this.pool = new SessionPool<ImapFlow>({
      now: Date.now,
      offline: () => net.state === 'offline' || net.inWakeGrace(),
      verifyOnline: async () => !net.inWakeGrace() && (await net.verifyOnline()),
      hostOf: (id) => this.hostKey(this.q.getAccountRow(id)?.imap_host),
      governor: (host) => this.governorFor(host),
      knownGood: (id) => !!this.accounts.get(id)?.verified,
      canLogin: (id) => this.loginBlocker(id),
      connect: (id) => this.connect(id),
      onLoginSuccess: (id) => {
        const host = this.hostKey(this.q.getAccountRow(id)?.imap_host)
        this.q.recordLoginAttempt(host, id, 'imap', 'ok')
        this.hostRecovered(host)
        const rt = this.accounts.get(id)
        if (rt) {
          rt.authFails = 0
          rt.authPausedUntil = 0
          rt.verified = true
          rt.sessionUpAt = Date.now()
        }
      },
      onLoginFailure: (id, kind) => {
        this.q.recordLoginAttempt(this.hostKey(this.q.getAccountRow(id)?.imap_host), id, 'imap', kind)
        if (kind === 'auth') this.onAuthFailure(id)
      },
      onCooldown: (host, ev) => this.onCooldown(host, ev),
      onMailboxActivity: (id) => this.pollSoon(id, 1500),
      onSessionLost: (id) => {
        // sıcak hesabın IDLE'ı düştü: acele etmeden yeniden kur. Oturum sürekli kısa ömürlü
        // düşüyorsa (sunucu kovuyor) aralık 30 sn → 10 dk katlanır — login churn'ü yok
        const rt = this.accounts.get(id)
        if (!rt || !this.hot.has(id)) return
        const now = Date.now()
        rt.sessionLosses = now - rt.sessionUpAt > 5 * 60_000 ? 1 : rt.sessionLosses + 1
        const delay = Math.min(CFG.sessionLostRepollMs * 2 ** (rt.sessionLosses - 1), 10 * 60_000)
        rt.hotRetryAt = now + delay
        this.pollSoon(id, delay + Math.random() * 10_000)
      }
    })
  }

  // ---- yapılandırma ----

  // ayarlar ekranından: kadans + güvenilir sunucu modu
  applyPrefs(): void {
    const sec = Number(this.q.prefGet('pollCadenceSec') ?? 0)
    this.prefCadenceMs = sec >= 30 ? sec * 1000 : CFG.pollIntervalMs
    this.prefTrusted = this.q.prefGet('trustedServer') === '1'
    for (const g of this.governors.values()) g.setLimits(this.limits())
  }

  private limits() {
    return this.prefTrusted ? TRUSTED_LIMITS : DEFAULT_LIMITS
  }

  private hostKey(host: string | undefined): string {
    return (host ?? '').trim().toLowerCase()
  }

  /** IMAP ve SMTP aynı governor'ı paylaşır: IP engeli ikisini birden vurur. */
  governorFor(host: string): HostGovernor {
    const key = this.hostKey(host)
    let g = this.governors.get(key)
    if (!g) {
      g = new HostGovernor(key, this.limits())
      this.governors.set(key, g)
    }
    return g
  }

  start(): void {
    this.applyPrefs()
    this.reloadAccounts(true)
    this.timer = setInterval(() => this.tick(), 1000)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.pool.closeAll()
  }

  refreshHot(): void {
    this.syncHotSet()
  }

  reloadAccounts(initial = false): void {
    const rows = this.q.getAccountRows()
    const now = Date.now()
    const fresh = rows.filter((r) => !this.accounts.has(r.id))
    fresh.forEach((r, i) => {
      // 1. şifre reddi DB'de kalıcı ('Şifre reddedildi …' + status_since): yeniden başlatma, hatalı
      // şifreli hesaba yeni bir deneme hakkı vermesin (çökme döngüsünde saatte onlarca başarısız login)
      const authPaused = r.status === 'degraded' && isAuthPausedDetail(r.status_detail)
      const pausedUntil = authPaused ? (r.status_since ?? now) + CFG.authPauseMs : 0
      this.accounts.set(r.id, {
        id: r.id,
        // açılışta poll'ları yay: toplu login imzası verme
        nextPollAt: now + 1500 + (i * CFG.startupSpreadMs) / Math.max(fresh.length, 1) + Math.random() * 500,
        pollSeq: 0,
        backoffMs: 0,
        netFails: 0,
        authFails: authPaused ? 1 : 0,
        authPausedUntil: pausedUntil > now ? pausedUntil : 0,
        // yalnızca bu süreçte görülen başarı sayılır: DB'deki eski başarı, şifre o günden beri
        // değişmiş hesabı auth bütçesinden muaf tutup banı tetikliyordu (29 Eyl)
        verified: false,
        quietPolls: 0,
        sessionUpAt: 0,
        sessionLosses: 0,
        hotRetryAt: 0,
        status: r.status,
        enabled: !!r.enabled,
        polling: false
      })
    })
    if (!initial) {
      for (const rt of this.accounts.values()) {
        const row = rows.find((r) => r.id === rt.id)
        if (row) rt.enabled = !!row.enabled
      }
    }
  }

  // kasa kilitlendi vb.: hesabın açık oturumunu kapat (kayıt kalır)
  dropSession(accountId: number): void {
    this.pool.drop(accountId)
  }

  removeAccount(accountId: number): void {
    this.accounts.delete(accountId)
    this.pool.drop(accountId)
  }

  setEnabled(accountId: number, enabled: boolean): void {
    const rt = this.accounts.get(accountId)
    if (!rt) return
    rt.enabled = enabled
    if (enabled) {
      rt.authFails = 0
      rt.authPausedUntil = 0
      rt.backoffMs = 0
      rt.nextPollAt = Date.now()
    } else {
      this.pool.drop(accountId)
    }
  }

  // kullanıcı eylemi (Yeniden dene / şifre-sunucu düzenleme): auth durdurmasını kaldır, oturumu tazele
  retryAccount(accountId: number): void {
    const rt = this.accounts.get(accountId)
    if (!rt) return
    rt.authFails = 0
    rt.authPausedUntil = 0
    rt.netFails = 0
    rt.backoffMs = 0
    rt.quietPolls = 0
    rt.verified = false // şifre değişmiş olabilir: ilk başarıya kadar "bilinen iyi" sayılmaz
    this.pool.drop(accountId)
    this.setStatus(rt, 'unknown', null)
    rt.nextPollAt = Date.now()
  }

  setViewed(accountIds: number[] | null): void {
    this.viewed = new Set(accountIds ?? [])
    let kicked = 0
    for (const id of this.viewed) {
      const rt = this.accounts.get(id)
      if (rt) rt.quietPolls = 0
      if (kicked++ >= 5) continue
      this.pollSoon(id, 0)
    }
    this.syncHotSet()
  }

  pollSoon(accountId: number, delayMs = 0): void {
    const rt = this.accounts.get(accountId)
    if (!rt || rt.status === 'auth_failed') return
    rt.nextPollAt = Math.min(rt.nextPollAt, Math.max(Date.now() + delayMs, rt.authPausedUntil))
  }

  pollAllSoon(): void {
    let i = 0
    for (const rt of this.accounts.values()) {
      rt.nextPollAt = Math.min(rt.nextPollAt, Math.max(Date.now() + i * 700 + Math.random() * 300, rt.authPausedUntil))
      i++
    }
  }

  // İnteraktif işler (body/ek indirme, flag yazma, APPEND, cihaz senkronu): hesabın havuzdaki
  // oturumunu kullanır; oturum yoksa governor'da interaktif önceliğiyle login. Soğumadaysa
  // anlaşılır bir hatayla hemen döner — "Tekrar dene" sunucuyu dövmez.
  enqueueInteractive<T>(accountId: number, fn: (client: ImapFlow, row: AccountRow) => Promise<T>): Promise<T> {
    const row = this.q.getAccountRow(accountId)
    if (!row || !this.accounts.has(accountId)) return Promise.reject(new Error(t('sync.err.accountNotFound')))
    return this.pool.run(accountId, 'interactive', (client) => fn(client, this.q.getAccountRow(accountId) ?? row))
  }

  /** Bağlantı paneli / host şeridi: governor durumu + açık oturum + son 24 saatin login sonuçları */
  getConnectionStats(): ConnectionStats {
    const since = Date.now() - 24 * 3600_000
    const rows = this.q.loginStats(since)
    const hosts = new Set<string>([...this.governors.keys(), ...rows.map((r) => r.host)])
    return {
      hosts: [...hosts].filter(Boolean).map((host) => {
        const g = this.governorFor(host)
        const snap = g.snapshot()
        const count = (result: string) => rows.filter((r) => r.host === host && r.result === result).reduce((n, r) => n + r.n, 0)
        return {
          host,
          state: snap.state,
          cooldownUntil: snap.state === 'ok' ? null : snap.cooldownUntil,
          reason: snap.reason,
          strikes: snap.strikes,
          sessions: this.pool.openCount(host),
          maxSessions: g.maxSessions(),
          loginsPerMin: this.limits().loginsPerMin,
          last24h: { ok: count('ok'), auth: count('auth'), preauth: count('preauth') + count('net'), limit: count('limit'), other: count('other') }
        }
      }),
      recentFailures: this.q.recentLoginFailures(15).map((f) => ({ ...f, email: f.accountId ? (this.q.getAccountRow(f.accountId)?.email ?? null) : null }))
    }
  }

  stats(): { accounts: number; hosts: number; sessions: number } {
    let sessions = 0
    for (const h of this.governors.keys()) sessions += this.pool.openCount(h)
    return { accounts: this.accounts.size, hosts: this.governors.size, sessions }
  }

  // ---- login politikası ----

  private loginBlocker(id: number): string | null {
    const rt = this.accounts.get(id)
    if (!rt) return t('sync.err.accountNotFound')
    if (!this.creds.get(id)) return t('sync.status.noPassword')
    if (rt.status === 'auth_failed') return t('sync.status.authRejected')
    if (rt.authPausedUntil > Date.now()) return authPausedMsg(rt.authPausedUntil)
    return null
  }

  /** Sieve girişi IMAP'in engellerine uyar: reddedilmiş ya da duraklatılmış hesapta ikinci kanaldan login denenmez */
  sieveLoginGate(accountId: number): string | null {
    return inProcessLocale(() => this.loginBlocker(accountId))
  }

  /** Sieve aynı governor'ı kullanır: açtığı soğuma IMAP'inkiyle aynı uyarıyı verir */
  sieveCooldown(host: string, ev: CooldownEvent): void {
    this.onCooldown(this.hostKey(host), ev)
  }

  /** IMAP'i olmayan ayrı Sieve ana makinesinde soğuma göstergesini ancak bu kapatır */
  sieveLoginOk(host: string): void {
    this.hostRecovered(this.hostKey(host))
  }

  private hostRecovered(host: string): void {
    if (!this.hostsInCooldown.delete(host)) return
    console.warn(`sync: ${host} yeniden bağlantı kabul ediyor — soğuma bitti`)
    this.ev.onHostHealth?.(host, 'ok', null, null)
  }

  private async connect(id: number): Promise<ImapFlow> {
    const row = this.q.getAccountRow(id)
    const pass = this.creds.get(id)
    if (!row || !pass) throw new Error(t('sync.err.accountOrPasswordNotFound'))
    const p = openConnection(row, pass, CFG)
    let timer: ReturnType<typeof setTimeout>
    const watchdog = new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        // login asılı kaldı: login-öncesi ağ hatası sayılır; geç gelen bağlantıyı kapat
        p.then((c) => c.close()).catch(() => {})
        rej(Object.assign(new Error(t('sync.err.connectTimeout')), { code: 'CONNECT_TIMEOUT', phase: 'connect' }))
      }, CFG.connectWatchdogMs)
    })
    return Promise.race([p, watchdog]).finally(() => clearTimeout(timer!))
  }

  // Başarısız login sunucu gözünde brute-force'un ta kendisi: 1. hatada 20 dk dur, tek deneme;
  // 2. ardışık hatada kullanıcı eylemine kadar bir daha asla deneme.
  private onAuthFailure(id: number): void {
    inProcessLocale(() => this.applyAuthFailure(id)) // durum metni herkese ortak, DB'de kalır
  }

  private applyAuthFailure(id: number): void {
    const rt = this.accounts.get(id)
    if (!rt) return
    rt.authFails++
    rt.verified = false
    console.warn(`sync: ${this.q.getAccountRow(id)?.email ?? id} — şifre reddedildi (${rt.authFails}. kez)`)
    if (rt.authFails >= CFG.authFailsToStop) {
      rt.authPausedUntil = 0
      this.pool.drop(id)
      const oauth = isOAuthAccount(this.q.getAccountRow(id) ?? { auth_type: 'password' })
      this.setStatus(
        rt,
        'auth_failed',
        oauth
          ? t('sync.status.oauthRevoked')
          : t('sync.status.authRejected')
      )
      this.syncHotSet()
      return
    }
    rt.authPausedUntil = Date.now() + CFG.authPauseMs
    rt.nextPollAt = rt.authPausedUntil + Math.random() * 30_000
    this.setStatus(rt, 'degraded', authPausedMsg(rt.authPausedUntil))
  }

  private onCooldown(host: string, ev: CooldownEvent): void {
    inProcessLocale(() => this.applyCooldown(host, ev))
  }

  private applyCooldown(host: string, ev: CooldownEvent): void {
    const msg =
      ev.reason === 'limit'
        ? t('sync.status.hostLimit', { host, time: fmtTime(ev.until) })
        : t('sync.status.hostRefusing', { host, time: fmtTime(ev.until) })
    console.warn(`sync: ${msg}`)
    for (const rt of this.accounts.values()) {
      // şifre reddi bilgisini ezme: hangi hesabın banı tetiklediği ancak bununla görülür
      if (!rt.enabled || rt.status === 'auth_failed' || rt.authPausedUntil > Date.now() || this.pool.hasLive(rt.id)) continue
      if (this.hostKey(this.q.getAccountRow(rt.id)?.imap_host) !== host) continue
      this.setStatus(rt, 'degraded', msg)
    }
    if (ev.first) this.ev.onHostAlert?.(host, msg)
    this.hostsInCooldown.add(host)
    this.ev.onHostHealth?.(host, 'cooldown', ev.until, msg)
    if (this.serverIdle && ev.reason === 'limit') this.syncHotSet() // tavan yarılandı: sıcak küme küçülür
  }

  // ---- sıcak set (IDLE) ----

  private desiredHot(): Set<number> {
    const srv = this.serverIdle
    const cap = srv ? srv.max : this.prefTrusted ? CFG.trustedIdleSetMax : CFG.idleSetMax
    const candidates: number[] = [...this.viewed] // bakılan önce gelir
    for (const r of this.q.getAccountRows()) if (r.starred) candidates.push(r.id)
    if (srv) {
      // sunucuda herkesçe susturulmuş hesap kümeye girmez (viewed/yıldızlı da: kimse bildirim istemiyor, yoklama yeter).
      // Sıra: yıldızlı → kural eşleşebilen (son ileti yeni olan önce) → diğerleri (son ileti yeni olan önce)
      const elig = srv.eligible()
      const ok = new Set(elig.map((e) => e.id))
      const byRecent = (a: { lastDate: number }, b: { lastDate: number }): number => b.lastDate - a.lastDate
      const tail = [...elig.filter((e) => e.rule).sort(byRecent), ...elig.filter((e) => !e.rule).sort(byRecent)].map((e) => e.id)
      const starred = candidates.filter((id) => ok.has(id))
      candidates.length = 0
      candidates.push(...starred, ...tail)
    }
    const out = new Set<number>()
    // sunucuda ana makine başına sıcak oturum <= oturum tavanı - boşluk (sıcak olmayanların yoklaması için);
    // limit hatasından sonra tavan yarılanınca küme de küçülür (fazlası yoklamaya düşer, sabitleme kalkar)
    const perHost = new Map<string, number>()
    for (const id of candidates) {
      if (out.size >= cap) break
      const rt = this.accounts.get(id)
      if (!rt || !rt.enabled || rt.status === 'auth_failed' || out.has(id)) continue
      if (srv) {
        const host = this.hostKey(this.q.getAccountRow(id)?.imap_host)
        const n = perHost.get(host) ?? 0
        if (n >= Math.max(0, this.governorFor(host).maxSessions() - CFG.hotHeadroom)) continue
        perHost.set(host, n + 1)
      }
      out.add(id)
    }
    return out
  }

  private syncHotSet(): void {
    if (this.stopped) return
    this.hot = this.desiredHot()
    this.pool.pin(this.hot)
    // oturumu olmayan sıcak hesap: sıradaki poll oturumu açar ve INBOX'ta IDLE'a bırakır
    for (const id of this.hot) {
      const rt = this.accounts.get(id)
      if (!rt || rt.polling || rt.backoffMs > 0 || this.pool.hasLive(id)) continue
      this.pollSoon(id, Math.max(0, rt.hotRetryAt - Date.now()))
    }
  }

  // ---- poll döngüsü ----

  private cadence(rt: AcctRt): number {
    const normal = this.prefTrusted ? 45_000 : this.prefCadenceMs
    let base: number
    if (this.hot.has(rt.id) && this.pool.hasLive(rt.id)) {
      base = CFG.idleSafetyPollMs
    } else if (this.viewed.has(rt.id)) {
      base = Math.max(30_000, Math.min(CFG.viewedPollIntervalMs, normal / 2))
    } else {
      const starred = !!this.q.getAccountRow(rt.id)?.starred
      const factor = starred ? 1 : Math.min(CFG.quietMaxFactor, 1 + rt.quietPolls * 0.25)
      base = normal * factor
    }
    const jitter = (Math.random() * 2 - 1) * CFG.jitterMs
    return Math.max(30_000, base + jitter + rt.backoffMs)
  }

  private onNetChange(state: NetState): void {
    this.ev.onNetwork?.(state)
    if (state !== 'online' || this.stopped) return
    for (const [host, g] of this.governors) {
      if (g.forgiveNetwork() && this.hostsInCooldown.delete(host)) {
        console.warn(`sync: internet geri geldi — ${host} soğuması kaldırıldı (kesinti yanlış alarmı)`)
        this.ev.onHostHealth?.(host, 'ok', null, null)
      }
    }
    this.pollAllSoon()
  }

  private tick(): void {
    if (this.stopped) return
    this.tickCount++
    // internet yok: bağlantı denenmez (her deneme sunucuya "reddediyor" diye yazılırdı);
    // bağımsız hedeflerle ara sıra yoklanır, gelince onNetChange yoklamayı başlatır
    if (this.net.state === 'offline') {
      if (this.tickCount % 5 === 0) void this.net.verifyOnline()
      return
    }
    if (this.tickCount % 10 === 0) this.syncHotSet()
    if (this.tickCount % 15 === 0) this.pool.sweep()
    const now = Date.now()
    const due: AcctRt[] = []
    for (const rt of this.accounts.values()) {
      if (!rt.enabled || rt.polling || rt.status === 'auth_failed' || rt.authPausedUntil > now) continue
      if (rt.nextPollAt <= now) due.push(rt)
    }
    due.sort((a, b) => a.nextPollAt - b.nextPollAt)
    for (const rt of due) {
      const row = this.q.getAccountRow(rt.id)
      if (!row) continue
      if (row.secure && !isVaultUnlocked()) continue // kasa hesabı + vault kilitli: yoklama yok (hata da değil)
      if (!this.creds.get(rt.id)) continue // şifre yüklenmedi (Keychain izni bekleniyor vb.): denemenin anlamı yok, durumu ezme
      const host = this.hostKey(row.imap_host)
      const blocked = this.governorFor(host).blockedFor()
      if (blocked > 0 && !this.pool.hasLive(rt.id)) {
        // host soğumada: yeni login yok. Açık oturumu olan hesaplar yoklamaya devam eder.
        rt.nextPollAt = now + blocked + Math.random() * 60_000
        continue
      }
      const slots = this.prefTrusted ? CFG.trustedPollSlotsPerHost : CFG.pollSlotsPerHost
      if ((this.pollsInFlight.get(host) ?? 0) >= slots) continue
      void this.runPoll(rt, row, host)
    }
  }

  private async runPoll(rt: AcctRt, row: AccountRow, host: string): Promise<void> {
    rt.polling = true
    this.pollsInFlight.set(host, (this.pollsInFlight.get(host) ?? 0) + 1)
    rt.nextPollAt = Date.now() + this.cadence(rt) // baştan planla; hata backoff'u ayrıca ekler
    try {
      const result = await this.pool.run(rt.id, 'background', (client) => this.pollWork(row, client, ++rt.pollSeq))
      this.onSuccess(rt, result.changed)
      if (result.changed) this.ev.emitChanged(rt.id)
      if (result.newInboxMessages > 0 || result.watchedArrivals > 0) this.ev.onNewMail(rt.id)
    } catch (e) {
      if (e instanceof PoolDeferred) {
        // governor/kapasite ertelemesi hata değil: bekleme sonrasına planla, durum değiştirme
        rt.nextPollAt = Date.now() + Math.max(2000, e.waitMs) + Math.random() * 5000
      } else if (e instanceof LoginDeniedError) {
        // hesabın kendi durumu (auth_failed, şifre yok) zaten gösteriliyor: üzerine yazma
        rt.nextPollAt = Date.now() + 5 * 60_000
      } else if (
        e instanceof OfflineError ||
        // açık oturum iş ortasında düştü: internet de yoksa hesaba/sunucuya yazma
        (['net', 'preauth'].includes(classifyError(e)) && !(await this.net.verifyOnline()))
      ) {
        // cihazın interneti yok: hesap hatası değil; internet gelince onNetChange hemen yoklar
        rt.nextPollAt = Date.now() + 30_000
      } else {
        this.onFailure(rt, e)
      }
    } finally {
      rt.polling = false
      this.pollsInFlight.set(host, Math.max(0, (this.pollsInFlight.get(host) ?? 1) - 1))
    }
  }

  // ayrı metod: opQueue sent-poll'u vb. için de kullanılabilir
  private async pollWork(row: AccountRow, client: ImapFlow, seq: number) {
    const result = await pollAccount(this.q, row, client, seq)
    // arka plan backfill: her 2. poll'da tek parti — bağlantı zaten açık, tarama hızını korur
    if (seq % 2 === 0) {
      const target = Number(this.q.prefGet('backfillTarget') ?? 5000)
      for (const f of this.q.getFolders(row.id)) {
        if (f.kind !== 'inbox') continue
        if (f.uidvalidity === null || f.backfill_low_uid === null || f.backfill_low_uid <= 1) continue
        if (this.q.folderMessageCount(f.id) >= target) continue
        const r = await backfillFolder(this.q, row, f, client, 500, target)
        if (r.fetched > 0) result.changed = true
        break // poll başına tek parti yeter
      }
    }
    // boşta gövde indeksleme (R27): her 3. poll'da, zaten açık oturumla birkaç küçük gövde. Yeni login yok;
    // hata poll'u düşürmez (bağlantı koptuysa sıradaki poll zaten görür).
    if (seq % 3 === 1 && !row.secure && this.ev.prefetchBodies && this.q.prefGet('bodyPrefetch') !== '0') {
      try {
        if (await this.ev.prefetchBodies(row, client)) result.changed = true
      } catch (e) {
        console.warn(`sync: gövde ön-çekme ${row.email}: ${describeError(e)}`)
      }
    }
    return result
  }

  private onSuccess(rt: AcctRt, changed: boolean): void {
    rt.backoffMs = 0
    rt.netFails = 0
    rt.quietPolls = changed ? 0 : rt.quietPolls + 1
    this.q.updateAccountStatus(rt.id, 'ok', null, true)
    if (rt.status !== 'ok') {
      rt.status = 'ok'
      this.ev.emitStatus(rt.id, 'ok', null)
    }
  }

  private onFailure(rt: AcctRt, e: unknown): void {
    inProcessLocale(() => this.applyFailure(rt, e))
  }

  private applyFailure(rt: AcctRt, e: unknown): void {
    const kind = classifyError(e)
    const msg = describeError(e)
    if (kind === 'auth') return // login politikası (onAuthFailure) durumu zaten ayarladı
    if (kind === 'limit') {
      // host soğuması governor'da; hesap da geri çekilir
      this.setStatus(rt, 'degraded', t('sync.status.rateLimited'))
      rt.backoffMs = Math.min(Math.max(rt.backoffMs * 2, 120_000), CFG.backoffMaxMs)
      return
    }
    if (kind === 'preauth' || kind === 'net') {
      rt.netFails++
      rt.backoffMs = Math.min(Math.max(rt.backoffMs * 2, 60_000), CFG.backoffMaxMs)
      rt.backoffMs *= 1 + (Math.random() * 0.4 - 0.2)
      this.setStatus(rt, rt.netFails >= 3 ? 'unreachable' : 'degraded', msg)
      return
    }
    rt.backoffMs = Math.min(Math.max(rt.backoffMs * 2, 60_000), CFG.backoffMaxMs)
    this.setStatus(rt, 'degraded', msg)
  }

  private setStatus(rt: AcctRt, status: AccountStatus, detail: string | null): void {
    this.q.updateAccountStatus(rt.id, status, detail, false)
    if (rt.status !== status) {
      rt.status = status
      this.ev.emitStatus(rt.id, status, detail)
    }
  }
}
