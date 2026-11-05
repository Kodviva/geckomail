// Uçtan uca: gerçek HTTP kaydı → gerçek PushSink → gerçek geckomail-relay → sahte APNs/FCM. Yakalanan kutu yalnız cihaz
// anahtarıyla açılır; rölenin gördüğü her şey seviye ve içerikten bağımsızdır.
import { createECDH, generateKeyPairSync, randomBytes, type ECDH } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import http from 'http'
import http2 from 'http2'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apnsBody, createApns, type ApnsSender } from '../../relay/apns'
import { fcmBody } from '../../relay/fcm'
import { createRelayServer } from '../../relay/server'
import { RelayStore } from '../../relay/store'
import '../../shared/i18n/locales/all'
import { NATIVE_PAD_TO, type NativePayload } from '../../shared/nativePush'
import type { PushItem, PushPayload } from '../../shared/pushTypes'
import { RELAY_MAX_CIPHERTEXT } from '../../shared/relayProtocol'
import { hashPassword } from '../../sync/auth/password'
import { openDb } from '../../sync/db'
import { makeQueries } from '../../sync/db/queries'
import { pushTransport } from '../../sync/db/q/pushDevices'
import { t as tr } from '../../shared/i18n'
import { sessionUserFromRow } from '../../sync/auth/sessionUser'
import type { OpQueue } from '../../sync/opQueue'
import { RpcHub, type RpcServerDeps } from '../../sync/rpcHub'
import type { Scheduler } from '../../sync/scheduler'
import { SESSION_IDLE_MS, tokenHash, WebAuth } from '../auth'
import type { ServerConfig } from '../config'
import { createServerHost } from '../hosts/serverHost'
import { createHttpServer } from '../http'
import { parseNativeDevice, PushSink, vapidLoader } from '../pushDevices'
import { RelayClient, relayKeyLoader } from '../relayClient'
import { decryptPush } from './pushTestUtil'

const ORIGIN = 'https://posta.example.com'
const IOS = 'capacitor://localhost'
const PW = 'dogru-parola-1'
const APNS_TOKEN = 'a'.repeat(64)
const FCM_TOKEN = 'f'.repeat(163)
const DAY = 24 * 3600_000

interface Res { status: number; body: string }
interface Device { ecdh: ECDH; authKey: Buffer; p256dh: string; auth: string }
function newDevice(): Device {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const authKey = randomBytes(16)
  return { ecdh, authKey, p256dh: ecdh.getPublicKey().toString('base64url'), auth: authKey.toString('base64url') }
}
const item = (over: Partial<PushItem> = {}): PushItem => ({
  title: 'Ayşe Öztürk 😀', body: 'gizli konu şğü', accountId: null, messageId: 42, level: 'normal', tag: 'm42', count: 1, ...over
})
const open = (c: string, d: Device): NativePayload =>
  JSON.parse(decryptPush(Buffer.from(c, 'base64url'), d.ecdh, d.authKey).toString('utf-8')) as NativePayload

