// Stalwart yönetim istemcisi (R17/R32). 0.16'da REST /api kaldırıldı; yönetim JMAP üzerinden
// (urn:stalwart:jmap, nesneler x: önekiyle). Kimlik: yönetim API anahtarı (Bearer) — posta
// protokollerine girmez. Adres yöneticinin girdiği sunucu (iç ağ olabilir), bu yüzden safeFetch değil.
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ServerAllowedIp, ServerBlockedIp } from '../shared/rpc'
import type { ServerProvider } from './serverProvider'
import { t } from '../shared/i18n'

const TIMEOUT_MS = 15_000
const MAX_GET = 500 // sunucunun maxObjectsInGet sınırı
const USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap', 'urn:ietf:params:jmap:principals']

/** Anahtar dosyası (terminalden kaydedilebilir; içeriği asla loglanmaz/döndürülmez). Eski ad da okunur. */
export const KEY_FILES = [join(homedir(), '.config', 'geckomail', 'server-admin.key'), join(homedir(), '.config', 'geckomail', 'stalwart-admin.key')]

export function existingKeyFile(): string | null {
  return KEY_FILES.find((f) => existsSync(f)) ?? null
}

export function readKeyFile(path = existingKeyFile()): string {
  if (!path) throw new Error(t('sync.server.keyFileMissing', { path: '~/.config/geckomail/server-admin.key' }))
  const key = readFileSync(path, 'utf-8').replace(/\s+/g, '')
  if (key.length < 16) throw new Error(t('sync.server.keyFileInvalid'))
  return key
}

export function normalizeBaseUrl(raw: string): string {
  const u = new URL(raw.trim())
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(t('sync.server.urlScheme'))
  if (u.username || u.password) throw new Error(t('sync.server.urlCredentials'))
  return `${u.protocol}//${u.host}`
}

type Invocation = [string, Record<string, unknown>, string]

export class StalwartAdmin implements ServerProvider {
  readonly id = 'stalwart' as const
  readonly name = 'Stalwart'
  private accountId: string | null = null

