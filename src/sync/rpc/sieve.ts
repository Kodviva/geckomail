// RPC — Sunucu tarafı filtreler: durum, dağıtım, onay, ham düzenleyici, tatil yanıtı. Mantık src/sync/sieve altında.
// Bu dosyada ManageSieve'e giden tek özel iş ham düzenleyicidir: kullanıcı eylemiyle yabancı ada yazan tek yol budur.
import { createHash } from 'crypto'
import { lookup } from 'dns/promises'
import { isIP } from 'net'
import {
  SIEVE_PUBLIC_DETAILS, SIEVE_RULES_SCRIPT, SIEVE_VACATION_CONFLICT, SIEVE_WRAPPER_SCRIPT, validateVacation, type ClientReason, type RulePlacementInfo,
  type SieveAccountInfo, type SieveVacation
} from '../../shared/sieve'
import { t } from '../../shared/i18n'
import { isBlockedAddress } from '../net/safeFetch'
import type { RpcSession } from '../rpcSession'
import { ManageSieveError, type ManageSieveClient } from '../sieve/manageSieve'
import { SieveDeferred, type SieveManager } from '../sieve/manager'
import type { Handler } from './common'

const MAX_SCRIPT_BYTES = 256 * 1024
const KEEP_BACKUPS = 3
const NO_VACATION: SieveVacation = { enabled: false, subject: '', body: '', days: 1, startDate: null, endDate: null }

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
const isManaged = (name: string): boolean => name === SIEVE_RULES_SCRIPT || name === SIEVE_WRAPPER_SCRIPT
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300)

function managerOf(s: RpcSession): SieveManager {
  const m = s.deps.sieve
  if (!m) throw new Error(t('sync.sieve.unavailable'))
  return m
}

/** Yetki denetiminden sonra: bilinmeyen hesap sieve_accounts'a yabancı anahtar hatasıyla düşmesin */
function existing(s: RpcSession, accountId: number): number {
  if (!s.deps.q.getAccountRow(accountId)) throw new Error(t('sync.err.accountNotFound'))
  return accountId
}

const manageable = (s: RpcSession, params: unknown): number => {
  const { accountId } = params as { accountId: number }
  s.assertCanManage(accountId)
  return existing(s, accountId)
}

/** Görme izni durumu verir. Ham sunucu metni ve betik adları hesabı yönetebilene aittir */
function forViewer(s: RpcSession, info: SieveAccountInfo): SieveAccountInfo {
  try {
    s.assertCanManage(info.accountId)
    return info
  } catch {
    return { ...info, detail: info.detail !== null && SIEVE_PUBLIC_DETAILS.has(info.detail) ? info.detail : null, consentNeededFor: null, wrapperOf: null }
  }
}

/** Sunucu modunda iç ağa bağlantı yok: elle verilen uç nokta iç hizmetleri yoklamanın yolu olmasın */
async function assertPublicHost(host: string): Promise<void> {
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address)
  if (!addresses.length || addresses.some(isBlockedAddress)) throw new Error(t('sync.sieve.privateEndpoint'))
}

function assertScriptSize(content: unknown): asserts content is string {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_SCRIPT_BYTES) throw new Error(t('sync.sieve.scriptTooLarge'))
}

/** Oturum ertelendi (parola yok, kilitli kasa, governor): kullanıcı eylemi sıraya girmez, nedenini görür */
async function inSession<T>(s: RpcSession, accountId: number, fn: (c: ManageSieveClient) => Promise<T>): Promise<T> {
  try {
    return await managerOf(s).withSession(accountId, 'interactive', fn)
  } catch (e) {
    if (e instanceof SieveDeferred) throw new Error(e.detail ?? t('sync.sieve.busy'))
    if (e instanceof ManageSieveError) throw new Error(errorText(e))
    throw e
  }
}

