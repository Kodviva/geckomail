// Hesap başına Sieve dağıtımı. Her login governor'dan geçer, oturum kısa ömürlüdür. Burada ne olursa olsun
// istemci güvenlik ağı olarak çalışır: dağıtılamayan kural Gelen Kutusu'nda istemcide uygulanır.
// Yazma yalnız managedPut/managedDelete üzerinden: yabancı ada giden tek yol yoktur.
import { t } from '../../shared/i18n'
import { SIEVE_UNREACHABLE, SIEVE_RULES_SCRIPT, SIEVE_VACATION_CONFLICT, SIEVE_VACATION_TOO_LARGE, SIEVE_WRAPPER_SCRIPT, type SieveAccountInfo, type SieveCapsInfo, type SieveState, type SieveVacation } from '../../shared/sieve'
import type { Queries, SieveAccountRow } from '../db/queries'
import type { HostGovernor, LoginGrant, Priority } from '../net/hostGovernor'
import { credentialFor } from '../oauth'
import { inProcessLocale } from '../sessionLocale'
import { getVaultKey } from '../vault/state'
import type { Scheduler } from '../scheduler'
import { planActivation, scriptOwnership, vacationConflict } from './coexist'
import { clearDetectCache, detectSieve } from './detect'
import { generateEmptyRules, generateSieve, generateWrapper, parseWrapperTarget, type RulePlan, type SieveGenOutput } from './generate'
import { ManageSieveClient, ManageSieveError, assertManagedName, sieveFailureKind, type SieveCredential } from './manageSieve'

const DEFAULT_PORT = 4190
const DEBOUNCE_MS = 30_000
const RETRY_BASE_MS = 5 * 60_000
const RETRY_MAX_MS = 60 * 60_000
const MAX_RETRIES = 5
const MIN_WAIT_MS = 1000
/** SessionPool ile aynı: kullanıcının tıklaması kısa hız beklemesini göze alır, soğumayı asla */
const INTERACTIVE_WAIT_MS = 20_000
const MAX_DETAIL = 300
/** Klasör satırında sınırlayıcı tutulmuyor: ikisinden birini içeren yeni ad sunucuda açılmaz, kural istemcide kalır */
const NEW_FOLDER_DELIMITERS = ['/', '.']
/** INTERNALDATE sunucunun saatidir: izleme başlangıcı bu kadar geriden alınır, saat farkı gerçek postayı düşürmesin */
const WATCH_CLOCK_SKEW_MS = 5 * 60_000

export interface SieveManagerDeps {
  q: Queries
  creds: Map<number, string>
  scheduler: Pick<Scheduler, 'governorFor' | 'sieveLoginGate' | 'sieveCooldown' | 'sieveLoginOk'>
  connect?: typeof ManageSieveClient.connect
  detect?: typeof detectSieve
  now?: () => number
  onState(accountId: number): void
  debounceMs?: number
}

/** Şimdi login yapılamaz: hata değil, sonraya kalır. `waitMs` null: bir olay (parola, kilit açma) bekleniyor */
export class SieveDeferred extends Error {
  constructor(readonly detail: string | null, readonly waitMs: number | null, readonly unreachable = false) {
    super(detail ?? 'deferred')
    this.name = 'SieveDeferred'
  }
}

const clip = (s: string): string => s.slice(0, MAX_DETAIL)
const errorText = (e: unknown): string => clip(e instanceof Error ? e.message : String(e))
const isQuota = (e: unknown): boolean => e instanceof ManageSieveError && !!e.code?.startsWith('QUOTA')
const expectedDetail = (gen: SieveGenOutput): string | null => (gen.vacationDropped ? SIEVE_VACATION_TOO_LARGE : null)
const NOTHING_ON_SERVER = new Set<SieveState>(['unknown', 'off', 'unsupported'])
const holdsScripts = (row: SieveAccountRow): boolean => row.script_hash !== null || row.wrapper_of !== null
const busyText = (): string => inProcessLocale(() => t('sync.sieve.busy'))

function parseCaps(row: SieveAccountRow | undefined): SieveCapsInfo | null {
  if (!row?.caps_json) return null
  try {
    return JSON.parse(row.caps_json) as SieveCapsInfo
  } catch {
    return null
  }
}