  constructor(
    private baseUrl: string,
    private key: string,
    private fetchImpl: typeof fetch = fetch
  ) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json', accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
        redirect: 'error'
      })
      if (res.status === 401 || res.status === 403) throw new Error(t('sync.server.keyRejected'))
      if (!res.ok) throw new Error(t('sync.err.httpStatus', { status: String(res.status) }))
      return await res.json()
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new Error(t('sync.server.noResponse'))
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  async session(): Promise<{ username: string; accountId: string }> {
    const s = (await this.post('/jmap/session', undefined)) as {
      username?: string
      primaryAccounts?: Record<string, string>
    }
    const accountId = s.primaryAccounts?.['urn:stalwart:jmap'] ?? s.primaryAccounts?.['urn:ietf:params:jmap:principals']
    if (!accountId || !s.username) throw new Error(t('sync.server.keyNoAdmin'))
    this.accountId = accountId
    return { username: s.username, accountId }
  }

  private async call(calls: Invocation[]): Promise<Record<string, unknown>[]> {
    if (!this.accountId) await this.session()
    const methodCalls = calls.map(([m, args, tag]) => [m, { accountId: this.accountId, ...args }, tag])
    const r = (await this.post('/jmap/', { using: USING, methodCalls })) as { methodResponses?: [string, Record<string, unknown>, string][] }
    const out: Record<string, unknown>[] = []
    for (const [name, obj] of r.methodResponses ?? []) {
      if (name === 'error') throw new Error(t('sync.server.error', { detail: `${String(obj.type ?? '')} ${String(obj.description ?? '')}`.trim() }))
      out.push(obj)
    }
    return out
  }

  async principalCount(): Promise<number> {
    const [q] = await this.call([['Principal/query', { filter: { type: 'individual' }, limit: 1, calculateTotal: true }, 'q']])
    return Number(q.total ?? 0)
  }

  /** Sunucudaki bireysel hesapların e-postaları (küçük harf) */
  async individualEmails(): Promise<string[]> {
    const emails: string[] = []
    for (let position = 0; position < 10_000; position += MAX_GET) {
      const [q, g] = await this.call([
        ['Principal/query', { filter: { type: 'individual' }, position, limit: MAX_GET }, 'q'],
        ['Principal/get', { '#ids': { resultOf: 'q', name: 'Principal/query', path: '/ids' }, properties: ['email'] }, 'g']
      ])
      const list = (g.list as { email?: string | null }[]) ?? []
      for (const p of list) if (p.email) emails.push(p.email.toLowerCase())
      if ((q.ids as unknown[]).length < MAX_GET) break
    }
    return emails
  }

  async blocked(opts: { address?: string; position?: number; limit?: number }): Promise<{ total: number; items: ServerBlockedIp[] }> {
    const limit = Math.min(opts.limit ?? 200, MAX_GET)
    const filter = opts.address?.trim() ? { address: opts.address.trim() } : undefined
    const [q, g] = await this.call([
      ['x:BlockedIp/query', { ...(filter ? { filter } : {}), position: opts.position ?? 0, limit, calculateTotal: true }, 'q'],
      ['x:BlockedIp/get', { '#ids': { resultOf: 'q', name: 'x:BlockedIp/query', path: '/ids' } }, 'g']
    ])
    return { total: Number(q.total ?? 0), items: ((g.list as ServerBlockedIp[]) ?? []).map(pickIp) }
  }

  async allowed(): Promise<ServerAllowedIp[]> {
    const [, g] = await this.call([
      ['x:AllowedIp/query', { limit: MAX_GET }, 'q'],
      ['x:AllowedIp/get', { '#ids': { resultOf: 'q', name: 'x:AllowedIp/query', path: '/ids' } }, 'g']
    ])
    return ((g.list as ServerAllowedIp[]) ?? []).map(pickIp)
  }

  async unblock(ids: string[]): Promise<number> {
    return this.destroy('x:BlockedIp/set', ids)
  }

  async removeAllowed(ids: string[]): Promise<number> {
    return this.destroy('x:AllowedIp/set', ids)
  }

  async allow(address: string, reason: string, expiresAt: string | null): Promise<void> {
    const [r] = await this.call([
      ['x:AllowedIp/set', { create: { n1: { address, reason, ...(expiresAt ? { expiresAt } : {}) } } }, 's']
    ])
    const notCreated = r.notCreated as Record<string, { description?: string; type?: string }> | undefined
    if (notCreated?.n1) throw new Error(t('sync.server.addFailed', { detail: notCreated.n1.description ?? notCreated.n1.type ?? t('sync.server.unknownError') }))
  }

  private async destroy(method: string, ids: string[]): Promise<number> {
    if (!ids.length) return 0
    const [r] = await this.call([[method, { destroy: ids.slice(0, MAX_GET) }, 's']])
    const failed = r.notDestroyed as Record<string, { description?: string }> | undefined
    if (failed && Object.keys(failed).length) {
      const first = Object.values(failed)[0]
      throw new Error(t('sync.server.deleteFailed', { count: Object.keys(failed).length, detail: first?.description ?? '' }).trim())
    }
    return ((r.destroyed as string[]) ?? []).length
  }
}

function pickIp<T extends { id: string; address: string; reason?: string | null; createdAt?: string | null; expiresAt?: string | null }>(x: T) {
  return { id: x.id, address: x.address, reason: x.reason ?? null, createdAt: x.createdAt ?? null, expiresAt: x.expiresAt ?? null }
}

/** Sunucu ↔ uygulama hesap uyumu */
export function accountDiff(serverEmails: string[], appEmails: string[]): { onServerNotInApp: string[]; inAppNotOnServer: string[] } {
  const server = new Set(serverEmails.map((e) => e.toLowerCase()))
  const app = new Set(appEmails.map((e) => e.toLowerCase()))
  return {
    onServerNotInApp: [...server].filter((e) => !app.has(e)).sort(),
    inAppNotOnServer: [...app].filter((e) => !server.has(e)).sort()
  }
}
