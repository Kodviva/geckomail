// RPC — Stalwart yönetimi (R17/R32): bağlantı, IP engelleri, izinli IP'ler, hesap uyumu.
// Anahtar safeStorage ile şifreli saklanır, renderer'a asla dönmez. Tamamı yönetici yetkisi ister.
import { isIP } from 'net'
import type { ServerAdminConfig } from '../../shared/rpc'
import type { RpcSession } from '../rpcSession'
import { detectProvider, PROVIDER_NAMES, providerFor, suggestAdminUrl, type ProviderId, type ServerProvider } from '../serverProvider'
import { accountDiff, existingKeyFile, normalizeBaseUrl, readKeyFile } from '../stalwartAdmin'
import type { Handler } from './common'
import { t } from '../../shared/i18n'

// eski ad (stalwart_*) ilk sürümden: taşınmadan okunur
const URL_PREFS = ['server_admin_url', 'stalwart_url']
const KEY_PREFS = ['server_admin_key_blob', 'stalwart_key_blob']
const PROVIDER_PREF = 'server_admin_provider'

function prefAny(s: RpcSession, keys: string[]): string | null {
  for (const k of keys) {
    const v = s.deps.q.prefGet(k)
    if (v) return v
  }
  return null
}

function config(s: RpcSession): ServerAdminConfig {
  const saved = prefAny(s, URL_PREFS)
  const suggestion = saved ? null : suggestAdminUrl(s.deps.q.getAccountRows().map((a) => a.imap_host))
  const provider = (prefAny(s, [PROVIDER_PREF]) as ProviderId | null) ?? (prefAny(s, KEY_PREFS) ? 'stalwart' : null)
  return {
    url: saved ?? suggestion ?? '',
    suggested: !saved && !!suggestion,
    hasKey: !!prefAny(s, KEY_PREFS),
    keyFileExists: !!existingKeyFile(),
    provider: provider ? PROVIDER_NAMES[provider] : null
  }
}

async function client(s: RpcSession): Promise<ServerProvider> {
  const blob = prefAny(s, KEY_PREFS)
  const url = prefAny(s, URL_PREFS)
  if (!blob || !url) throw new Error(t('sync.server.notConfigured'))
  const [key] = await s.deps.decrypt([new Uint8Array(Buffer.from(blob, 'base64'))])
  if (!key) throw new Error(t('sync.server.keyDecryptFailed'))
  return providerFor((prefAny(s, [PROVIDER_PREF]) as ProviderId | null) ?? 'stalwart', url, key)
}

/** IPv4/IPv6 ya da CIDR */
function validIpMask(v: string): boolean {
  const [ip, bits, extra] = v.split('/')
  if (extra !== undefined || !isIP(ip)) return false
  if (bits === undefined) return true
  const n = Number(bits)
  return Number.isInteger(n) && n >= 0 && n <= (isIP(ip) === 4 ? 32 : 128)
}

const ids = (params: unknown): string[] =>
  (Array.isArray((params as { ids?: unknown }).ids) ? (params as { ids: unknown[] }).ids : [])
    .map(String)
    .filter((x) => /^[a-z0-9]{1,40}$/i.test(x))

export const serverAdminHandlers: Record<string, Handler> = {
  async serverAdminGetConfig(s: RpcSession, _params: unknown) {
    return config(s)
  },

  async serverAdminSetConfig(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { url, key, importKeyFile } = params as { url: string; key?: string; importKeyFile?: boolean }
    const base = normalizeBaseUrl(String(url ?? ''))
    const newKey = importKeyFile ? readKeyFile() : key ? String(key).replace(/\s+/g, '') : null
    if (newKey !== null && newKey.length < 16) throw new Error(t('sync.server.keyTooShort'))
    // önce dene ve sunucu türünü algıla: çalışmayan anahtar/adres kaydedilmesin
    if (newKey) {
      const provider = await detectProvider(base, newKey)
      const [blob] = await s.deps.encrypt([newKey])
      q.prefSet(KEY_PREFS[0], Buffer.from(blob).toString('base64'))
      q.prefSet(PROVIDER_PREF, provider.id)
      q.prefSet(KEY_PREFS[1], '')
    }
    q.prefSet(URL_PREFS[0], base)
    q.prefSet(URL_PREFS[1], '')
    return config(s)
  },

  async serverAdminClearKey(s: RpcSession, _params: unknown) {
    for (const k of KEY_PREFS) s.deps.q.prefSet(k, '')
    return config(s)
  },

  async serverAdminTest(s: RpcSession, _params: unknown) {
    const c = await client(s)
    const { username } = await c.session()
    return { username, principals: await c.principalCount(), provider: c.name }
  },

  async serverAdminBlocked(s: RpcSession, params: unknown) {
    const { address, position } = params as { address?: string; position?: number }
    return (await client(s)).blocked({ address: address ? String(address).slice(0, 64) : undefined, position: Math.max(0, Number(position) || 0) })
  },

  async serverAdminUnblock(s: RpcSession, params: unknown) {
    return { removed: await (await client(s)).unblock(ids(params)) }
  },

  async serverAdminAllowed(s: RpcSession, _params: unknown) {
    return (await client(s)).allowed()
  },

  async serverAdminAllow(s: RpcSession, params: unknown) {
    const { address, hours, reason } = params as { address: string; hours: number; reason: string }
    const a = String(address ?? '').trim()
    if (!validIpMask(a)) throw new Error(t('sync.server.invalidIp'))
    const h = Number(hours)
    // süresiz izin bilinçli seçim olmalı: 0 = süresiz, aksi halde 1 saat – 30 gün
    const expiresAt = h > 0 ? new Date(Date.now() + Math.min(h, 720) * 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z') : null
    await (await client(s)).allow(a, String(reason ?? '').trim().slice(0, 80) || 'geckomail', expiresAt)
    return { ok: true }
  },

  async serverAdminRemoveAllowed(s: RpcSession, params: unknown) {
    return { removed: await (await client(s)).removeAllowed(ids(params)) }
  },

  async serverAdminAccountDiff(s: RpcSession, _params: unknown) {
    const serverEmails = await (await client(s)).individualEmails()
    // yalnız sunucunun alan adlarındaki uygulama hesapları karşılaştırılır (başka sağlayıcılar değil)
    const domains = new Set(serverEmails.map((e) => e.split('@')[1]))
    const appEmails = s.deps.q.getAccountRows().map((a) => a.email).filter((e) => domains.has(e.toLowerCase().split('@')[1]))
    return { ...accountDiff(serverEmails, appEmails), serverTotal: serverEmails.length }
  }
}
