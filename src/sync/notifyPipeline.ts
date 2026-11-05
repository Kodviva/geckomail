// Bildirim hattı (§10.1): yeni posta ve duyurular için kullanıcı başına karar, pencere boyunca toplama, hesaplar
// arası özet. Karar sırası: hesap kapalı → kişisel kural → otomasyon/VIP → kapsam (özet adayı). Oturum aranmaz:
// sekmesi kapalı kullanıcı için de karar verilir (teslimi NotifySink bilir). Kasa hesabı bildirimi içerik taşımaz.
import { getLocale, isLocale, tFor, type Locale } from '../shared/i18n'
import { firstMatch, matchRule, ruleNeedsBody, type NotifyLevel, type NotifyMessage, type NotifyRule } from '../shared/notifyRules'
import type { PushActionId, PushItem } from '../shared/pushTypes'
import type { MessageRow, SessionUser } from '../shared/rpc'
import { userCanView } from './auth/sessionUser'
import type { Queries } from './db/queries'
import type { EngineHost } from './host'
import { syncLog as log } from './log'
import { isVip, parseNotifyPrefs, shouldNotifyMessage, shouldNotifySummary, type NotifyPrefs, type NotifyReason } from './notifyPolicy'
import { USER_PREF_KEYS } from './rpc/common'
import type { RpcHub } from './rpcHub'
import { inProcessLocale } from './sessionLocale'

export interface NotifySink {
  deliver(userId: number, items: PushItem[]): void
}

export interface NotifyPipelineOptions {
  q: Queries
  hub: RpcHub
  sink: NotifySink
  mode: 'desktop' | 'server'
  windowMs?: number
  now?: () => Date
  /** Parti başına gövde çekimi süresi */
  bodyBudgetMs?: number
  /** Yalnız kasa dışı hesap iletisi için çağrılır; okunamazsa null */
  fetchBodyText(messageId: number): Promise<string | null>
}

export const MAX_INDIVIDUAL = 5 // bir partide kişi başına en fazla; fazlası özete katılır
const WINDOW_MS = 3000
const MAX_BODY_FETCH = 20 // parti başına; fazlası gövdesiz değerlendirilir
const MAX_BODY_TEXT = 200 * 1024
const BODY_BUDGET_MS = 10_000
/** Masaüstünde hiç kullanıcı yokken (kurulum öncesi) genel tercihlerle karar: sink kullanıcıya bakmaz */
const NO_USER = 0

/** Kullanıcının bildirim tercihleri; kişisel değer yoksa genel değer (göç öncesi varsayılan).
 *  userId null: yalnız genel (hiç kullanıcı yokken). Susturma (notifyMutedUntil) cihaz genelidir. */
export function userNotifyPrefs(q: Queries, userId: number | null): NotifyPrefs {
  return parseNotifyPrefs((k) => (userId != null && USER_PREF_KEYS.has(k) ? q.userPrefGet(userId, k) : null) ?? q.prefGet(k))
}

/** Hesabı görebilen etkin kullanıcılar (yöneticiler dahil) */
export function usersFor(q: Queries, accountId: number): number[] {
  return q.notifyUserIdsFor(accountId)
}

/** Masaüstü: ev sahibi bildirimi; tıklama messageId varsa iletiyi, yoksa hesabı açar. `actionsFor`: gösterilecek düğmeler */
export function hostSink(host: Pick<EngineHost, 'notify'>, actionsFor: (item: PushItem) => PushActionId[] = () => []): NotifySink {
  return {
    deliver(_userId, items) {
      for (const it of items) {
        host.notify({
          title: it.title,
          body: it.body,
          ...(it.accountId != null ? { accountId: it.accountId } : {}),
          ...(it.messageId != null ? { messageId: it.messageId } : {}),
          actions: actionsFor(it),
          level: it.level,
          tag: it.tag
        })
      }
    }
  }
}

/** Duyuru metni: hazır ya da alıcının dilinde üretilir */
export type NoticeText = string | ((loc: Locale) => string)

export interface Notice {
  title: NoticeText
  body: NoticeText
  accountId: number | null
  userIds?: number[]
  /** Masaüstünde kimse girişli değilken başlık yerine: içerik sahibinden başkasına görünmesin */
  anonymousTitle?: NoticeText
}

/** Süresi dolan takip için duyuru: yalnız sahibine; göç öncesi sahipsiz kayıt hesabı görenlere. Kasa hesabında
 *  konu ve alıcı yazılmaz. */
