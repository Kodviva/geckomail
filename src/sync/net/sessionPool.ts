// Hesap başına yeniden kullanılan, doğrulanmış IMAP oturumu havuzu.
// Eski model her poll/tıklama için TCP+TLS+LOGIN+LOGOUT açıyordu (68 hesapta ~34 login/dk).
// Burada poll, gövde/ek/başlık, flag, APPEND ve cihaz senkronu aynı oturumu paylaşır;
// boşta kalan oturum imapflow auto-IDLE ile açık kalır (bedava push + keepalive).
// Yeni login yalnızca HostGovernor izin verirse açılır.
import { classifyError, type ErrClass } from '../imapClient'
import type { CooldownEvent, HostGovernor, Priority } from './hostGovernor'
import { fmtTime, t } from '../../shared/i18n'

export interface PoolClient {
  usable: boolean
  mailbox: unknown
  on(event: string, fn: (...args: unknown[]) => void): unknown
  mailboxOpen(path: string): Promise<unknown>
  logout(): Promise<unknown>
  close(): void
}

export interface PoolDeps<C extends PoolClient> {
  now(): number
  hostOf(accountId: number): string
  governor(host: string): HostGovernor
  /** hesap bu şifreyle daha önce başarıyla girdi mi (auth bütçesi aşımında yalnız bunlar) */
  knownGood(accountId: number): boolean
  /** null: login serbest; string: neden serbest değil (kullanıcıya gösterilir) */
  canLogin(accountId: number): string | null
  connect(accountId: number): Promise<C>
  onLoginSuccess(accountId: number): void
  onLoginFailure(accountId: number, kind: ErrClass, err: unknown): void
  onCooldown(host: string, ev: CooldownEvent): void
  onMailboxActivity(accountId: number): void
  onSessionLost(accountId: number): void
  sleep?(ms: number): Promise<void>
  /** cihazın interneti yok mu (tahmin, ağa çıkmaz) — yoksa login hiç denenmez */
  offline?(): boolean
  /** login-öncesi/ağ hatası sonrası: internet gerçekten var mı? false → hata sunucuya yazılmaz */
  verifyOnline?(): Promise<boolean>
}

export interface PoolOpts {
  idleTtlMs: number // sabitlenmemiş oturum bu kadar boşta kalınca kapanır
  jobTimeoutMs: number // tek iş için watchdog
  interactiveWaitMs: number // interaktif iş jeton/slot için en fazla bu kadar bekler
}

export const DEFAULT_POOL_OPTS: PoolOpts = {
  idleTtlMs: 5 * 60_000,
  jobTimeoutMs: 120_000,
  interactiveWaitMs: 20_000
}

export type DeferReason = 'rate' | 'cooldown' | 'probe' | 'auth-budget' | 'capacity'

/** Governor/kapasite yüzünden iş yapılmadı — hata değil, erteleme. */
/** Login bu hesap için şu an yapılmaz (şifre yok, reddedilmiş …): sunucu hatası değil, metni sınıflanmaz */
export class LoginDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoginDeniedError'
  }
}

/** Cihazın interneti yok: sunucu hatası değil, ban sayacına ve soğumaya işlemez */
export class OfflineError extends Error {
  constructor() {
    super(t('sync.net.offline'))
    this.name = 'OfflineError'
  }
}

export class PoolDeferred extends Error {
  constructor(
    readonly reason: DeferReason,
    readonly waitMs: number,
    now: number
  ) {
    super(deferMessage(reason, now + waitMs))
    this.name = 'PoolDeferred'
  }
}

function deferMessage(reason: DeferReason, at: number): string {
  switch (reason) {
    case 'cooldown':
    case 'probe':
      return t('sync.net.deferCooldown', { time: fmtTime(at) })
    case 'auth-budget':
      return t('sync.net.deferAuthBudget', { time: fmtTime(at) })
    case 'capacity':
      return t('sync.net.deferCapacity')
    default:
      return t('sync.net.deferRate')
  }
}