/** Dakika çözünürlüğü: aynı dakikadaki ikinci kayıt ilk yedeği ezmesin. UTC: yaz saati sırayı bozmaz */
function backupNameFor(name: string, taken: Set<string>, now: number): string {
  for (let t = now; ; t += 60_000) {
    const stamp = new Date(t).toISOString().replace(/\D/g, '').slice(0, 12)
    const candidate = `${name}.bak-${stamp}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Yalnız tam kalıba uyan, etkin olmayan yedekler. Temizlik başarısızlığı kaydı geri almaz */
async function pruneBackups(c: ManageSieveClient, name: string, scripts: { name: string; active: boolean }[], fresh: string): Promise<void> {
  const prefix = `${name}.bak-`
  const isBackup = (n: string): boolean => n.startsWith(prefix) && /^\d{12}$/.test(n.slice(prefix.length))
  const old = scripts.filter((x) => isBackup(x.name) && !x.active).map((x) => x.name).sort().reverse().slice(KEEP_BACKUPS - 1)
  for (const n of old) {
    if (n === fresh) continue
    await c.deleteScript(n).catch((e) => console.warn('sync: Sieve yedeği silinemedi', errorText(e)))
  }
}

interface SaveResult {
  ok: boolean
  conflict?: boolean
  error?: string
  backupName?: string
  content?: string
  sha?: string
  scripts?: { name: string; active: boolean; managed: boolean }[]
}

/** Düzenleyicinin yeniden okuyacağı her şey aynı oturumda döner: kayıt tek login */
async function saveScript(c: ManageSieveClient, name: string, content: string, baseSha: string, now: number): Promise<SaveResult> {
  const scripts = await c.listScripts()
  if (!scripts.some((x) => x.name === name)) return { ok: false, error: t('sync.sieve.scriptMissing') } // K20: yeni betik bu parçada yok
  const current = await c.getScript(name)
  if (sha(current) !== baseSha) return { ok: false, conflict: true }
  const check = await c.checkScript(content)
  if (!check.ok) return { ok: false, error: check.error }
  const backupName = backupNameFor(name, new Set(scripts.map((x) => x.name)), now)
  if (!(await c.haveSpace(backupName, Buffer.byteLength(current, 'utf8')))) return { ok: false, error: t('sync.sieve.noSpace') }
  try {
    await c.putScript(backupName, current)
  } catch (e) {
    if (!(e instanceof ManageSieveError)) throw e
    return { ok: false, error: e.code?.startsWith('QUOTA') ? t('sync.sieve.noSpace') : errorText(e) }
  }
  await c.putScript(name, content)
  await pruneBackups(c, name, scripts, backupName)
  const saved = await c.getScript(name)
  return { ok: true, backupName, content: saved, sha: sha(saved), scripts: (await c.listScripts()).map((x) => ({ ...x, managed: isManaged(x.name) })) }
}

function endpointHost(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  const v = String(raw).trim().toLowerCase()
  if (!/^[a-z0-9.-]+$/.test(v) || !v.includes('.')) throw new Error(t('sync.acct.invalidHost', { proto: 'ManageSieve' }))
  return v
}

function endpointPort(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 65535) throw new Error(t('sync.acct.invalidPort', { proto: 'ManageSieve' }))
  return raw
}

export const sieveHandlers: Record<string, Handler> = {
  async listSieveAccounts(s: RpcSession, _params: unknown) {
    const m = managerOf(s)
    const ids = s.resolveAccountIds(null) ?? s.deps.q.getAccountRows().map((a) => a.id)
    return ids.map((id) => forViewer(s, m.info(id)))
  },

  async getSieveAccount(s: RpcSession, params: unknown) {
    const { accountId } = params as { accountId: number }
    s.assertCanView(accountId)
    return forViewer(s, managerOf(s).info(existing(s, accountId)))
  },

  async sieveDetect(s: RpcSession, params: unknown) {
    return managerOf(s).detect(manageable(s, params), !!(params as { force?: boolean }).force)
  },

  async sieveSetEnabled(s: RpcSession, params: unknown) {
    return managerOf(s).setEnabled(manageable(s, params), !!(params as { enabled?: boolean }).enabled)
  },

  async sieveSetEndpoint(s: RpcSession, params: unknown) {
    const accountId = manageable(s, params)
    const p = params as { host?: unknown; port?: unknown }
    const host = endpointHost(p.host)
    if (host !== null && s.hub.mode === 'server') await assertPublicHost(host)
    const abandon = !!(p as { abandon?: unknown }).abandon && s.currentUser?.role === 'admin' // üye için eskisi gibi ret
    return managerOf(s).setEndpoint(accountId, host, endpointPort(p.port), abandon)
  },

  async sieveConsent(s: RpcSession, params: unknown) {
    const accountId = manageable(s, params)
    const { scriptName } = params as { scriptName?: unknown }
    const m = managerOf(s)
    // boş ad: etkinlik hiçbir betikte değil, kuralları yeniden kurmak yalnız displaced durumunda istenebilir
    const reinstall = scriptName === '' && m.info(accountId).state === 'displaced'
    if (typeof scriptName !== 'string' || (!scriptName && !reinstall)) throw new Error(t('sync.sieve.scriptMissing'))
    return m.consent(accountId, scriptName)
  },

  async sieveDeployNow(s: RpcSession, params: unknown) {
    return managerOf(s).deployNow(manageable(s, params), true)
  },

  async sieveRollback(s: RpcSession, params: unknown) {
    return managerOf(s).rollback(manageable(s, params))
  },

  async sieveListScripts(s: RpcSession, params: unknown) {
    const accountId = manageable(s, params)
    const scripts = await inSession(s, accountId, (c) => c.listScripts())
    return scripts.map((x) => ({ ...x, managed: isManaged(x.name) }))
  },

  async sieveGetScript(s: RpcSession, params: unknown) {
    const accountId = manageable(s, params)
    const { name } = params as { name: string }
    const content = await inSession(s, accountId, (c) => c.getScript(String(name)))
    return { content, sha: sha(content), managed: isManaged(String(name)) }
  },

  async sieveCheckScript(s: RpcSession, params: unknown) {
    const accountId = manageable(s, params)
    const { content } = params as { content: unknown }
    assertScriptSize(content)
    return inSession(s, accountId, (c) => c.checkScript(content))
  },

  async sieveSaveScript(s: RpcSession, params: unknown) {
    const accountId = manageable(s, params)
    const { name, content, baseSha } = params as { name: string; content: unknown; baseSha: string }
    if (typeof name !== 'string' || !name) throw new Error(t('sync.sieve.scriptMissing'))
    if (isManaged(name)) throw new Error(t('sync.sieve.scriptManaged'))
    assertScriptSize(content)
    const out = await inSession(s, accountId, (c) => saveScript(c, name, content, String(baseSha), s.hub.now()))
    if (out.ok) managerOf(s).onScriptEdited(accountId, name)
    return out
  },

  async getSieveVacation(s: RpcSession, params: unknown) {
    const accountId = manageable(s, params)
    const info = managerOf(s).info(accountId)
    const ext = info.caps?.sieve ?? []
    return {
      vacation: s.deps.q.getSieveVacation(accountId) ?? NO_VACATION, // kilitli kasa burada atar: boş tatil gibi görünmez
      supported: ext.includes('vacation'),
      dateRange: ext.includes('date') && ext.includes('relational'),
      conflict: info.detail === SIEVE_VACATION_CONFLICT
    }
  },

  async setSieveVacation(s: RpcSession, params: unknown) {
    const accountId = manageable(s, params)
    const m = managerOf(s)
    const v = validateVacation((params as { vacation?: unknown }).vacation)
    if (typeof v === 'string') throw new Error(t(v))
    const { caps } = m.info(accountId)
    // K18: istemci yedeği yok. Yetenek bilinmiyorsa kayıt kalır, dağıtım eklentiye bakar
    if (v.enabled && caps && !caps.sieve.includes('vacation')) throw new Error(t('sync.sieve.vacationUnsupported'))
    s.deps.q.setSieveVacation(accountId, v, s.hub.now())
    m.schedule(accountId)
    return m.info(accountId)
  },

  async getRulePlacements(s: RpcSession, _params: unknown) {
    const m = managerOf(s)
    const byRule = new Map<number, RulePlacementInfo & { why: Set<ClientReason> }>()
    for (const { id } of s.deps.q.getAccountRows()) {
      for (const plan of m.placementFor(id)) {
        let info = byRule.get(plan.ruleId)
        if (!info) {
          info = { ruleId: plan.ruleId, server: 0, split: 0, client: 0, reasons: [], why: new Set() }
          byRule.set(plan.ruleId, info)
        }
        info[plan.placement]++
        if (plan.reason) info.why.add(plan.reason)
      }
    }
    return [...byRule.values()].map(({ why, ...info }) => ({ ...info, reasons: [...why] }))
  }
}