export function followupNotice(
  q: Queries,
  f: { accountId: number; subject: string | null; to: string | null; userId: number | null }
): Notice & { accountId: number } {
  const acct = q.getAccountRow(f.accountId)
  return {
    title: (loc) => tFor(loc, 'sync.notify.noReply'),
    body: (loc) =>
      acct?.secure ? acct.email : `${f.subject || tFor(loc, 'sync.notify.noSubject')} — ${f.to ?? ''}${acct ? ` (${acct.email})` : ''}`,
    accountId: f.accountId,
    ...(f.userId != null ? { userIds: [f.userId] } : {})
  }
}

interface Viewer {
  id: number
  prefs: NotifyPrefs
  rules: NotifyRule[]
  locale: Locale
  accountMode: 'on' | 'off' | null
}

interface AccountLabel {
  accountId: number
  email: string
}

/** Bir onNewMail çağrısının karar girdileri */
interface MailBatch {
  label: AccountLabel
  secure: boolean
  starred: boolean
  automation: ReadonlyMap<number, NotifyReason>
  now: Date
  /** masaüstü: alıcılar belirlenirken girişli kullanıcı */
  sessionUserId: number | null
}

/** Pencere boyunca biriken: mail satırı üst sınıra takılırsa özete, duyuru duyuru sayacına iner */
type Entry = { item: PushItem; account: AccountLabel | null; settled?: (delivered: boolean) => void }

interface Bucket {
  locale: Locale
  entries: Entry[]
  /** özet adayları: hesap başına sayı */
  summary: Map<number, AccountLabel & { count: number; urgent: boolean }>
  /** masaüstü: karar anındaki girişli kullanıcı */
  sessionUserId: number | null
  timer: ReturnType<typeof setTimeout>
}

function recipients(toJson: string | null): string[] {
  if (!toJson) return []
  try {
    const list = JSON.parse(toJson) as { address?: string }[]
    return Array.isArray(list) ? list.flatMap((a) => (a?.address ? [a.address] : [])) : []
  } catch {
    return []
  }
}

/** Kişinin kuralları için gövde gerekir mi: önce gelen kural gövdesiz eşleşiyorsa ya da gövde koşulu dışındaki
 *  koşullar tutmuyorsa sonuç gövdeye bağlı değildir (kurallar position sırasıyla gelir) */
function waitsForBody(rules: NotifyRule[], msg: NotifyMessage): boolean {
  for (const r of rules) {
    if (!r.enabled) continue
    if (matchRule(r, msg)) return false
    if (!ruleNeedsBody(r)) continue
    const possible = r.groups.some((g) => {
      const rest = g.filter((c) => c.field !== 'body')
      return g.length > 0 && (rest.length === 0 || matchRule({ ...r, groups: [rest] }, msg))
    })
    if (possible) return true
  }
  return false
}

export class NotifyPipeline {
  private readonly q: Queries
  private readonly hub: RpcHub
  private readonly sink: NotifySink
  private readonly mode: 'desktop' | 'server'
  private readonly windowMs: number
  private readonly bodyBudgetMs: number
  private readonly now: () => Date
  private readonly fetchBodyText: (messageId: number) => Promise<string | null>
  private readonly buckets = new Map<number, Bucket>()
  private readonly inflight = new Set<Promise<void>>()
  /** pencerede bekleyen takipler: sonraki tur yeniden sıraya almasın */
  private readonly followupsQueued = new Set<number>()
  private stopped = false

  constructor(o: NotifyPipelineOptions) {
    this.q = o.q
    this.hub = o.hub
    this.sink = o.sink
    this.mode = o.mode
    this.windowMs = o.windowMs ?? WINDOW_MS
    this.bodyBudgetMs = o.bodyBudgetMs ?? BODY_BUDGET_MS
    this.now = o.now ?? (() => new Date())
    this.fetchBodyText = o.fetchBodyText
  }

  /** rows: bu turun yeni iletileri; automation: otomasyon kuralının "Bildir" nedeni (ileti kimliğine göre) */
  onNewMail(accountId: number, rows: MessageRow[], automation: ReadonlyMap<number, NotifyReason> = new Map()): Promise<void> {
    const job: Promise<void> = this.process(accountId, rows, automation)
      .catch((e) => console.error('sync: bildirim kararı başarısız', (e as Error).message))
      .finally(() => this.inflight.delete(job))
    this.inflight.add(job)
    return job
  }

