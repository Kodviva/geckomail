// Mobil kimlik yolu: uzun ömürlü mobil oturum, 15 dakikalık erişim belirteci, tek kullanımlık WebSocket bileti ve dar
// CORS. Gerçek HTTP ve WS katmanı, gerçek DB. Tehdit numaraları (T1…) test adlarının yanında belirtilir.
import type Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import http, { type IncomingMessage } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { hashPassword } from '../../sync/auth/password'
import { openDb } from '../../sync/db'
import { makeQueries } from '../../sync/db/queries'
import type { OpQueue } from '../../sync/opQueue'
import { RpcHub, type RpcServerDeps } from '../../sync/rpcHub'
import type { Scheduler } from '../../sync/scheduler'
import { SESSION_TTL_MS, tokenHash, WebAuth } from '../auth'
import type { ServerConfig } from '../config'
import { createServerHost } from '../hosts/serverHost'
import { createHttpServer } from '../http'
import { WS_CLOSE_RENEW } from '../../shared/mobileProtocol'
import { t as t2 } from '../../shared/i18n'
import {
  ACCESS_TTL_MS, corsHeaders, isBearerPath, MOBILE_ORIGINS, MobileTokens, nativeOnly, TICKET_TTL_MS, WS_SUBPROTOCOL, WS_TICKET_PREFIX
} from '../mobileAuth'

const ORIGIN = 'https://posta.example.com'
const IOS = 'capacitor://localhost'
const ANDROID = 'https://localhost'
const PW = 'dogru-parola-1'
const DAY = 24 * 3600_000