interface Entry<C> {
  id: number
  host: string
  client: C | null
  connecting: boolean
  busy: boolean
  pinned: boolean
  lastUsed: number
  chain: Promise<void>
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class SessionPool<C extends PoolClient> {
  private entries = new Map<number, Entry<C>>()
  private pinned = new Set<number>()

  constructor(
    private deps: PoolDeps<C>,
    private opts: PoolOpts = DEFAULT_POOL_OPTS
  ) {}

  /** Hesabın oturumunda seri iş çalıştır; gerekirse governor izniyle login. */
  run<T>(accountId: number, priority: Priority, fn: (client: C) => Promise<T>): Promise<T> {
    const e = this.entry(accountId)
    const job = e.chain.then(() => this.exec(e, priority, fn))
    e.chain = job.then(
      () => {},
      () => {}
    )
    return job
  }

  /** Sıcak set: bu hesapların oturumu tahliye edilmez, iş sonrası INBOX'ta IDLE bekler. */
  pin(ids: Set<number>): void {
    this.pinned = new Set(ids)
    for (const e of this.entries.values()) e.pinned = this.pinned.has(e.id)
  }

  hasLive(accountId: number): boolean {
    return !!this.entries.get(accountId)?.client?.usable
  }

  openCount(host: string): number {
    let n = 0
    for (const e of this.entries.values()) if (e.host === host && (e.client || e.connecting)) n++
    return n
  }

  /** Periyodik: süresi dolmuş boştaki oturumları kapat. */
  sweep(): void {
    const t = this.deps.now()
    for (const e of this.entries.values()) {
      if (!e.client) continue
      if (!e.client.usable) {
        e.client = null
        continue
      }
      if (!e.pinned && !e.busy && t - e.lastUsed > this.opts.idleTtlMs) this.closeEntry(e)
    }
  }

  /** Hesap silindi/şifresi değişti: oturumu kapat, kaydı unut. */
  drop(accountId: number): void {
    const e = this.entries.get(accountId)
    if (!e) return
    this.closeEntry(e)
    this.entries.delete(accountId)
  }

  closeAll(): void {
    for (const e of this.entries.values()) this.closeEntry(e)
  }

  private entry(accountId: number): Entry<C> {
    let e = this.entries.get(accountId)
    const host = this.deps.hostOf(accountId)
    if (!e) {
      e = {
        id: accountId,
        host,
        client: null,
        connecting: false,
        busy: false,
        pinned: this.pinned.has(accountId),
        lastUsed: this.deps.now(),
        chain: Promise.resolve()
      }
      this.entries.set(accountId, e)
    } else if (e.host !== host) {
      // sunucu adresi düzenlendi: eski hosttaki oturum geçersiz
      this.closeEntry(e)
      e.host = host
    }
    return e
  }

  private async exec<T>(e: Entry<C>, priority: Priority, fn: (client: C) => Promise<T>): Promise<T> {
    e.busy = true
    try {
      const client = await this.ensureClient(e, priority)
      let result: T
      try {
        result = await this.withWatchdog(fn(client), client)
      } catch (err) {
        if (!client.usable && e.client === client) e.client = null
        throw err
      }
      await this.park(e, client)
      return result
    } finally {
      e.busy = false
      e.lastUsed = this.deps.now()
    }
  }

  // İş sonrası: oturumu seçili bir mailbox'ta bırak ki imapflow auto-IDLE devreye girsin
  // (seçili mailbox yoksa soket 60 sn sessizlikte kapanır). Sıcak hesap INBOX'u dinler.
  private async park(e: Entry<C>, client: C): Promise<void> {
    if (!client.usable || e.client !== client) return
    const mb = client.mailbox as { path?: string } | false | undefined
    const want = e.pinned ? 'INBOX' : null
    if (!mb || (want && mb.path !== want)) {
      await client.mailboxOpen(want ?? 'INBOX').catch(() => {})
    }
  }

  private async ensureClient(e: Entry<C>, priority: Priority): Promise<C> {
    if (e.client?.usable) return e.client
    e.client = null

    const denied = this.deps.canLogin(e.id)
    if (denied) throw new LoginDeniedError(denied)
    if (this.deps.offline?.()) throw new OfflineError()

    const gov = this.deps.governor(e.host)
    const sleep = this.deps.sleep ?? realSleep
    const deadline = this.deps.now() + (priority === 'interactive' ? this.opts.interactiveWaitMs : 0)

    // 1) kapasite: tavan doluysa en eski boştaki oturumu kapat
    for (;;) {
      if (this.openCount(e.host) < gov.maxSessions() || this.evictOne(e.host)) break
      if (this.deps.now() >= deadline) throw new PoolDeferred('capacity', 5000, this.deps.now())
      await sleep(200)
    }

    // 2) login izni: interaktif iş kısa hız beklemesini göze alır, soğumayı asla
    for (;;) {
      const g = gov.tryTakeLogin(priority, this.deps.knownGood(e.id))
      if (g.ok) break
      const t = this.deps.now()
      if (g.reason === 'rate' && t + g.waitMs <= deadline) {
        await sleep(g.waitMs)
        continue
      }
      throw new PoolDeferred(g.reason, g.waitMs, t)
    }

    // 3) login
    e.connecting = true
    let client: C
    try {
      client = await this.deps.connect(e.id)
    } catch (err) {
      const kind = classifyError(err)
      // bağlantı düştüyse önce kendi internetimize bak: kesintiyi "sunucu reddediyor" sanma
      if ((kind === 'preauth' || kind === 'net') && this.deps.verifyOnline && !(await this.deps.verifyOnline())) {
        throw new OfflineError()
      }
      const ev = gov.onLoginFailure(kind)
      if (ev) this.deps.onCooldown(e.host, ev)
      this.deps.onLoginFailure(e.id, kind, err)
      throw err
    } finally {
      e.connecting = false
    }
    gov.onLoginSuccess()
    this.deps.onLoginSuccess(e.id)

    const activity = () => this.deps.onMailboxActivity(e.id)
    client.on('exists', activity)
    client.on('expunge', activity)
    client.on('flags', activity) // başka cihazda okundu/yıldız — fetch yanıtları komuta özel, döngü yok
    client.on('close', () => {
      if (e.client !== client) return // bizim kapattığımız ya da yerine yenisi gelmiş
      e.client = null
      this.deps.onSessionLost(e.id)
    })
    e.client = client
    return client
  }

  private evictOne(host: string): boolean {
    let victim: Entry<C> | null = null
    for (const x of this.entries.values()) {
      if (x.host !== host || !x.client || x.busy || x.pinned) continue
      if (!victim || x.lastUsed < victim.lastUsed) victim = x
    }
    if (!victim) return false
    this.closeEntry(victim)
    return true
  }

  private closeEntry(e: Entry<C>): void {
    const c = e.client
    e.client = null // önce bağı kopar: 'close' olayı "kayıp oturum" sayılmasın
    if (!c) return
    void Promise.race([c.logout().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]).finally(() => {
      try {
        c.close()
      } catch {
        /* umursanmaz */
      }
    })
  }

  private withWatchdog<T>(p: Promise<T>, client: C): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    const watchdog = new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        try {
          client.close()
        } catch {
          /* umursanmaz */
        }
        rej(new Error(t('sync.net.watchdog')))
      }, this.opts.jobTimeoutMs)
    })
    return Promise.race([p, watchdog]).finally(() => clearTimeout(timer!)) as Promise<T>
  }
}