  /** Posta dışı duyuru (takip, anomali): kapsamdan bağımsız, sessiz saat ve susturmaya uyar.
   *  'queued': pencereye girdi, settled teslim sonucunu bir kez bildirir. 'retry': şimdi kimseye gidemez (sessiz
   *  saat, susturma, masaüstünde başka kullanıcı girişli). 'nobody': alıcı yok, beklemenin anlamı yok.
   *  Sahipsiz duyuruda en az biri aldıysa kişi başına iz tutulmaz, sessiz saatteki diğerlerine tekrar edilmez. */
  notice(n: Notice, settled?: (delivered: boolean) => void): 'queued' | 'retry' | 'nobody' {
    if (this.stopped) return 'retry'
    const sessionUserId = this.sessionUser()?.id ?? null
    if (n.anonymousTitle && this.mode === 'desktop' && sessionUserId == null) n = { ...n, title: n.anonymousTitle }
    // masaüstünde kimse girişli değilken karar ilk admin adına: sahibi süzmek hatırlatmayı kaybettirir
    const allowed = n.userIds && (this.mode === 'server' || sessionUserId != null) ? new Set(n.userIds) : null
    const now = this.now()
    const targets = this.targets(n.accountId).filter((id) => !allowed || allowed.has(id))
    if (!targets.length) return this.mode === 'desktop' && sessionUserId != null ? 'retry' : 'nobody'
    const viewers = targets.map((id) => this.viewer(id, n.accountId)).filter((v) => v.accountMode !== 'off')
    if (!viewers.length) return 'nobody'
    const awake = viewers.filter((v) => shouldNotifyMessage(v.prefs, 'rule', now))
    if (!awake.length) return 'retry'
    let left = awake.length
    let any = false
    const one = (delivered: boolean): void => {
      any ||= delivered
      if (--left === 0) settled?.(any)
    }
    for (const v of awake) {
      const title = typeof n.title === 'string' ? n.title : n.title(v.locale)
      const body = typeof n.body === 'string' ? n.body : n.body(v.locale)
      this.bucket(v, sessionUserId).entries.push({
        account: null,
        settled: one,
        item: { title, body, accountId: n.accountId, messageId: null, level: 'normal', count: 1, tag: `notice:${n.accountId ?? ''}:${title}:${body}` }
      })
    }
    return 'queued'
  }

  /** Bildirimi bekleyen takipleri sıraya alır. Kayıt teslimden sonra işaretlenir: sessiz saate takılan ya da
   *  kullanıcı değişince atılan takip sonraki turda yeniden denenir */
  deliverDueFollowups(): void {
    for (const f of this.q.followupsToNotify()) {
      if (this.followupsQueued.has(f.id)) continue
      const outcome = this.notice(followupNotice(this.q, f), (delivered) => {
        this.followupsQueued.delete(f.id)
        if (delivered) this.q.markFollowupNotified(f.id)
      })
      if (outcome === 'queued') this.followupsQueued.add(f.id)
      else if (outcome === 'nobody') this.q.markFollowupNotified(f.id)
    }
  }

  /** Süren kararları bekler, biriken her şeyi hemen teslim eder */
  async flush(): Promise<void> {
    while (this.inflight.size) await Promise.all(this.inflight)
    for (const id of this.buckets.keys()) this.drain(id)
  }

  /** Motor kapanıyor: kararı verilmiş olan teslim edilir, DB'ye bir daha dokunulmaz */
  stop(): void {
    for (const id of this.buckets.keys()) this.drain(id)
    this.stopped = true
  }

