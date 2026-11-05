// RPC — Yerelden sunucuya taşıma (yalnız sunucu modunda, yönetici). Öge zarfla gelir, açılır, `host.encrypt` ya da kasa anahtarıyla
// yazılır. Her öge bağımsızdır ve idempotenttir: `import_ledger` kaldığı yeri tutar, içine yalnız anahtar ve neden kodu girer.
// Ayrıştırma hatası metni içerik parçası taşıyabilir: ögeden gelen hata asla yayılmaz ya da yazılmaz.
import { randomUUID } from 'crypto'
import type { ImportBlock, ImportKind, ImportNotice, Sealed } from '../../shared/importTypes'
import { MAX_RULES, validateRule } from '../../shared/notifyRules'
import type { RuleAction, RuleCondition, ScheduleType, SessionUser, TriggerActionType } from '../../shared/rpc'
import { sessionUserFromRow } from '../auth/sessionUser'
import { mergeAccount, mergeRule } from '../configMerge'
import { remotePasswordWins, type SyncAccount } from '../deviceSync'
import { newImportKeys } from '../importEnvelope'
import { IMPORT_GENERAL_PREFS } from '../importExport'
import { computeNextDailyRun } from '../scheduledTriggers'
import { getVaultStatus } from '../vault/manager'
import type { RpcSession } from '../rpcSession'
import { type Handler, USER_PREF_KEYS } from './common'
import { t } from '../../shared/i18n'

const RUN_TTL_MS = 30 * 60_000
const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_KEY = 512
const MAX_B64 = 16 * 1024 * 1024
const MAX_NAME = 200
const MAX_SIGNATURE = 20_000
const MAX_PREF = 8000
const HOST = /^[a-z0-9.-]+$/
const DEFAULT_COLOR = '#8d7ba6'

export interface ImportRun {
  session: RpcSession
  sourceId: string
  expires: number
  open(s: Sealed, importId: string): Buffer
}

type Outcome = { status: 'added' | 'updated' | 'kept'; notice?: ImportNotice } | { status: 'blocked'; detail: ImportBlock }
const KEPT: Outcome = { status: 'kept' }
const ADDED: Outcome = { status: 'added' }
const blocked = (detail: ImportBlock): Outcome => ({ status: 'blocked', detail })

const PERSONAL_KINDS: ImportKind[] = ['userPref', 'notifyRule', 'notifyAccountPref', 'signature']
const KINDS: ImportKind[] = ['group', 'webhook', 'account', 'rule', 'trigger', 'template', 'pref', ...PERSONAL_KINDS]

const kindOf = (key: string): string => key.slice(0, key.indexOf(':'))
/** Kişisel veri sunucudaki her kullanıcıya ayrı gider: başka yöneticinin taşıması bunu tamamlanmış saymaz */
const isPersonal = (key: string): boolean => PERSONAL_KINDS.includes(kindOf(key) as ImportKind) || key.startsWith('template:u')
const lower = (v: unknown): unknown => (typeof v === 'string' ? v.toLowerCase() : v)

/** Bu kaynağın sunucuya yazdığı ya da eşlediği ögeler: grup ve kapsam kararları buna bakar */
const doneKeys = (s: RpcSession, sourceId: string): Set<string> =>
  new Set(s.deps.q.importLedgerRows(sourceId).filter((r) => r.status === 'done').map((r) => r.itemKey))

/** Genel kural ve tüm hesap özeti başkalarının postasını da kapsar: bu kaynaktan gelmeyen hesap varsa kapalı gelir */
const hasOtherAccounts = (s: RpcSession, done: Set<string>): boolean => s.deps.q.getAccountRows().some((a) => !done.has(`account:${a.email}`))

/** Taşınan webhook adı sunucuda başka adrese gidiyorsa veri yanlış uca akar */
const webhookMatches = (s: RpcSession, name: string, url: unknown): boolean => s.deps.q.allWebhooks().filter((w) => w.name === name).every((w) => w.url === url)

