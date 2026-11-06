import type Database from 'better-sqlite3'
import { createHash, randomBytes } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import http, { type IncomingMessage } from 'http'
import { connect, type AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { hashPassword } from '../../sync/auth/password'
import { openDb } from '../../sync/db'
import { makeQueries } from '../../sync/db/queries'
import type { OpQueue } from '../../sync/opQueue'
import { RpcHub, type RpcServerDeps } from '../../sync/rpcHub'
import type { Scheduler } from '../../sync/scheduler'
import { WebAuth } from '../auth'
import { configErrorText, configFromEnv, type ServerConfig } from '../config'
import { createServerHost } from '../hosts/serverHost'
import { createHttpServer, readJson } from '../http'
import { CSP, WEB_CSP } from '../securityHeaders'
import { clientIp } from '../../shared/clientIp'
import { base32Decode, totpCode } from '../../sync/auth/totp'

const ORIGIN = 'https://posta.example.com'
const PW = 'dogru-parola-1'

interface Res {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

describe('HTTP + WebSocket sunucusu', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let auth: WebAuth
  let server: http.Server
  let port: number
  const sockets: WebSocket[] = []

  const start = async (
    revalidateMs?: number, heartbeatMs?: number, publicOrigin = ORIGIN, bodyLimits?: Parameters<typeof createHttpServer>[0]['bodyLimits']
  ): Promise<void> => {
    const cfg: ServerConfig = {
      dataDir: dir, listenHost: '127.0.0.1', listenPort: 0, keyFile: join(dir, 'master.key'), publicOrigin, trustedProxyDepth: 0,
      webDir: join(dir, 'web')
    }
    server = createHttpServer({ cfg, hub, auth, revalidateMs, heartbeatMs, bodyLimits })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-http-'))
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
    auth = new WebAuth(q, host)
  })
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    if (server?.listening) await new Promise<void>((r) => server.close(() => r()))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const mkUser = (username: string, role: 'admin' | 'member' = 'member') => q.insertUser({ username, passwordHash: hashPassword(PW), role })

  const req = (method: string, path: string, o: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> =>
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
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    req('POST', path, { headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const cookieOf = (r: Res): string => {
    const c = r.headers['set-cookie']?.[0] ?? ''
    return c.split(';')[0]
  }
  const loginCookie = async (username: string): Promise<string> => {
    const r = await post('/api/login', { username, password: PW })
    expect(r.status).toBe(200)
    return cookieOf(r)
  }

  const openWs = (headers: Record<string, string>, path = '/rpc', autoPong = true): WebSocket => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, autoPong })
    sockets.push(ws)
    return ws
  }
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
    })
  const wsClosed = (ws: WebSocket): Promise<number> => new Promise((resolve) => ws.on('close', (code) => resolve(code)))
  const call = (ws: WebSocket, id: number, method: string, params: unknown = {}): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
    new Promise((resolve) => {
      const onMsg = (data: WebSocket.RawData) => {
        const m = JSON.parse(data.toString())
        if (m.id !== id) return
        ws.off('message', onMsg)
        resolve(m)
      }
      ws.on('message', onMsg)
      ws.send(JSON.stringify({ id, method, params }))
    })

  it('healthz ok', async () => {
    await start()
    const r = await req('GET', '/healthz')
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toEqual({ ok: true })
  })

  it('unknown path 404', async () => {
    await start()
    expect((await req('GET', '/')).status).toBe(404)
    expect((await req('GET', '/api/nope')).status).toBe(404)
    expect((await req('GET', '/api/login')).status).toBe(404)
  })

  it('serves web client with page CSP; /api headers unchanged', async () => {
    mkdirSync(join(dir, 'web', 'assets'), { recursive: true })
    writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html><title>GeckoMail</title>')
    await start()
    for (const p of ['/', '/mail/42']) {
      const r = await req('GET', p)
      expect(r.status).toBe(200)
      expect(r.body).toContain('GeckoMail')
      expect(r.headers['content-security-policy']).toBe(WEB_CSP)
      expect(r.headers['strict-transport-security']).toBe('max-age=31536000')
      expect(r.headers['cache-control']).toBe('no-cache, no-transform')
    }
    const api = await req('GET', '/api/me')
    expect(api.status).toBe(401)
    expect(api.headers['content-security-policy']).toBe(CSP)
    expect(api.headers['cache-control']).toBe('no-store')
    expect((await req('GET', '/api/nope')).headers['content-type']).toMatch(/^application\/json/)
    // /api'nin kendisi de API yolu: SPA değil, JSON 404
    for (const p of ['/api', '/api?x=1']) {
      const r = await req('GET', p)
      expect(r.status, p).toBe(404)
      expect(r.headers['content-type'], p).toMatch(/^application\/json/)
      expect(r.headers['cache-control'], p).toBe('no-store')
    }
    expect((await req('GET', '/rpc')).headers['content-security-policy']).toBe(CSP)
    expect((await req('POST', '/', { headers: { origin: ORIGIN } })).status).toBe(404)
  })

  it('login sets HttpOnly Secure SameSite=Strict cookie and body has no token', async () => {
    const id = mkUser('ali')
    await start()
    const r = await post('/api/login', { username: 'ali', password: PW })
    expect(r.status).toBe(200)
    const set = r.headers['set-cookie']!
    expect(set).toHaveLength(1)
    const parts = set[0].split(';').map((s) => s.trim())
    const token = parts[0].slice('gm_session='.length)
    expect(parts[0]).toMatch(/^gm_session=[A-Za-z0-9_-]{43}$/)
    expect(parts).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']))
    const body = JSON.parse(r.body)
    expect(Object.keys(body)).toEqual(['user'])
    expect(body.user).toMatchObject({ id, username: 'ali' })
    expect(r.body).not.toContain(token)
    expect(r.headers['cache-control']).toBe('no-store')
  })

  it('login failures map to status codes with reason only', async () => {
    mkUser('ali')
    mkUser('veli')
    await start()
    const bad = await post('/api/login', { username: 'ali', password: 'yanlis' })
    expect(bad.status).toBe(401)
    expect(JSON.parse(bad.body)).toEqual({ reason: 'bad' })
    expect(bad.headers['set-cookie']).toBeUndefined()
    q.prefSet('require2fa', '1')
    const setup = await post('/api/login', { username: 'veli', password: PW })
    expect(setup.status).toBe(428)
    expect(JSON.parse(setup.body)).toEqual({ reason: 'totpSetupRequired' })
    for (let i = 0; i < 5; i++) await post('/api/login', { username: 'ali', password: 'yanlis' })
    const locked = await post('/api/login', { username: 'ali', password: PW })
    expect(locked.status).toBe(423)
    expect(JSON.parse(locked.body)).toEqual({ reason: 'locked' })
  })

  it('cross-origin login rejected 403', async () => {
    mkUser('ali')
    await start()
    expect((await post('/api/login', { username: 'ali', password: PW }, { origin: 'https://evil.example' })).status).toBe(403)
    // Origin yok: yalnız Sec-Fetch-Site: same-origin kabul
    const noOrigin = (h: Record<string, string>) =>
      req('POST', '/api/login', { headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ username: 'ali', password: PW }) })
    expect((await noOrigin({})).status).toBe(403)
    expect((await noOrigin({ 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await noOrigin({ 'sec-fetch-site': 'same-origin' })).status).toBe(200)
    // Origin uyuşmuyorsa Sec-Fetch-Site kurtarmaz
    expect((await post('/api/login', { username: 'ali', password: PW }, { origin: 'null', 'sec-fetch-site': 'same-origin' })).status).toBe(403)
  })

  it('non-json post rejected 415', async () => {
    mkUser('ali')
    await start()
    const r = await req('POST', '/api/login', {
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=ali&password=x'
    })
    expect(r.status).toBe(415)
    expect((await req('POST', '/api/login', { headers: { origin: ORIGIN }, body: '{}' })).status).toBe(415)
    expect((await post('/api/login', { username: 'ali', password: PW }, { 'content-type': 'application/json; charset=utf-8' })).status).toBe(200)
  })

  it('oversized or malformed body rejected', async () => {
    await start()
    const big = await post('/api/login', { username: 'ali', password: 'x'.repeat(17 * 1024) })
    expect(big.status).toBe(413)
    const bad = await req('POST', '/api/login', { headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{nope' })
    expect(bad.status).toBe(400)
    expect(bad.body).not.toMatch(/at .*\.ts|SyntaxError/)
    expect((await post('/api/login', ['dizi'])).status).toBe(400)
    expect((await post('/api/login', { username: 1, password: PW })).status).toBe(400)
  })

  it('düz http yerel kökende çerez Secure değil (Linux WebKit saklamaz); gerisi aynı', async () => {
    const local = 'http://127.0.0.1:8080'
    await start(undefined, undefined, local)
    mkUser('ali')
    const r = await post('/api/login', { username: 'ali', password: PW }, { origin: local })
    expect(r.status).toBe(200)
    const set = r.headers['set-cookie']![0]
    expect(set).not.toContain('Secure')
    expect(set).toContain('HttpOnly')
    expect(set).toContain('SameSite=Strict')
  })

  it('me returns user with cookie, 401 without', async () => {
    const id = mkUser('ali')
    await start()
    expect((await req('GET', '/api/me')).status).toBe(401)
    expect((await req('GET', '/api/me', { headers: { cookie: 'gm_session=uydurma' } })).status).toBe(401)
    const cookie = await loginCookie('ali')
    const r = await req('GET', '/api/me', { headers: { cookie: `diger=1; ${cookie}` } })
    expect(String(r.headers['set-cookie'])).toMatch(/gm_session=[^;]+; HttpOnly.*SameSite=Strict; Path=\/; Max-Age=\d+/)
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body).user).toMatchObject({ id, username: 'ali' })
  })

  it('me 401 tells whether first admin setup is required', async () => {
    await start()
    const empty = await req('GET', '/api/me')
    expect(empty.status).toBe(401)
    expect(JSON.parse(empty.body)).toEqual({ reason: 'unauthenticated', setupRequired: true })
    mkUser('ali')
    const some = await req('GET', '/api/me', { headers: { cookie: 'gm_session=uydurma' } })
    expect(some.status).toBe(401)
    expect(JSON.parse(some.body)).toEqual({ reason: 'unauthenticated', setupRequired: false })
  })

  it('logout clears cookie, deletes session and closes its sockets', async () => {
    mkUser('ali')
    await start()
    const c1 = await loginCookie('ali')
    const c2 = await loginCookie('ali')
    const ws1 = openWs({ origin: ORIGIN, cookie: c1 })
    const ws2 = openWs({ origin: ORIGIN, cookie: c2 })
    await Promise.all([wsOpen(ws1), wsOpen(ws2)])
    const closed = wsClosed(ws1)
    // çapraz kaynaklı çıkış reddedilir
    expect((await post('/api/logout', {}, { cookie: c1, origin: 'https://evil.example' })).status).toBe(403)
    const r = await post('/api/logout', {}, { cookie: c1 })
    expect(r.status).toBe(204)
    expect(r.headers['set-cookie']![0]).toMatch(/^gm_session=;.*Max-Age=0/)
    expect(r.headers['set-cookie']![0]).toContain('; Secure') // https kökeninde temizleyen çerez de Secure
    expect(await closed).toBe(4401)
    expect((await req('GET', '/api/me', { headers: { cookie: c1 } })).status).toBe(401)
    // diğer oturum etkilenmez
    expect(ws2.readyState).toBe(WebSocket.OPEN)
    expect((await req('GET', '/api/me', { headers: { cookie: c2 } })).status).toBe(200)
  })

  it('ws without cookie gets 401', async () => {
    mkUser('ali')
    await start()
    expect(await wsRejected(openWs({ origin: ORIGIN }))).toBe(401)
    expect(await wsRejected(openWs({ origin: ORIGIN, cookie: 'gm_session=uydurma' }))).toBe(401)
    expect(hub.sessions()).toHaveLength(0)
  })

  it('ws cross-origin or wrong path rejected', async () => {
    mkUser('ali')
    await start()
    const cookie = await loginCookie('ali')
    expect(await wsRejected(openWs({ origin: 'https://evil.example', cookie }))).toBe(403)
    expect(await wsRejected(openWs({ cookie }))).toBe(403)
    expect(await wsRejected(openWs({ origin: ORIGIN, cookie }, '/baska'))).toBe(404)
    expect(hub.sessions()).toHaveLength(0)
  })

  it('ws with cookie can call getAccounts', async () => {
    const id = mkUser('ali')
    await start()
    const cookie = await loginCookie('ali')
    const ws = openWs({ origin: ORIGIN, cookie })
    await wsOpen(ws)
    expect(await call(ws, 1, 'getAccounts')).toEqual({ id: 1, ok: true, result: [] })
    const [s] = hub.sessions()
    expect(s.currentUser?.id).toBe(id)
    expect(s.webSessionId).toMatch(/^[0-9a-f]{64}$/)
    expect(s.ip).toBe('127.0.0.1')
    // masaüstüne özgü yöntem sunucuda kapalı
    expect((await call(ws, 2, 'login', { username: 'ali', password: PW })).ok).toBe(false)
  })

  it('revoked session closes socket on revalidation (4401)', async () => {
    mkUser('ali')
    await start(50)
    const cookie = await loginCookie('ali')
    const ws = openWs({ origin: ORIGIN, cookie })
    await wsOpen(ws)
    const closed = wsClosed(ws)
    // çerez HTTP katmanı dışında silinir (ör. süre doldu): yeniden doğrulama soketi kapatır
    auth.logout(cookie.slice('gm_session='.length))
    expect(await closed).toBe(4401)
    await new Promise((r) => setTimeout(r, 20))
    expect(hub.sessions()).toHaveLength(0)
  })

  it('revalidation refreshes group permissions of open sockets', async () => {
    const memberId = mkUser('uye')
    const acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    const g = q.insertGroup('A', '#111111')
    q.setAccountGroup(acc, g)
    q.setGroupPermission(memberId, g, true, false)
    await start(50)
    const ws = openWs({ origin: ORIGIN, cookie: await loginCookie('uye') })
    await wsOpen(ws)
    const r1 = await call(ws, 1, 'getAccounts')
    expect((r1.result as { id: number }[]).map((a) => a.id)).toEqual([acc])
    // yönetici üyeyi gruptan çıkarır (oturum iptali olmadan)
    q.setGroupPermission(memberId, g, false, false)
    await new Promise((r) => setTimeout(r, 150))
    expect(hub.sessions()[0].currentUser?.permittedGroupIds).toEqual([])
    expect(await call(ws, 2, 'getAccounts')).toEqual({ id: 2, ok: true, result: [] })
    expect(ws.readyState).toBe(WebSocket.OPEN)
  })

  it('server close terminates open sockets', async () => {
    mkUser('ali')
    await start(50)
    const ws = openWs({ origin: ORIGIN, cookie: await loginCookie('ali') })
    await wsOpen(ws)
    const closed = wsClosed(ws)
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    await closed
    // istemcinin close olayı sunucu tarafındaki oturum silinmeden gelebilir
    await vi.waitFor(() => expect(hub.sessions()).toHaveLength(0))
  })

  it('heartbeat terminates socket that misses a pong', async () => {
    mkUser('ali')
    mkUser('veli')
    await start(60_000, 40)
    const live = openWs({ origin: ORIGIN, cookie: await loginCookie('ali') })
    // ping'lere yanıt vermeyen istemci (kopmuş bağlantı gibi)
    const dead = openWs({ origin: ORIGIN, cookie: await loginCookie('veli') }, '/rpc', false)
    await Promise.all([wsOpen(live), wsOpen(dead)])
    const closed = wsClosed(dead)
    expect(hub.sessions()).toHaveLength(2)
    // terminate: kapanış çerçevesi yok (1006)
    expect(await closed).toBe(1006)
    await vi.waitFor(() => expect(hub.sessions().map((s) => s.currentUser?.username)).toEqual(['ali']))
    // pong veren soket birkaç aralık sonra da açık
    await new Promise((r) => setTimeout(r, 200))
    expect(live.readyState).toBe(WebSocket.OPEN)
    expect(await call(live, 1, 'getAccounts')).toEqual({ id: 1, ok: true, result: [] })
  })

  it('genel istek süresi kapalı, başlık süresi yerinde; süreler yol başına', async () => {
    await start()
    expect(server.requestTimeout).toBe(0)
    expect(server.headersTimeout).toBeGreaterThan(0)
  })

  /** Bildirilen gövdeyi göndermeyen istemci: bağlantı kapanana dek gelen her şey */
  const silentBody = (path: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const c = connect(port, '127.0.0.1')
      let out = ''
      c.write(`POST ${path} HTTP/1.1\r\nhost: x\r\norigin: ${ORIGIN}\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"yar`)
      c.on('data', (d) => (out += d.toString()))
      c.on('close', () => resolve(out))
      c.on('error', reject)
    })

  it('JSON gövdesi süresinde gelmezse 408, bağlantı kapanır', async () => {
    await start(undefined, undefined, ORIGIN, { jsonMs: 50 })
    const out = await silentBody('/api/login')
    expect(out).toMatch(/^HTTP\/1\.1 408 /)
    expect(out).toContain('"timeout"')
  })

  it('gövdesi okunmayan yanıttan sonra susan istemcinin bağlantısı kesilir', async () => {
    await start(undefined, undefined, ORIGIN, { unreadGraceMs: 50 })
    expect(await silentBody('/api/yok')).toMatch(/^HTTP\/1\.1 404 /)
  })

  it('readJson süre dolunca 408 döner', async () => {
    const r = new PassThrough() as unknown as IncomingMessage & PassThrough
    Object.assign(r, { headers: {} })
    expect(await readJson(r, false, 20)).toEqual({ ok: false, status: 408 })
  })

  it('aborted request body settles readJson', async () => {
    const r = new PassThrough() as unknown as IncomingMessage & PassThrough
    Object.assign(r, { headers: {} })
    const p = readJson(r)
    r.write('{"username":')
    r.destroy()
    expect(await p).toEqual({ ok: false, status: 400 })
  })

  it('changeOwnPassword ends the other sessions and their push devices, keeps the current one', async () => {
    const id = mkUser('ali')
    await start()
    const c1 = await loginCookie('ali')
    const c2 = await loginCookie('ali')
    const hash = (c: string): string => createHash('sha256').update(c.split('=')[1]).digest('hex')
    const dev = (c: string, n: string): number => q.upsertPushDevice({ userId: id, sessionId: hash(c), endpoint: `https://fcm.googleapis.com/${n}`, p256dh: 'p', auth: 'a', label: null, now: 1 })
    const keptDev = dev(c1, 'bir')
    dev(c2, 'iki')
    const ws1 = openWs({ origin: ORIGIN, cookie: c1 })
    const ws2 = openWs({ origin: ORIGIN, cookie: c2 })
    await Promise.all([wsOpen(ws1), wsOpen(ws2)])
    const closed = wsClosed(ws2)
    expect(await call(ws1, 1, 'changeOwnPassword', { currentPassword: PW, newPassword: 'yeni-parola-12' })).toMatchObject({ ok: true })
    expect(await closed).toBe(4401)
    expect(ws1.readyState).toBe(WebSocket.OPEN)
    expect((await req('GET', '/api/me', { headers: { cookie: c1 } })).status).toBe(200)
    expect((await req('GET', '/api/me', { headers: { cookie: c2 } })).status).toBe(401)
    expect(q.listPushDevices(id).map((d) => d.id)).toEqual([keptDev])
  })

  it('disabled user socket closes immediately (4401)', async () => {
    mkUser('admin', 'admin')
    const memberId = mkUser('uye')
    // yeniden doğrulama beklenmez: kapanış revokeUser'dan gelmeli
    await start(60_000)
    const admin = openWs({ origin: ORIGIN, cookie: await loginCookie('admin') })
    const memberCookie = await loginCookie('uye')
    const member = openWs({ origin: ORIGIN, cookie: memberCookie })
    await Promise.all([wsOpen(admin), wsOpen(member)])
    const closed = wsClosed(member)
    expect(await call(admin, 1, 'updateUser', { userId: memberId, patch: { enabled: false } })).toMatchObject({ ok: true })
    expect(await closed).toBe(4401)
    expect(admin.readyState).toBe(WebSocket.OPEN)
    expect((await req('GET', '/api/me', { headers: { cookie: memberCookie } })).status).toBe(401)
  })

  it('forced 2fa setup over http sets cookie on confirm', async () => {
    const id = mkUser('ali')
    q.prefSet('require2fa', '1')
    await start()
    expect((await post('/api/2fa/setup/begin', { username: 'ali', password: PW }, { origin: 'https://evil.example' })).status).toBe(403)
    expect(
      (await req('POST', '/api/2fa/setup/begin', { headers: { origin: ORIGIN, 'content-type': 'text/plain' }, body: '{}' })).status
    ).toBe(415)
    expect((await post('/api/2fa/setup/begin', { username: 'ali', password: 'yanlis' })).status).toBe(401)
    const b = await post('/api/2fa/setup/begin', { username: 'ali', password: PW })
    expect(b.status).toBe(200)
    expect(b.headers['set-cookie']).toBeUndefined()
    expect(b.headers['cache-control']).toBe('no-store')
    const { otpauthUri, secretBase32 } = JSON.parse(b.body)
    expect(otpauthUri).toContain(secretBase32)
    const secret = base32Decode(secretBase32)
    const code = totpCode(secret, Date.now() / 1000)
    const wrong = code === '000000' ? '111111' : '000000'
    const bad = await post('/api/2fa/setup/confirm', { username: 'ali', password: PW, code: wrong })
    expect(bad.status).toBe(401)
    expect(JSON.parse(bad.body)).toEqual({ reason: 'totpBad' })
    const ok = await post('/api/2fa/setup/confirm', { username: 'ali', password: PW, code })
    expect(ok.status).toBe(200)
    expect(Object.keys(JSON.parse(ok.body))).toEqual(['user'])
    expect(ok.headers['set-cookie']![0]).toMatch(/^gm_session=[A-Za-z0-9_-]{43}; .*HttpOnly/)
    expect(JSON.parse((await req('GET', '/api/me', { headers: { cookie: cookieOf(ok) } })).body).user.id).toBe(id)
    // etkin 2FA varken kurulum yeniden başlamaz
    const again = await post('/api/2fa/setup/begin', { username: 'ali', password: PW })
    expect(again.status).toBe(409)
    expect(JSON.parse(again.body)).toEqual({ reason: 'notRequired' })
  })

  it('responses carry enforced CSP', async () => {
    await start()
    // API/sağlık yanıtları API CSP'siyle; kök altındaki diğer yollar web istemcisinin (sayfa CSP'si, ayrı test)
    for (const r of [await req('GET', '/healthz'), await req('GET', '/api/yok'), await post('/api/login', {}, { origin: 'https://evil.example' })]) {
      expect(r.headers['content-security-policy']).toBe(
        "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
      )
      expect(r.headers['content-security-policy-report-only']).toBeUndefined()
      expect(r.headers['x-content-type-options']).toBe('nosniff')
      expect(r.headers['referrer-policy']).toBe('no-referrer')
      expect(r.headers['strict-transport-security']).toBe('max-age=31536000')
    }
    const page = await req('GET', '/yok')
    expect(page.status).toBe(404)
    expect(page.headers['content-security-policy']).toBe(WEB_CSP)
    expect(page.headers['strict-transport-security']).toBe('max-age=31536000')
  })

  it('clientIp honours trusted depth', () => {
    const fake = (xff?: string) =>
      ({ socket: { remoteAddress: '10.9.9.9' }, headers: xff == null ? {} : { 'x-forwarded-for': xff } }) as unknown as IncomingMessage
    expect(clientIp(fake('1.1.1.1, 2.2.2.2'), 0)).toBe('10.9.9.9')
    expect(clientIp(fake('1.1.1.1, 2.2.2.2'), 1)).toBe('2.2.2.2')
    expect(clientIp(fake('1.1.1.1, 2.2.2.2'), 2)).toBe('1.1.1.1')
    // eksik girdi: soket adresi
    expect(clientIp(fake('1.1.1.1, 2.2.2.2'), 3)).toBe('10.9.9.9')
    expect(clientIp(fake(), 1)).toBe('10.9.9.9')
    expect(clientIp(fake(' , '), 1)).toBe('10.9.9.9')
  })
})