/** Sarmalanan betik: sunucudaki metin satırdan önce gelir, başka cihaz başka betiği sarmalamış olabilir */
function wrappedTarget(row: SieveAccountRow, wrapperText: string | null): string | null {
  const live = wrapperText !== null && scriptOwnership(wrapperText, 'wrapper') === 'ours' ? parseWrapperTarget(wrapperText) : null
  return live ?? row.wrapper_of ?? (wrapperText === null ? null : parseWrapperTarget(wrapperText))
}

function managedPut(c: ManageSieveClient, name: string, text: string): Promise<void> {
  assertManagedName(name)
  return c.putScript(name, text)
}

function managedDelete(c: ManageSieveClient, name: string): Promise<void> {
  assertManagedName(name)
  return c.deleteScript(name)
}

export class SieveManager {
  private timers = new Map<number, { at: number; timer: ReturnType<typeof setTimeout> }>()
  private attempts = new Map<number, number>()
  /** Bu parolayla Sieve'e girmiş hesaplar. IMAP girişi kanıt değil: Sieve reddi aynı parolada da gelir. Yeniden başlayınca bütçe yine geçerli */
  private knownGood = new Set<number>()
  private chains = new Map<number, Promise<unknown>>()
  private stopped = false
  private now: () => number
  private connect: typeof ManageSieveClient.connect
  private detector: typeof detectSieve
  private debounceMs: number

  constructor(private d: SieveManagerDeps) {
    this.now = d.now ?? Date.now
    this.connect = d.connect ?? ManageSieveClient.connect.bind(ManageSieveClient)
    this.detector = d.detect ?? detectSieve
    this.debounceMs = d.debounceMs ?? DEBOUNCE_MS
  }

  // ---- sıra ----

  schedule(accountId: number): void {
    if (this.d.q.getSieveAccount(accountId)?.enabled) this.arm(accountId, this.debounceMs)
  }

  scheduleAll(): void {
    for (const r of this.d.q.listSieveAccounts()) if (r.enabled) this.arm(r.account_id, this.debounceMs)
  }

  /** Sırada çalışır: eski parolayla süren iş auth_failed'ı bundan sonra yazamasın. Kapalı hesapta da bekleyen geri alma tamamlanır */
  onCredentialsChanged(accountId: number): void {
    this.knownGood.delete(accountId)
    void this.serial(accountId, async () => {
      const row = this.d.q.getSieveAccount(accountId)
      if (!row || (!row.enabled && !holdsScripts(row))) return
      this.attempts.delete(accountId)
      if (row.state === 'auth_failed') this.patch(accountId, { state: 'pending', state_detail: null })
      this.arm(accountId, this.debounceMs)
    })
  }

  /** Kilit açma ve yeniden başlatma: bekleyen işin zamanlayıcısı bellekteydi */
  schedulePending(): void {
    for (const r of this.d.q.listSieveAccounts()) if (r.enabled && r.state === 'pending') this.arm(r.account_id, this.debounceMs)
  }

  /** Uç nokta geçersiz kılınmamışsa IMAP sunucusunu izler: eski TLS kipi ve yetenekler yeni sunucuya ait değildir */
  onAccountHostChanged(accountId: number): void {
    void this.serial(accountId, async () => {
      const row = this.d.q.getSieveAccount(accountId)
      if (row && row.host === null) this.resetTransport(accountId, {})
    })
  }

  /** IMAP adresi yazılmadan önce: eski sunucudaki betikler geri alınır, olmazsa atar ve değişiklik yapılmaz */
  prepareHostChange(accountId: number, abandon = false): Promise<boolean> {
    return this.serial(accountId, async () => {
      if (this.d.q.getSieveAccount(accountId)?.host !== null) return false
      const left = await this.leaveServer(accountId, abandon)
      if (left) this.resetTransport(accountId, {})
      return left
    })
  }

  /** Ham düzenleyici sarmalanan betiği değiştirdi: özet aynı kalsa da K5 ve K19 sunucuda yeniden denetlenmeli */
  onScriptEdited(accountId: number, name: string): void {
    const row = this.d.q.getSieveAccount(accountId)
    if (!row?.enabled || (row.state !== 'active' && row.state !== 'blocked_user_include') || row.wrapper_of !== name) return
    this.patch(accountId, { state: 'pending', state_detail: null })
    this.arm(accountId, this.debounceMs)
  }