/** Oturumdaki kimlik 60 sn'ye dek bayat olabilir: parola yazan iş DB'ye bakar */
function freshAdmin(s: RpcSession): SessionUser {
  const row = s.deps.q.getUserById(s.currentUser!.id)
  if (!row?.enabled || row.role !== 'admin') throw new Error(t('sync.perm.adminRequired'))
  return sessionUserFromRow(s.deps.q, row)
}

function activeRun(s: RpcSession, importId: unknown): ImportRun {
  const run = typeof importId === 'string' ? s.hub.imports.get(importId) : undefined
  // süresi dolan ya da başka oturumun taşıması ayrılmaz: koşucu yeniden başlar
  if (!run || run.session !== s || run.expires <= s.hub.now()) throw new Error('taşıma oturumu yok')
  return run
}

const str = (v: unknown, max = MAX_NAME): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const optStr = (v: unknown, max: number): boolean => v == null || (typeof v === 'string' && v.length <= max)

function parseSealed(v: unknown): Sealed {
  const i = (v ?? {}) as Record<string, unknown>
  const ok = str(i.key, MAX_KEY) && str(i.pub, MAX_B64) && str(i.iv, MAX_B64) && str(i.ct, MAX_B64)
  if (!ok || !KINDS.includes(kindOf(i.key as string) as ImportKind)) throw new Error('zarf bozuk')
  return i as unknown as Sealed
}

const validHost = (h: unknown): h is string => typeof h === 'string' && HOST.test(h) && h.includes('.')
const validPort = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 65535
const validTls = (v: unknown): boolean => v === 'tls' || v === 'starttls'

type AccountData = SyncAccount & { secure: boolean }

function validAccount(a: Partial<AccountData>): a is AccountData {
  return str(a.email, 254) && a.email.includes('@') && validHost(a.imapHost) && validHost(a.smtpHost) && validPort(a.imapPort) && validPort(a.smtpPort)
    && validTls(a.imapTls) && validTls(a.smtpTls) && str(a.color, 32) && optStr(a.displayName, MAX_NAME) && optStr(a.signature, MAX_SIGNATURE)
    && optStr(a.groupName, MAX_NAME) && str(a.password, 4096) && typeof a.allowInvalidCerts === 'boolean' && typeof a.secure === 'boolean'
    && (a.passwordChangedAt === undefined || Number.isSafeInteger(a.passwordChangedAt))
}

/** Yalnız parola alanları: sunucu adresi, sertifika ayarı, grup ve imza sunucudaki haliyle kalır */
async function replacePassword(s: RpcSession, id: number, data: AccountData): Promise<Outcome> {
  const { q, creds, scheduler, encrypt, sieve } = s.deps
  q.updateAccountFields(id, { password_enc: Buffer.from((await encrypt([data.password]))[0]), password_changed_at: data.passwordChangedAt ?? 0 })
  creds.set(id, data.password)
  scheduler.retryAccount(id)
  sieve?.onCredentialsChanged(id)
  return { status: 'updated' }
}

async function importAccount(s: RpcSession, sourceId: string, raw: Partial<AccountData>): Promise<Outcome> {
  const { q, scheduler } = s.deps
  const data = { ...raw, imapHost: lower(raw.imapHost), smtpHost: lower(raw.smtpHost) } as Partial<AccountData>
  if (data.authType && data.authType !== 'password') return blocked('oauthReconnect')
  if (!validAccount(data)) return blocked('invalid')
  const existingId = q.getAccountIdByEmail(data.email)
  const row = existingId != null ? q.getAccountRow(existingId) : undefined
  if (row?.secure || (row && data.secure)) return blocked('vaultConflict')
  if (data.secure && getVaultStatus(q) !== 'unlocked') return blocked('vaultRequired') // korumayı sessizce düşürmek yasak
  // var olan hesapta yalnız daha yeni parola değişir, başka alan yazılmaz. OAuth hesabına parola yazılmaz
  if (row) return row.auth_type === 'password' && remotePasswordWins(false, row.password_changed_at ?? null, data.passwordChangedAt) ? replacePassword(s, row.id, data) : KEPT
  // başka birinin grubuna katılırsa posta o grubun üyelerine açılır
  const groupName = data.groupName && doneKeys(s, sourceId).has(`group:${data.groupName}`) ? data.groupName : null
  const r = await mergeAccount(s.deps, { ...data, groupName, authType: 'password' }, { vault: data.secure })
  if (r.skippedSecure) return blocked('vaultConflict')
  scheduler.reloadAccounts()
  return data.groupName && !groupName ? { status: 'added', notice: 'groupDropped' } : ADDED
}

