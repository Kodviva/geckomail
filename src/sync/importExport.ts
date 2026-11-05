// Yerel motor: taşıma planı ve mühürleme. Yalnız ana sürecin parentPort mesajıyla çağrılır, RPC yöntemi yoktur: renderer (posta XSS'i
// dahil) kendi anahtarını verip parolaları mühürletemesin. Plan sır taşımaz; parola yalnız `sealImportBatch` içinde okunur.
import { AUTOMATION_HOLD_PREF, type BlockReason, type ImportKind, type ImportNotice, type ImportStaying, type PlanItem, type Sealed, type SealRequest } from '../shared/importTypes'
import type { NotifyClause, NotifyRule } from '../shared/notifyRules'
import type { RuleAction, RuleCondition, SessionUser } from '../shared/rpc'
import { sessionUserFromRow } from './auth/sessionUser'
import { actionsToPortable } from './deviceSync'
import { sealItem } from './importEnvelope'
import type { RpcHub } from './rpcHub'
import { USER_PREF_KEYS } from './rpc/common'

export type { ImportKind, BlockReason, PlanItem } from '../shared/importTypes'

/** Beyaz liste: makineye ve sunucuya özgü olmayan genel ayarlar. Sunucu kendi listesiyle yeniden denetler */
export const IMPORT_GENERAL_PREFS = ['backfillTarget', 'pollCadenceSec', 'bodyPrefetch', 'authBanPerDay'] as const

/** Sıra anlamlıdır: kural hesap ve webhook'tan, kişisel veri hesaptan sonra gelir */
const KINDS: ImportKind[] = ['group', 'webhook', 'account', 'rule', 'trigger', 'template', 'pref', 'userPref', 'notifyRule', 'notifyAccountPref', 'signature']
/** Sunucuda da çalışmaya başlayanlar */
const AUTOMATION_KINDS: ImportKind[] = ['rule', 'trigger']

interface Item extends PlanItem {
  payload(): unknown
}

/** Tüm hesapların parolaları tek kullanıcının onayıyla gider: yalnız yerelde girişli yönetici başlatabilir */
function localAdmin(hub: RpcHub): SessionUser {
  const { q } = hub.deps
  const user = hub.sessions().find((s) => s.currentUser)?.currentUser
  const row = user?.role === 'admin' ? q.getUserById(user.id) : undefined // oturumdaki kimlik bayat olabilir
  if (hub.mode !== 'desktop' || !row?.enabled || row.role !== 'admin') throw new Error('yerel yönetici oturumu yok')
  return sessionUserFromRow(q, row)
}

function accountBlock(hub: RpcHub, a: { id: number; secure: number; authType: string }): BlockReason | null {
  if (a.authType !== 'password') return 'oauthReconnect'
  if (hub.deps.creds.has(a.id)) return null
  return a.secure ? 'vaultLocked' : 'noPassword'
}

/** Yerel Sieve ayarı taşınmaz, posta sunucusundaki betik kalır: hesap başına uyarılır */
function sieveLeft(hub: RpcHub, accountId: number): boolean {
  const row = hub.deps.q.getSieveAccount(accountId)
  return !!row && (!!row.enabled || row.script_hash !== null || row.wrapper_of !== null)
}

const accountClauses = (r: NotifyRule): NotifyClause[] => r.groups.flat().filter((c) => c.field === 'account')