interface Res {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

describe('mobileAuth birimleri', () => {
  it('izinli kökenler sabit: http yok', () => {
    expect([...MOBILE_ORIGINS].sort()).toEqual(['capacitor://localhost', 'https://localhost'])
  })

  it('isBearerPath listesi dar', () => {
    for (const [m, p] of [
      ['GET', '/api/me'], ['POST', '/api/upload'], ['DELETE', '/api/upload/abc'], ['GET', '/api/attachment/1/2'], ['HEAD', '/api/attachment/1/2'],
      ['GET', '/api/push/devices'], ['DELETE', '/api/push/devices/4'], ['POST', '/api/notify/action'], ['POST', '/api/mobile/ws-ticket'],
      ['POST', '/api/mobile/device']
    ]) expect(isBearerPath(m, p), `${m} ${p}`).toBe(true)
    for (const [m, p] of [
      ['POST', '/api/me'], ['GET', '/api/notify/action'], ['GET', '/api/backup'], ['POST', '/api/restart'], ['GET', '/api/restore/status'],
      ['GET', '/api/passkeys'], ['POST', '/api/passkey/register/options'], ['POST', '/api/2fa/setup/begin'], ['POST', '/oauth/complete'],
      ['GET', '/api/push/key'], ['POST', '/api/push/subscribe'], ['POST', '/api/login'], ['POST', '/api/mobile/login'], ['POST', '/api/mobile/token'],
      ['POST', '/api/mobile/logout'], ['GET', '/api/uploadx'], ['GET', '/api/mobile/ws-ticket'], ['GET', '/api/attachmentx/1'], ['GET', '/api/push/devicesx']
    ]) expect(isBearerPath(m, p), `${m} ${p}`).toBe(false)
  })

  it('corsHeaders yalnız izinli köken ve izinli yol için, kimlik bilgisi izni hiç yok', () => {
    expect(corsHeaders(IOS, 'GET', '/api/me')).toEqual({
      'Access-Control-Allow-Origin': IOS, Vary: 'Origin', 'Access-Control-Expose-Headers': 'Content-Disposition'
    })
    expect(corsHeaders(ANDROID, 'GET', '/api/mobile/hello')['Access-Control-Allow-Origin']).toBe(ANDROID)
    expect(corsHeaders('http://localhost', 'GET', '/api/me')).toEqual({})
    expect(corsHeaders('https://localhost.evil.example', 'GET', '/api/me')).toEqual({})
    expect(corsHeaders(undefined, 'GET', '/api/me')).toEqual({})
    expect(corsHeaders(IOS, 'GET', '/api/backup')).toEqual({})
    expect(corsHeaders(IOS, 'POST', '/api/mobile/login')).toEqual({})
  })

  it('nativeOnly Origin ve Sec-Fetch-* görünce false', () => {
    const r = (headers: Record<string, string>): IncomingMessage => ({ headers }) as unknown as IncomingMessage
    expect(nativeOnly(r({ 'user-agent': 'GeckoMail' }))).toBe(true)
    expect(nativeOnly(r({ origin: 'null' }))).toBe(false)
    expect(nativeOnly(r({ origin: IOS }))).toBe(false)
    expect(nativeOnly(r({ 'sec-fetch-site': 'none' }))).toBe(false)
    expect(nativeOnly(r({ 'sec-fetch-mode': 'navigate' }))).toBe(false)
    expect(nativeOnly(r({ 'sec-fetch-dest': 'empty' }))).toBe(false)
  })

  it('MobileTokens: türler karışmaz, süre sınırı, süpürme', () => {
    let t = 1000
    const m = new MobileTokens(() => t)
    const a = m.issueAccess('s1')
    const ticket = m.issueTicket(a.token)!
    expect(a.token.startsWith('gma_')).toBe(true)
    expect(a.expiresAt).toBe(1000 + ACCESS_TTL_MS)
    expect(ticket.startsWith('gmt_')).toBe(true)
    expect(m.resolveAccess(ticket)).toBeNull()
    expect(m.consumeTicket(a.token)).toBeNull()
    expect(m.resolveAccess(a.token)).toBe('s1')
    t += ACCESS_TTL_MS - 1
    expect(m.resolveAccess(a.token)).toBe('s1')
    t += 1
    expect(m.resolveAccess(a.token)).toBeNull()
    expect(m.consumeTicket(ticket)).toBeNull()
    m.sweep()
    expect(m.size()).toBe(0)
  })

  it('bilet erişim belirtecinden alınır, süresi onu aşamaz', () => {
    let t = 1000
    const m = new MobileTokens(() => t)
    expect(m.issueTicket('gma_yok')).toBeNull()
    const a = m.issueAccess('s1')
    expect(m.consumeTicket(m.issueTicket(a.token)!)).toEqual({ sessionId: 's1', accessExpiresAt: a.expiresAt })
    t = a.expiresAt - 10
    const late = m.issueTicket(a.token)!
    t = a.expiresAt
    expect(m.consumeTicket(late)).toBeNull()
    expect(m.issueTicket(a.token)).toBeNull()
  })
})

describe('mobil kimlik HTTP + WS', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let auth: WebAuth
  let server: http.Server
  let port: number
  let t: number
  const sockets: WebSocket[] = []
  const now = (): number => t

  const start = async (o: { mobileEnabled?: boolean; publicOrigin?: string; revalidateMs?: number } = {}): Promise<void> => {
    const cfg: ServerConfig = {
      dataDir: dir, listenHost: '127.0.0.1', listenPort: 0, keyFile: join(dir, 'master.key'), publicOrigin: o.publicOrigin ?? ORIGIN,
      trustedProxyDepth: 0, webDir: join(dir, 'web'), mobileEnabled: o.mobileEnabled
    }
    server = createHttpServer({ cfg, hub, auth, now, revalidateMs: o.revalidateMs })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  }
  const stop = (): Promise<void> => new Promise((r) => server.close(() => r()))

  beforeEach(() => {
    t = Date.now()
    dir = mkdtempSync(join(tmpdir(), 'gecko-mobile-'))
    db = openDb(dir)
    q = makeQueries(db)
    const host = createServerHost(randomBytes(32), () => hub)
    const stub = new Proxy({}, { get: () => () => undefined })
    const deps: RpcServerDeps = {
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: (v) => host.encrypt(v),
      decrypt: async (b) => (await host.decrypt(b)).map((u) => Buffer.from(u).toString('utf-8')),
      userData: dir, dbSchemaVersion: () => 0
    }
    hub = new RpcHub(deps, 'server')
    auth = new WebAuth(q, host, now)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const ws of sockets.splice(0)) ws.terminate()
    if (server?.listening) await stop()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const mkUser = (username: string, role: 'admin' | 'member' = 'member') => q.insertUser({ username, passwordHash: hashPassword(PW), role })

  const req = (method: string, path: string, o: { headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Res> =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method, path, headers: o.headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }))
      })
      r.on('error', reject)
      if (o.body != null) r.write(o.body)
      r.end()
    })
  /** Yerel katman gibi: Origin ve Sec-Fetch-* yok */
  const native = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    req('POST', path, { headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const bearer = (token: string, origin: string | null = IOS): Record<string, string> => ({
    authorization: `Bearer ${token}`, ...(origin ? { origin } : {})
  })
  const mobileLogin = async (username: string): Promise<{ token: string; id: string }> => {
    const r = await native('/api/mobile/login', { username, password: PW })
    expect(r.status).toBe(200)
    const token = (JSON.parse(r.body) as { token: string }).token
    return { token, id: tokenHash(token) }
  }
  const access = async (mobileToken: string): Promise<string> => {
    const r = await native('/api/mobile/token', undefined, bearer(mobileToken, null))
    expect(r.status).toBe(200)
    return (JSON.parse(r.body) as { accessToken: string }).accessToken
  }
  const ticketFor = async (accessToken: string): Promise<string> => {
    const r = await req('POST', '/api/mobile/ws-ticket', { headers: bearer(accessToken) })
    expect(r.status).toBe(200)
    return (JSON.parse(r.body) as { ticket: string }).ticket
  }
  const webLogin = async (username: string): Promise<string> => {
    const r = await req('POST', '/api/login', {
      headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PW })
    })
    expect(r.status).toBe(200)
    return (r.headers['set-cookie']?.[0] ?? '').split(';')[0]
  }
  const addDevice = (userId: number, sessionId: string): void => {
    q.upsertPushDevice({ userId, sessionId, endpoint: 'relay:cihaz', p256dh: 'p', auth: 'a', label: null, now: t })
  }
  const openWs = (headers: Record<string, string>, protocols: string[] = []): WebSocket => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, protocols, { headers })
    sockets.push(ws)
    return ws
  }
  const ticketWs = (ticket: string, origin: string | null = IOS): WebSocket =>
    openWs(origin ? { origin } : {}, [WS_SUBPROTOCOL, WS_TICKET_PREFIX + ticket])
  const wsRejected = (ws: WebSocket): Promise<number> =>
    new Promise((resolve, reject) => {
      ws.on('unexpected-response', (_req, res: IncomingMessage) => resolve(res.statusCode!))
      ws.on('open', () => reject(new Error('yükseltme kabul edildi')))
      ws.on('error', () => {})
    })
  const wsOpen = (ws: WebSocket): Promise<void> =>
    new Promise((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('unexpected-response', (_req, res: IncomingMessage) => reject(new Error(`HTTP ${res.statusCode}`)))
      ws.on('error', reject)
    })
  const wsClosed = (ws: WebSocket): Promise<number> => new Promise((resolve) => ws.on('close', (code) => resolve(code)))

  // T1
  it('cookie ignored on mobile origin', async () => {
    await start()
    const uid = mkUser('admin', 'admin')
    const cookie = await webLogin('admin')
    expect(uid).toBeGreaterThan(0)
    for (const origin of [IOS, ANDROID]) {
      for (const [m, p] of [
        ['GET', '/api/me'], ['GET', '/api/attachment/1/2'], ['GET', '/api/push/devices'], ['GET', '/api/backup'], ['GET', '/api/passkeys'],
        ['GET', '/api/restore/status'], ['POST', '/api/notify/action'], ['POST', '/api/upload'], ['POST', '/api/logout'], ['POST', '/api/mobile/ws-ticket']
      ]) {
        const r = await req(m, p, { headers: { origin, cookie, 'content-type': 'application/json' }, body: m === 'POST' ? '{}' : undefined })
        expect(r.status, `${origin} ${m} ${p}`).toBe(401)
        expect(r.body).not.toContain('"user"')
      }
    }
    // /api/logout mobil kökenden çalışmadı: çerez oturumu yerinde
    const me = await req('GET', '/api/me', { headers: { cookie } })
    expect(me.status).toBe(200)
  })

  // T2
  it('allowlisted origin without bearer gets nothing', async () => {
    await start()
    mkUser('ada')
    for (const origin of [IOS, ANDROID]) {
      const r = await req('GET', '/api/me', { headers: { origin } })
      expect(r.status).toBe(401)
      expect(JSON.parse(r.body)).toEqual({ reason: 'unauthenticated' }) // setupRequired bile yok
      expect(r.headers['access-control-allow-credentials']).toBeUndefined()
      expect(r.headers['set-cookie']).toBeUndefined()
      // 401'i okuyabilmeli: yenileme yolu buna bağlı
      expect(r.headers['access-control-allow-origin']).toBe(origin)
    }
  })

  it('bearer works on listed paths and carries no cookie', async () => {
    await start()
    const uid = mkUser('ada')
    const { token, id } = await mobileLogin('ada')
    const a = await access(token)
    const me = await req('GET', '/api/me', { headers: bearer(a) })
    expect(me.status).toBe(200)
    expect((JSON.parse(me.body) as { user: { username: string } }).user.username).toBe('ada')
    expect(me.headers['set-cookie']).toBeUndefined()
    expect(me.headers['access-control-allow-origin']).toBe(IOS)
    expect(me.headers.vary).toContain('Origin')
    // yerel katman Origin taşımaz
    expect((await req('GET', '/api/me', { headers: bearer(a, null) })).status).toBe(200)

    const up = await req('POST', '/api/upload', {
      headers: { ...bearer(a, ANDROID), 'content-type': 'application/octet-stream', 'x-filename': "UTF-8''a.txt" }, body: Buffer.from('icerik')
    })
    expect(up.status).toBe(200)
    expect(up.headers['access-control-allow-origin']).toBe(ANDROID)
    const { uploadId } = JSON.parse(up.body) as { uploadId: string }
    expect((await req('DELETE', `/api/upload/${uploadId}`, { headers: bearer(a) })).status).toBe(204)

    addDevice(uid, id)
    const list = await req('GET', '/api/push/devices', { headers: bearer(a) })
    const devices = (JSON.parse(list.body) as { devices: { id: number; current: boolean }[] }).devices
    expect(devices).toHaveLength(1)
    expect(devices[0].current).toBe(true)
    expect((await req('DELETE', `/api/push/devices/${devices[0].id}`, { headers: bearer(a) })).status).toBe(204)

    const act = await req('POST', '/api/notify/action', { headers: { ...bearer(a), 'content-type': 'application/json' }, body: '{}' })
    expect(act.status).toBe(400) // kimlik geçti, gövde geçersiz
    expect((await req('GET', '/api/attachment/1/2', { headers: bearer(a) })).status).toBe(404)
  })

  it('bearer from any other origin refused, web origin included', async () => {
    await start()
    mkUser('ada')
    const a = await access((await mobileLogin('ada')).token)
    for (const origin of [ORIGIN, 'https://evil.example', 'http://localhost', 'null']) {
      const r = await req('GET', '/api/me', { headers: bearer(a, origin) })
      expect(r.status, origin).toBe(403)
      expect(r.headers['access-control-allow-origin']).toBeUndefined()
    }
  })

  it('authorization header disables cookie even with bad bearer', async () => {
    await start()
    mkUser('ada')
    const cookie = await webLogin('ada')
    const r = await req('GET', '/api/me', { headers: { cookie, authorization: 'Bearer yanlis' } })
    expect(r.status).toBe(401)
    const b = await req('GET', '/api/backup', { headers: { cookie, authorization: 'Bearer yanlis' } })
    expect(b.status).toBe(401)
  })

  it('cookie path unchanged without bearer', async () => {
    await start()
    mkUser('ada')
    const cookie = await webLogin('ada')
    const me = await req('GET', '/api/me', { headers: { cookie } })
    expect(me.status).toBe(200)
    expect(me.headers['set-cookie']?.[0]).toMatch(/^gm_session=.*HttpOnly; Secure; SameSite=Strict/)
    expect(me.headers['access-control-allow-origin']).toBeUndefined()
    expect(me.headers.vary).toBeUndefined()
    // aynı kökenli web isteği de CORS başlığı almaz
    const web = await req('GET', '/api/me', { headers: { cookie, origin: ORIGIN } })
    expect(web.status).toBe(200)
    expect(web.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('basic authorization from a proxy does not touch the cookie path', async () => {
    await start()
    mkUser('ada')
    const cookie = await webLogin('ada')
    const r = await req('GET', '/api/me', { headers: { cookie, authorization: 'Basic YTpi' } })
    expect(r.status).toBe(200)
  })

  it('public origin equal to an allowlisted origin stays on the cookie path', async () => {
    await start({ publicOrigin: ANDROID })
    mkUser('ada')
    const r = await req('POST', '/api/login', {
      headers: { origin: ANDROID, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ada', password: PW })
    })
    expect(r.status).toBe(200)
    const cookie = (r.headers['set-cookie']?.[0] ?? '').split(';')[0]
    const me = await req('GET', '/api/me', { headers: { cookie, origin: ANDROID } })
    expect(me.status).toBe(200)
    expect(me.headers['access-control-allow-origin']).toBeUndefined()
  })

  // T3
  it('mobile origin ws without ticket 401', async () => {
    await start()
    mkUser('ada')
    const cookie = await webLogin('ada')
    for (const origin of [IOS, ANDROID]) {
      expect(await wsRejected(openWs({ origin }))).toBe(401)
      expect(await wsRejected(openWs({ origin, cookie }))).toBe(401) // çerez bilet yerine geçmez
      expect(await wsRejected(openWs({ origin, cookie }, [WS_SUBPROTOCOL]))).toBe(401)
    }
  })

  it('ticket single use', async () => {
    await start()
    mkUser('ada')
    const a = await access((await mobileLogin('ada')).token)
    const ticket = await ticketFor(a)
    const ws = ticketWs(ticket)
    await wsOpen(ws)
    expect(ws.protocol).toBe('gecko.v1') // bilet yankılanmaz
    expect(await wsRejected(ticketWs(ticket))).toBe(401)
    // yerel katmandan Origin'siz de olur, ANDROID kökeninden de
    await wsOpen(ticketWs(await ticketFor(a), null))
    await wsOpen(ticketWs(await ticketFor(a), ANDROID))
  })

  const rpcCall = (ws: WebSocket, method: string): Promise<{ ok: boolean; error?: string }> =>
    new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1e9)
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString()) as { id?: number; ok: boolean; error?: string }
        if (m.id === id) resolve(m)
      })
      ws.send(JSON.stringify({ id, method, params: {} }))
    })

  // T8: biletli soket yetki yükseltme yan kapısı değil
  it('ticket session refuses admin and 2fa methods, cookie session does not', async () => {
    await start()
    mkUser('kok', 'admin')
    const ws = ticketWs(await ticketFor(await access((await mobileLogin('kok')).token)))
    await wsOpen(ws)
    for (const m of ['getUsers', 'setPrefs', 'createUser', 'twoFactorStatus', 'twoFactorBegin', 'twoFactorDisable']) {
      const r = await rpcCall(ws, m)
      expect(r.ok, m).toBe(false)
      expect(r.error, m).toBe(t2('sync.perm.browserRequired'))
    }
    expect((await rpcCall(ws, 'getAccounts')).ok).toBe(true)
    const web = openWs({ origin: ORIGIN, cookie: await webLogin('kok') })
    await wsOpen(web)
    expect((await rpcCall(web, 'getUsers')).ok).toBe(true)
    expect((await rpcCall(web, 'twoFactorStatus')).ok).toBe(true)
  })

  it('ticket ws closes when access token expires, with renew code, revalidate does not extend', async () => {
    await start({ revalidateMs: 10 })
    mkUser('ada')
    const a = await access((await mobileLogin('ada')).token)
    t += ACCESS_TTL_MS - 150
    const ws = ticketWs(await ticketFor(a))
    await wsOpen(ws)
    expect(await wsClosed(ws)).toBe(WS_CLOSE_RENEW)
  })

  it('cookie ws is not tied to access expiry', async () => {
    await start()
    mkUser('ada')
    const web = openWs({ origin: ORIGIN, cookie: await webLogin('ada') })
    await wsOpen(web)
    await new Promise((r) => setTimeout(r, 30))
    expect(web.readyState).toBe(WebSocket.OPEN)
  })

  it('ticket from another origin refused and not burned', async () => {
    await start()
    mkUser('ada')
    const a = await access((await mobileLogin('ada')).token)
    const ticket = await ticketFor(a)
    expect(await wsRejected(ticketWs(ticket, 'https://evil.example'))).toBe(403)
    expect(await wsRejected(ticketWs(ticket, ORIGIN))).toBe(403)
    await wsOpen(ticketWs(ticket))
  })

  it('ticket expires', async () => {
    await start()
    mkUser('ada')
    const a = await access((await mobileLogin('ada')).token)
    const ticket = await ticketFor(a)
    t += TICKET_TTL_MS
    expect(await wsRejected(ticketWs(ticket))).toBe(401)
  })

  it('ticket endpoint needs bearer access, not cookie or mobile token', async () => {
    await start()
    mkUser('ada')
    const { token } = await mobileLogin('ada')
    const cookie = await webLogin('ada')
    expect((await req('POST', '/api/mobile/ws-ticket', { headers: { cookie, origin: ORIGIN } })).status).toBe(401)
    expect((await req('POST', '/api/mobile/ws-ticket', { headers: { cookie } })).status).toBe(401)
    // JS'e girmeyen uzun belirteç erişim belirteci yerine geçmez
    expect((await req('POST', '/api/mobile/ws-ticket', { headers: bearer(token) })).status).toBe(401)
    expect((await req('GET', '/api/me', { headers: bearer(token) })).status).toBe(401)
  })

  it('web ws with ticket-free cookie path unchanged', async () => {
    await start()
    mkUser('ada')
    const cookie = await webLogin('ada')
    const ws = openWs({ origin: ORIGIN, cookie })
    await wsOpen(ws)
    expect(ws.protocol).toBe('')
  })

  // T5
  it('mobile token rejected as cookie', async () => {
    await start()
    mkUser('ada')
    const { token, id } = await mobileLogin('ada')
    const cookie = `gm_session=${token}`
    expect((await req('GET', '/api/me', { headers: { cookie } })).status).toBe(401)
    expect(await wsRejected(openWs({ origin: ORIGIN, cookie }))).toBe(401)
    expect((await req('GET', '/api/attachment/1/2', { headers: { cookie } })).status).toBe(401)
    expect(auth.resolve(token)).toBeNull()
    expect(q.getWebSession(id)).toBeDefined() // tür uymazsa satır silinmez
    // çerez yolu çıkışı mobil oturumu kapatamaz
    await req('POST', '/api/logout', { headers: { origin: ORIGIN, 'content-type': 'application/json', cookie }, body: '{}' })
    expect(q.getWebSession(id)).toBeDefined()
    expect(auth.resolve(token, 'mobile')).not.toBeNull()
  })

  it('web token rejected on mobile endpoints', async () => {
    await start()
    mkUser('ada')
    const cookie = await webLogin('ada')
    const web = cookie.slice('gm_session='.length)
    const ws = openWs({ origin: ORIGIN, cookie })
    await wsOpen(ws)
    expect((await native('/api/mobile/token', undefined, bearer(web, null))).status).toBe(401)
    await native('/api/mobile/logout', undefined, bearer(web, null))
    expect(auth.resolve(web)).not.toBeNull()
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(auth.resolveSession(tokenHash(web))).toBeNull()
  })

  // T6
  it('native endpoints refuse browser requests', async () => {
    await start()
    mkUser('ada')
    const { token } = await mobileLogin('ada')
    const browser: Record<string, string>[] = [
      { origin: IOS }, { origin: ANDROID }, { origin: ORIGIN }, { origin: 'null' }, { 'sec-fetch-site': 'none' }, { 'sec-fetch-mode': 'cors' },
      { 'sec-fetch-dest': 'empty' }
    ]
    for (const h of browser) {
      const login = await native('/api/mobile/login', { username: 'ada', password: PW }, h)
      expect(login.status, JSON.stringify(h)).toBe(403)
      expect(login.body).not.toContain('token')
      expect(login.headers['access-control-allow-origin']).toBeUndefined()
      expect((await native('/api/mobile/token', undefined, { ...bearer(token, null), ...h })).status).toBe(403)
      expect((await native('/api/mobile/logout', undefined, { ...bearer(token, null), ...h })).status).toBe(403)
    }
    expect(auth.resolve(token, 'mobile')).not.toBeNull()
  })

  it('mobile login returns token only in body, hides nothing else; errors match web codes', async () => {
    await start()
    mkUser('ada')
    const ok = await native('/api/mobile/login', { username: 'ada', password: PW })
    expect(ok.status).toBe(200)
    expect(ok.headers['set-cookie']).toBeUndefined()
    const b = JSON.parse(ok.body) as { token: string; user: { username: string } }
    expect(b.user.username).toBe('ada')
    expect(q.getWebSession(tokenHash(b.token))?.kind).toBe('mobile')
    const bad = await native('/api/mobile/login', { username: 'ada', password: 'yanlis' })
    expect(bad.status).toBe(401)
    expect(JSON.parse(bad.body)).toEqual({ reason: 'bad' })
    expect((await native('/api/mobile/login', { username: 'ada' })).status).toBe(400)
    const notJson = await req('POST', '/api/mobile/login', { headers: { 'content-type': 'text/plain' }, body: '{}' })
    expect(notJson.status).toBe(415)
  })

  // T7
  it('no token in logs', async () => {
    const lines: string[] = []
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')))
    }
    await start()
    mkUser('ada')
    const { token } = await mobileLogin('ada')
    const a = await access(token)
    const ticket = await ticketFor(a)
    const ws = ticketWs(ticket)
    await wsOpen(ws)
    expect(await wsRejected(ticketWs(ticket))).toBe(401)
    await req('GET', '/api/me', { headers: bearer(a) })
    await req('GET', '/api/me', { headers: bearer(`${a}x`) })
    await native('/api/mobile/token', undefined, bearer(`${token}x`, null))
    await native('/api/mobile/logout', undefined, bearer(token, null))
    const text = lines.join('\n')
    for (const secret of [token, a, ticket]) expect(text).not.toContain(secret)
    expect(text).not.toMatch(/gma_|gmt_/)
    // adreste belirteç yok: hepsi başlıkta; sunucu URL'den belirteç kabul etmez
    expect((await req('GET', `/api/me?access_token=${a}`)).status).toBe(401)
  })

  // T8
  it('bearer refused on backup and passkey', async () => {
    await start()
    mkUser('admin', 'admin')
    const a = await access((await mobileLogin('admin')).token)
    for (const [m, p] of [
      ['GET', '/api/backup'], ['POST', '/api/backup'], ['POST', '/api/restart'], ['GET', '/api/restore/status'], ['POST', '/api/restore/upload'],
      ['GET', '/api/passkeys'], ['DELETE', '/api/passkeys/x'], ['POST', '/api/passkey/register/options'], ['POST', '/api/passkey/register/verify'],
      ['POST', '/api/passkey/login/options'], ['POST', '/api/2fa/setup/begin'], ['POST', '/api/2fa/setup/confirm'], ['POST', '/oauth/complete'],
      ['GET', '/oauth/callback'], ['GET', '/api/push/key'], ['POST', '/api/push/subscribe'], ['POST', '/api/login'], ['POST', '/api/logout']
    ]) {
      for (const origin of [IOS, null]) {
        const r = await req(m, p, { headers: { ...bearer(a, origin), 'content-type': 'application/json' }, body: m === 'POST' ? '{}' : undefined })
        expect(r.status, `${m} ${p}`).toBe(401)
      }
    }
  })

  // T13
  it('mobile login shares lockout', async () => {
    await start()
    mkUser('ada')
    for (let i = 0; i < 3; i++) expect((await native('/api/mobile/login', { username: 'ada', password: 'yanlis' })).status).toBe(401)
    for (let i = 0; i < 2; i++) {
      const r = await req('POST', '/api/login', {
        headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ada', password: 'yanlis' })
      })
      expect(r.status).toBe(401)
    }
    expect((await native('/api/mobile/login', { username: 'ada', password: PW })).status).toBe(423)
    const web = await req('POST', '/api/login', {
      headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ada', password: PW })
    })
    expect(web.status).toBe(423)
  })

  it('access expires after 15 minutes', async () => {
    await start()
    mkUser('ada')
    const { token } = await mobileLogin('ada')
    const r = await native('/api/mobile/token', undefined, bearer(token, null))
    const b = JSON.parse(r.body) as { accessToken: string; expiresAt: number; user: { username: string } }
    expect(b.expiresAt).toBe(t + 15 * 60_000)
    expect(b.user.username).toBe('ada')
    t += 15 * 60_000 - 1
    expect((await req('GET', '/api/me', { headers: bearer(b.accessToken) })).status).toBe(200)
    t += 1
    expect((await req('GET', '/api/me', { headers: bearer(b.accessToken) })).status).toBe(401)
    expect((await req('GET', '/api/me', { headers: bearer(await access(token)) })).status).toBe(200)
  })

  it('restart loses access but mobile token renews', async () => {
    await start()
    mkUser('ada')
    const { token } = await mobileLogin('ada')
    const a = await access(token)
    await stop()
    await start()
    expect((await req('GET', '/api/me', { headers: bearer(a) })).status).toBe(401)
    expect((await req('GET', '/api/me', { headers: bearer(await access(token)) })).status).toBe(200)
  })

  it('revoked session invalidates access immediately', async () => {
    await start()
    const uid = mkUser('ada')
    const { token } = await mobileLogin('ada')
    const a = await access(token)
    const ticket = await ticketFor(a)
    const ws = ticketWs(await ticketFor(a))
    await wsOpen(ws)
    const closed = wsClosed(ws)
    hub.onUserRevoked?.(uid)
    await closed
    expect((await req('GET', '/api/me', { headers: bearer(a) })).status).toBe(401)
    expect(await wsRejected(ticketWs(ticket))).toBe(401)
    expect((await native('/api/mobile/token', undefined, bearer(token, null))).status).toBe(401)
  })

  it('disabled user loses open ws on revalidate', async () => {
    await start({ revalidateMs: 20 })
    const uid = mkUser('ada')
    const a = await access((await mobileLogin('ada')).token)
    const ws = ticketWs(await ticketFor(a))
    await wsOpen(ws)
    const closed = wsClosed(ws)
    db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(uid)
    await closed
    expect((await req('GET', '/api/me', { headers: bearer(a) })).status).toBe(401)
  })

  it('logout ends session, device and sockets', async () => {
    await start()
    const uid = mkUser('ada')
    const { token, id } = await mobileLogin('ada')
    addDevice(uid, id)
    const a = await access(token)
    const ws = ticketWs(await ticketFor(a))
    await wsOpen(ws)
    const closed = wsClosed(ws)
    const r = await native('/api/mobile/logout', undefined, bearer(token, null))
    expect(r.status).toBe(204)
    expect(r.headers['set-cookie']).toBeUndefined()
    await closed
    expect(q.getWebSession(id)).toBeUndefined()
    expect(q.listPushDevices(uid)).toHaveLength(0)
    expect((await req('GET', '/api/me', { headers: bearer(a) })).status).toBe(401)
    // yerelde bekleyen çıkış yinelenebilir
    expect((await native('/api/mobile/logout', undefined, bearer(token, null))).status).toBe(204)
    expect((await native('/api/mobile/logout')).status).toBe(401)
  })

  it('logout closes an idle session that keeps push', async () => {
    await start()
    const uid = mkUser('ada')
    const { token, id } = await mobileLogin('ada')
    addDevice(uid, id)
    t += 8 * DAY
    expect((await native('/api/mobile/logout', undefined, bearer(token, null))).status).toBe(204)
    expect(q.getWebSession(id)).toBeUndefined()
    expect(q.listPushDevices(uid)).toHaveLength(0)
  })

  it('options only on bearer paths', async () => {
    await start()
    const preflight = (path: string, method: string, origin = IOS) =>
      req('OPTIONS', path, { headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': 'authorization' } })
    for (const [m, p] of [
      ['GET', '/api/me'], ['POST', '/api/upload'], ['DELETE', '/api/upload/abc'], ['GET', '/api/attachment/1/2'], ['GET', '/api/push/devices'],
      ['POST', '/api/notify/action'], ['POST', '/api/mobile/ws-ticket'], ['POST', '/api/mobile/device'], ['GET', '/api/mobile/hello']
    ]) {
      const r = await preflight(p, m)
      expect(r.status, `${m} ${p}`).toBe(204)
      expect(r.headers['access-control-allow-origin']).toBe(IOS)
      expect(r.headers['access-control-allow-methods']).toContain(m)
      expect(r.headers['access-control-allow-headers']).toBe('Authorization, Content-Type, X-Filename')
      expect(r.headers['access-control-expose-headers']).toBe('Content-Disposition')
      expect(r.headers['access-control-max-age']).toBe('600')
      expect(r.headers.vary).toContain('Origin')
    }
    for (const [m, p] of [
      ['GET', '/api/backup'], ['GET', '/api/passkeys'], ['POST', '/api/mobile/login'], ['POST', '/api/mobile/token'], ['POST', '/api/mobile/logout'],
      ['POST', '/api/login'], ['POST', '/api/me'], ['GET', '/rpc'], ['GET', '/']
    ]) {
      const r = await preflight(p, m)
      expect(r.status, `${m} ${p}`).toBe(404)
      expect(r.headers['access-control-allow-origin']).toBeUndefined()
    }
    for (const origin of [ORIGIN, 'https://evil.example', 'http://localhost']) {
      const r = await preflight('/api/me', 'GET', origin)
      expect(r.status, origin).toBe(404)
      expect(r.headers['access-control-allow-origin']).toBeUndefined()
    }
    expect((await req('OPTIONS', '/api/me', { headers: { origin: IOS } })).status).toBe(404) // preflight değil
  })

  it('no allow-credentials header anywhere', async () => {
    await start()
    mkUser('ada')
    const { token } = await mobileLogin('ada')
    const a = await access(token)
    const seen: Res[] = [
      await req('OPTIONS', '/api/me', { headers: { origin: IOS, 'access-control-request-method': 'GET' } }),
      await req('GET', '/api/me', { headers: { origin: IOS } }),
      await req('GET', '/api/me', { headers: bearer(a) }),
      await req('GET', '/api/mobile/hello', { headers: { origin: ANDROID } }),
      await req('POST', '/api/mobile/ws-ticket', { headers: bearer(a) }),
      await req('GET', '/api/attachment/1/2', { headers: bearer(a) }),
      await req('POST', '/api/upload', { headers: { ...bearer(a), 'content-type': 'application/octet-stream', 'x-filename': 'a' }, body: 'x' }),
      await native('/api/mobile/token', undefined, bearer(token, null))
    ]
    for (const r of seen) {
      expect(r.headers['access-control-allow-credentials']).toBeUndefined()
      expect(r.headers['set-cookie']).toBeUndefined()
      const allow = r.headers['access-control-allow-origin']
      expect(allow === undefined || allow === IOS || allow === ANDROID).toBe(true)
    }
  })

  it('hello has no version', async () => {
    await start()
    const r = await req('GET', '/api/mobile/hello', { headers: { origin: IOS } })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toEqual({ product: 'geckomail', api: 1, push: false })
    expect(r.headers['access-control-allow-origin']).toBe(IOS)
    expect(r.body).not.toMatch(/version|\d+\.\d+/i)
    const other = await req('GET', '/api/mobile/hello', { headers: { origin: 'https://evil.example' } })
    expect(other.status).toBe(200)
    expect(other.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('GECKO_MOBILE=0 disables all', async () => {
    await start({ mobileEnabled: false })
    mkUser('ada')
    const cookie = await webLogin('ada')
    const seeded = auth.login({ username: 'ada', password: PW, ip: '1.2.3.4', userAgent: '' }, 'mobile')
    const r0 = await seeded
    if (!r0.ok) throw new Error('giriş')
    expect((await req('GET', '/api/mobile/hello', { headers: { origin: IOS } })).status).toBe(404)
    expect((await native('/api/mobile/login', { username: 'ada', password: PW })).status).toBe(404)
    expect((await native('/api/mobile/token', undefined, bearer(r0.token, null))).status).toBe(404)
    expect((await native('/api/mobile/logout', undefined, bearer(r0.token, null))).status).toBe(404)
    expect((await req('POST', '/api/mobile/ws-ticket', { headers: bearer('gma_x') })).status).toBe(404)
    const pre = await req('OPTIONS', '/api/me', { headers: { origin: IOS, 'access-control-request-method': 'GET' } })
    expect(pre.status).toBe(404)
    expect(pre.headers['access-control-allow-origin']).toBeUndefined()
    expect((await req('GET', '/api/me', { headers: { origin: IOS } })).headers['access-control-allow-origin']).toBeUndefined()
    expect(await wsRejected(ticketWs('gmt_x'))).toBe(403)
    // web yolu yerinde
    expect((await req('GET', '/api/me', { headers: { cookie } })).status).toBe(200)
  })

  it('mobile session idle 8 days refused but row stays with push device', async () => {
    await start()
    const uid = mkUser('ada')
    const { token, id } = await mobileLogin('ada')
    addDevice(uid, id)
    t += 8 * DAY
    const seen = q.getWebSession(id)!.last_seen_at
    expect((await native('/api/mobile/token', undefined, bearer(token, null))).status).toBe(401)
    expect(auth.resolveSession(id)).toBeNull()
    const row = q.getWebSession(id)
    expect(row).toBeDefined()
    expect(row!.last_seen_at).toBe(seen) // reddedilen istek boşta süresini sıfırlamaz
    expect(q.listPushDevices(uid)).toHaveLength(1)
  })

  it('token route tells idle from gone', async () => {
    await start()
    const uid = mkUser('ada')
    const reason = async (token?: string): Promise<unknown> => {
      const r = await native('/api/mobile/token', undefined, token ? bearer(token, null) : undefined)
      expect(r.status).toBe(401)
      return JSON.parse(r.body).reason
    }
    const { token, id } = await mobileLogin('ada')
    addDevice(uid, id)
    t += 8 * DAY
    expect(await reason(token)).toBe('idle')
    expect(await reason(token)).toBe('idle') // yineleyen istek satırı silmez, boşta süresini sıfırlamaz
    expect(q.listPushDevices(uid)).toHaveLength(1)
    t += 23 * DAY // push sınırı da geçti
    expect(await reason(token)).toBe('gone')
    expect(q.getWebSession(id)).toBeUndefined()

    const noPush = await mobileLogin('ada')
    t += 8 * DAY
    expect(await reason(noPush.token)).toBe('gone')

    const disabled = await mobileLogin('ada')
    addDevice(uid, disabled.id)
    t += 8 * DAY
    q.updateUserFields(uid, { enabled: 0 })
    expect(await reason(disabled.token)).toBe('gone')
    q.updateUserFields(uid, { enabled: 1 })

    const revoked = await mobileLogin('ada')
    addDevice(uid, revoked.id)
    expect((await native('/api/mobile/logout', undefined, bearer(revoked.token, null))).status).toBe(204)
    t += 8 * DAY
    expect(await reason(revoked.token)).toBe('gone')

    expect(await reason('gms_uydurma')).toBe('gone')
    expect(await reason()).toBe('gone')
  })

  it('web cookie token is gone on token route', async () => {
    await start()
    mkUser('ada')
    const web = (await webLogin('ada')).slice('gm_session='.length)
    expect(JSON.parse((await native('/api/mobile/token', undefined, bearer(web, null))).body).reason).toBe('gone')
  })

  it('mobile session idle 8 days without device is deleted', async () => {
    await start()
    mkUser('ada')
    const { token, id } = await mobileLogin('ada')
    t += 8 * DAY
    expect((await native('/api/mobile/token', undefined, bearer(token, null))).status).toBe(401)
    expect(q.getWebSession(id)).toBeUndefined()
  })

  it('mobile session rolls expiry when used', async () => {
    await start()
    const uid = mkUser('ada')
    const { token, id } = await mobileLogin('ada')
    addDevice(uid, id)
    const first = q.getWebSession(id)!.expires_at
    expect(first).toBe(t + SESSION_TTL_MS)
    t += DAY - 1
    await access(token)
    expect(q.getWebSession(id)!.expires_at).toBe(first) // günde en çok bir yazma
    t += 1
    await access(token)
    expect(q.getWebSession(id)!.expires_at).toBe(t + SESSION_TTL_MS)
    // erişim belirteci yolu da aynı kuralla uzatır
    t += DAY
    expect(auth.resolveSession(id)?.expiresAt).toBe(t + SESSION_TTL_MS)
    expect(q.getWebSession(id)!.expires_at).toBe(t + SESSION_TTL_MS)
  })

  it('sweep removes mobile session and device', async () => {
    await start()
    const uid = mkUser('ada')
    const { id } = await mobileLogin('ada')
    addDevice(uid, id)
    auth.sweepExpired()
    expect(q.getWebSession(id)).toBeDefined()
    t += SESSION_TTL_MS + 1
    auth.sweepExpired()
    expect(q.getWebSession(id)).toBeUndefined()
    expect(q.listPushDevices(uid)).toHaveLength(0)
  })

  it('auth.resolve kind mismatch keeps row in both directions', async () => {
    mkUser('ada')
    const r = await auth.login({ username: 'ada', password: PW, ip: '1.2.3.4', userAgent: '' })
    if (!r.ok) throw new Error('giriş')
    expect(auth.resolve(r.token, 'mobile')).toBeNull()
    expect(auth.resolve(r.token)).not.toBeNull()
    auth.logout(r.token, 'mobile')
    expect(auth.resolve(r.token)).not.toBeNull()
  })
})