  private async process(accountId: number, rows: MessageRow[], automation: ReadonlyMap<number, NotifyReason>): Promise<void> {
    if (this.stopped) return
    const acc = this.q.getAccountRow(accountId)
    if (!acc) return
    const fresh = rows.filter((r) => !r.locked) // kilitli kasa sessiz kalır (§10.6)
    const viewers = this.targets(accountId).map((id) => this.viewer(id, accountId)).filter((v) => v.accountMode !== 'off')
    if (!fresh.length || !viewers.length) return
    const batch: MailBatch = { label: { accountId, email: acc.email }, secure: !!acc.secure, starred: !!acc.starred, automation, now: this.now(), sessionUserId: this.sessionUser()?.id ?? null }

    // gövde beklemeyen kararlar hemen pencereye: başkasının gövde kuralı kimseyi bekletmez
    const waiting = new Map<number, { row: MessageRow; viewers: Viewer[] }>()
    for (const v of viewers) {
      for (const row of fresh) {
        if (!batch.secure && waitsForBody(v.rules, this.toNotifyMessage(row, accountId, null))) {
          const w = waiting.get(row.id)
          if (w) w.viewers.push(v)
          else waiting.set(row.id, { row, viewers: [v] })
        } else this.decide(v, row, null, batch)
      }
    }
    if (!waiting.size) return

    // gövde ileti başına bir kez çekilir; rulesRunner'ın işlemi bittikten sonra buradayız
    const bodies = await this.fetchBodies([...waiting.keys()].slice(0, MAX_BODY_FETCH))
    if (this.stopped) return
    const later = { ...batch, now: this.now() }
    for (const { row, viewers: list } of waiting.values()) for (const v of list) this.decide(v, row, bodies.get(row.id) ?? null, later)
  }

  private toNotifyMessage(row: MessageRow, accountId: number, body: string | null): NotifyMessage {
    return { accountId, fromAddr: row.fromAddr, to: recipients(row.toJson), subject: row.subject, body, hasAttachments: row.hasAttachments }
  }

  private decide(v: Viewer, row: MessageRow, body: string | null, b: MailBatch): void {
    const rule = firstMatch(v.rules, this.toNotifyMessage(row, b.label.accountId, body))
    if (rule?.level === 'silent') return
    const reason: NotifyReason | undefined = rule
      ? rule.level === 'urgent' ? 'rule-urgent' : 'rule'
      : isVip(row.fromAddr, v.prefs.vip) ? 'vip' : b.automation.get(row.id)
    if (reason) {
      if (shouldNotifyMessage(v.prefs, reason, b.now)) this.bucket(v, b.sessionUserId).entries.push({ account: b.label, item: this.messageItem(v.locale, row, reason, b.label, b.secure) })
    } else if (shouldNotifySummary(v.accountMode === 'on' ? { ...v.prefs, scope: 'all' } : v.prefs, b.starred, b.now)) {
      this.addSummary(this.bucket(v, b.sessionUserId), b.label, false)
    }
  }

