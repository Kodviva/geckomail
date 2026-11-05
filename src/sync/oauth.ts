// OAuth2 (Gmail / Microsoft 365) — masaüstü uygulama akışı: yetkilendirme kodu + PKCE, yönlendirme
// 127.0.0.1'de geçici bir porta döner (RFC 8252). Şifre uygulamaya hiç girmez; yenileme belirteci
// password_enc'te (Anahtar Zinciri) durur, erişim belirteci yalnız bellekte ve süresi dolmadan yenilenir.
import { createHash, randomBytes } from 'crypto'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import type { AccountRow } from './db/queries'
import { intlTag, t } from '../shared/i18n'

export type OAuthProviderId = 'google' | 'microsoft'
/** Belirtecin kaynağı: Microsoft belirteci tek kaynaklıdır, Google'da tek belirteç hepsini taşır */
export type OAuthAudience = 'mail' | 'graph'

export interface OAuthClient {
  clientId: string
  /** Google "Masaüstü uygulaması" istemcisi gizli anahtar ister (Google'ın kendi belgesine göre gizli sayılmaz) */
  clientSecret?: string
}

export interface OAuthProviderDef {
  id: OAuthProviderId
  label: string
  authUrl: string
  tokenUrl: string
  scopes: string[]
  /** Yalnız "Kişi ve takvimi bağla" akışında istenir: kiracı Graph iznini kapattıysa posta girişi bozulmamalı */
  pimScopes: string[]
  graphScopes?: string[]
  imap: { host: string; port: number }
  smtp: { host: string; port: number }
  extraAuthParams?: Record<string, string>
}

const MICROSOFT_GRAPH_SCOPES = ['https://graph.microsoft.com/Contacts.ReadWrite', 'https://graph.microsoft.com/Calendars.ReadWrite']

export const OAUTH_PROVIDERS: Record<OAuthProviderId, OAuthProviderDef> = {
  google: {
    id: 'google',
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://mail.google.com/', 'openid', 'email'],
    // carddav kapsamı Google belgelerinde yok, topluluk kaynaklarında var: reddedilirse posta belirteci değişmez
    pimScopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/carddav'],
    imap: { host: 'imap.gmail.com', port: 993 },
    smtp: { host: 'smtp.gmail.com', port: 465 },
    // yenileme belirteci her zaman gelsin (daha önce izin verilmiş olsa da)
    extraAuthParams: { access_type: 'offline', prompt: 'consent' }
  },
  microsoft: {
    id: 'microsoft',
    label: 'Microsoft',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['offline_access', 'openid', 'email', 'https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send'],
    pimScopes: MICROSOFT_GRAPH_SCOPES,
    graphScopes: MICROSOFT_GRAPH_SCOPES,
    imap: { host: 'outlook.office365.com', port: 993 },
    smtp: { host: 'smtp.office365.com', port: 587 },
    extraAuthParams: { prompt: 'select_account' }
  }
}

export function providerOfAuthType(authType: string | null | undefined): OAuthProviderId | null {
  return authType === 'oauth:google' ? 'google' : authType === 'oauth:microsoft' ? 'microsoft' : null
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

export function buildAuthUrl(p: OAuthProviderDef, client: OAuthClient, redirectUri: string, state: string, challenge: string, loginHint?: string, extraScopes?: string[]): string {
  const u = new URL(p.authUrl)
  const params: Record<string, string> = {
    client_id: client.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: [...p.scopes, ...(extraScopes ?? [])].join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(loginHint ? { login_hint: loginHint } : {}),
    ...p.extraAuthParams
  }
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString()
}

export interface TokenSet {
  accessToken: string
  expiresAt: number
  refreshToken?: string
  email?: string
  /** Sağlayıcının bildirdiği kapsamlar; yoksa (RFC 6749 §5.1) istenenin tamamı verilmiştir */
  scope?: string
}

/** id_token yükünden e-posta (imza doğrulanmaz: belirteç doğrudan sağlayıcının TLS uç noktasından geldi) */
export function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf-8')) as {
      email?: string
      preferred_username?: string
      upn?: string
    }
    const e = payload.email ?? payload.preferred_username ?? payload.upn
    return e && e.includes('@') ? e.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

export class OAuthGrantError extends Error {
  /** classifyError 'auth' sayar: hesap "yeniden yetkilendir" durumuna düşer */
  readonly authenticationFailed = true
  constructor(message: string) {
    super(message)
    this.name = 'OAuthGrantError'
  }
}