describe('configFromEnv', () => {
  it('defaults', () => {
    expect(configFromEnv({ GECKO_PUBLIC_ORIGIN: 'https://posta.example.com/' })).toEqual({
      dataDir: '/data', listenHost: '0.0.0.0', listenPort: 8080, keyFile: '/data/master.key',
      publicOrigin: 'https://posta.example.com', trustedProxyDepth: 0, idleMax: 40, davPrivateHosts: [], mailPrivateHosts: [], mobileEnabled: true, relayUrl: 'https://relay.kodviva.com',
      webDir: expect.stringMatching(/[\\/]web$/)
    })
  })

  it('reads all variables', () => {
    expect(
      configFromEnv({
        GECKO_DATA_DIR: '/srv/g', GECKO_LISTEN: '[::]:9000', GECKO_KEY_FILE: '/run/k', GECKO_PUBLIC_ORIGIN: 'http://localhost:9000',
        GECKO_TRUSTED_PROXY_DEPTH: '1', GECKO_IDLE_MAX: '40', GECKO_WEB_DIR: '/srv/web', GECKO_MOBILE: '0'
      })
    ).toEqual({
      dataDir: '/srv/g', listenHost: '::', listenPort: 9000, keyFile: '/run/k', publicOrigin: 'http://localhost:9000', trustedProxyDepth: 1,
      idleMax: 40, davPrivateHosts: [], mailPrivateHosts: [], mobileEnabled: false, relayUrl: 'https://relay.kodviva.com', webDir: '/srv/web'
    })
  })

  it('GECKO_MOBILE yalnız 0 ya da 1', () => {
    expect(() => configFromEnv({ GECKO_PUBLIC_ORIGIN: 'https://posta.example.com', GECKO_MOBILE: 'evet' })).toThrow('GECKO_MOBILE')
  })

  it('error text hints at origin only for origin errors', () => {
    const msg = (env: NodeJS.ProcessEnv): string => {
      try {
        configFromEnv(env)
      } catch (e) {
        return configErrorText((e as Error).message)
      }
      throw new Error('hata beklenirdi')
    }
    expect(msg({})).toContain('GECKO_PUBLIC_ORIGIN zorunlu')
    const listen = msg({ GECKO_PUBLIC_ORIGIN: ORIGIN, GECKO_LISTEN: 'x' })
    expect(listen).toContain('GECKO_LISTEN')
    expect(listen).not.toContain('GECKO_PUBLIC_ORIGIN')
  })

  it('accepts http only for loopback hosts', () => {
    for (const o of ['http://localhost:9000', 'http://127.0.0.1:8080', 'http://[::1]:8080', 'http://LOCALHOST']) {
      expect(configFromEnv({ GECKO_PUBLIC_ORIGIN: o }).publicOrigin).toBe(new URL(o).origin)
    }
  })

  it('rejects missing or invalid values', () => {
    expect(() => configFromEnv({})).toThrow('GECKO_PUBLIC_ORIGIN')
    expect(() => configFromEnv({ GECKO_PUBLIC_ORIGIN: 'posta.example.com' })).toThrow('GECKO_PUBLIC_ORIGIN')
    expect(() => configFromEnv({ GECKO_PUBLIC_ORIGIN: 'https://posta.example.com/yol' })).toThrow('GECKO_PUBLIC_ORIGIN')
    expect(() => configFromEnv({ GECKO_PUBLIC_ORIGIN: 'ftp://x' })).toThrow('GECKO_PUBLIC_ORIGIN')
    // düz http yalnız yerel ana makinede: oturum çerezi orada Secure taşımaz, başka adreste açıkta giderdi
    expect(() => configFromEnv({ GECKO_PUBLIC_ORIGIN: 'http://posta.example.com' })).toThrow('GECKO_PUBLIC_ORIGIN')
    expect(() => configFromEnv({ GECKO_PUBLIC_ORIGIN: 'http://10.0.0.5:8080' })).toThrow('GECKO_PUBLIC_ORIGIN')
    expect(() => configFromEnv({ GECKO_PUBLIC_ORIGIN: 'http://localhost.example.com' })).toThrow('GECKO_PUBLIC_ORIGIN')
    expect(() => configFromEnv({ GECKO_PUBLIC_ORIGIN: ORIGIN, GECKO_LISTEN: '0.0.0.0:99999' })).toThrow('GECKO_LISTEN')
    expect(() => configFromEnv({ GECKO_PUBLIC_ORIGIN: ORIGIN, GECKO_LISTEN: '8080' })).toThrow('GECKO_LISTEN')
    expect(() => configFromEnv({ GECKO_PUBLIC_ORIGIN: ORIGIN, GECKO_TRUSTED_PROXY_DEPTH: '-1' })).toThrow('GECKO_TRUSTED_PROXY_DEPTH')
    expect(() => configFromEnv({ GECKO_PUBLIC_ORIGIN: ORIGIN, GECKO_TRUSTED_PROXY_DEPTH: 'x' })).toThrow('GECKO_TRUSTED_PROXY_DEPTH')
    expect(() => configFromEnv({ GECKO_PUBLIC_ORIGIN: ORIGIN, GECKO_IDLE_MAX: '0' })).toThrow('GECKO_IDLE_MAX')
    expect(() => configFromEnv({ GECKO_PUBLIC_ORIGIN: ORIGIN, GECKO_IDLE_MAX: 'x' })).toThrow('GECKO_IDLE_MAX')
    expect(configFromEnv({ GECKO_PUBLIC_ORIGIN: ORIGIN, GECKO_IDLE_MAX: '75' }).idleMax).toBe(75)
  })
})