function importRule(s: RpcSession, sourceId: string, d: { name?: unknown; enabled?: unknown; accountEmail?: unknown; groupName?: unknown; conditions?: unknown; actions?: unknown; runOnServer?: unknown; webhookUrls?: unknown }): Outcome {
  const { q, sieve } = s.deps
  if (!str(d.name) || typeof d.enabled !== 'boolean' || !optStr(d.accountEmail, 254) || !optStr(d.groupName, MAX_NAME)) return blocked('invalid')
  if (typeof d.conditions !== 'object' || d.conditions === null || !Array.isArray(d.actions)) return blocked('invalid')
  if (d.runOnServer !== undefined && typeof d.runOnServer !== 'boolean') return blocked('invalid')
  if (q.getAllRules().some((r) => r.name === d.name)) return KEPT // sunucudaki aynı adlı kural ezilmez
  const accountEmail = (d.accountEmail as string | null | undefined) ?? null
  if (accountEmail && q.getAccountIdByEmail(accountEmail) == null) return blocked('unmappedAccount')
  const groupName = (d.groupName as string | null | undefined) ?? null
  const done = doneKeys(s, sourceId)
  if (groupName && !done.has(`group:${groupName}`)) return blocked('groupConflict') // başka grubun üyelerine yayılmasın
  const webhookIds = new Map(q.allWebhooks().map((w) => [w.name, w.id]))
  const actions = d.actions as (RuleAction & { webhookName?: string })[]
  const hooks = actions.flatMap((a) => (a.type === 'webhook' ? [a.webhookName ?? ''] : []))
  if (hooks.some((n) => !webhookIds.has(n))) return blocked('invalid') // yanlış webhook'a veri gitmesin
  const urls = (d.webhookUrls ?? {}) as Record<string, unknown>
  if (hooks.some((n) => !webhookMatches(s, n, urls[n]))) return blocked('webhookConflict')
  const narrowed = d.enabled && !accountEmail && !groupName && hasOtherAccounts(s, done)
  mergeRule(q, { name: d.name, enabled: d.enabled && !narrowed, accountEmail, groupName, conditions: d.conditions as RuleCondition, actions, runOnServer: d.runOnServer as boolean | undefined }, webhookIds)
  // grup ve genel kuralın hesap listesi burada çözülmez: automation.ts ile aynı
  const scopeId = accountEmail ? q.getAccountIdByEmail(accountEmail) : null
  if (scopeId == null) sieve?.scheduleAll()
  else sieve?.schedule(scopeId)
  return narrowed ? { status: 'added', notice: 'scopeDisabled' } : ADDED
}