async function tokenRequest(p: OAuthProviderDef, client: OAuthClient, body: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenSet> {
  const form = new URLSearchParams({ client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}), ...body })
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 20_000)
  let res: Response
  try {
    res = await fetchImpl(p.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      signal: ctl.signal
    })
  } catch (e) {
    throw Object.assign(new Error(t('sync.oauth.tokenUnreachable', { provider: p.label })), { code: 'ETIMEDOUT', cause: e })
  } finally {
    clearTimeout(timer)
  }
  const j = (await res.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    refresh_token?: string
    id_token?: string
    scope?: string
    error?: string
    error_description?: string
  }
  if (!res.ok || !j.access_token) {
    // geri alınmış/süresi dolmuş izin: kullanıcı yeniden yetkilendirmeli (tekrar denemek anlamsız)
    if (j.error === 'invalid_grant' || j.error === 'unauthorized_client' || j.error === 'invalid_client')
      throw new OAuthGrantError(t('sync.oauth.grantInvalid', { provider: p.label, error: j.error }))
    throw new Error(
      t('sync.oauth.tokenError', { provider: p.label, error: j.error ?? String(res.status) }) +
        (j.error_description ? ` — ${j.error_description.slice(0, 160)}` : '')
    )
  }
  return {
    accessToken: j.access_token,
    expiresAt: Date.now() + Math.max(60, Number(j.expires_in) || 3600) * 1000,
    refreshToken: j.refresh_token,
    email: emailFromIdToken(j.id_token),
    ...(j.scope ? { scope: j.scope } : {})
  }
}

export function refreshAccessToken(p: OAuthProviderDef, client: OAuthClient, refreshToken: string, fetchImpl: typeof fetch = fetch, scope?: string): Promise<TokenSet> {
  return tokenRequest(p, client, { grant_type: 'refresh_token', refresh_token: refreshToken, ...(scope ? { scope } : {}) }, fetchImpl)
}

/** Yetkilendirme kodu → belirteçler (PKCE doğrulayıcısıyla); yenileme belirteci ve e-posta zorunlu.
 *  Masaüstü (geri döngü) ve web (sunucu üzerinden dönüş) akışı aynı değiş tokuşu kullanır. */
export async function exchangeCode(
  p: OAuthProviderDef, client: OAuthClient, code: string, redirectUri: string, verifier: string, fetchImpl: typeof fetch = fetch
): Promise<TokenSet & { email: string }> {
  const tok = await tokenRequest(p, client, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }, fetchImpl)
  if (!tok.refreshToken) throw new Error(t('sync.oauth.noRefreshToken', { provider: p.label }))
  if (!tok.email) throw new Error(t('sync.oauth.noEmail', { provider: p.label }))
  return tok as TokenSet & { email: string }
}

/** Hesap ve kaynak başına erişim belirteci önbelleği; süresine 2 dk kala yeniler, eşzamanlı istekler tek yenilemeyi paylaşır. */
export class TokenCache {
  private cache = new Map<string, TokenSet>()
  private inflight = new Map<string, Promise<TokenSet>>()

  constructor(
    private clientFor: (p: OAuthProviderId) => OAuthClient | null,
    private onRotate?: (accountId: number, refreshToken: string) => void,
    private fetchImpl: typeof fetch = fetch,
    private now: () => number = Date.now,
    /** Hesabın yenileme belirteci Graph kaynağı taşıyabilir mi (kaynak sonradan kaldırılsa da): IMAP Graph belirteci alamasın diye mail kapsamı açıkça istenir */
    private pimBound: (accountId: number) => boolean = () => false
  ) {}

  /** Yalnız Microsoft kaynak ayırır. Bağlı olmayan hesabın posta yenilemesi eskisi gibi scope'suz kalır. */
  private refreshScope(accountId: number, provider: OAuthProviderId, audience: OAuthAudience): string | undefined {
    if (provider !== 'microsoft') return undefined
    const p = OAUTH_PROVIDERS.microsoft
    if (audience === 'graph') return [...p.graphScopes!, 'offline_access'].join(' ')
    return this.pimBound(accountId) ? p.scopes.join(' ') : undefined
  }