  /** abandon: yönetici eski sunucuya ulaşılamadığını bilerek onayladı; betik orada kalır, yerel durum silinir. `left` true: öyle oldu */
  setEndpoint(accountId: number, host: string | null, port: number | null, abandon = false): Promise<SieveAccountInfo & { left: boolean }> {
    return this.serial(accountId, async () => {
      const left = await this.leaveServer(accountId, abandon)
      this.resetTransport(accountId, { host, port })
      return { ...this.info(accountId), left }
    })
  }

  /**
   * Başka sunucuya geçmeden önce: geride yetim betik kalmaz, onay da yeni sunucuya taşınmaz (K4).
   * Eski sunucu ulaşılamazsa geri alma sonsuza dek engellemesin diye yönetici bırakmayı onaylayabilir (true döner)
   */
  private async leaveServer(accountId: number, abandon: boolean): Promise<boolean> {
    const row = this.d.q.getSieveAccount(accountId)
    if (!row || !holdsScripts(row)) return false
    const refused = (reason: string, unreachable = false): Error => {
      const e = new Error(t('sync.sieve.endpointRefused', { reason: reason.slice(0, 120) })) as Error & { code?: string }
      if (unreachable) e.code = SIEVE_UNREACHABLE
      return e
    }
    let stillActive: boolean
    try {
      stillActive = await this.session(accountId, 'interactive', (c) => this.undo(c, row))
    } catch (e) {
      const kind = sieveFailureKind(e)
      const unreachable = e instanceof SieveDeferred ? e.unreachable : kind === 'unreachable' || kind === 'preauth'
      if (unreachable && abandon) {
        this.patch(accountId, { enabled: 0 }) // yeniden kurulmasın; resetTransport onay, sarmalayıcı ve özeti siler
        return true
      }
      throw refused(e instanceof SieveDeferred ? (e.detail ?? busyText()) : errorText(e), unreachable)
    }
    if (stillActive) throw refused(t('set.sieve.state.drift'))
    return false
  }