function localItems(hub: RpcHub, user: SessionUser): Item[] {
  const { q, creds } = hub.deps
  const exp = q.getSyncExport()
  const emailOf = new Map(exp.accounts.map((a) => [a.id, a.email]))
  const webhooks = q.allWebhooks()
  const webhookName = new Map(webhooks.map((w) => [w.id, w.name]))
  const webhookUrl = new Map(webhooks.map((w) => [w.name, w.url]))
  const sameName = new Set(webhooks.filter((w, i) => webhooks.findIndex((x) => x.name === w.name) !== i).map((w) => w.name))
  const items: Item[] = []
  const add = (kind: ImportKind, id: string, label: string, blocked: BlockReason | null, payload: () => unknown, notice?: ImportNotice): void => {
    items.push({ key: `${kind}:${id}`, kind, label, blocked, payload, ...(notice ? { notice } : {}) })
  }

  for (const g of exp.groups) add('group', g.name, g.name, null, () => g)
  for (const w of webhooks) add('webhook', w.name, w.name, null, () => ({ name: w.name, url: w.url, secret: w.secret, enabled: !!w.enabled }))
  for (const a of exp.accounts) {
    add('account', a.email, a.email, accountBlock(hub, a), () => ({
      email: a.email, displayName: a.displayName, imapHost: a.imapHost, imapPort: a.imapPort, imapTls: a.imapTls, smtpHost: a.smtpHost, smtpPort: a.smtpPort,
      smtpTls: a.smtpTls, color: a.color, signature: a.signature, allowInvalidCerts: !!a.allowInvalidCerts, groupName: a.groupName,
      passwordChangedAt: a.passwordChangedAt || undefined, authType: a.authType, secure: !!a.secure, password: creds.get(a.id)
    }), sieveLeft(hub, a.id) ? 'sieveLeft' : undefined)
  }
  for (const r of exp.rules) {
    const actions = actionsToPortable(JSON.parse(r.actions_json) as RuleAction[], webhookName) as (RuleAction & { webhookName?: string })[]
    const hooks = actions.flatMap((a) => (a.type === 'webhook' && a.webhookName ? [a.webhookName] : []))
    add('rule', r.name, r.name, hooks.some((n) => sameName.has(n)) ? 'duplicateName' : null, () => ({
      name: r.name, enabled: !!r.enabled, accountEmail: r.accountEmail, groupName: r.groupName,
      conditions: JSON.parse(r.conditions_json) as RuleCondition, actions, runOnServer: r.run_on_server !== 0, webhookUrls: Object.fromEntries(hooks.map((n) => [n, webhookUrl.get(n)]))
    }))
  }
  for (const t of q.getAllScheduledTriggers()) {
    const p = JSON.parse(t.action_payload_json) as { fromAccountId?: number; toAddr?: string; accountIds?: number[] | null; webhookId?: number; resumeAtHHMM?: string }
    const ids = t.action_type === 'digest_email' ? [p.fromAccountId, ...(p.accountIds ?? [])] : []
    const unmapped = ids.some((id) => id == null || !emailOf.has(id)) || (t.action_type === 'webhook_ping' && !webhookName.has(p.webhookId ?? 0))
    const hook = t.action_type === 'webhook_ping' ? webhookName.get(p.webhookId ?? 0) : undefined
    add('trigger', t.name, t.name, unmapped ? 'unmappedAccount' : hook && sameName.has(hook) ? 'duplicateName' : null, () => ({
      name: t.name, enabled: !!t.enabled, scheduleType: t.schedule_type, scheduleValue: t.schedule_value, actionType: t.action_type,
      actionPayload: t.action_type === 'digest_email'
        ? { fromEmail: emailOf.get(p.fromAccountId!), toAddr: p.toAddr, accountEmails: p.accountIds ? p.accountIds.map((id) => emailOf.get(id)) : null }
        : t.action_type === 'webhook_ping' ? { webhookName: hook, webhookUrl: webhookUrl.get(hook ?? '') } : { resumeAtHHMM: p.resumeAtHHMM }
    }))
  }
  for (const t of q.listTemplates(user.id)) {
    add('template', t.shared ? `s:${t.name}` : `u${user.id}:${t.name}`, t.name, null, () => t)
  }
  const prefs = q.getAllPrefs()
  for (const k of IMPORT_GENERAL_PREFS) {
    const value = prefs[k]
    if (value != null) add('pref', k, k, null, () => ({ key: k, value }))
  }
  for (const k of USER_PREF_KEYS) {
    const value = q.userPrefGet(user.id, k)
    if (value != null) add('userPref', `u${user.id}:${k}`, k, null, () => ({ key: k, value }))
  }
  for (const r of q.listNotifyRules(user.id)) {
    const unmapped = accountClauses(r).some((c) => !emailOf.has(Number(c.value)))
    add('notifyRule', `u${user.id}:${r.name}`, r.name, unmapped ? 'unmappedAccount' : null, () => ({
      name: r.name, enabled: r.enabled, level: r.level,
      // hesap kimliği cihazlar arası farklı: e-postayla taşınır, sunucuda kimliğe çevrilir
      groups: r.groups.map((g) => g.map((c) => (c.field === 'account' ? { ...c, value: emailOf.get(Number(c.value)) } : c)))
    }))
  }
  for (const p of q.listNotifyAccountPrefs(user.id)) {
    const email = emailOf.get(p.accountId)
    if (email) add('notifyAccountPref', `u${user.id}:${email}`, email, null, () => ({ email, mode: p.mode }))
  }
  for (const [accountId, signature] of q.userSignatureMap(user.id)) {
    const email = emailOf.get(accountId)
    if (email) add('signature', `u${user.id}:${email}`, email, null, () => ({ email, signature }))
  }
  // anahtar adla kurulur, ad benzersiz değil: biri sessizce kaybolmasın, kural yanlış webhook'a bağlanmasın
  const seen = new Map<string, number>()
  for (const i of items) seen.set(i.key, (seen.get(i.key) ?? 0) + 1)
  for (const i of items) if ((seen.get(i.key) ?? 0) > 1) i.blocked ??= 'duplicateName'
  return KINDS.flatMap((k) => items.filter((i) => i.kind === k))
}

export function buildImportPlan(hub: RpcHub): PlanItem[] {
  return localItems(hub, localAdmin(hub)).map(({ key, kind, label, blocked, notice }) => ({ key, kind, label, blocked, ...(notice ? { notice } : {}) }))
}

export function importStaying(hub: RpcHub): ImportStaying {
  return hub.deps.q.importStayingCounts(hub.now())
}

/** Engelli, bilinmeyen ya da sırası değişen anahtar sessizce düşer: koşucu eksik ögeyi başarısız sayar. `serverKey` yalnız main'den gelir */
export function sealImportBatch(hub: RpcHub, r: SealRequest): Sealed[] {
  const wanted = new Set(r.keys)
  const items = localItems(hub, localAdmin(hub)).filter((i) => wanted.has(i.key) && !i.blocked)
  const sealed = items.map((i) => {
    const plain = Buffer.from(JSON.stringify({ kind: i.kind, data: i.payload() }), 'utf-8')
    try {
      return sealItem(r.serverKey, r.importId, i.key, plain)
    } finally {
      plain.fill(0)
    }
  })
  // kural sunucuda çalışmaya başlamadan yerelde durur. Mühürleme başarısızsa hiçbir şey gitmedi: otomasyona dokunulmaz.
  // Tamamlanan öge yeniden mühürlenmez, bekleyen kuralı olmayan sürdürme kullanıcının kararını bozmaz
  if (sealed.some((_, n) => AUTOMATION_KINDS.includes(items[n].kind))) hub.deps.q.prefSet(AUTOMATION_HOLD_PREF, '1')
  return sealed
}