  async get(accountId: number, provider: OAuthProviderId, refreshToken: string, forceRefresh = false, audience: OAuthAudience = 'mail'): Promise<string> {
    const key = `${accountId}:${provider === 'google' ? 'mail' : audience}`
    const hit = this.cache.get(key)
    if (!forceRefresh && hit && hit.expiresAt - this.now() > 120_000) return hit.accessToken
    const running = this.inflight.get(key)
    if (running) return (await running).accessToken
    const client = this.clientFor(provider)
    if (!client) throw new OAuthGrantError(t('sync.oauth.noClient', { provider: OAUTH_PROVIDERS[provider].label }))
    const p = refreshAccessToken(OAUTH_PROVIDERS[provider], client, refreshToken, this.fetchImpl, this.refreshScope(accountId, provider, audience))
      .then((tok) => {
        // bitiş zamanı önbelleğin saatine göre (testte enjekte edilen saat)
        this.cache.set(key, { ...tok, expiresAt: this.now() + (tok.expiresAt - Date.now()) })
        // Microsoft yenileme belirtecini döndürür (rotation): yenisi saklanmazsa eski bir süre sonra geçersizleşir
        if (tok.refreshToken && tok.refreshToken !== refreshToken) this.onRotate?.(accountId, tok.refreshToken)
        return tok
      })
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return (await p).accessToken
  }

  drop(accountId: number): void {
    this.cache.delete(`${accountId}:mail`)
    this.cache.delete(`${accountId}:graph`)
  }
}

/** SASL XOAUTH2 başlangıç yanıtı */
export function xoauth2(user: string, accessToken: string): string {
  return Buffer.from(`user=${user}\x01auth=Bearer ${accessToken}\x01\x01`).toString('base64')
}

/** SASL OAUTHBEARER başlangıç yanıtı (RFC 7628); GS2 adında virgül ve eşittir kaçırılır */
export function oauthBearer(user: string, host: string, port: number, accessToken: string): string {
  const gs2 = user.replace(/=/g, '=3D').replace(/,/g, '=2C')
  return Buffer.from(`n,a=${gs2},\x01host=${host}\x01port=${port}\x01auth=Bearer ${accessToken}\x01\x01`).toString('base64')
}

// ---- etkileşimli yetkilendirme (loopback) ----

interface Flow {
  server: Server
  result: Promise<TokenSet & { email: string }>
  cancel: () => void
}

const flows = new Map<string, Flow>()
const FLOW_TIMEOUT_MS = 5 * 60_000

// tarayıcıda görünen sonuç sayfası: istek geldiği andaki arayüz dilinde
const PAGE = (title: string, body: string) =>
  `<!doctype html><html lang="${intlTag()}"><meta charset="utf-8"><title>GeckoMail</title><body style="font:15px -apple-system,system-ui,sans-serif;background:#141814;color:#e8ece4;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:420px"><h2 style="margin:0 0 8px">${title}</h2><p style="color:#9aa394">${body}</p></div>`

/** Akışı başlatır: yerel yönlendirme sunucusu açılır, tarayıcıda açılacak adres döner. */
export async function startFlow(provider: OAuthProviderId, client: OAuthClient, loginHint?: string, fetchImpl: typeof fetch = fetch, extraScopes?: string[]): Promise<{ flowId: string; url: string }> {
  const p = OAUTH_PROVIDERS[provider]
  const { verifier, challenge } = pkcePair()
  const state = b64url(randomBytes(24))
  const flowId = b64url(randomBytes(12))
  let resolveCode!: (code: string) => void
  let rejectCode!: (e: Error) => void
  const codeP = new Promise<string>((res, rej) => {
    resolveCode = res
    rejectCode = rej
  })
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    if (u.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    // yalnız bu akışın state'i: başka bir sayfa bu porta kod gönderip hesabı ele geçiremesin
    if (u.searchParams.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE(t('sync.oauth.page.invalidTitle'), t('sync.oauth.page.invalidBody')))
      return
    }
    const err = u.searchParams.get('error')
    const code = u.searchParams.get('code')
    if (err || !code) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE(t('sync.oauth.page.deniedTitle'), t('sync.oauth.page.deniedBody')))
      rejectCode(new Error(err === 'access_denied' ? t('sync.oauth.denied') : t('sync.oauth.authError', { error: err ?? t('sync.oauth.noCode') })))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE(t('sync.oauth.page.okTitle'), t('sync.oauth.page.okBody')))
    resolveCode(code)
  })
  await new Promise<void>((res, rej) => server.listen(0, '127.0.0.1', () => res()).on('error', rej))
  const port = (server.address() as AddressInfo).port
  // Microsoft portalı "http://localhost" kaydeder (port eşleşmede yok sayılır); tarayıcı localhost'u ::1'e
  // de çözebildiği için aynı port IPv6 geri döngüde de dinlenir. Yalnız geri döngü — ağa açılmaz.
  const server6 = createServer(server.listeners('request')[0] as Parameters<typeof createServer>[1])
  server6.on('error', () => {})
  server6.listen(port, '::1')
  const redirectUri = provider === 'microsoft' ? `http://localhost:${port}/callback` : `http://127.0.0.1:${port}/callback`
  const timer = setTimeout(() => rejectCode(new Error(t('sync.oauth.flowTimeout'))), FLOW_TIMEOUT_MS)
  const result = codeP
    .then((code) => exchangeCode(p, client, code, redirectUri, verifier, fetchImpl))
    .finally(() => {
      clearTimeout(timer)
      server.close()
      server6.close()
      setTimeout(() => flows.delete(flowId), 60_000)
    })
  result.catch(() => {}) // bekleyen yoksa işlenmemiş ret olmasın
  flows.set(flowId, { server, result, cancel: () => rejectCode(new Error(t('sync.oauth.cancelled'))) })
  return { flowId, url: buildAuthUrl(p, client, redirectUri, state, challenge, loginHint, extraScopes) }
}