  /** Sırayla çeker; ilk hata ya da süre dolunca durur, kalan iletiler gövdesiz değerlendirilir */
  private async fetchBodies(ids: number[]): Promise<Map<number, string | null>> {
    const bodies = new Map<number, string | null>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('süre doldu'), { name: 'BodyBudgetExpired' })), this.bodyBudgetMs)
      timer.unref?.()
    })
    try {
      for (const id of ids) {
        if (this.stopped) break
        try {
          const text = await Promise.race([this.fetchBodyText(id), expired])
          bodies.set(id, text?.slice(0, MAX_BODY_TEXT) ?? null)
        } catch (e) {
          log.warn('bildirim kuralı için gövde okunamadı', { messageId: id, error: (e as Error).name })
          break
        }
      }
    } finally {
      clearTimeout(timer)
    }
    return bodies
  }

  /** Kimin için karar verilecek. Masaüstü: girişli kullanıcı, yoksa ilk admin (ya da hiç kullanıcı yok) */
  private targets(accountId: number | null): number[] {
    if (this.mode === 'desktop') {
      const user = this.sessionUser()
      if (user) return accountId == null || userCanView(this.q, user, accountId) ? [user.id] : []
      return [this.q.firstAdminId() ?? NO_USER]
    }
    if (accountId != null) return usersFor(this.q, accountId)
    return this.q.getUsers().filter((u) => u.enabled).map((u) => u.id)
  }

  private sessionUser(): SessionUser | null {
    return this.hub.sessions().find((s) => s.currentUser)?.currentUser ?? null
  }

  private viewer(id: number, accountId: number | null): Viewer {
    const userId = id === NO_USER ? null : id
    const q = this.q
    return {
      id,
      prefs: userNotifyPrefs(q, userId),
      rules: userId == null ? [] : q.listNotifyRules(userId),
      locale: this.localeOf(userId),
      accountMode: userId != null && accountId != null ? (q.listNotifyAccountPrefs(userId).find((p) => p.accountId === accountId)?.mode ?? null) : null
    }
  }

  /** Masaüstünde dil süreç geneli; sunucuda kullanıcının kayıtlı dili (setSessionLocale), yoksa süreç dili */
  private localeOf(userId: number | null): Locale {
    const saved = userId != null && this.mode === 'server' ? this.q.userPrefGet(userId, 'locale') : null
    return isLocale(saved) ? saved : inProcessLocale(() => getLocale())
  }

  private messageItem(loc: Locale, row: MessageRow, reason: NotifyReason, acc: AccountLabel, secure: boolean): PushItem {
    const base = { accountId: acc.accountId, messageId: row.id, level: reason === 'rule' ? 'normal' : 'urgent', tag: `msg:${row.id}`, count: 1 } as const
    // kasa: gönderen ve konu bildirime girmez
    if (secure) return { ...base, title: acc.email, body: tFor(loc, 'sync.notify.newMail', { count: 1 }) }
    const from = row.fromName || row.fromAddr || tFor(loc, 'sync.notify.newMailFallback')
    const title = reason === 'vip' ? tFor(loc, 'sync.notify.titleVip', { from }) : reason === 'rule-urgent' ? tFor(loc, 'sync.notify.titleUrgent', { from }) : from
    return { ...base, title, body: `${row.subject || tFor(loc, 'sync.notify.noSubject')} — ${acc.email}` }
  }

  private addSummary(b: Bucket, acc: AccountLabel, urgent: boolean): void {
    const cur = b.summary.get(acc.accountId)
    if (cur) {
      cur.count++
      cur.urgent ||= urgent
    } else b.summary.set(acc.accountId, { ...acc, count: 1, urgent })
  }

  private bucket(v: Viewer, sessionUserId: number | null): Bucket {
    let b = this.buckets.get(v.id)
    if (b) b.sessionUserId ??= sessionUserId
    else {
      const timer = setTimeout(() => this.drain(v.id), this.windowMs)
      timer.unref?.()
      b = { locale: v.locale, entries: [], summary: new Map(), sessionUserId, timer }
      this.buckets.set(v.id, b)
    }
    return b
  }

  private drain(userId: number): void {
    const b = this.buckets.get(userId)
    if (!b) return
    clearTimeout(b.timer)
    this.buckets.delete(userId)
    if (this.mode === 'desktop') {
      // pencerede kullanıcı değişti: öncekinin bildirimi yeni kişinin ekranına düşmesin
      const current = this.sessionUser()?.id ?? null
      if (current != null ? current !== userId : b.sessionUserId != null) {
        for (const e of b.entries) e.settled?.(false)
        return
      }
    }
    // sınıra takılan normal olsun: acil öne (sıralama kararlı, gelen sıra korunur)
    const sorted = [...b.entries].sort((x, y) => Number(y.item.level === 'urgent') - Number(x.item.level === 'urgent'))
    const items = sorted.slice(0, MAX_INDIVIDUAL).map((e) => e.item)
    let extraNotices = 0
    for (const e of sorted.slice(MAX_INDIVIDUAL)) {
      if (e.account) this.addSummary(b, e.account, e.item.level === 'urgent')
      else extraNotices++
    }
    if (extraNotices) {
      items.push({
        title: 'GeckoMail', body: tFor(b.locale, 'sync.notify.moreNotices', { count: extraNotices }), accountId: null, messageId: null,
        level: 'normal', tag: 'notices', count: extraNotices
      })
    }
    const summary = this.summaryItem(b)
    if (summary) items.push(summary)
    if (!items.length) return
    let delivered = false
    try {
      this.sink.deliver(userId, items)
      delivered = true
    } catch (e) {
      console.error('sync: bildirim teslim edilemedi', (e as Error).message)
    }
    for (const e of b.entries) e.settled?.(delivered)
  }

  private summaryItem(b: Bucket): PushItem | null {
    const list = [...b.summary.values()]
    if (!list.length) return null
    const count = list.reduce((n, a) => n + a.count, 0)
    const level: NotifyLevel = list.some((a) => a.urgent) ? 'urgent' : 'normal'
    if (list.length === 1) {
      const [a] = list
      return { title: a.email, body: tFor(b.locale, 'sync.notify.newMail', { count }), accountId: a.accountId, messageId: null, level, tag: `new:${a.accountId}`, count }
    }
    const body = tFor(b.locale, 'sync.notify.newMailMulti', { accounts: list.length, count })
    return { title: 'GeckoMail', body, accountId: null, messageId: null, level, tag: 'new:all', count }
  }
}
