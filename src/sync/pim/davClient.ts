// CalDAV/CardDAV istemcisi: safeFetch üstünde ince katman. Yanlış parola sunucuda IP engeli yaratır, bu yüzden
// Basic 401'de asla yeniden denemez; OAuth belirteci 401'de bir kez yenilenir.
import { t } from '../../shared/i18n'
import { PUBLIC_DAV_PORTS, safeFetch, type NetPolicy, type SafeResponse } from '../net/safeFetch'
import { errorConditions, multigetBody, parseMultistatus, propfindBody, syncCollectionBody, type DavProp, type DavResource } from './davXml'

export type { DavProp, DavResource } from './davXml'

const MAX_RESPONSE_BYTES = 20_000_000
const XML_TYPE = 'application/xml; charset=utf-8'

export interface DavAuth {
  /** Basic ya da Bearer başlığı; force: 401 sonrası belirteci yeniler */
  header(force?: boolean): Promise<string | null>
}

export interface DavObject {
  href: string
  etag: string | null
  data: string
}

export class DavAuthError extends Error {
  constructor(readonly status: 401 | 403) {
    super(t('pim.err.davAuth'))
    this.name = 'DavAuthError'
  }
}

export class DavHttpError extends Error {
  constructor(readonly status: number) {
    super(t('sync.err.httpStatus', { status: String(status) }))
    this.name = 'DavHttpError'
  }
}

/** Abonelik URL'si dışarıdan gelir: masaüstünde de sunucuda da istisna almaz. Masaüstünde DAV adresini kullanıcı yazar;
 *  sunucuda iç ağa yalnız yöneticinin listelediği DAV sunucuları (çıplak ad 80, 443, 8443; `ad:port` yalnız o port) */
export function pimNetPolicy(mode: 'desktop' | 'server', config: { davPrivateHosts?: string[] } | null, o: { ics: boolean }): NetPolicy {
  if (o.ics) return {}
  if (mode === 'desktop') return { allowPrivateHosts: 'all', allowedPorts: 'any' }
  return { allowPrivateHosts: new Set(config?.davPrivateHosts ?? []), allowedPorts: PUBLIC_DAV_PORTS }
}

const headerList = (v: string | string[] | undefined): string[] =>
  (Array.isArray(v) ? v.join(',') : v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

const firstHeader = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? v[0] : v) ?? null

interface DavRequest {
  method: string
  headers?: Record<string, string>
  body?: string
}

export class DavClient {
  private readonly auth: DavAuth
  private readonly net: NetPolicy
  private readonly timeoutMs: number

  constructor(o: { auth: DavAuth; net: NetPolicy; timeoutMs?: number }) {
    this.auth = o.auth
    this.net = o.net
    this.timeoutMs = o.timeoutMs ?? 30_000
  }

  async propfind(url: string, depth: 0 | 1, props: DavProp[]): Promise<DavResource[]> {
    const res = await this.xml(url, 'PROPFIND', propfindBody(props), { depth: String(depth) })
    if (res.status !== 207) throw new DavHttpError(res.status)
    return parseMultistatus(res.body.toString()).responses
  }

  async options(url: string): Promise<{ dav: string[]; allow: string[] }> {
    const res = await this.send(url, { method: 'OPTIONS' })
    if (!res.ok) throw new DavHttpError(res.status)
    return { dav: headerList(res.headers.dav), allow: headerList(res.headers.allow) }
  }

  async multiget(collectionUrl: string, type: 'calendar' | 'addressbook', hrefs: string[]): Promise<DavObject[]> {
    if (!hrefs.length) return []
    const res = await this.xml(collectionUrl, 'REPORT', multigetBody(type, hrefs), { depth: '1' })
    if (res.status !== 207) throw new DavHttpError(res.status)
    return parseMultistatus(res.body.toString()).responses.flatMap((r) => (r.data ? [{ href: r.href, etag: r.etag, data: r.data }] : []))
  }