function triggerPayload(s: RpcSession, type: unknown, p: Record<string, unknown>): Record<string, unknown> | ImportBlock {
  const { q } = s.deps
  if (type === 'digest_email') {
    const fromAccountId = str(p.fromEmail, 254) ? q.getAccountIdByEmail(p.fromEmail) : undefined
    if (fromAccountId == null) return 'unmappedAccount'
    if (!str(p.toAddr, 254)) return 'invalid'
    if (p.accountEmails == null) return { fromAccountId, toAddr: p.toAddr, accountIds: null }
    if (!Array.isArray(p.accountEmails)) return 'invalid'
    const accountIds = p.accountEmails.map((e) => (typeof e === 'string' ? q.getAccountIdByEmail(e) : undefined))
    return accountIds.some((id) => id == null) ? 'unmappedAccount' : { fromAccountId, toAddr: p.toAddr, accountIds }
  }
  if (type === 'webhook_ping') {
    const webhook = q.allWebhooks().find((w) => w.name === p.webhookName)
    if (!webhook) return 'invalid'
    return webhookMatches(s, webhook.name, p.webhookUrl) ? { webhookId: webhook.id } : 'webhookConflict'
  }
  if (type === 'mute_notifications') return typeof p.resumeAtHHMM === 'string' && /^\d{2}:\d{2}$/.test(p.resumeAtHHMM) ? { resumeAtHHMM: p.resumeAtHHMM } : 'invalid'
  return 'invalid'
}

function importTrigger(s: RpcSession, sourceId: string, d: { name?: unknown; enabled?: unknown; scheduleType?: unknown; scheduleValue?: unknown; actionType?: unknown; actionPayload?: unknown }): Outcome {
  const { q } = s.deps
  if (!str(d.name) || typeof d.enabled !== 'boolean' || !str(d.scheduleValue, 16) || (d.scheduleType !== 'daily' && d.scheduleType !== 'interval')) return blocked('invalid')
  if (d.scheduleType === 'daily' && !/^\d{2}:\d{2}$/.test(d.scheduleValue)) return blocked('invalid')
  if (typeof d.actionPayload !== 'object' || d.actionPayload === null) return blocked('invalid')
  if (q.getAllScheduledTriggers().some((x) => x.name === d.name)) return KEPT
  const actionPayload = triggerPayload(s, d.actionType, d.actionPayload as Record<string, unknown>)
  if (typeof actionPayload === 'string') return blocked(actionPayload)
  const now = s.hub.now()
  const nextRunAt = d.scheduleType === 'daily' ? computeNextDailyRun(d.scheduleValue, now) : now + Math.max(1, Number(d.scheduleValue) || 30) * 60_000
  const id = q.insertScheduledTrigger({ name: d.name, scheduleType: d.scheduleType as ScheduleType, scheduleValue: d.scheduleValue, actionType: d.actionType as TriggerActionType, actionPayload, nextRunAt })
  const allAccounts = d.actionType === 'digest_email' && (actionPayload as { accountIds?: unknown }).accountIds == null
  const narrowed = d.enabled && allAccounts && hasOtherAccounts(s, doneKeys(s, sourceId))
  if (!d.enabled || narrowed) q.updateScheduledTriggerFields(id, { enabled: 0 })
  return narrowed ? { status: 'added', notice: 'scopeDisabled' } : ADDED
}

function importTemplate(s: RpcSession, user: SessionUser, key: string, d: { name?: unknown; subject?: unknown; body?: unknown; updatedAt?: unknown }): Outcome {
  const { q } = s.deps
  if (!str(d.name) || !optStr(d.subject, MAX_NAME * 5) || typeof d.body !== 'string' || !Number.isSafeInteger(d.updatedAt)) return blocked('invalid')
  const shared = key.startsWith('template:s:')
  if (q.templateExists(d.name, shared ? null : user.id)) return KEPT
  q.saveTemplate({ name: d.name, subject: (d.subject as string | null | undefined) ?? null, body: d.body, shared }, shared ? null : user.id, d.updatedAt as number)
  return ADDED
}

function importPref(s: RpcSession, d: { key?: unknown; value?: unknown }): Outcome {
  const { q, scheduler } = s.deps
  // beyaz liste burada da: yönetici oturumu bile bu yolla güven ayarı ya da iç durum yazamaz
  if (!IMPORT_GENERAL_PREFS.some((k) => k === d.key) || !str(d.value, 64)) return KEPT
  if (q.prefGet(d.key as string) != null) return KEPT
  q.prefSet(d.key as string, d.value)
  scheduler.applyPrefs()
  return ADDED
}

