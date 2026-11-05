import type Database from 'better-sqlite3'
import { createHash, randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { t } from '../../shared/i18n'
import { hashPassword } from '../../sync/auth/password'
import { openDb } from '../../sync/db'
import { makeQueries } from '../../sync/db/queries'
import type { OpQueue } from '../../sync/opQueue'
import { RpcHub, type RpcServerDeps } from '../../sync/rpcHub'
import type { Scheduler } from '../../sync/scheduler'
import { WebAuth } from '../auth'
import type { ServerConfig } from '../config'
import { createServerHost } from '../hosts/serverHost'
import { createHttpServer } from '../http'
import { createWebOAuth } from '../oauthWeb'
import { WEB_CSP } from '../securityHeaders'

const ORIGIN = 'https://posta.example.com'
const PW = 'dogru-parola-1'
const idToken = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

interface Res {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

describe('web OAuth akışı (sunucu üzerinden, PKCE)', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let auth: WebAuth
  let host: ReturnType<typeof createServerHost>
  let server: http.Server
  let port: number
  let clock: number
  // sahte sağlayıcı: token uç noktası yerel HTTP sunucusu
  let provider: http.Server
  let providerUrl: string
  let tokenBodies: URLSearchParams[]
  let tokenReply: (b: URLSearchParams) => Record<string, unknown>
  const sockets: WebSocket[] = []

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-oauthweb-'))
    db = openDb(dir)
    q = makeQueries(db)
    clock = Date.now()
    tokenBodies = []
    tokenReply = () => ({ access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-1', id_token: idToken({ email: 'Kisi@Gmail.com' }) })
    provider = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const b = new URLSearchParams(Buffer.concat(chunks).toString('utf-8'))
        tokenBodies.push(b)
        const j = tokenReply(b)
        res.writeHead('error' in j ? 400 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(j))
      })
    })
    await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r))
    providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`

    host = createServerHost(randomBytes(32), () => hub)
    const stub = new Proxy({}, { get: () => () => undefined })
    const deps: RpcServerDeps = {
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'attachments'),
      encrypt: (v) => host.encrypt(v),
      decrypt: async (b) => (await host.decrypt(b)).map((u) => Buffer.from(u).toString('utf-8')),
      userData: dir, dbSchemaVersion: () => 0
    }
    hub = new RpcHub(deps, 'server')
    auth = new WebAuth(q, host)
    q.insertUser({ username: 'yon', passwordHash: hashPassword(PW), role: 'admin' })
    q.prefSet('oauth_google_client_id', 'cid.apps.googleusercontent.com')
    q.prefSet('oauth_google_client_secret', 'gizli-anahtar')

    const cfg: ServerConfig = {
      dataDir: dir, listenHost: '127.0.0.1', listenPort: 0, keyFile: join(dir, 'master.key'), publicOrigin: ORIGIN, trustedProxyDepth: 0,
      webDir: join(dir, 'web')
    }
    server = createHttpServer({
      cfg, hub, auth, now: () => clock,
      oauthProviders: { google: { authUrl: `${providerUrl}/auth`, tokenUrl: `${providerUrl}/token` } }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    if (server?.listening) await new Promise<void>((r) => server.close(() => r()))
    await new Promise<void>((r) => provider.close(() => r()))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const req = (method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method, path, headers: body ? { ...headers, 'content-length': String(Buffer.byteLength(body)) } : headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }))
      })
      r.on('error', reject)
      if (body) r.write(body)
      r.end()
    })
  const loginCookie = async (): Promise<string> => {
    const r = await req('POST', '/api/login', { origin: ORIGIN, 'content-type': 'application/json' }, JSON.stringify({ username: 'yon', password: PW }))
    expect(r.status).toBe(200)
    return (r.headers['set-cookie']?.[0] ?? '').split(';')[0]
  }

  interface Conn {
    ws: WebSocket
    events: { event: string; data: Record<string, unknown> }[]
    call(method: string, params: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }>
  }
  let seq = 0
  const connect = (cookie: string): Promise<Conn> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { headers: { origin: ORIGIN, cookie } })
      sockets.push(ws)
      const events: Conn['events'] = []
      const waiting = new Map<number, (m: { ok: boolean; result?: unknown; error?: string }) => void>()
      ws.on('message', (data) => {
        const m = JSON.parse(data.toString())
        if (m.event) events.push(m)
        else waiting.get(m.id)?.(m)
      })
      ws.on('open', () =>
        resolve({
          ws, events,
          call: (method, params) =>
            new Promise((res) => {
              const id = ++seq
              waiting.set(id, res)
              ws.send(JSON.stringify({ id, method, params }))
            })
        })
      )
      ws.on('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    })
  const startFlow = async (c: Conn, params: Record<string, unknown> = {}) => {
    const r = await c.call('oauthStart', { provider: 'google', ...params })
    expect(r.ok, r.error).toBe(true)
    const { flowId, url } = r.result as { flowId: string; url: string }
    const u = new URL(url)
    return { flowId, url: u, state: u.searchParams.get('state')!, challenge: u.searchParams.get('code_challenge')! }
  }
  /** Sağlayıcıdan dönüş: siteler arası, oturum çerezi yok */
  const callback = (query: string) => req('GET', `/oauth/callback?${query}`)
  const nonceOf = (r: Res): string => (r.headers['set-cookie']?.[0] ?? '').split(';')[0]
  /** Uygulama sayfasından tamamlama (aynı köken, JSON) */
  const complete = (state: string, cookie: string, headers: Record<string, string> = {}) =>
    req('POST', '/oauth/complete', { origin: ORIGIN, 'content-type': 'application/json', cookie, ...headers }, JSON.stringify({ state }))
  const reason = (r: Res): string | undefined => (r.body ? (JSON.parse(r.body) as { reason?: string }).reason : undefined)
  const clearsNonce = (r: Res): boolean => /^gm_oauth=; .*; Secure; .*Max-Age=0/.test(r.headers['set-cookie']?.[0] ?? '')
  const events = (c: Conn, name: string) => c.events.filter((e) => e.event === name).map((e) => e.data)
  const done = (c: Conn) => events(c, 'oauth:done')
  const until = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
  }
  /** Dönüş + tamamlama: sahibinin çereziyle ve dönüşün işaretiyle */
  const returnAndComplete = async (state: string, query: string, cookie: string): Promise<Res> => {
    const r = await callback(`${query}&state=${state}`)
    expect(r.status).toBe(200)
    return complete(state, `${cookie}; ${nonceOf(r)}`)
  }

  it('oauthStart returns provider URL with server redirect, PKCE and 32-byte state', async () => {
    const a = await connect(await loginCookie())
    const f = await startFlow(a, { email: 'kisi@gmail.com' })
    expect(f.url.origin + f.url.pathname).toBe(`${providerUrl}/auth`)
    expect(Object.fromEntries(f.url.searchParams)).toMatchObject({
      client_id: 'cid.apps.googleusercontent.com', response_type: 'code', redirect_uri: `${ORIGIN}/oauth/callback`,
      code_challenge_method: 'S256', login_hint: 'kisi@gmail.com'
    })
    expect(Buffer.from(f.state, 'base64url')).toHaveLength(32)
    expect(f.flowId).not.toBe(f.state)
  })

  it('callback exchanges code and emits oauth:done', async () => {
    const cookieA = await loginCookie()
    const a = await connect(cookieA)
    const b = await connect(await loginCookie()) // aynı kullanıcının başka oturumu
    const f = await startFlow(a)
    const finish = a.call('oauthFinish', { flowId: f.flowId, provider: 'google' })
    // sağlayıcı dönüşü: küçük sayfa, script yok, kod sayfada yok; kod işaret çereziyle saklanır
    const r = await callback(`code=kod-1&state=${f.state}`)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toMatch(/^text\/html/)
    expect(r.headers['content-security-policy']).toBe(WEB_CSP)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.headers['referrer-policy']).toBe('no-referrer')
    expect(r.body).not.toMatch(/<script|http-equiv/i)
    expect(r.body).not.toContain('kod-1')
    const sc = r.headers['set-cookie']?.[0] ?? ''
    expect(sc).toMatch(/^gm_oauth=[A-Za-z0-9_-]{32}; /)
    expect(sc.split('; ').slice(1).sort()).toEqual(['HttpOnly', 'Max-Age=600', 'Path=/oauth/', 'SameSite=Lax', 'Secure'])
    expect(tokenBodies).toHaveLength(0)
    await until(() => events(a, 'oauth:returned').length > 0)
    expect(events(a, 'oauth:returned')).toEqual([{ flowId: f.flowId }])
    expect(events(b, 'oauth:returned')).toEqual([])

    // uygulama sayfası tamamlar: 204, işaret temizlenir
    const c = await complete(f.state, `${cookieA}; ${nonceOf(r)}`)
    expect(c.status).toBe(204)
    expect(clearsNonce(c)).toBe(true)
    // kod değiş tokuşu sunucuda: PKCE doğrulayıcısı ve aynı yönlendirme adresiyle
    expect(tokenBodies).toHaveLength(1)
    const tb = Object.fromEntries(tokenBodies[0])
    expect(tb).toMatchObject({
      grant_type: 'authorization_code', code: 'kod-1', redirect_uri: `${ORIGIN}/oauth/callback`,
      client_id: 'cid.apps.googleusercontent.com', client_secret: 'gizli-anahtar'
    })
    expect(createHash('sha256').update(tb.code_verifier).digest('base64url')).toBe(f.challenge)
    // hesap masaüstüyle aynı biçimde: yenileme belirteci ev sahibiyle şifreli
    const id = q.getAccountIdByEmail('kisi@gmail.com')!
    const row = q.getAccountRow(id)!
    expect(row).toMatchObject({ auth_type: 'oauth:google', imap_host: 'imap.gmail.com', smtp_host: 'smtp.gmail.com' })
    expect(row.password_enc.toString('utf-8')).not.toContain('rt-1')
    expect(Buffer.from((await host.decrypt([new Uint8Array(row.password_enc)]))[0]).toString('utf-8')).toBe('rt-1')
    expect(hub.deps.creds.get(id)).toBe('rt-1')
    await until(() => done(a).length > 0)
    expect(done(a)).toEqual([{ ok: true, flowId: f.flowId, email: 'kisi@gmail.com', added: true }])
    expect(done(b)).toEqual([])
    expect(await finish).toEqual({ id: expect.any(Number), ok: true, result: { email: 'kisi@gmail.com', added: true } })
  })

  it('dönüş soket yokken geldiyse yeni soket açılınca oauth:returned yinelenir ve akış tamamlanır', async () => {
    const cookie = await loginCookie()
    const a = await connect(cookie)
    const f = await startFlow(a)
    a.ws.close()
    await new Promise<void>((r) => a.ws.once('close', () => r()))
    const r = await callback(`code=kod-1&state=${f.state}`)
    expect(r.status).toBe(200)
    expect(events(a, 'oauth:returned')).toEqual([])
    const again = await connect(cookie)
    await until(() => events(again, 'oauth:returned').length > 0)
    expect(events(again, 'oauth:returned')).toEqual([{ flowId: f.flowId }])
    // başka oturuma açılan soket duymaz
    const other = await connect(await loginCookie())
    await new Promise((res) => setTimeout(res, 30))
    expect(events(other, 'oauth:returned')).toEqual([])
    expect((await complete(f.state, `${cookie}; ${nonceOf(r)}`)).status).toBe(204)
    await until(() => done(again).length > 0)
    expect(done(again)).toEqual([{ ok: true, flowId: f.flowId, email: 'kisi@gmail.com', added: true }])
    // tamamlanan akış yinelenmez
    const later = await connect(cookie)
    await new Promise((res) => setTimeout(res, 30))
    expect(events(later, 'oauth:returned')).toEqual([])
  })

  it('dönüş yanıtı yazılamadan bağlantı koparsa da oauth:returned gider, bir kez', async () => {
    const returned: string[] = []
    const oauth = createWebOAuth({
      publicOrigin: ORIGIN, https: true, session: () => null, returned: (_o, flowId) => returned.push(flowId), notify: () => {},
      providers: { google: { authUrl: `${providerUrl}/auth`, tokenUrl: `${providerUrl}/token` } }
    })
    try {
      const flow = oauth.start({ owner: 'o', provider: 'google', client: { clientId: 'c', clientSecret: 's' }, finish: async () => ({ email: 'a@b.c', added: true }) })
      const state = new URL(flow.url).searchParams.get('state')!
      // 'finish' hiç gelmeyen yanıt: yazma sonrası bağlantı koptu
      const res = Object.assign(new EventEmitter(), { writeHead: () => res, end: () => {} })
      await oauth.handle({ url: `/oauth/callback?code=k&state=${state}`, headers: {} } as never, res as never)
      expect(returned).toEqual([])
      res.emit('close')
      res.emit('finish')
      expect(returned).toEqual([flow.flowId])
    } finally {
      oauth.close()
    }
  })

  it('state bound to session', async () => {
    const cookieA = await loginCookie()
    const cookieB = await loginCookie()
    const a = await connect(cookieA)
    const b = await connect(cookieB)
    const f = await startFlow(a)
    const r = await callback(`code=kod-1&state=${f.state}`)
    const nonce = nonceOf(r)
    // başka oturumun çereziyle (işaret doğru olsa da): 400, belirteç istenmez, hesap eklenmez, akış yerinde kalır
    const x = await complete(f.state, `${cookieB}; ${nonce}`)
    expect(x.status).toBe(400)
    expect(reason(x)).toBe('invalid')
    expect(clearsNonce(x)).toBe(true)
    // sahibi ama kodu getiren tarayıcının işareti yok / yanlış (aynı uzunlukta) / oturumsuz
    expect(reason(await complete(f.state, cookieA))).toBe('invalid')
    expect(reason(await complete(f.state, `${cookieA}; gm_oauth=${randomBytes(24).toString('base64url')}`))).toBe('invalid')
    expect(reason(await complete(f.state, nonce))).toBe('invalid')
    // ikinci bir kod getirilemez
    expect((await callback(`code=kod-2&state=${f.state}`)).status).toBe(400)
    expect(tokenBodies).toHaveLength(0)
    expect(q.getAccountIdByEmail('kisi@gmail.com')).toBeUndefined()
    // başka oturum akışı iptal edemez ve bekleyemez
    await b.call('oauthCancel', { flowId: f.flowId })
    expect((await b.call('oauthFinish', { flowId: f.flowId, provider: 'google' })).ok).toBe(false)
    expect(done(b)).toEqual([])
    // sahibi hâlâ tamamlar
    expect((await complete(f.state, `${cookieA}; ${nonce}`)).status).toBe(204)
    expect(Object.fromEntries(tokenBodies[0]).code).toBe('kod-1')
    expect(q.getAccountIdByEmail('kisi@gmail.com')).toBeTruthy()
  })

  it('complete requires same origin and JSON', async () => {
    const cookieA = await loginCookie()
    const a = await connect(cookieA)
    const f = await startFlow(a)
    const nonce = nonceOf(await callback(`code=k&state=${f.state}`))
    expect((await complete(f.state, `${cookieA}; ${nonce}`, { origin: 'https://kotu.example' })).status).toBe(403)
    expect((await complete(f.state, `${cookieA}; ${nonce}`, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await req('GET', '/oauth/complete', { cookie: cookieA })).status).toBe(404)
    expect((await req('POST', '/oauth/callback', { origin: ORIGIN })).status).toBe(405)
    expect(tokenBodies).toHaveLength(0)
    expect((await complete(f.state, `${cookieA}; ${nonce}`)).status).toBe(204)
  })

  it('state single use', async () => {
    const cookieA = await loginCookie()
    const a = await connect(cookieA)
    const f = await startFlow(a)
    const r = await callback(`code=kod-1&state=${f.state}`)
    expect((await complete(f.state, `${cookieA}; ${nonceOf(r)}`)).status).toBe(204)
    const again = await complete(f.state, `${cookieA}; ${nonceOf(r)}`)
    expect(again.status).toBe(400)
    expect(reason(again)).toBe('stale')
    expect((await callback(`code=kod-1&state=${f.state}`)).status).toBe(400)
    expect(tokenBodies).toHaveLength(1)
    // bilinmeyen, biçimsiz ve eksik state
    expect((await callback(`code=k&state=${randomBytes(32).toString('base64url')}`)).status).toBe(400)
    expect((await callback('code=k&state=%3Cb%3E')).status).toBe(400)
    expect((await callback('code=k')).status).toBe(400)
    expect(reason(await complete('<b>', cookieA))).toBe('stale')
    // dönüş parametresi olmadan saklanmaz
    const g = await startFlow(a)
    expect((await callback(`state=${g.state}`)).status).toBe(400)
  })

  it('state expires', async () => {
    const cookieA = await loginCookie()
    const a = await connect(cookieA)
    const f = await startFlow(a)
    const finish = a.call('oauthFinish', { flowId: f.flowId, provider: 'google' })
    const r = await callback(`code=kod-1&state=${f.state}`)
    clock += 10 * 60_000 + 1
    const c = await complete(f.state, `${cookieA}; ${nonceOf(r)}`)
    expect(c.status).toBe(400)
    expect(reason(c)).toBe('stale')
    expect(tokenBodies).toHaveLength(0)
    await until(() => done(a).length > 0)
    expect(done(a)).toEqual([{ ok: false, flowId: f.flowId, error: t('sync.oauth.webFlowTimeout') }])
    expect((await finish).ok).toBe(false)
    // dönüş de süre dolduktan sonra gelirse
    const g = await startFlow(a)
    clock += 10 * 60_000 + 1
    expect((await callback(`code=k&state=${g.state}`)).status).toBe(400)
  })

  it('provider error, token error and cancel', async () => {
    const cookieA = await loginCookie()
    const a = await connect(cookieA)
    const f = await startFlow(a)
    const r = await returnAndComplete(f.state, 'error=access_denied', cookieA)
    expect(r.status).toBe(400)
    expect(reason(r)).toBe('denied')
    expect(clearsNonce(r)).toBe(true)
    await until(() => done(a).length > 0)
    expect(done(a)).toEqual([{ ok: false, flowId: f.flowId, error: t('sync.oauth.denied') }])

    // access_denied dışındaki sağlayıcı hatası 'failed'
    const s = await startFlow(a)
    const sr = await returnAndComplete(s.state, 'error=server_error', cookieA)
    expect(reason(sr)).toBe('failed')
    await until(() => done(a).length > 1)
    expect(done(a)[1]).toEqual({ ok: false, flowId: s.flowId, error: t('sync.oauth.authError', { error: 'server_error' }) })
    expect(tokenBodies).toHaveLength(0)

    // token hatası: oturuma iletilir, hesap eklenmez
    tokenReply = () => ({ error: 'invalid_grant' })
    const g = await startFlow(a)
    const gr = await returnAndComplete(g.state, 'code=k', cookieA)
    expect(reason(gr)).toBe('failed')
    expect(clearsNonce(gr)).toBe(true)
    await until(() => done(a).length > 2)
    expect(done(a)[2]).toMatchObject({ ok: false, flowId: g.flowId })
    expect(q.getAccountIdByEmail('kisi@gmail.com')).toBeUndefined()

    // iptal: bekleyen oauthFinish düşer, dönüş reddedilir
    const c = await startFlow(a)
    const finish = a.call('oauthFinish', { flowId: c.flowId, provider: 'google' })
    await a.call('oauthCancel', { flowId: c.flowId })
    expect((await finish).ok).toBe(false)
    expect((await callback(`code=k&state=${c.state}`)).status).toBe(400)
  })

  it('no longer admin at completion', async () => {
    const cookieA = await loginCookie()
    const a = await connect(cookieA)
    const f = await startFlow(a)
    const r = await callback(`code=k&state=${f.state}`)
    // rol doğrudan DB'de düşürülür (oturum açık kalır; tamamlamada çerezden güncel rol okunur)
    q.updateUserFields(q.getUserByUsername('yon')!.id, { role: 'member' })
    const c = await complete(f.state, `${cookieA}; ${nonceOf(r)}`)
    expect(c.status).toBe(400)
    expect(reason(c)).toBe('failed')
    expect(clearsNonce(c)).toBe(true)
    expect(tokenBodies).toHaveLength(0)
    await until(() => done(a).length > 0)
    expect(done(a)).toEqual([{ ok: false, flowId: f.flowId, error: t('sync.perm.adminRequired') }])
    // akış tüketildi
    expect(reason(await complete(f.state, `${cookieA}; ${nonceOf(r)}`))).toBe('stale')
  })

  it('new start replaces the pending flow of the same session', async () => {
    const cookieA = await loginCookie()
    const a = await connect(cookieA)
    const f1 = await startFlow(a)
    const f2 = await startFlow(a)
    expect((await callback(`code=k&state=${f1.state}`)).status).toBe(400)
    expect((await returnAndComplete(f2.state, 'code=k', cookieA)).status).toBe(204)
  })

  it('reauthorize checks the account', async () => {
    const cookieA = await loginCookie()
    const a = await connect(cookieA)
    const other = q.insertAccount({ email: 'baska@gmail.com', displayName: null, imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465, passwordEnc: Buffer.from('x') })
    const f = await startFlow(a, { accountId: other })
    expect(reason(await returnAndComplete(f.state, 'code=k', cookieA))).toBe('failed')
    await until(() => done(a).length > 0)
    expect(done(a)[0]).toEqual({ ok: false, flowId: f.flowId, error: t('sync.oauth.accountMismatch', { account: 'baska@gmail.com', email: 'kisi@gmail.com' }) })
    expect(q.getAccountRow(other)!.auth_type).toBe('password')
  })

  describe('kişi ve takvim bağlama', () => {
    const accountOf = (authType: string, email = 'kisi@gmail.com'): number =>
      q.insertAccount({
        email, displayName: null, imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465,
        passwordEnc: Buffer.from('eski'), authType
      })
    const storedSecret = (id: number): string => q.getAccountRow(id)!.password_enc.toString()

    it('web flow carries extra scopes and pim finish runs', async () => {
      const id = accountOf('oauth:google')
      const cookie = await loginCookie()
      const c = await connect(cookie)
      const { url, state } = await startFlow(c, { accountId: id, pim: true })
      expect(url.searchParams.get('scope')).toBe(
        'https://mail.google.com/ openid email https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/carddav'
      )
      await returnAndComplete(state, 'code=kod', cookie)
      await until(() => done(c).length > 0)
      expect(done(c)[0]).toMatchObject({ ok: true, email: 'kisi@gmail.com', added: false })
      // testte sağlayıcı sahte: keşif sonucu ayrıca pimSourcesRpc.test.ts'te
      expect(done(c)[0].pimStatus).toBeDefined()
      expect(tokenBodies.length).toBeGreaterThan(0)
    })

    it('normal posta akışı kaynak açmaz', async () => {
      const id = accountOf('oauth:google')
      const cookie = await loginCookie()
      const c = await connect(cookie)
      const { url, state } = await startFlow(c, { accountId: id })
      expect(url.searchParams.get('scope')).toBe('https://mail.google.com/ openid email')
      await returnAndComplete(state, 'code=kod', cookie)
      await until(() => done(c).length > 0)
      expect(done(c)[0]).toMatchObject({ ok: true })
      expect(q.getPimSourceByAccount(id)).toBeUndefined()
    })

    it('member cannot start pim oauth', async () => {
      const id = accountOf('oauth:google')
      q.insertUser({ username: 'uye', passwordHash: hashPassword(PW), role: 'member' })
      const r = await req('POST', '/api/login', { origin: ORIGIN, 'content-type': 'application/json' }, JSON.stringify({ username: 'uye', password: PW }))
      const c = await connect((r.headers['set-cookie']?.[0] ?? '').split(';')[0])
      const res = await c.call('oauthStart', { provider: 'google', accountId: id, pim: true })
      expect(res.ok).toBe(false)
    })

    it('vault account refused', async () => {
      const id = accountOf('oauth:google')
      q.setAccountSecureFlag(id, true)
      const c = await connect(await loginCookie())
      const res = await c.call('oauthStart', { provider: 'google', accountId: id, pim: true })
      expect(res).toMatchObject({ ok: false, error: t('sync.oauth.vaultAccount') })
    })

    it('hesapsız ya da başka sağlayıcının hesabında pim akışı başlamaz', async () => {
      const id = accountOf('password')
      const c = await connect(await loginCookie())
      expect((await c.call('oauthStart', { provider: 'google', pim: true })).ok).toBe(false)
      expect((await c.call('oauthStart', { provider: 'google', accountId: id, pim: true })).ok).toBe(false)
    })

    it('partial google consent marks needs_reauth', async () => {
      const id = accountOf('oauth:google')
      tokenReply = () => ({
        access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-1', id_token: idToken({ email: 'kisi@gmail.com' }),
        scope: 'https://mail.google.com/ openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar'
      })
      const cookie = await loginCookie()
      const c = await connect(cookie)
      const { state } = await startFlow(c, { accountId: id, pim: true })
      await returnAndComplete(state, 'code=kod', cookie)
      await until(() => done(c).length > 0)
      expect(done(c)[0]).toMatchObject({ ok: true, pimStatus: 'needsConsent' })
      expect(q.getPimSourceByAccount(id)).toMatchObject({ status: 'needs_reauth' })
      // eksik izinli belirteç posta belirtecinin yerine geçmez
      expect(storedSecret(id)).toBe('eski')
      await until(() => events(c, 'pim:changed').length > 0)
      expect(events(c, 'pim:changed')[0]).toMatchObject({ kind: 'sources', accountId: id })
    })

    it('posta akışıyla yeniden yetkilendirme reddedilmiş kaynağı yeniden açar', async () => {
      const id = accountOf('oauth:google')
      const src = q.upsertAccountPimSource({ accountId: id, kind: 'dav', label: 'k', caldavUrl: 'https://x.test/', carddavUrl: null, serverSchedules: false, grantedScopes: null, now: 1 })
      q.markPimSourceNeedsReauth(src.id, 'ret')
      tokenReply = () => ({ access_token: 'at-2', expires_in: 3600, refresh_token: 'rt-2', id_token: idToken({ email: 'kisi@gmail.com' }) })
      const cookie = await loginCookie()
      const c = await connect(cookie)
      const { state } = await startFlow(c, { accountId: id })
      await returnAndComplete(state, 'code=kod', cookie)
      await until(() => done(c).length > 0)
      expect(done(c)[0]).toMatchObject({ ok: true })
      expect(q.getPimSource(src.id)).toMatchObject({ status: 'ok' })
    })

    it('sağlayıcı kapsamı reddederse posta belirteci ve kaynak değişmez', async () => {
      const id = accountOf('oauth:google')
      const cookie = await loginCookie()
      const c = await connect(cookie)
      const { state } = await startFlow(c, { accountId: id, pim: true })
      await returnAndComplete(state, 'error=invalid_scope', cookie)
      await until(() => done(c).length > 0)
      expect(done(c)[0]).toMatchObject({ ok: false })
      expect(String(done(c)[0].error)).toContain('invalid_scope')
      expect(tokenBodies).toHaveLength(0)
      expect(storedSecret(id)).toBe('eski')
      expect(q.getPimSourceByAccount(id)).toBeUndefined()
    })

    it('başka hesapla dönen pim akışı reddedilir', async () => {
      const id = accountOf('oauth:google', 'baska@gmail.com')
      const cookie = await loginCookie()
      const c = await connect(cookie)
      const { state } = await startFlow(c, { accountId: id, pim: true })
      await returnAndComplete(state, 'code=kod', cookie)
      await until(() => done(c).length > 0)
      expect(done(c)[0]).toMatchObject({ ok: false })
      expect(q.getPimSourceByAccount(id)).toBeUndefined()
    })
  })
})