describe('motordan röleye teslim', () => {
  let t: number
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let auth: WebAuth
  let host: ReturnType<typeof createServerHost>
  let server: http.Server
  let relayServer: http.Server
  let port: number
  let apnsServer: http2.Http2Server
  let apns: ApnsSender
  let store: RelayStore
  let client: RelayClient
  let sink: PushSink
  let seen: { headers: http2.IncomingHttpHeaders; body: string }[]
  let fcmSeen: string[]
  let reply: { status: number; body?: string }
  let relayRequests: { headers: http.IncomingHttpHeaders; body: string }[]
  const now = (): number => t

  const startSink = (o: { relay?: RelayClient | null; fetch?: typeof fetch } = {}): PushSink => {
    const relay = o.relay === undefined ? client : o.relay
    sink = new PushSink({ q, keys: vapidLoader(q, host), subject: 'mailto:x@y.z', broadcast: () => {}, relay, now, retryMs: 5, fetch: o.fetch })
    return sink
  }
  const start = async (o: { relay?: RelayClient | null; mobileEnabled?: boolean } = {}): Promise<void> => {
    const cfg: ServerConfig = {
      dataDir: dir, listenHost: '127.0.0.1', listenPort: 0, keyFile: join(dir, 'k'), publicOrigin: ORIGIN, trustedProxyDepth: 0, webDir: join(dir, 'web'),
      mobileEnabled: o.mobileEnabled
    }
    server = createHttpServer({ cfg, hub, auth, now, relay: o.relay === undefined ? client : o.relay })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  }

  beforeEach(async () => {
    t = Date.now()
    seen = []
    fcmSeen = []
    relayRequests = []
    reply = { status: 200 }
    dir = mkdtempSync(join(tmpdir(), 'gecko-relaye2e-'))
    db = openDb(dir)
    q = makeQueries(db)
    host = createServerHost(randomBytes(32), () => hub)
    const stub = new Proxy({}, { get: () => () => undefined })
    const deps: RpcServerDeps = {
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: (v) => host.encrypt(v),
      decrypt: async (b) => (await host.decrypt(b)).map((u) => Buffer.from(u).toString('utf-8')),
      userData: dir, dbSchemaVersion: () => 0
    }
    hub = new RpcHub(deps, 'server')
    auth = new WebAuth(q, host, now)

    apnsServer = http2.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString() })
        res.writeHead(reply.status)
        res.end(reply.body ?? '')
      })
    })
    await new Promise<void>((r) => apnsServer.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(apnsServer.address() as AddressInfo).port}`
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    apns = createApns({ key: privateKey, keyId: 'KID', teamId: 'TEAM', topic: 'com.kodviva.geckomail', bases: { production: base, sandbox: base } })
    store = new RelayStore(':memory:')
    const relayCfg = { listenHost: '127.0.0.1', listenPort: 0, dataDir: '/yok', trustedProxyDepth: 0, publicHost: '' }
    const relayHandler = createRelayServer({
      cfg: relayCfg, store, apns,
      fcm: async (_d, c) => {
        fcmSeen.push(c)
        return 'ok'
      }
    })
    // rölenin gördüğü istekler kaydedilir: içerik ve seviye sızıntısı testi
    relayServer = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      const forward = http.request(
        { host: '127.0.0.1', port: (relayHandler.address() as AddressInfo).port, method: req.method, path: req.url, headers: req.headers },
        (up) => {
          res.writeHead(up.statusCode!, up.headers)
          up.pipe(res)
        }
      )
      req.on('data', (c: Buffer) => {
        chunks.push(c)
        forward.write(c)
      })
      req.on('end', () => {
        relayRequests.push({ headers: req.headers, body: Buffer.concat(chunks).toString() })
        forward.end()
      })
    })
    await new Promise<void>((r) => relayHandler.listen(0, '127.0.0.1', r))
    await new Promise<void>((r) => relayServer.listen(0, '127.0.0.1', r))
    relayServer.on('close', () => {
      relayHandler.close()
      relayHandler.closeAllConnections()
    })
    relayCfg.publicHost = `127.0.0.1:${(relayServer.address() as AddressInfo).port}`
    client = new RelayClient({ url: `http://${relayCfg.publicHost}`, keys: relayKeyLoader(q, host) })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    sink?.close()
    if (server?.listening) await new Promise<void>((r) => server.close(() => r()))
    apns.close()
    await new Promise<void>((r) => relayServer.close(() => r()))
    relayServer.closeAllConnections()
    await new Promise<void>((r) => apnsServer.close(() => r()))
    store.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const mkUser = (username: string): number => q.insertUser({ username, passwordHash: hashPassword(PW), role: 'member' })
  const req = (method: string, path: string, o: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...o.headers } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }))
      })
      r.on('error', reject)
      if (o.body !== undefined) r.write(JSON.stringify(o.body))
      r.end()
    })
  const login = async (username: string): Promise<{ token: string; access: string; id: string }> => {
    const l = await req('POST', '/api/mobile/login', { body: { username, password: PW } })
    expect(l.status).toBe(200)
    const { token } = JSON.parse(l.body) as { token: string }
    const a = await req('POST', '/api/mobile/token', { headers: { authorization: `Bearer ${token}` } })
    expect(a.status).toBe(200)
    return { token, access: (JSON.parse(a.body) as { accessToken: string }).accessToken, id: tokenHash(token) }
  }
  const bearer = (access: string): Record<string, string> => ({ authorization: `Bearer ${access}`, origin: IOS })
  const register = (access: string, d: Device, over: Record<string, unknown> = {}): Promise<Res> =>
    req('POST', '/api/mobile/device', {
      headers: bearer(access),
      body: { platform: 'ios', env: 'production', token: APNS_TOKEN, p256dh: d.p256dh, auth: d.auth, label: 'iPhone', ...over }
    })
  const enrolled = async (username = 'ali', d = newDevice()): Promise<{ uid: number; id: number; d: Device; session: Awaited<ReturnType<typeof login>> }> => {
    const uid = mkUser(username)
    const session = await login(username)
    const r = await register(session.access, d)
    expect(r.status).toBe(200)
    return { uid, id: (JSON.parse(r.body) as { id: number }).id, d, session }
  }
  const pushedApns = async (count: number): Promise<string[]> => {
    await vi.waitFor(() => expect(seen).toHaveLength(count))
    return seen.map((s) => (JSON.parse(s.body) as { c: string }).c)
  }

  it('relayE2e: PushSink → röle → APNs, kutu cihaz anahtarıyla açılır', async () => {
    await start()
    const { uid, d } = await enrolled()
    startSink().deliver(uid, [item()])
    const [c] = await pushedApns(1)
    const p = open(c, d)
    expect(p).toEqual({
      v: 1, title: 'Ayşe Öztürk 😀', body: 'gizli konu şğü', accountId: null, messageId: 42, level: 'normal', tag: expect.stringMatching(/^[0-9a-f]{16}$/),
      count: 1, ts: t, actions: ['read']
    })
  })

  it('android cihazı FCM yoluna gider', async () => {
    await start()
    const uid = mkUser('ali')
    const s = await login('ali')
    const d = newDevice()
    const r = await register(s.access, d, { platform: 'android', token: FCM_TOKEN })
    expect(r.status).toBe(200)
    expect(q.listPushDevices(uid).map(pushTransport)).toEqual(['fcm'])
    startSink().deliver(uid, [item()])
    await vi.waitFor(() => expect(fcmSeen).toHaveLength(1))
    expect(open(fcmSeen[0], d).title).toBe('Ayşe Öztürk 😀')
  })

  it('relay sees no plaintext', async () => {
    await start()
    const { uid } = await enrolled()
    startSink().deliver(uid, [item({ title: 'GIZLIBASLIK', body: 'GIZLIGOVDE', accountId: 7 })])
    const [c] = await pushedApns(1)
    expect(relayRequests.some((r) => r.body.includes(c))).toBe(true)
    for (const r of relayRequests) {
      const all = `${r.body} ${JSON.stringify(r.headers)}`
      for (const secret of ['GIZLIBASLIK', 'GIZLIGOVDE', '"accountId"', '"level"', '"messageId"']) expect(all).not.toContain(secret)
    }
    for (const secret of ['GIZLIBASLIK', 'GIZLIGOVDE']) expect(Buffer.from(c, 'base64url').toString('latin1')).not.toContain(secret)
    expect(seen[0].body).not.toContain('GIZLI')
  })

  it('cihaz belirteci motorda saklanmaz', async () => {
    await start()
    const { uid } = await enrolled()
    const dump = JSON.stringify(db.prepare('SELECT * FROM push_devices').all())
    expect(dump).not.toContain(APNS_TOKEN)
    const [row] = q.listPushDevices(uid)
    expect(row.endpoint).toMatch(/^relay:[A-Za-z0-9_-]+$/)
    expect(pushTransport(row)).toBe('apns')
    expect(row.web_session_id).not.toBeNull()
  })

  it('envelope within 4096 bytes', async () => {
    await start()
    const { uid } = await enrolled()
    const worst = '😀"\\\u0001ğ'.repeat(4000)
    startSink().deliver(uid, [item({ title: worst, body: worst, accountId: Number.MAX_SAFE_INTEGER, messageId: Number.MAX_SAFE_INTEGER, count: 99999, level: 'urgent' })])
    const [c] = await pushedApns(1)
    expect(c.length).toBeLessThanOrEqual(RELAY_MAX_CIPHERTEXT)
    expect(Buffer.byteLength(apnsBody(c))).toBeLessThanOrEqual(4096)
    expect(Buffer.byteLength(fcmBody(FCM_TOKEN, c))).toBeLessThanOrEqual(4096)
  })

  it('all ciphertexts same length', async () => {
    await start()
    const { uid } = await enrolled()
    startSink().deliver(uid, [item({ title: 'a', body: '' }), item({ title: 'ş'.repeat(3000), body: 'ğ'.repeat(3000), tag: 'b' }), item({ title: '', body: '😀', tag: 'c', messageId: null })])
    const cs = await pushedApns(3)
    expect(new Set(cs.map((c) => c.length)).size).toBe(1)
    expect(Buffer.from(cs[0], 'base64url').length).toBe(86 + NATIVE_PAD_TO + 1 + 16)
  })

  it('vault account payload stripped on native', async () => {
    await start()
    const { uid, d } = await enrolled()
    const acc = q.insertAccount({ email: 'gizli@t.co', displayName: null, imapHost: 'm', imapPort: 993, smtpHost: 'm', smtpPort: 465, passwordEnc: Buffer.from('x') })
    q.setAccountSecureFlag(acc, true)
    startSink().deliver(uid, [item({ accountId: acc, title: 'gizli@t.co', body: 'kasa konusu' })])
    const [c] = await pushedApns(1)
    const p = open(c, d)
    expect(p.body).toBe('')
    expect(p.title).not.toContain('gizli')
  })

  it('urgent and normal indistinguishable at relay', async () => {
    await start()
    const { uid, d } = await enrolled()
    startSink().deliver(uid, [item({ level: 'normal', tag: 'a' }), item({ level: 'urgent', tag: 'b' })])
    const cs = await pushedApns(2)
    expect(cs.map((c) => open(c, d).level)).toEqual(['normal', 'urgent'])
    expect(cs[0].length).toBe(cs[1].length)
    const strip = (h: http2.IncomingHttpHeaders): Record<string, unknown> => {
      const { authorization: _a, 'content-length': _b, ...rest } = h
      return rest
    }
    expect(strip(seen[0].headers)).toEqual(strip(seen[1].headers))
    const shape = relayRequests.filter((r) => r.body.includes('"c"')).map((r) => Object.keys(r.headers).sort())
    expect(shape[0]).toEqual(shape[1])
  })

  it('reregister after idle moves device', async () => {
    await start()
    const { uid, session: old, d } = await enrolled()
    const before = q.listPushDevices(uid)
    t += 8 * DAY
    auth.sweepExpired()
    expect(q.getWebSession(old.id)).toBeDefined() // push cihazı oturumu tutar
    const fresh = await login('ali')
    expect((await register(fresh.access, d)).status).toBe(200)
    const after = q.listPushDevices(uid)
    expect(after).toHaveLength(1)
    expect(after[0].endpoint).toBe(before[0].endpoint)
    expect(after[0].web_session_id).toBe(fresh.id)
    auth.sweepExpired()
    expect(q.getWebSession(old.id)).toBeUndefined()
    expect(q.listPushDevices(uid)).toHaveLength(1)
    expect(t - before[0].created_at).toBeGreaterThan(SESSION_IDLE_MS)
  })

  it('jeton değişince oturumun eski röle satırı kalkar, çift bildirim gitmez', async () => {
    await start()
    const { uid, session, d } = await enrolled()
    expect((await register(session.access, d, { token: 'b'.repeat(64) })).status).toBe(200)
    expect(q.listPushDevices(uid)).toHaveLength(1)
  })

  it('relay gone deletes device', async () => {
    await start()
    const { uid } = await enrolled()
    reply = { status: 410, body: JSON.stringify({ reason: 'Unregistered' }) }
    startSink().deliver(uid, [item()])
    await vi.waitFor(() => expect(q.listPushDevices(uid)).toHaveLength(0))
  })

  it('retry once then drop', async () => {
    await start()
    const { uid } = await enrolled()
    reply = { status: 503 }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    startSink().deliver(uid, [item()])
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('iki denemede gitmedi')))
    expect(seen).toHaveLength(2)
    expect(q.listPushDevices(uid)).toHaveLength(1)
  })

  it('röle kapalıyken yerel cihaz atlanır, satır kalır', async () => {
    await start()
    const { uid } = await enrolled()
    startSink({ relay: null }).deliver(uid, [item()])
    await new Promise((r) => setTimeout(r, 30))
    expect(seen).toHaveLength(0)
    expect(q.listPushDevices(uid)).toHaveLength(1)
  })

  it('member cannot delete other device', async () => {
    await start()
    const { uid, id } = await enrolled()
    mkUser('veli')
    const other = await login('veli')
    expect((await req('DELETE', `/api/push/devices/${id}`, { headers: bearer(other.access) })).status).toBe(404)
    expect(q.getPushDevice(id)).toBeDefined()
    const own = await login('ali')
    expect((await req('DELETE', `/api/push/devices/${id}`, { headers: bearer(own.access) })).status).toBe(204)
    expect(q.listPushDevices(uid)).toHaveLength(0)
  })

  it('başka oturumdan kaldırılan telefonun oturumu biter, röleden düşer', async () => {
    await start()
    const { uid, id, session } = await enrolled()
    const endpoint = q.listPushDevices(uid)[0].endpoint
    const unregister = vi.spyOn(client, 'unregister').mockRejectedValue(new Error('ağ'))
    const browser = await login('ali')
    expect((await req('DELETE', `/api/push/devices/${id}`, { headers: bearer(browser.access) })).status).toBe(204)
    expect(q.getWebSession(session.id)).toBeUndefined()
    expect(q.getPushDevice(id)).toBeUndefined()
    expect(unregister).toHaveBeenCalledWith(endpoint.slice('relay:'.length))
    expect((await req('GET', '/api/push/devices', { headers: bearer(session.access) })).status).toBe(401)
    expect((await req('POST', '/api/mobile/token', { headers: { authorization: `Bearer ${session.token}` } })).status).toBe(401)
    expect(q.getWebSession(browser.id)).toBeDefined()
  })

  it('telefon kendini kaldırınca oturum sürer: yalnız bildirim kapanır', async () => {
    await start()
    const { uid, id, session } = await enrolled()
    const unregister = vi.spyOn(client, 'unregister')
    expect((await req('DELETE', `/api/push/devices/${id}`, { headers: bearer(session.access) })).status).toBe(204)
    expect(q.getWebSession(session.id)).toBeDefined()
    expect(q.listPushDevices(uid)).toHaveLength(0)
    expect(unregister).not.toHaveBeenCalled()
  })

  describe('Oturumlarım', () => {
    const cookieSession = async (userAgent: string): Promise<{ rpc: ReturnType<RpcHub['openSession']>; id: string; ws: { sent: unknown[]; closed: boolean } }> => {
      const r = await auth.login({ username: 'ali', password: PW, ip: '1.1.1.1', userAgent })
      if (!r.ok) throw new Error('giriş')
      const id = tokenHash(r.token)
      const ws = { sent: [] as unknown[], closed: false }
      const port = { send: (m: unknown) => void ws.sent.push(m), onMessage() {}, onClose() {}, close: () => void (ws.closed = true) }
      return { rpc: hub.openSession(port, { user: r.user, webSessionId: id }), id, ws }
    }
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'

    it('liste tür, ad, son görülme ve geçerli oturumu verir; belirteç özeti çıkmaz', async () => {
      await start()
      const { session } = await enrolled()
      const web = await cookieSession(UA)
      const list = (await web.rpc.handle('listSessions', {})) as { id: string; kind: string; label: string; lastSeenAt: number; current: boolean }[]
      expect(list.map((s) => [s.kind, s.label, s.current]).sort()).toEqual([['mobile', 'iPhone', false], ['web', 'Safari · macOS', true]])
      expect(JSON.stringify(list)).not.toContain(session.id)
      expect(JSON.stringify(list)).not.toContain(web.id)
      expect(list[0].lastSeenAt).toBeGreaterThan(0)
    })

    it('kapatılan oturumun soketi kapanır, push satırı gider, röleden düşer', async () => {
      await start()
      const { uid, session } = await enrolled()
      const endpoint = q.listPushDevices(uid)[0].endpoint
      const unregister = vi.spyOn(client, 'unregister').mockResolvedValue()
      const web = await cookieSession(UA)
      const phoneWs = await cookieSession(UA) // başka oturum etkilenmez
      const list = (await web.rpc.handle('listSessions', {})) as { id: string; kind: string }[]
      expect(await web.rpc.handle('revokeSession', { id: list.find((s) => s.kind === 'mobile')!.id })).toEqual({ ok: true })
      expect(q.getWebSession(session.id)).toBeUndefined()
      expect(q.listPushDevices(uid)).toHaveLength(0)
      expect(unregister).toHaveBeenCalledWith(endpoint.slice('relay:'.length))
      expect(phoneWs.ws.closed).toBe(false)
      expect((await req('POST', '/api/mobile/token', { headers: { authorization: `Bearer ${session.token}` } })).status).toBe(401)
    })

    it('kapatılan oturumun açık soketi kapanır', async () => {
      await start()
      mkUser('ali')
      const a = await cookieSession(UA)
      const b = await cookieSession(UA)
      const other = ((await a.rpc.handle('listSessions', {})) as { id: string; current: boolean }[]).find((s) => !s.current)!
      await a.rpc.handle('revokeSession', { id: other.id })
      expect(b.ws.closed).toBe(true)
      expect(a.ws.closed).toBe(false)
    })

    it('kendi oturumu ve başkasının oturumu kapatılamaz', async () => {
      await start()
      mkUser('ali')
      const a = await cookieSession(UA)
      mkUser('veli')
      const veli = await login('veli')
      const mine = ((await a.rpc.handle('listSessions', {})) as { id: string }[])[0].id
      expect(await a.rpc.handle('revokeSession', { id: mine })).toEqual({ ok: false })
      expect(await a.rpc.handle('revokeSession', { id: veli.id.slice(0, 16) })).toEqual({ ok: false })
      expect(q.getWebSession(veli.id)).toBeDefined()
      expect(q.getWebSession(a.id)).toBeDefined()
    })

    it('diğerlerini kapat yalnız bu oturumu bırakır', async () => {
      await start()
      const { uid, session } = await enrolled()
      vi.spyOn(client, 'unregister').mockResolvedValue()
      const a = await cookieSession(UA)
      const b = await cookieSession(UA)
      expect(await a.rpc.handle('revokeOtherSessions', {})).toEqual({ count: 2 })
      expect(q.getWebSession(a.id)).toBeDefined()
      expect(q.getWebSession(session.id)).toBeUndefined()
      expect(q.getWebSession(b.id)).toBeUndefined()
      expect(b.ws.closed).toBe(true)
      expect(q.listPushDevices(uid)).toHaveLength(0)
    })

    it('biletli oturumda çalışmaz', async () => {
      await start()
      const { uid, session } = await enrolled()
      const row = q.getUserById(uid)!
      const port = { send() {}, onMessage() {}, onClose() {}, close() {} }
      const s = hub.openSession(port, { user: sessionUserFromRow(q, row), webSessionId: session.id, ticket: true })
      for (const m of ['listSessions', 'revokeSession', 'revokeOtherSessions']) await expect(s.handle(m, {}), m).rejects.toThrow(tr('sync.perm.browserRequired'))
    })
  })

  it('session end deletes device', async () => {
    await start()
    const { uid, session } = await enrolled()
    t += 31 * DAY
    auth.sweepExpired()
    expect(q.getWebSession(session.id)).toBeUndefined()
    expect(q.listPushDevices(uid)).toHaveLength(0)
  })

  it('logout cihazı siler, röleden de düşürür; hata yutulur', async () => {
    await start()
    const { uid, session } = await enrolled()
    const unregister = vi.spyOn(client, 'unregister').mockRejectedValue(new Error('ağ'))
    const endpoint = q.listPushDevices(uid)[0].endpoint
    expect((await req('POST', '/api/mobile/logout', { headers: { authorization: `Bearer ${session.token}` } })).status).toBe(204)
    expect(q.listPushDevices(uid)).toHaveLength(0)
    expect(unregister).toHaveBeenCalledWith(endpoint.slice('relay:'.length))
  })

  it('web push path unchanged', async () => {
    await start()
    const uid = mkUser('ali')
    const r = await auth.login({ username: 'ali', password: PW, ip: '1.1.1.1', userAgent: '' })
    if (!r.ok) throw new Error('giriş olmadı')
    const d = newDevice()
    q.upsertPushDevice({ userId: uid, sessionId: tokenHash(r.token), endpoint: 'https://fcm.googleapis.com/send/x', p256dh: d.p256dh, auth: d.auth, label: null, now: t })
    const bodies: Buffer[] = []
    const fake = (async (_u: string, init: RequestInit) => {
      bodies.push(Buffer.from(init.body as Uint8Array))
      return new Response(null, { status: 201 })
    }) as unknown as typeof fetch
    startSink({ fetch: fake }).deliver(uid, [item()])
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    const p = JSON.parse(decryptPush(bodies[0], d.ecdh, d.authKey).toString('utf-8')) as PushPayload
    expect(p.title).toBe('Ayşe Öztürk 😀')
    expect(p.actions[0]).toEqual({ action: 'read', title: expect.any(String) })
    expect(bodies[0].length).toBeLessThan(1000) // doldurma yalnız yerel yolda
    expect(seen).toHaveLength(0)
  })

  describe('POST /api/mobile/device', () => {
    it('hello push röle yapılandırmasını izler', async () => {
      await start()
      expect(JSON.parse((await req('GET', '/api/mobile/hello')).body)).toEqual({ product: 'geckomail', api: 1, push: true })
      await new Promise<void>((r) => server.close(() => r()))
      await start({ relay: null })
      expect(JSON.parse((await req('GET', '/api/mobile/hello')).body)).toEqual({ product: 'geckomail', api: 1, push: false })
    })

    it('röle kapalıysa 409', async () => {
      await start({ relay: null })
      mkUser('ali')
      const s = await login('ali')
      const r = await register(s.access, newDevice())
      expect(r.status).toBe(409)
      expect(JSON.parse(r.body)).toEqual({ reason: 'relayOff' })
    })

    it('röleye ulaşılamazsa 502 relayUnavailable, satır açılmaz', async () => {
      await start()
      const uid = mkUser('ali')
      const s = await login('ali')
      vi.spyOn(client, 'register').mockRejectedValue(new Error('relay.unavailable'))
      const r = await register(s.access, newDevice())
      expect(r.status).toBe(502)
      expect(JSON.parse(r.body)).toEqual({ reason: 'relayUnavailable' })
      expect(q.listPushDevices(uid)).toHaveLength(0)
    })

    it('Bearer ister: belirteçsiz 401, çerezli web isteği 401, kötü köken 403', async () => {
      await start()
      const body = { platform: 'ios', env: 'production', token: APNS_TOKEN, p256dh: 'p', auth: 'a' }
      expect((await req('POST', '/api/mobile/device', { headers: { origin: IOS }, body })).status).toBe(401)
      expect((await req('POST', '/api/mobile/device', { headers: { authorization: 'Bearer gma_yok', origin: IOS }, body })).status).toBe(401)
      expect((await req('POST', '/api/mobile/device', { headers: { authorization: 'Bearer gma_yok', origin: 'https://kotu.example' }, body })).status).toBe(403)
      mkUser('ali')
      const web = await req('POST', '/api/login', { headers: { origin: ORIGIN }, body: { username: 'ali', password: PW } })
      expect(web.status).toBe(200)
      expect((await req('POST', '/api/mobile/device', { headers: { origin: ORIGIN }, body })).status).toBe(401)
    })

    it('GECKO_MOBILE=0 iken yok', async () => {
      await start({ mobileEnabled: false })
      expect((await req('POST', '/api/mobile/device', { headers: { origin: ORIGIN }, body: {} })).status).toBe(404)
    })

    it('kayıt sırasında kapanan oturumda satır açılmaz', async () => {
      await start()
      const uid = mkUser('ali')
      const s = await login('ali')
      vi.spyOn(client, 'register').mockImplementation(async () => {
        auth.logout(s.token, 'mobile')
        return 'cihaz'
      })
      expect((await register(s.access, newDevice())).status).toBe(401)
      expect(q.listPushDevices(uid)).toHaveLength(0)
    })

    it('parseNativeDevice bozuk girdiyi reddeder', () => {
      const d = newDevice()
      const ok = { platform: 'ios', env: 'sandbox', token: APNS_TOKEN, p256dh: d.p256dh, auth: d.auth, label: 'x'.repeat(500) }
      expect(parseNativeDevice(ok)).toMatchObject({ platform: 'ios', env: 'sandbox', token: APNS_TOKEN, label: 'x'.repeat(100) })
      expect(parseNativeDevice({ ...ok, label: undefined })?.label).toBeNull()
      for (const bad of [
        { platform: 'web' }, { env: 'test' }, { token: '../x' }, { token: 'b'.repeat(40) }, { p256dh: 'AAAA' }, { auth: 'AAAA' }, { label: 5 },
        { platform: 'android', token: 'kısa' }, { token: 5 }
      ]) expect(parseNativeDevice({ ...ok, ...bad }), JSON.stringify(bad)).toBeNull()
    })
  })
})