function importUserPref(s: RpcSession, user: SessionUser, d: { key?: unknown; value?: unknown }): Outcome {
  const { q } = s.deps
  if (typeof d.key !== 'string' || !USER_PREF_KEYS.has(d.key) || !str(d.value, MAX_PREF)) return KEPT
  if (q.userPrefGet(user.id, d.key) != null) return KEPT
  q.userPrefSet(user.id, d.key, d.value)
  return ADDED
}

function importNotifyRule(s: RpcSession, user: SessionUser, d: unknown): Outcome {
  const { q } = s.deps
  const raw = (d ?? {}) as { groups?: { field: string; value: unknown }[][] }
  if (!Array.isArray(raw.groups) || !raw.groups.every(Array.isArray)) return blocked('invalid')
  let unmapped = false
  const groups = raw.groups.map((g) => g.map((c) => {
    if (c?.field !== 'account') return c
    const id = typeof c.value === 'string' ? q.getAccountIdByEmail(c.value) : undefined
    unmapped ||= id == null
    return { ...c, value: String(id) }
  }))
  if (unmapped) return blocked('unmappedAccount')
  const rule = validateRule({ ...raw, groups })
  if (typeof rule === 'string') return blocked('invalid')
  const own = q.listNotifyRules(user.id)
  if (own.some((r) => r.name === rule.name)) return KEPT
  if (own.length >= MAX_RULES) return blocked('invalid')
  q.saveNotifyRule(user.id, { ...rule, id: 0 }, s.hub.now())
  return ADDED
}

function importNotifyAccountPref(s: RpcSession, user: SessionUser, d: { email?: unknown; mode?: unknown }): Outcome {
  const { q } = s.deps
  if ((d.mode !== 'on' && d.mode !== 'off') || !str(d.email, 254)) return blocked('invalid')
  const id = q.getAccountIdByEmail(d.email)
  if (id == null) return blocked('unmappedAccount')
  if (q.listNotifyAccountPrefs(user.id).some((p) => p.accountId === id)) return KEPT
  q.setNotifyAccountPref(user.id, id, d.mode)
  return ADDED
}

function importSignature(s: RpcSession, user: SessionUser, d: { email?: unknown; signature?: unknown }): Outcome {
  const { q } = s.deps
  if (!str(d.email, 254) || !str(d.signature, MAX_SIGNATURE)) return blocked('invalid')
  const id = q.getAccountIdByEmail(d.email)
  if (id == null) return blocked('unmappedAccount')
  if (q.userSignatureMap(user.id).has(id)) return KEPT
  q.setUserSignature(user.id, id, d.signature)
  return ADDED
}

function importSimple(s: RpcSession, user: SessionUser, sourceId: string, kind: ImportKind, key: string, d: Record<string, unknown>): Outcome {
  const { q } = s.deps
  switch (kind) {
    case 'group':
      if (!str(d.name)) return blocked('invalid')
      if (q.getSyncExport().groups.some((g) => g.name === d.name)) return blocked('groupConflict') // üyeleri başkasının: birleştirilmez
      q.ensureGroupByName(d.name, str(d.color, 32) ? d.color : DEFAULT_COLOR)
      return ADDED
    case 'webhook':
      if (!str(d.name) || !str(d.url, 2048) || !optStr(d.secret, 512) || typeof d.enabled !== 'boolean') return blocked('invalid')
      if (q.allWebhooks().some((w) => w.name === d.name)) return KEPT // sır dahil: sunucudaki aynı adlı webhook ezilmez
      q.upsertWebhookByName({ name: d.name, url: d.url, secret: (d.secret as string | null | undefined) ?? null, enabled: d.enabled })
      return ADDED
    case 'rule':
      return importRule(s, sourceId, d)
    case 'trigger':
      return importTrigger(s, sourceId, d)
    case 'template':
      return importTemplate(s, user, key, d)
    case 'pref':
      return importPref(s, d)
    case 'userPref':
      return importUserPref(s, user, d)
    case 'notifyRule':
      return importNotifyRule(s, user, d)
    case 'notifyAccountPref':
      return importNotifyAccountPref(s, user, d)
    case 'signature':
      return importSignature(s, user, d)
    default:
      return blocked('invalid')
  }
}