export function waitFlow(flowId: string): Promise<TokenSet & { email: string }> {
  const f = flows.get(flowId)
  if (!f) return Promise.reject(new Error(t('sync.oauth.flowNotFound')))
  return f.result
}

export function cancelFlow(flowId: string): void {
  flows.get(flowId)?.cancel() // bekleyen oauthFinish hemen sonlanır; sunucu finally'de kapanır
}

/** Hesap OAuth mı? (IMAP/SMTP bağlantısı buna göre kimlik seçer) */
export function isOAuthAccount(row: Pick<AccountRow, 'auth_type'>): boolean {
  return providerOfAuthType(row.auth_type) !== null
}

// ---- süreç geneli: kimlik seçimi ----

let tokens: TokenCache | null = null

export function initOAuth(cache: TokenCache): void {
  tokens = cache
}

export function dropAccessToken(accountId: number): void {
  tokens?.drop(accountId)
}

export type Credential = { kind: 'password'; password: string } | { kind: 'oauth'; accessToken: string }

/** Hesabın sakladığı sır (şifre ya da yenileme belirteci) → bağlantıda kullanılacak kimlik */
export async function credentialFor(row: Pick<AccountRow, 'id' | 'auth_type'>, secret: string, forceRefresh = false): Promise<Credential> {
  const provider = providerOfAuthType(row.auth_type)
  if (!provider) return { kind: 'password', password: secret }
  if (!tokens) throw new Error(t('sync.oauth.notInitialized'))
  return { kind: 'oauth', accessToken: await tokens.get(row.id, provider, secret, forceRefresh) }
}

/** Kişi ve takvim isteklerinin erişim belirteci; yalnız OAuth hesabı */
export function accessTokenFor(row: Pick<AccountRow, 'id' | 'auth_type'>, secret: string, audience: OAuthAudience, forceRefresh = false): Promise<string> {
  const provider = providerOfAuthType(row.auth_type)
  if (!provider) return Promise.reject(new Error(t('sync.oauth.invalidProvider')))
  if (!tokens) return Promise.reject(new Error(t('sync.oauth.notInitialized')))
  return tokens.get(row.id, provider, secret, forceRefresh, audience)
}

/** İstemci kimlikleri: Ayarlar'dan girilen, yoksa ortam değişkeni (paketli sürümde derlemede verilir) */
export function oauthClientsFrom(get: (k: string) => string | null): (p: OAuthProviderId) => OAuthClient | null {
  return (p) => {
    if (p === 'google') {
      const clientId = get('oauth_google_client_id') || process.env.GECKO_GOOGLE_CLIENT_ID || ''
      const clientSecret = get('oauth_google_client_secret') || process.env.GECKO_GOOGLE_CLIENT_SECRET || ''
      return clientId ? { clientId, clientSecret: clientSecret || undefined } : null
    }
    const clientId = get('oauth_microsoft_client_id') || process.env.GECKO_MICROSOFT_CLIENT_ID || ''
    return clientId ? { clientId } : null
  }
}
