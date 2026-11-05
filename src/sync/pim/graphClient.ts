// Microsoft Graph istemcisi. İstekler yalnız sabit kökene gider: sunucunun verdiği nextLink/deltaLink başka kökene çıkamaz, belirteç
// sızmaz. Yönlendirme izlenmez. 401'de belirteç bir kez yenilenir; 401/403 kaynağı durdurur, posta bağlantısına dokunulmaz.
import { t } from '../../shared/i18n'
import { safeFetch, type NetPolicy, type SafeResponse } from '../net/safeFetch'

const ORIGIN = 'https://graph.microsoft.com'
const TIMEOUT_MS = 30_000
const MAX_BYTES = 20_000_000
const DEFAULT_RETRY_MS = 60_000
const MAX_RETRY_MS = 6 * 3_600_000

export class GraphAuthError extends Error {
  readonly authenticationFailed = true
  constructor(readonly status: 401 | 403) {
    super(t('pim.err.graphConsent'))
  }
}

export class GraphHttpError extends Error {
  constructor(readonly status: number) {
    super(t('pim.err.graphHttp', { status }))
  }
}

/** Hizmet yavaşlatıyor: kaynak `retryAfterMs` kadar ertelenir, hata sayılmaz */
export class GraphRateLimit extends Error {
  constructor(readonly retryAfterMs: number) {
    super(t('pim.err.graphThrottled'))
  }
}

function retryDelay(res: SafeResponse): number {
  const raw = res.headers['retry-after']
  const s = Number(Array.isArray(raw) ? raw[0] : raw)
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, MAX_RETRY_MS) : DEFAULT_RETRY_MS
}

export class GraphClient {
  private readonly origin: string

  constructor(private readonly o: { token(force?: boolean): Promise<string>; net?: NetPolicy; baseUrl?: string }) {
    this.origin = o.baseUrl ?? ORIGIN
  }

  private urlOf(pathOrLink: string): string {
    const u = new URL(pathOrLink, this.origin)
    if (u.origin !== this.origin) throw new Error(t('pim.err.graphForeignLink'))
    return u.toString()
  }

  private async request(method: string, pathOrLink: string, headers: Record<string, string>, body?: string): Promise<SafeResponse> {
    const url = this.urlOf(pathOrLink)
    const once = async (force: boolean): Promise<SafeResponse> =>
      safeFetch(url, { method, headers: { ...headers, authorization: `Bearer ${await this.o.token(force)}` }, body, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, redirect: 'manual', net: this.o.net })
    let res = await once(false)
    if (res.status === 401) res = await once(true)
    if (res.status === 401 || res.status === 403) throw new GraphAuthError(res.status)
    if (res.status === 429 || (res.status === 503 && res.headers['retry-after'])) throw new GraphRateLimit(retryDelay(res))
    return res
  }

  async get<T>(pathOrLink: string, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.request('GET', pathOrLink, { accept: 'application/json', ...headers })
    if (!res.ok) throw new GraphHttpError(res.status)
    return JSON.parse(res.body.toString('utf-8')) as T
  }

  /** 412: başkası değiştirmiş */
  async send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, etag?: string | null): Promise<T | 'conflict'> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (etag) headers['if-match'] = etag
    const res = await this.request(method, path, headers, body === undefined ? undefined : JSON.stringify(body))
    if (res.status === 412) return 'conflict'
    if (!res.ok) throw new GraphHttpError(res.status)
    return (res.body.length ? JSON.parse(res.body.toString('utf-8')) : undefined) as T
  }
}