  private resetTransport(accountId: number, endpoint: Partial<SieveAccountRow>): void {
    const enabled = !!this.d.q.getSieveAccount(accountId)?.enabled
    clearDetectCache()
    this.attempts.delete(accountId)
    this.knownGood.delete(accountId)
    this.patch(accountId, {
      ...endpoint, tls: null, caps_json: null, caps_at: null, state: enabled ? 'pending' : 'unknown', state_detail: null,
      consent_script: null, consent_at: null, wrapper_of: null, script_hash: null, deployed_at: null, watched_json: '[]'
    })
    if (enabled) this.arm(accountId, this.debounceMs)
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers.values()) clearTimeout(t.timer)
    this.timers.clear()
  }

  /** Bekleyen tek zamanlayıcı: yenisi ötelemez, ilk değişikliğin penceresinde hepsi birlikte gider */
  private arm(accountId: number, delayMs: number): void {
    if (this.stopped) return
    const at = this.now() + delayMs
    const existing = this.timers.get(accountId)
    if (existing && existing.at <= at) return
    this.disarm(accountId)
    const timer = setTimeout(() => {
      this.timers.delete(accountId)
      const row = this.d.q.getSieveAccount(accountId)
      // kapalı hesapta tek bekleyen iş yarım kalmış geri almadır
      const job = !row || row.enabled || !holdsScripts(row) ? this.deployNow(accountId) : this.rollback(accountId)
      void job.catch((e) => console.error('sync: Sieve dağıtımı başarısız', errorText(e)))
    }, delayMs)
    timer.unref?.()
    this.timers.set(accountId, { at, timer })
  }

  private disarm(accountId: number): void {
    const t = this.timers.get(accountId)
    if (t) clearTimeout(t.timer)
    this.timers.delete(accountId)
  }

  /** Aynı hesapta tek iş: dağıtım, geri alma ve ham düzenleyici birbirinin oturumuna karışmaz */
  private serial<T>(accountId: number, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(accountId) ?? Promise.resolve()).then(fn, fn)
    const tail = run.catch(() => {})
    this.chains.set(accountId, tail)
    void tail.then(() => {
      if (this.chains.get(accountId) === tail) this.chains.delete(accountId)
    })
    return run
  }

  // ---- durum ----

  private patch(accountId: number, p: Partial<SieveAccountRow>): void {
    this.d.q.upsertSieveAccount(accountId, p, this.now())
    this.d.onState(accountId)
  }

  info(accountId: number): SieveAccountInfo {
    const row = this.d.q.getSieveAccount(accountId)
    const { host, port } = this.endpoint(accountId, row)
    return {
      accountId, enabled: !!row?.enabled, state: row?.state ?? 'unknown', detail: row?.state_detail ?? null, caps: parseCaps(row), capsAt: row?.caps_at ?? null,
      host, port, customHost: row?.host ?? null, deployedAt: row?.deployed_at ?? null, scriptHash: row?.script_hash ?? null,
      consentNeededFor: row?.state === 'needs_consent' ? (row.state_detail ?? null) : null, wrapperOf: row?.wrapper_of ?? null
    }
  }

  private endpoint(accountId: number, row: SieveAccountRow | undefined): { host: string; port: number } {
    return { host: row?.host ?? this.d.q.getAccountRow(accountId)?.imap_host ?? '', port: row?.port ?? DEFAULT_PORT }
  }

  private logFailure(accountId: number, state: SieveState): void {
    // sunucu metni betik parçası taşıyabilir: günlüğe yalnız durum adı
    this.d.q.insertRuleLog({ kind: 'rule', refId: null, accountId, messageId: null, summary: `Sieve: ${state}`, ok: false })
  }

  private defer(accountId: number, detail: string | null, waitMs: number | null): SieveAccountInfo {
    this.patch(accountId, { state: 'pending', state_detail: detail })
    if (waitMs !== null) this.arm(accountId, Math.max(MIN_WAIT_MS, waitMs))
    return this.info(accountId)
  }

  private retryLater(accountId: number): void {
    const n = (this.attempts.get(accountId) ?? 0) + 1
    if (n > MAX_RETRIES) return
    this.attempts.set(accountId, n)
    this.arm(accountId, Math.min(RETRY_BASE_MS * 2 ** (n - 1), RETRY_MAX_MS))
  }

  private failed(accountId: number, e: unknown): SieveAccountInfo {
    const kind = sieveFailureKind(e)
    const state: SieveState = kind === 'auth' ? 'auth_failed' : 'error'
    this.patch(accountId, { state, state_detail: errorText(e) })
    this.logFailure(accountId, state)
    const transient = kind === 'limit' || kind === 'net' || kind === 'preauth' || kind === 'unreachable'
    if (transient && !isQuota(e)) this.retryLater(accountId)
    return this.info(accountId)
  }

  // ---- algılama ----

  detect(accountId: number, force = false): Promise<SieveAccountInfo> {
    return this.serial(accountId, async () => {
      await this.runDetect(accountId, force)
      return this.info(accountId)
    })
  }

  private async runDetect(accountId: number, force: boolean): Promise<void> {
    const account = this.d.q.getAccountRow(accountId)
    if (!account) return
    const row = this.d.q.getSieveAccount(accountId)
    const { host, port } = this.endpoint(accountId, row)
    if (this.d.scheduler.governorFor(host).blockedFor() > 0) return // K13: soğumadaki ana makineye yoklama yok
    const r = await this.detector(
      { host, port, rejectUnauthorized: !account.allow_invalid_certs, authType: account.auth_type },
      { now: this.now, force }
    )
    if (r.supported) {
      const fresh = !row || row.state === 'unknown' || row.state === 'unsupported' || row.state === 'off'
      this.patch(accountId, {
        tls: r.tls, caps_json: JSON.stringify(r.caps), caps_at: this.now(),
        ...(fresh ? { state: row?.enabled ? 'pending' : 'off', state_detail: null } : {})
      })
    } else if (!r.transient && !row?.script_hash) {
      // ağ kesintisi desteklenmiyor demek değildir; dağıtılmış hesapta geçici yoklama hatası kuralları askıya almaz
      this.patch(accountId, { state: 'unsupported', state_detail: r.reason, tls: null, caps_json: r.caps ? JSON.stringify(r.caps) : null, caps_at: this.now() })
    }
  }

  // ---- üretim ----

  private generate(accountId: number, extensions: string[], vacation: SieveVacation | null): SieveGenOutput {
    return generateSieve({
      rules: this.d.q.getActiveRulesFor(accountId), extensions, folders: this.d.q.getFolders(accountId), delimiters: NEW_FOLDER_DELIMITERS,
      vacation, accountEmail: this.d.q.getAccountRow(accountId)?.email ?? ''
    })
  }

  placementFor(accountId: number): RulePlan[] {
    const row = this.d.q.getSieveAccount(accountId)
    const caps = parseCaps(row)
    // tatil yerleşimi etkilemez: kilitli kasada da çalışsın diye okunmaz
    if (row?.enabled && row.state === 'active' && caps) return this.generate(accountId, caps.sieve, null).plans
    return this.generate(accountId, [], null).plans.map((p) => ({ ...p, reason: 'sieve_off' as const }))
  }

  // ---- oturum ----

  withSession<T>(accountId: number, priority: Priority, fn: (c: ManageSieveClient) => Promise<T>): Promise<T> {
    return this.serial(accountId, () => this.session(accountId, priority, fn))
  }

  private async credential(accountId: number, secret: string): Promise<SieveCredential> {
    const account = this.d.q.getAccountRow(accountId)!
    const cred = await credentialFor(account, secret)
    return cred.kind === 'oauth'
      ? { kind: 'oauth', user: account.email, accessToken: cred.accessToken }
      : { kind: 'password', user: account.email, password: cred.password }
  }

  private async takeLogin(gov: HostGovernor, priority: Priority, knownGood: boolean): Promise<LoginGrant> {
    const deadline = Date.now() + (priority === 'interactive' ? INTERACTIVE_WAIT_MS : 0)
    for (;;) {
      const grant = gov.tryTakeLogin(priority, knownGood)
      if (grant.ok || grant.reason !== 'rate' || Date.now() + grant.waitMs > deadline) return grant
      await new Promise((resolve) => setTimeout(resolve, grant.waitMs))
    }
  }

  private async session<T>(accountId: number, priority: Priority, fn: (c: ManageSieveClient) => Promise<T>): Promise<T> {
    const { q, scheduler, creds } = this.d
    const account = q.getAccountRow(accountId)
    const secret = creds.get(accountId)
    if (!account) throw new SieveDeferred(null, null)
    const gate = scheduler.sieveLoginGate(accountId)
    if (gate || !secret) throw new SieveDeferred(gate, null)
    let row = q.getSieveAccount(accountId)
    if (row?.state === 'auth_failed') throw new SieveDeferred(row.state_detail, null) // K17: parola değişene kadar yok
    if (!row?.tls) {
      await this.runDetect(accountId, false)
      row = q.getSieveAccount(accountId)
    }
    const tls = row?.tls === 'tls' || row?.tls === 'starttls' ? row.tls : null
    const { host, port } = this.endpoint(accountId, row)
    const gov = scheduler.governorFor(host)
    if (!tls) throw new SieveDeferred(null, gov.blockedFor() || null, gov.blockedFor() === 0) // yoklama sunucuya ulaşamadı
    const credential = await this.credential(accountId, secret)
    // toplu açmada aynı ret her hesapta gelir: bütçe dolunca bu ana makineye hiçbir hesap denemez
    const budgetWait = gov.authBudgetWait()
    if (budgetWait > 0) throw new SieveDeferred(null, budgetWait)
    const grant = await this.takeLogin(gov, priority, this.knownGood.has(accountId))
    if (!grant.ok) throw new SieveDeferred(null, grant.waitMs)

    let client: ManageSieveClient | null = null
    let loggedIn = false
    try {
      client = await this.connect({ host, port, tls, rejectUnauthorized: !account.allow_invalid_certs })
      await client.authenticate(credential)
      loggedIn = true
      this.knownGood.add(accountId)
      gov.onLoginSuccess()
      scheduler.sieveLoginOk(host)
      q.recordLoginAttempt(host, accountId, 'sieve', 'ok')
      const out = await fn(client)
      await client.logout()
      return out
    } catch (e) {
      const kind = sieveFailureKind(e)
      // girişten sonraki kopma ana makine engeli değildir: soğuma IMAP'i de durdururdu
      const cooldown = kind === 'unreachable' || loggedIn ? null : gov.onLoginFailure(kind)
      if (cooldown) scheduler.sieveCooldown(host, cooldown)
      if (!loggedIn) q.recordLoginAttempt(host, accountId, 'sieve', kind === 'unreachable' ? 'net' : kind)
      // scheduler.onAuthFailure yok: Sieve reddi IMAP'i durdurmaz (K17)
      if (kind === 'auth') {
        this.knownGood.delete(accountId)
        this.patch(accountId, { state: 'auth_failed', state_detail: errorText(e) })
      }
      throw e
    } finally {
      client?.close()
    }
  }

  // ---- dağıtım ----

  /** force: özet aynı olsa da bağlanır. Sapma ancak böyle görülür (K23), yalnız kullanıcı eylemi */
  deployNow(accountId: number, force = false): Promise<SieveAccountInfo> {
    return this.serial(accountId, () => this.deploy(accountId, force))
  }

  private async deploy(accountId: number, force = false): Promise<SieveAccountInfo> {
    const { q, scheduler, creds } = this.d
    this.disarm(accountId)
    let row = q.getSieveAccount(accountId)
    if (!row?.enabled || !q.getAccountRow(accountId)) return this.info(accountId)
    if (row.state === 'unsupported' || row.state === 'auth_failed') return this.info(accountId)
    const gate = scheduler.sieveLoginGate(accountId)
    // parola yoksa olay bekler (kilit açma), diğer engeller IMAP tarafında kendiliğinden kalkar
    if (gate) return this.defer(accountId, gate, creds.get(accountId) ? RETRY_BASE_MS : null)

    try {
      if (!parseCaps(row)) {
        await this.runDetect(accountId, false)
        row = q.getSieveAccount(accountId)!
        if (row.state === 'unsupported') return this.info(accountId)
      }
      const caps = parseCaps(row)
      const { host } = this.endpoint(accountId, row)
      if (!caps) return this.defer(accountId, null, scheduler.governorFor(host).blockedFor() || RETRY_BASE_MS)

      let vacation: SieveVacation | null
      try {
        vacation = q.getSieveVacation(accountId)
      } catch (e) {
        if (getVaultKey()) throw e // kasa açık: satır bozuk, sonsuza kadar beklemesin
        return this.defer(accountId, null, null) // kasa kilitli: K21, içerik okunamıyorsa yazılmaz
      }
      const gen = this.generate(accountId, caps.sieve, vacation)
      const wanted = gen.hash ?? (row.script_hash ? generateEmptyRules().hash : null)
      if (wanted === null) {
        // K22: hiç dağıtılmadı ve dağıtılacak bir şey yok
        this.attempts.delete(accountId)
        this.patch(accountId, { state: 'active', state_detail: expectedDetail(gen) })
        return this.info(accountId)
      }
      // tatil çatışmasında dağıtılan betik tatilsizdir: aynı olduğu sürece bağlanmaya gerek yok
      const deployed = row.state_detail === SIEVE_VACATION_CONFLICT && gen.requires.includes('vacation')
        ? { hash: this.generate(accountId, caps.sieve, null).hash ?? generateEmptyRules().hash, detail: SIEVE_VACATION_CONFLICT }
        : { hash: wanted, detail: expectedDetail(gen) }
      if (!force && deployed.hash === row.script_hash && row.state === 'active' && row.state_detail === deployed.detail) return this.info(accountId)

      const current = row
      await this.session(accountId, 'background', (c) => this.apply(accountId, c, current, vacation))
      if (q.getSieveAccount(accountId)?.state === 'active') this.attempts.delete(accountId)
      return this.info(accountId)
    } catch (e) {
      if (e instanceof SieveDeferred) return this.defer(accountId, e.detail, e.waitMs)
      return this.failed(accountId, e)
    }
  }

  private async apply(accountId: number, c: ManageSieveClient, row: SieveAccountRow, vacation: SieveVacation | null): Promise<void> {
    const extensions = c.caps.sieve
    const capsPatch = { caps_json: JSON.stringify(c.caps), caps_at: this.now() }
    const scripts = await c.listScripts()
    const has = (name: string): boolean => scripts.some((s) => s.name === name)
    const rulesText = has(SIEVE_RULES_SCRIPT) ? await c.getScript(SIEVE_RULES_SCRIPT) : null
    const wrapperText = has(SIEVE_WRAPPER_SCRIPT) ? await c.getScript(SIEVE_WRAPPER_SCRIPT) : null
    const active = scripts.find((s) => s.active)?.name ?? null
    const activeText = active === null ? null
      : active === SIEVE_RULES_SCRIPT ? rulesText
      : active === SIEVE_WRAPPER_SCRIPT ? wrapperText
      : await c.getScript(active)

    const liveWrapped = active === SIEVE_WRAPPER_SCRIPT ? wrappedTarget(row, wrapperText) : null
    const liveWrappedText = liveWrapped !== null && has(liveWrapped) ? await c.getScript(liveWrapped) : null

    const plan = planActivation({
      scripts, rulesText, wrapperText, activeText, extensions, consentScript: row.consent_script, wrapperOf: row.wrapper_of,
      wrappedName: liveWrapped, wrappedText: liveWrappedText
    })
    if (plan.do === 'stop') {
      this.patch(accountId, { ...capsPatch, state: plan.state, state_detail: plan.userScript ?? null })
      return
    }

    const wrapped = plan.do === 'write_wrapper' ? plan.userScript : liveWrapped
    const wrappedText = plan.do === 'write_wrapper' ? activeText : liveWrappedText

    let gen = this.generate(accountId, extensions, vacation)
    const conflict = gen.requires.includes('vacation') && vacationConflict(wrappedText)
    if (conflict) gen = this.generate(accountId, extensions, null)
    const empty = gen.text === null && (row.script_hash !== null || rulesText !== null) ? generateEmptyRules() : null
    const text = gen.text ?? empty?.text ?? null
    const hash = gen.hash ?? empty?.hash ?? null
    const stateDetail = conflict ? SIEVE_VACATION_CONFLICT : expectedDetail(gen)

    if (text === null) {
      // yalnız tatil vardı ve çatıştı: yazılacak bir şey kalmadı
      this.patch(accountId, { ...capsPatch, state: 'active', state_detail: stateDetail })
      return
    }
    // betik etkinleşmeden önce: etkinleşme anından sonra hedefe düşen posta ilk poll'da yeni sayılabilsin
    if (gen.watched.length) this.d.q.addSieveWatched(accountId, gen.watched, this.now() - WATCH_CLOCK_SKEW_MS)
    if (!(await this.upload(accountId, c, SIEVE_RULES_SCRIPT, text))) return

    let wrapperOf: string | null = wrapped
    if (plan.do === 'activate_rules') {
      await c.setActive(SIEVE_RULES_SCRIPT)
      wrapperOf = null
    } else if (plan.do === 'write_wrapper') {
      if (!(await this.upload(accountId, c, SIEVE_WRAPPER_SCRIPT, generateWrapper(plan.userScript)))) return
      await c.setActive(SIEVE_WRAPPER_SCRIPT)
    }
    this.patch(accountId, {
      ...capsPatch, script_hash: hash, deployed_at: this.now(), watched_json: JSON.stringify(gen.watched),
      wrapper_of: wrapperOf, state: 'active', state_detail: stateDetail
    })
  }

  /** Denetle, yer sor, yaz. false: durum yazıldı, dağıtım durur */
  private async upload(accountId: number, c: ManageSieveClient, name: string, text: string): Promise<boolean> {
    const stop = (state: SieveState, detail: string | null): false => {
      this.patch(accountId, { state, state_detail: detail })
      this.logFailure(accountId, state)
      return false
    }
    // VERSION'sız sunucuda checkScript geçici betik yükler: dağıtımda yazma olmasın, PUTSCRIPT zaten doğrular
    if (c.caps.version !== null) {
      const check = await c.checkScript(text)
      if (!check.ok) return stop('invalid', clip(check.error))
    }
    if (!(await c.haveSpace(name, Buffer.byteLength(text, 'utf8')))) return stop('error', 'QUOTA')
    try {
      await managedPut(c, name, text)
    } catch (e) {
      // koda bağlı olmayan NO: sunucu betiği reddetti
      if (e instanceof ManageSieveError && e.phase === 'command' && e.code === null && e.transport === null) return stop('invalid', errorText(e))
      throw e
    }
    return true
  }

  // ---- açma, onay, geri alma ----

  async setEnabled(accountId: number, on: boolean): Promise<SieveAccountInfo> {
    if (!on) return this.rollback(accountId)
    return this.serial(accountId, async () => {
      this.d.q.upsertSieveAccount(accountId, { enabled: 1 }, this.now())
      await this.runDetect(accountId, false)
      if (this.d.q.getSieveAccount(accountId)?.state === 'unsupported') {
        this.patch(accountId, { enabled: 0 })
        return this.info(accountId)
      }
      return this.deploy(accountId)
    })
  }

  consent(accountId: number, scriptName: string): Promise<SieveAccountInfo> {
    return this.serial(accountId, async () => {
      const row = this.d.q.getSieveAccount(accountId)
      // kaldırılmış sarmalayıcıda yeni onay kurulumu yeniden başlatır
      const reset = row?.state === 'displaced' ? { wrapper_of: null } : {}
      this.patch(accountId, { consent_script: scriptName || null, consent_at: this.now(), ...reset })
      return this.deploy(accountId)
    })
  }

  rollback(accountId: number): Promise<SieveAccountInfo> {
    return this.serial(accountId, async () => {
      this.disarm(accountId)
      this.attempts.delete(accountId)
      const row = this.d.q.getSieveAccount(accountId)
      if (!row) return this.info(accountId)
      const touched = holdsScripts(row) || !(NOTHING_ON_SERVER.has(row.state) || row.state === 'auth_failed')
      if (touched) {
        let stillActive: boolean
        try {
          stillActive = await this.session(accountId, 'interactive', (c) => this.undo(c, row))
        } catch (e) {
          // satır kalır, geri alma yeniden çağrılabilir. Hesap kapanır: geri alınmak istenen betik yeniden dağıtılmasın
          const state = this.d.q.getSieveAccount(accountId)?.state === 'auth_failed' ? 'auth_failed' : 'error'
          const deferred = e instanceof SieveDeferred ? e : null
          this.patch(accountId, { enabled: 0, state, state_detail: deferred ? (deferred.detail ?? busyText()) : errorText(e) })
          this.logFailure(accountId, state)
          if (deferred?.waitMs != null) this.arm(accountId, Math.max(MIN_WAIT_MS, deferred.waitMs))
          return this.info(accountId)
        }
        if (stillActive) {
          // elle düzenlenmiş betik sunucuda çalışıyor: "kapalı" demek yalan olur, izlenen klasörler de sürer
          this.patch(accountId, { enabled: 0, state: 'drift', state_detail: null })
          this.logFailure(accountId, 'drift')
          return this.info(accountId)
        }
      }
      this.patch(accountId, {
        enabled: 0, state: 'off', state_detail: null, script_hash: null, deployed_at: null, consent_script: null, consent_at: null,
        wrapper_of: null, watched_json: '[]'
      })
      return this.info(accountId)
    })
  }

  /** Etkin betik bizimse önceki sahibine döner. Başlığı tutmayan betik bizim sayılmaz: silinmez, etkinliği değişmez.
   *  true: bizim adımızla elle düzenlenmiş betik hâlâ etkin */
  private async undo(c: ManageSieveClient, row: SieveAccountRow): Promise<boolean> {
    const scripts = await c.listScripts()
    const has = (name: string): boolean => scripts.some((s) => s.name === name)
    const rulesText = has(SIEVE_RULES_SCRIPT) ? await c.getScript(SIEVE_RULES_SCRIPT) : null
    const wrapperText = has(SIEVE_WRAPPER_SCRIPT) ? await c.getScript(SIEVE_WRAPPER_SCRIPT) : null
    const ownRules = scriptOwnership(rulesText, 'rules') === 'ours'
    const ownWrapper = scriptOwnership(wrapperText, 'wrapper') === 'ours'
    let active = scripts.find((s) => s.active)?.name ?? null
    if ((active === SIEVE_RULES_SCRIPT && ownRules) || (active === SIEVE_WRAPPER_SCRIPT && ownWrapper)) {
      const back = wrappedTarget(row, wrapperText)
      const target = back !== null && has(back) && back !== SIEVE_RULES_SCRIPT && back !== SIEVE_WRAPPER_SCRIPT ? back : ''
      await c.setActive(target)
      active = target || null
    }
    if (ownWrapper && active !== SIEVE_WRAPPER_SCRIPT) await managedDelete(c, SIEVE_WRAPPER_SCRIPT)
    // elle düzenlenmiş sarmalayıcı etkinken kural betiği silinirse include çalışma zamanında bozulur
    if (ownRules && active !== SIEVE_RULES_SCRIPT && active !== SIEVE_WRAPPER_SCRIPT) await managedDelete(c, SIEVE_RULES_SCRIPT)
    return active === SIEVE_RULES_SCRIPT || active === SIEVE_WRAPPER_SCRIPT
  }
}