async function applyItem(s: RpcSession, user: SessionUser, sourceId: string, key: string, plain: Buffer): Promise<Outcome> {
  const { kind, data } = JSON.parse(plain.toString('utf-8')) as { kind: ImportKind; data: Record<string, unknown> }
  // anahtar defterde durur: içerikle aynı türü söylemeli
  if (kind !== kindOf(key) || typeof data !== 'object' || data === null) return blocked('invalid')
  return kind === 'account' ? importAccount(s, sourceId, data) : importSimple(s, user, sourceId, kind, key, data)
}

export const importHandlers: Record<string, Handler> = {
  async importBegin(s: RpcSession, params: unknown) {
    const sourceId = (params as { sourceId?: unknown } | null)?.sourceId
    if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId) || !s.webSessionId) throw new Error(t('sync.perm.loginRequired'))
    const user = freshAdmin(s)
    const now = s.hub.now()
    for (const [id, run] of s.hub.imports) if (run.session === s || run.expires <= now) s.hub.imports.delete(id)
    const keys = newImportKeys()
    const importId = randomUUID()
    s.hub.imports.set(importId, { session: s, sourceId, expires: now + RUN_TTL_MS, open: keys.open })
    setTimeout(() => s.hub.imports.delete(importId), RUN_TTL_MS).unref?.() // özel anahtar süresi dolunca bellekten çıkar
    const rows = s.deps.q.importLedgerRows(sourceId).filter((r) => r.status === 'done' && (!isPersonal(r.itemKey) || r.userId === user.id))
    return { importId, serverKey: keys.publicKey, done: rows.map((r) => r.itemKey), notices: rows.filter((r) => r.detail).map((r) => ({ key: r.itemKey, notice: r.detail })) }
  },

  async importItem(s: RpcSession, params: unknown) {
    const { importId, item: raw } = (params ?? {}) as { importId?: unknown; item?: unknown }
    const run = activeRun(s, importId)
    const user = freshAdmin(s)
    const item = parseSealed(raw)
    let plain: Buffer
    try {
      plain = run.open(item, importId as string)
    } catch {
      throw new Error('zarf açılamadı')
    }
    const { q } = s.deps
    let result: Outcome
    try {
      const prior = q.importLedgerRows(run.sourceId).find((r) => r.itemKey === item.key)
      result = prior?.status === 'done' && (!isPersonal(item.key) || prior.userId === user.id) ? KEPT : await applyItem(s, user, run.sourceId, item.key, plain)
    } catch {
      console.error('taşıma ögesi işlenemedi', { kind: kindOf(item.key) }) // hata metni içerik taşıyabilir
      result = blocked('invalid')
    } finally {
      plain.fill(0)
    }
    q.importLedgerSet({
      sourceId: run.sourceId, itemKey: item.key, status: result.status === 'blocked' ? 'blocked' : 'done',
      detail: result.status === 'blocked' ? result.detail : (result.notice ?? null), userId: user.id, now: s.hub.now()
    })
    return result
  },

  async importFinish(s: RpcSession, params: unknown) {
    const importId = (params as { importId?: unknown } | null)?.importId
    const run = activeRun(s, importId)
    const { q, scheduler } = s.deps
    s.hub.imports.delete(importId as string)
    scheduler.reloadAccounts()
    scheduler.pollAllSoon()
    s.broadcast('messages:changed', { accountId: null })
    s.broadcast('counts:changed', {})
    return { accounts: q.importLedgerRows(run.sourceId).filter((r) => r.status === 'done' && kindOf(r.itemKey) === 'account').length }
  }
}