  async syncCollection(url: string, token: string | null): Promise<{ changed: { href: string; etag: string | null }[]; removed: string[]; token: string; truncated: boolean } | 'token-invalid' | 'unsupported'> {
    const res = await this.xml(url, 'REPORT', syncCollectionBody(token), { depth: '0' }, true)
    if (res.status === 403 || res.status === 409) {
      const conditions = errorConditions(res.body.toString())
      if (conditions.includes('valid-sync-token')) return 'token-invalid'
      if (conditions.includes('supported-report') || conditions.includes('valid-sync-level')) return 'unsupported'
      if (res.status === 403) throw new DavAuthError(403)
      throw new DavHttpError(res.status)
    }
    if (res.status === 400 || res.status === 405 || res.status === 501) return 'unsupported'
    if (res.status !== 207 && res.status !== 507) throw new DavHttpError(res.status)
    const { responses, syncToken } = parseMultistatus(res.body.toString())
    if (!syncToken) return 'unsupported'
    const collectionPath = new URL(url).pathname.replace(/\/$/, '')
    let truncated = res.status === 507
    const changed: { href: string; etag: string | null }[] = []
    const removed: string[] = []
    for (const r of responses) {
      if (r.status === 507) truncated = true
      else if (r.status === 404 || r.status === 410) removed.push(r.href)
      else if (r.status == null && !r.etag && r.failedStatuses.includes(404)) removed.push(r.href)
      else if (r.href.replace(/\/$/, '') !== collectionPath) changed.push({ href: r.href, etag: r.etag })
    }
    return { changed, removed, token: syncToken, truncated }
  }

  async get(url: string): Promise<DavObject | null> {
    const res = await this.send(url, { method: 'GET' })
    if (res.status === 404 || res.status === 410) return null
    if (!res.ok) throw new DavHttpError(res.status)
    return { href: url, etag: firstHeader(res.headers.etag), data: res.body.toString() }
  }

  async put(url: string, body: string, contentType: string, cond: { ifMatch?: string; ifNoneMatch?: '*' }): Promise<{ etag: string | null } | 'conflict'> {
    const headers: Record<string, string> = { 'content-type': contentType }
    if (cond.ifMatch) headers['if-match'] = cond.ifMatch
    if (cond.ifNoneMatch) headers['if-none-match'] = cond.ifNoneMatch
    const res = await this.send(url, { method: 'PUT', headers, body })
    if (res.status === 412) return 'conflict'
    if (!res.ok) throw new DavHttpError(res.status)
    return { etag: firstHeader(res.headers.etag) }
  }

  async delete(url: string, ifMatch?: string): Promise<'ok' | 'gone' | 'conflict'> {
    const res = await this.send(url, { method: 'DELETE', headers: ifMatch ? { 'if-match': ifMatch } : {} })
    if (res.status === 404 || res.status === 410) return 'gone'
    if (res.status === 412) return 'conflict'
    if (!res.ok) throw new DavHttpError(res.status)
    return 'ok'
  }

  private xml(url: string, method: string, body: string, headers: Record<string, string>, raw403 = false): Promise<SafeResponse> {
    return this.send(url, { method, body, headers: { 'content-type': XML_TYPE, ...headers } }, raw403)
  }

  /** raw403: sync hata gövdesini çağıran okur */
  private async send(url: string, req: DavRequest, raw403 = false): Promise<SafeResponse> {
    const header = await this.auth.header()
    let res = await this.fetch(url, req, header)
    if (res.status === 401) {
      if (!header || !/^bearer\s/i.test(header)) throw new DavAuthError(401)
      res = await this.fetch(url, req, await this.auth.header(true))
      if (res.status === 401) throw new DavAuthError(401)
    }
    if (res.status === 403 && !raw403) throw new DavAuthError(403)
    return res
  }

  private fetch(url: string, req: DavRequest, header: string | null): Promise<SafeResponse> {
    return safeFetch(url, {
      method: req.method, body: req.body, net: this.net, timeoutMs: this.timeoutMs, maxBytes: MAX_RESPONSE_BYTES,
      headers: { ...req.headers, ...(header ? { authorization: header } : {}) }
    })
  }
}
