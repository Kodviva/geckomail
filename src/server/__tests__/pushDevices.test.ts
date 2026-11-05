import { createECDH, randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../shared/i18n/locales/all'
import type { PushItem, PushPayload } from '../../shared/pushTypes'
import { hashPassword } from '../../sync/auth/password'
import { openDb } from '../../sync/db'
import { makeQueries } from '../../sync/db/queries'
import type { OpQueue } from '../../sync/opQueue'
import { RpcHub, type RpcServerDeps } from '../../sync/rpcHub'
import type { Scheduler } from '../../sync/scheduler'
import { SESSION_IDLE_MS, SESSION_IDLE_PUSH_MS, SESSION_TTL_MS, WebAuth } from '../auth'
import type { ServerConfig } from '../config'
import { createServerHost } from '../hosts/serverHost'
import { createHttpServer } from '../http'
import { PushSink, pushSubject, pushTag } from '../pushDevices'
import { loadOrCreateVapid } from '../webPush'
import { decryptPush } from './pushTestUtil'

const ORIGIN = 'https://posta.example.com'
const PW = 'dogru-parola-1'

interface Ua { ecdh: ReturnType<typeof createECDH>; authKey: Buffer; p256dh: string; auth: string }
function newUa(): Ua {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const authKey = randomBytes(16)
  return { ecdh, authKey, p256dh: ecdh.getPublicKey().toString('base64url'), auth: authKey.toString('base64url') }
}

const item = (over: Partial<PushItem> = {}): PushItem => ({
  title: 'Ali', body: 'gizli konu', accountId: null, messageId: 42, level: 'normal', tag: 'm42', count: 1, ...over
})

describe('Web Push cihazları', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let auth: WebAuth
  let host: ReturnType<typeof createServerHost>
  let server: http.Server | undefined
  let port: number
  const sinks: PushSink[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-push-'))
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
    auth = new WebAuth(q, host)
  })
  afterEach(async () => {
    for (const s of sinks.splice(0)) s.close()
    if (server?.listening) await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const mkUser = (username: string): number => q.insertUser({ username, passwordHash: hashPassword(PW), role: 'member' })

  describe('cihaz oturumuyla ölür (auth)', () => {
    let clock: number
    const sessionIds = (id: number): string[] =>
      (db.prepare(`SELECT id_hash FROM web_sessions WHERE user_id = ?`).all(id) as { id_hash: string }[]).map((r) => r.id_hash)
    const session = async (a: WebAuth): Promise<{ id: number; token: string; device: number }> => {
      const id = mkUser('ali')
      const r = await a.login({ username: 'ali', password: PW, ip: '1.1.1.1', userAgent: '' })
      if (!r.ok) throw new Error('giriş olmadı')
      const device = q.upsertPushDevice({
        userId: id, sessionId: sessionIds(id)[0], endpoint: 'https://fcm.googleapis.com/x', p256dh: 'p', auth: 'a', label: null, now: 1
      })
      return { id, token: r.token, device }
    }
    beforeEach(() => {
      clock = 1_000_000
    })

    const desktopDevice = (userId: number, sessionId: string): number =>
      q.upsertPushDevice({ userId, sessionId, endpoint: 'desktop:cihaz', p256dh: '', auth: '', label: 'Mac', now: 1, kind: 'desktop' })

    it('desktop device rolls session', async () => {
      const a = new WebAuth(q, host, () => clock)
      const s = await session(a)
      q.deletePushDevice(s.device, 'https://fcm.googleapis.com/x')
      const id = sessionIds(s.id)[0]
      desktopDevice(s.id, id)
      const before = q.getWebSession(id)!.expires_at
      // ajan soketi her dakika resolve'dan geçer: 30 gün sınırı kullanılan oturumda kaymalı
      clock += 2 * 24 * 3600_000
      expect(a.resolve(s.token)?.expiresAt).toBe(clock + SESSION_TTL_MS)
      expect(q.getWebSession(id)!.expires_at).toBeGreaterThan(before)
    })

    it('desktop cihazı olan oturum boşta kalınca erişim vermez, satırı durur', async () => {
      const a = new WebAuth(q, host, () => clock)
      const s = await session(a)
      q.deletePushDevice(s.device, 'https://fcm.googleapis.com/x')
      const id = sessionIds(s.id)[0]
      const device = desktopDevice(s.id, id)
      clock += SESSION_IDLE_MS + 1
      expect(a.resolve(s.token)).toBeNull()
      expect(q.getPushDevice(device)).toBeDefined()
      a.sweepExpired()
      expect(q.getWebSession(id)).toBeDefined()
    })

    it('süre dolunca resolve cihazı siler', async () => {
      const a = new WebAuth(q, host, () => clock)
      const s = await session(a)
      clock += SESSION_TTL_MS + 1
      expect(a.resolve(s.token)).toBeNull()
      expect(q.getPushDevice(s.device)).toBeUndefined()
    })

    it('boşta süresi dolunca resolve cihazı siler', async () => {
      const a = new WebAuth(q, host, () => clock)
      const s = await session(a)
      clock += SESSION_IDLE_PUSH_MS + 1
      expect(a.resolve(s.token)).toBeNull()
      expect(q.getPushDevice(s.device)).toBeUndefined()
    })

    it('devre dışı kullanıcıda resolve cihazı siler', async () => {
      const a = new WebAuth(q, host, () => clock)
      const s = await session(a)
      q.updateUserFields(s.id, { enabled: 0 })
      expect(a.resolve(s.token)).toBeNull()
      expect(q.getPushDevice(s.device)).toBeUndefined()
    })

    it('hiç dönmeyen oturum: sweepExpired süresi ve boşta süresi dolanı siler, canlıya dokunmaz', async () => {
      const a = new WebAuth(q, host, () => clock)
      const s = await session(a)
      clock += SESSION_IDLE_PUSH_MS - 1
      a.sweepExpired()
      expect(q.getPushDevice(s.device)).toBeDefined()
      clock += 2
      a.sweepExpired()
      expect(q.getPushDevice(s.device)).toBeUndefined()
      expect(sessionIds(s.id)).toEqual([])
    })
  })

  describe('HTTP uçları', () => {
    const start = async (pushHosts?: string[], sessionSweepMs?: number): Promise<void> => {
      const cfg: ServerConfig = {
        dataDir: dir, listenHost: '127.0.0.1', listenPort: 0, keyFile: join(dir, 'master.key'), publicOrigin: ORIGIN, trustedProxyDepth: 0,
        webDir: join(dir, 'web')
      }
      server = createHttpServer({ cfg, hub, auth, pushHosts, sessionSweepMs })
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
      port = (server.address() as AddressInfo).port
    }
    interface Res { status: number; body: string; json: any; headers: http.IncomingHttpHeaders } // eslint-disable-line @typescript-eslint/no-explicit-any
    const req = (method: string, path: string, o: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> =>
      new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, method, path, headers: o.headers }, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString()
            resolve({ status: res.statusCode!, body, json: body ? JSON.parse(body) : null, headers: res.headers })
          })
        })
        r.on('error', reject)
        if (o.body != null) r.write(o.body)
        r.end()
      })
    const post = (path: string, body: unknown, cookie = ''): Promise<Res> =>
      req('POST', path, { headers: { origin: ORIGIN, 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })
    const get = (path: string, cookie: string): Promise<Res> => req('GET', path, { headers: { origin: ORIGIN, cookie } })
    const del = (path: string, cookie: string): Promise<Res> => req('DELETE', path, { headers: { origin: ORIGIN, cookie } })
    const login = async (username: string): Promise<string> => {
      const r = await post('/api/login', { username, password: PW })
      expect(r.status).toBe(200)
      return r.headers['set-cookie']![0].split(';')[0]
    }
    const sub = (ua: Ua, id = 'a', extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, keys: { p256dh: ua.p256dh, auth: ua.auth }, ...extra
    })

    it('GET /api/push/key oturum ve aynı köken ister; hep aynı açık anahtar', async () => {
      await start()
      mkUser('ali')
      const c = await login('ali')
      expect((await req('GET', '/api/push/key')).status).toBe(401)
      expect((await req('GET', '/api/push/key', { headers: { origin: 'https://kotu.example.com', cookie: c } })).status).toBe(403)
      const a = await get('/api/push/key', c)
      expect(a.status).toBe(200)
      expect(Buffer.from(a.json.publicKey, 'base64url').length).toBe(65)
      expect((await get('/api/push/key', c)).json.publicKey).toBe(a.json.publicKey)
    })

    it('subscribe kaydeder; liste yalnız kendi cihazlarını gösterir, uç nokta ve anahtar dönmez', async () => {
      await start()
      const ali = mkUser('ali')
      mkUser('ayse')
      const ca = await login('ali')
      const cb = await login('ayse')
      const ua = newUa()
      const r = await post('/api/push/subscribe', sub(ua, 'a', { label: 'Telefon' }), ca)
      expect(r.status).toBe(200)
      expect(q.listPushDevices(ali)[0]).toMatchObject({ id: r.json.id, label: 'Telefon', p256dh: ua.p256dh })
      await post('/api/push/subscribe', sub(newUa(), 'b'), cb)

      const l = await get('/api/push/devices', ca)
      expect(l.json.devices.map((d: { id: number }) => d.id)).toEqual([r.json.id])
      expect(l.json.devices[0].label).toBe('Telefon')
      expect(l.body).not.toContain('fcm.googleapis.com')
      expect(l.body).not.toContain(ua.p256dh)
    })

    it('oturumsuz ve başka kökenli subscribe reddedilir', async () => {
      await start()
      mkUser('ali')
      const c = await login('ali')
      expect((await post('/api/push/subscribe', sub(newUa()))).status).toBe(401)
      const r = await req('POST', '/api/push/subscribe', {
        headers: { origin: 'https://kotu.example.com', 'content-type': 'application/json', cookie: c }, body: JSON.stringify(sub(newUa()))
      })
      expect(r.status).toBe(403)
    })

    it('disallowed host rejected', async () => {
      await start()
      const ali = mkUser('ali')
      const c = await login('ali')
      const ua = newUa()
      for (const endpoint of ['https://169.254.169.254/latest', 'http://fcm.googleapis.com/x', 'http://127.0.0.1:9/x']) {
        expect((await post('/api/push/subscribe', { ...sub(ua), endpoint }, c)).status).toBe(400)
      }
      expect(q.listPushDevices(ali)).toEqual([])
    })

    it('createHttpServer seçeneği yerel sahte servise izin verir', async () => {
      await start(['127.0.0.1'])
      mkUser('ali')
      const c = await login('ali')
      expect((await post('/api/push/subscribe', { ...sub(newUa()), endpoint: 'http://127.0.0.1:9/x' }, c)).status).toBe(200)
    })

    it('geçersiz tarayıcı anahtarları 400', async () => {
      await start()
      const ali = mkUser('ali')
      const c = await login('ali')
      const ua = newUa()
      const bad = [
        { keys: { p256dh: 'kisa', auth: ua.auth } },
        { keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: ua.auth } }, // eğri üzerinde değil
        { keys: { p256dh: ua.p256dh, auth: 'a' } },
        { keys: { p256dh: ua.p256dh } },
        { keys: 'x' },
        { endpoint: 1 }
      ]
      for (const b of bad) expect((await post('/api/push/subscribe', { ...sub(ua), ...b }, c)).status).toBe(400)
      expect(q.listPushDevices(ali)).toEqual([])
    })

    it('aynı uç nokta başka kullanıcıyla yeniden kaydolunca satır ona geçer', async () => {
      await start()
      const ali = mkUser('ali')
      const ayse = mkUser('ayse')
      const ca = await login('ali')
      const cb = await login('ayse')
      const a = await post('/api/push/subscribe', sub(newUa()), ca)
      const ua2 = newUa()
      const b = await post('/api/push/subscribe', sub(ua2), cb)
      expect(b.json.id).toBe(a.json.id)
      expect(q.listPushDevices(ali)).toEqual([])
      expect(q.listPushDevices(ayse)[0].p256dh).toBe(ua2.p256dh)
    })

    it("member cannot delete another user's device", async () => {
      await start()
      const ali = mkUser('ali')
      mkUser('ayse')
      const ca = await login('ali')
      const cb = await login('ayse')
      const { json } = await post('/api/push/subscribe', sub(newUa()), ca)
      expect((await del(`/api/push/devices/${json.id}`, cb)).status).toBe(404)
      expect(q.listPushDevices(ali)).toHaveLength(1)
      const cross = await req('DELETE', `/api/push/devices/${json.id}`, { headers: { origin: 'https://kotu.example.com', cookie: ca } })
      expect(cross.status).toBe(403)
      expect((await del(`/api/push/devices/${json.id}`, ca)).status).toBe(204)
      expect(q.listPushDevices(ali)).toEqual([])
    })

    it('logout removes device: yalnız o oturumun cihazı', async () => {
      await start()
      const ali = mkUser('ali')
      const c1 = await login('ali')
      const c2 = await login('ali')
      await post('/api/push/subscribe', sub(newUa(), 'bir'), c1)
      await post('/api/push/subscribe', sub(newUa(), 'iki'), c2)
      await post('/api/logout', {}, c1)
      expect(q.listPushDevices(ali).map((d) => d.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/iki'])
    })

    it('sınır: kullanıcı başına 10 cihaz, en eski düşer', async () => {
      await start()
      const ali = mkUser('ali')
      const c = await login('ali')
      for (let i = 0; i < 11; i++) expect((await post('/api/push/subscribe', sub(newUa(), `c${i}`), c)).status).toBe(200)
      const list = q.listPushDevices(ali).map((d) => d.endpoint)
      expect(list).toHaveLength(10)
      expect(list).not.toContain('https://fcm.googleapis.com/fcm/send/c0')
      expect(list).toContain('https://fcm.googleapis.com/fcm/send/c10')
    })

    it('sınır desktop satırını düşürmez, ajan kaydı web aboneliğini düşürmez', async () => {
      await start()
      const ali = mkUser('ali')
      const c = await login('ali')
      const agent = q.upsertPushDevice({ userId: ali, sessionId: 'oturum', endpoint: `desktop:${ali}:c`, p256dh: '', auth: '', label: 'Mac', now: 1, kind: 'desktop' })
      for (let i = 0; i < 12; i++) expect((await post('/api/push/subscribe', sub(newUa(), `c${i}`), c)).status).toBe(200)
      expect(q.getPushDevice(agent)).toBeDefined()
      expect(q.listPushDevices(ali).filter((d) => d.kind === 'webpush')).toHaveLength(10)
      q.upsertPushDevice({ userId: ali, sessionId: 'oturum-2', endpoint: `desktop:${ali}:d`, p256dh: '', auth: '', label: 'Mac', now: Date.now(), kind: 'desktop' })
      expect(q.listPushDevices(ali).filter((d) => d.kind === 'webpush')).toHaveLength(10)
      expect(q.listPushDevices(ali).filter((d) => d.kind === 'desktop')).toHaveLength(2)
    })

    it('başka kullanıcıdan taşınan cihaz sınırda kendisi düşmez; ad ve zamanlar sıfırlanır', async () => {
      await start()
      const ayse = mkUser('ayse')
      mkUser('ali')
      const ca = await login('ali')
      const cb = await login('ayse')
      const ep = 'https://fcm.googleapis.com/fcm/send/tasinan'
      const ua = newUa()
      const moved = (await post('/api/push/subscribe', { ...sub(ua), endpoint: ep, label: 'Ali telefonu' }, ca)).json.id as number
      q.touchPushDevice(moved, 123)
      db.prepare(`UPDATE push_devices SET created_at = 7 WHERE id = ?`).run(moved)
      for (let i = 0; i < 10; i++) await post('/api/push/subscribe', sub(newUa(), `b${i}`), cb)
      await post('/api/push/subscribe', { ...sub(ua), endpoint: ep }, cb)
      const row = q.getPushDevice(moved)!
      expect(row).toMatchObject({ user_id: ayse, label: null, last_ok_at: null })
      expect(row.created_at).toBeGreaterThan(7)
      expect(q.listPushDevices(ayse)).toHaveLength(10)
    })

    it('aynı kullanıcı yeniden kaydolunca ad ve zamanlar korunur', async () => {
      await start()
      const ali = mkUser('ali')
      const c = await login('ali')
      const ua = newUa()
      const id = (await post('/api/push/subscribe', sub(ua, 'a', { label: 'Telefon' }), c)).json.id as number
      q.touchPushDevice(id, 123)
      await post('/api/push/subscribe', sub(ua, 'a'), c)
      expect(q.listPushDevices(ali)[0]).toMatchObject({ label: 'Telefon', last_ok_at: 123 })
    })

    it('süpürme: geri dönmeyen kullanıcının süresi dolan oturumu ve cihazı silinir, süpürme close ile durur', async () => {
      const u = mkUser('ali')
      q.insertWebSession({ idHash: 'eski', userId: u, now: 1, expiresAt: Date.now() + 1e9, ip: null, userAgent: null })
      q.insertWebSession({ idHash: 'canli', userId: u, now: Date.now(), expiresAt: Date.now() + 1e9, ip: null, userAgent: null })
      const dev = (id: string, s: string): number => q.upsertPushDevice({ userId: u, sessionId: s, endpoint: `https://fcm.googleapis.com/${id}`, p256dh: 'p', auth: 'a', label: null, now: 1 })
      dev('eski', 'eski')
      const live = dev('canli', 'canli')
      const sweep = vi.spyOn(auth, 'sweepExpired')
      await start(undefined, 10)
      await vi.waitFor(() => expect(q.getWebSession('eski')).toBeUndefined())
      expect(q.listPushDevices(u).map((d) => d.id)).toEqual([live])
      await new Promise<void>((r) => server!.close(() => r()))
      const n = sweep.mock.calls.length
      await new Promise((r) => setTimeout(r, 40))
      expect(sweep.mock.calls.length).toBe(n)
    })

    it('revokeUser removes devices: hub.onUserRevoked yolu', async () => {
      await start()
      const ali = mkUser('ali')
      const ayse = mkUser('ayse')
      const ca = await login('ali')
      const cb = await login('ayse')
      await post('/api/push/subscribe', sub(newUa(), 'a'), ca)
      await post('/api/push/subscribe', sub(newUa(), 'b'), cb)
      hub.onUserRevoked!(ali)
      expect(q.listPushDevices(ali)).toEqual([])
      expect(q.listPushDevices(ayse)).toHaveLength(1)
    })
  })

  describe('PushSink', () => {
    type Sent = { url: string; headers: Record<string, string>; body: Buffer }
    const sent: Sent[] = []
    const reply = (status: number) => async (url: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      sent.push({ url: String(url), headers: init!.headers as Record<string, string>, body: Buffer.from(init!.body as Uint8Array) })
      return new Response(null, { status })
    }
    const uas = new Map<number, Ua>()
    const addDevice = (userId: number, id: string, sessionId = `oturum-${id}`): number => {
      const ua = newUa()
      if (!q.getWebSession(sessionId)) q.insertWebSession({ idHash: sessionId, userId, now: 5000, expiresAt: 1e12, ip: null, userAgent: null })
      const d = q.upsertPushDevice({ userId, sessionId, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, p256dh: ua.p256dh, auth: ua.auth, label: null, now: 1 })
      uas.set(d, ua)
      return d
    }
    const groupAccount = (userId: number, canManage: boolean): { accountId: number } => {
      const accountId = q.insertAccount({ email: `h${userId}@t.co`, displayName: null, imapHost: 'm', imapPort: 993, smtpHost: 'm', smtpPort: 465, passwordEnc: Buffer.from('x') })
      const group = q.insertGroup(`G${accountId}`, '#111111')
      q.setAccountGroup(accountId, group)
      q.setGroupPermission(userId, group, true, canManage)
      return { accountId }
    }
    const open = (s: Sent, device: number): PushPayload => {
      const ua = uas.get(device)!
      return JSON.parse(decryptPush(s.body, ua.ecdh, ua.authKey).toString())
    }
    const mkSink = (fetchFn: typeof fetch, o: Partial<ConstructorParameters<typeof PushSink>[0]> = {}): PushSink => {
      const s = new PushSink({
        q, keys: () => loadOrCreateVapid(q, host), subject: pushSubject(ORIGIN), broadcast: () => {},
        fetch: fetchFn, retryMs: 10, windowMs: 60_000, now: () => 5000, ...o
      })
      sinks.push(s)
      return s
    }
    const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms))

    beforeEach(() => {
      sent.length = 0
      uas.clear()
    })

    it('VAPID subject publicOrigin ana makinesinden', () => {
      expect(pushSubject('https://posta.example.com:8443')).toBe('mailto:postmaster@posta.example.com')
    })

    it('payload encrypted (no plaintext in body); eylemler kullanıcının dilinde', async () => {
      const u = mkUser('ali')
      q.userPrefSet(u, 'locale', 'tr')
      const d = addDevice(u, 'a')
      const { accountId } = groupAccount(u, true)
      mkSink(reply(201)).deliver(u, [item({ accountId })])
      await vi.waitFor(() => expect(q.getPushDevice(d)?.last_ok_at).toBe(5000))
      expect(sent).toHaveLength(1)
      expect(sent[0].body.includes('gizli konu')).toBe(false)
      const p = open(sent[0], d)
      expect(p).toMatchObject({ title: 'Ali', body: 'gizli konu', messageId: 42, level: 'normal', tag: pushTag('m42'), count: 1 })
      expect(p.actions).toEqual([
        { action: 'read', title: 'Okundu' }, { action: 'archive', title: 'Arşivle' }, { action: 'reply', title: 'Yanıtla' }
      ])
    })

    it('yalnız görme izni olan üyeye arşiv ve yanıt düğmesi gitmez (yanıt yönetme ister)', async () => {
      const u = mkUser('ali')
      const d = addDevice(u, 'a')
      const { accountId } = groupAccount(u, false)
      mkSink(reply(201)).deliver(u, [item({ accountId })])
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      expect(open(sent[0], d).actions.map((a) => a.action)).toEqual(['read'])
    })

    it('oturumlara yayın her öge için, cihazsız kullanıcıda da', async () => {
      const u = mkUser('ali')
      const broadcast = vi.fn()
      const it1 = item()
      mkSink(reply(201), { broadcast }).deliver(u, [it1, it1])
      expect(broadcast).toHaveBeenCalledTimes(2)
      expect(broadcast).toHaveBeenCalledWith(u, { ...it1, tag: pushTag(it1.tag), actions: ['read'] })
      await settle()
      expect(sent).toEqual([])
    })

    it('acil: Urgency high, TTL 86400; normal: TTL 3600', async () => {
      const u = mkUser('ali')
      addDevice(u, 'a')
      mkSink(reply(201)).deliver(u, [item({ level: 'urgent' }), item()])
      await vi.waitFor(() => expect(sent).toHaveLength(2))
      expect(sent[0].headers).toMatchObject({ Urgency: 'high', TTL: '86400' })
      expect(sent[1].headers).toMatchObject({ Urgency: 'normal', TTL: '3600' })
    })

    it('410 removes device; yeniden denenmez', async () => {
      const u = mkUser('ali')
      const d = addDevice(u, 'a')
      mkSink(reply(410)).deliver(u, [item()])
      await vi.waitFor(() => expect(q.getPushDevice(d)).toBeUndefined())
      await settle()
      expect(sent).toHaveLength(1)
    })

    it('500 retries once; sonra bırakılır, cihaz kalır', async () => {
      const u = mkUser('ali')
      const d = addDevice(u, 'a')
      mkSink(reply(500)).deliver(u, [item()])
      await vi.waitFor(() => expect(sent).toHaveLength(2))
      await settle()
      expect(sent).toHaveLength(2)
      expect(q.getPushDevice(d)?.last_ok_at).toBeNull()
    })

    it('ikinci deneme başarılıysa cihaz canlı', async () => {
      const u = mkUser('ali')
      const d = addDevice(u, 'a')
      let n = 0
      mkSink((async (url, init) => reply(n++ ? 201 : 503)(url as string, init)) as typeof fetch).deliver(u, [item()])
      await vi.waitFor(() => expect(q.getPushDevice(d)?.last_ok_at).toBe(5000))
      expect(sent).toHaveLength(2)
    })

    it('bekleyen yeniden deneme çıkış sonrası gitmez', async () => {
      const u = mkUser('ali')
      const d = addDevice(u, 'a')
      mkSink(reply(500), { retryMs: 200 }).deliver(u, [item()])
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      q.deletePushDevice(d, q.getPushDevice(d)!.endpoint)
      await settle(260)
      expect(sent).toHaveLength(1)
    })

    it('uç nokta başka kullanıcıya geçtiyse önceki kullanıcının kuyruktaki bildirimi gitmez', async () => {
      const u = mkUser('ali')
      const v = mkUser('ayse')
      const d = addDevice(u, 'a')
      mkSink(reply(500), { retryMs: 200 }).deliver(u, [item()])
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      const ua = uas.get(d)!
      q.upsertPushDevice({ userId: v, sessionId: null, endpoint: 'https://fcm.googleapis.com/fcm/send/a', p256dh: ua.p256dh, auth: ua.auth, label: null, now: 2 })
      await settle(260)
      expect(sent).toHaveLength(1)
    })

    it('cihaz başına eşzamanlı 1: sonraki, önceki bitince gider', async () => {
      const u = mkUser('ali')
      addDevice(u, 'a')
      addDevice(u, 'b')
      const gates: (() => void)[] = []
      const inFlight = new Map<string, number>()
      let max = 0
      const f = (async (url: string) => {
        inFlight.set(url, (inFlight.get(url) ?? 0) + 1)
        max = Math.max(max, inFlight.get(url)!)
        await new Promise<void>((r) => gates.push(r))
        inFlight.set(url, inFlight.get(url)! - 1)
        return new Response(null, { status: 201 })
      }) as unknown as typeof fetch
      mkSink(f).deliver(u, [item(), item()])
      await vi.waitFor(() => expect(gates).toHaveLength(2)) // her cihazdan birer tane
      await settle(10)
      expect(gates).toHaveLength(2)
      gates.splice(0).forEach((g) => g())
      await vi.waitFor(() => expect(gates).toHaveLength(2))
      gates.splice(0).forEach((g) => g())
      await settle(10)
      expect(max).toBe(1)
    })

    it('rate limit collapses to summary: dakikada 30, fazlası tek özet', async () => {
      const u = mkUser('ali')
      q.userPrefSet(u, 'locale', 'en')
      const d = addDevice(u, 'a')
      const sink = mkSink(reply(201), { windowMs: 60 })
      for (let i = 0; i < 37; i++) sink.deliver(u, [item({ tag: `m${i}`, level: i === 35 ? 'urgent' : 'normal' })])
      await vi.waitFor(() => expect(sent).toHaveLength(31))
      await settle(100)
      expect(sent).toHaveLength(31)
      const p = open(sent[30], d)
      expect(p).toMatchObject({ body: '7 new messages', count: 7, messageId: null, level: 'urgent', actions: [] })
      expect(sent[30].headers.Urgency).toBe('high')
    })

    it('oran sınırı kullanıcı başına', async () => {
      const u = mkUser('ali')
      const v = mkUser('ayse')
      addDevice(u, 'a')
      addDevice(v, 'b')
      const sink = mkSink(reply(201))
      sink.deliver(u, Array.from({ length: 31 }, () => item()))
      sink.deliver(v, [item()])
      await vi.waitFor(() => expect(sent).toHaveLength(31))
    })

    it('yük 3 KB\'ı aşmaz; uzun gövde kesilir, çok baytlı karakter bölünmez', async () => {
      const u = mkUser('ali')
      const d = addDevice(u, 'a')
      mkSink(reply(201)).deliver(u, [item({ body: '😀ş"'.repeat(5000), title: 'Konu' })])
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      const plain = decryptPush(sent[0].body, uas.get(d)!.ecdh, uas.get(d)!.authKey)
      expect(plain.length).toBeLessThanOrEqual(3072)
      const p = JSON.parse(plain.toString()) as PushPayload
      expect(p.title).toBe('Konu')
      expect(p.body.endsWith('…')).toBe(true)
      expect(p.body).not.toContain('�')
      expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(p.body)).toBe(false)
    })

    it('uzun etiket ve uzun başlık: yük yine 3 KB içinde, etiket 16 onaltılık', async () => {
      const u = mkUser('ali')
      const d = addDevice(u, 'a')
      const tag = `notice:1:${'a"😀'.repeat(4000)}`
      mkSink(reply(201)).deliver(u, [item({ tag, title: '"😀'.repeat(4000), body: '\\ş'.repeat(4000) })])
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      const plain = decryptPush(sent[0].body, uas.get(d)!.ecdh, uas.get(d)!.authKey)
      expect(plain.length).toBeLessThanOrEqual(3072)
      expect((JSON.parse(plain.toString()) as PushPayload).tag).toMatch(/^[0-9a-f]{16}$/)
    })

    it('oturumu bitmiş cihaz gönderim almaz, satırı silinir', async () => {
      const u = mkUser('ali')
      const gone = addDevice(u, 'yok')
      const expired = addDevice(u, 'dolmus')
      const idle = addDevice(u, 'bosta')
      const live = addDevice(u, 'canli')
      db.prepare(`DELETE FROM web_sessions WHERE id_hash = 'oturum-yok'`).run()
      db.prepare(`UPDATE web_sessions SET expires_at = 1 WHERE id_hash = 'oturum-dolmus'`).run()
      db.prepare(`UPDATE web_sessions SET last_seen_at = ? WHERE id_hash = 'oturum-bosta'`).run(5000 - SESSION_IDLE_PUSH_MS - 1)
      mkSink(reply(201)).deliver(u, [item()])
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      expect(sent[0].url).toContain('canli')
      expect(q.listPushDevices(u).map((x) => x.id)).toEqual([live])
      expect([gone, expired, idle].map((id) => q.getPushDevice(id))).toEqual([undefined, undefined, undefined])
    })

    it('oturumsuz satır da gönderim almaz', async () => {
      const u = mkUser('ali')
      q.upsertPushDevice({ userId: u, sessionId: null, endpoint: 'https://fcm.googleapis.com/fcm/send/z', p256dh: 'p', auth: 'a', label: null, now: 1 })
      mkSink(reply(201)).deliver(u, [item()])
      await settle()
      expect(sent).toEqual([])
      expect(q.listPushDevices(u)).toEqual([])
    })

    it('izinsiz ana makineli satıra istek gitmez, satır silinir; extraHosts geçirir', async () => {
      const u = mkUser('ali')
      addDevice(u, 'a')
      const e = 'http://127.0.0.1:9/x'
      const put = (): number => q.upsertPushDevice({ userId: u, sessionId: 'oturum-a', endpoint: e, p256dh: uas.values().next().value!.p256dh, auth: uas.values().next().value!.auth, label: null, now: 1 })
      const a = put()
      mkSink(reply(201)).deliver(u, [item()])
      await vi.waitFor(() => expect(q.getPushDevice(a)).toBeUndefined())
      expect(sent.map((s) => s.url)).not.toContain(e)
      const b = put()
      sent.length = 0
      mkSink(reply(201), { extraHosts: ['127.0.0.1'] }).deliver(u, [item()])
      await vi.waitFor(() => expect(sent.map((s) => s.url)).toContain(e))
      expect(q.getPushDevice(b)).toBeDefined()
    })

    it('gone yalnız aynı uç noktayı siler: gönderim sürerken kimlik yeniden kullanılsa da', async () => {
      const u = mkUser('ali')
      const d = addDevice(u, 'a')
      const ep = q.getPushDevice(d)!.endpoint
      const f = (async () => {
        q.deletePushDevice(d, ep)
        db.prepare(`INSERT INTO push_devices (id, user_id, web_session_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, 'oturum-a', 'https://fcm.googleapis.com/fcm/send/yeni', 'p', 'a', 1)`).run(d, u)
        return new Response(null, { status: 410 })
      }) as unknown as typeof fetch
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      mkSink(f).deliver(u, [item()])
      await settle()
      spy.mockRestore()
      expect(q.getPushDevice(d)?.endpoint).toBe('https://fcm.googleapis.com/fcm/send/yeni')
    })

    it('kuyruk taşınca acil öge düşmez, en eski normal düşer', async () => {
      const u = mkUser('ali')
      const d = addDevice(u, 'a')
      const gates: (() => void)[] = []
      const f = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        await new Promise<void>((r) => gates.push(r))
        return reply(201)(url, init)
      }) as typeof fetch
      const sink = mkSink(f, { windowMs: 60_000 })
      // 1 gönderimde + 29 kuyrukta + acil; oran sınırı 30 olduğundan pencere sınırına takılmadan taşırmak için doğrudan kuyruk
      const enqueue = (level: PushItem['level'], tag: string): void => (sink as unknown as { enqueue(j: unknown): void }).enqueue({
        userId: u, deviceId: d, retried: false,
        payload: { ...item({ level, tag }), actions: [] }
      })
      enqueue('normal', 'ilk') // işleniyor
      for (let i = 0; i < 30; i++) enqueue('normal', `n${i}`) // kuyruk dolu
      enqueue('urgent', 'acil')
      for (;;) {
        await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0))
        gates.shift()!()
        const before = sent.length
        await vi.waitFor(() => expect(sent.length).toBe(before + 1))
        if (sent.length === 31) break
      }
      const tags = sent.map((s) => open(s, d).tag)
      expect(tags).toContain('acil')
      expect(tags).not.toContain('n0')
      expect(tags).toContain('n1')
    })

    it('close bekleyen yeniden denemeyi ve tutulan özeti iptal eder', async () => {
      const u = mkUser('ali')
      addDevice(u, 'a')
      const sink = mkSink(reply(500), { retryMs: 30, windowMs: 30 })
      sink.deliver(u, Array.from({ length: 31 }, () => item()))
      await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), { interval: 1 })
      // kapanış bayrağı göndermeyi zaten keser: zamanlayıcıların gerçekten durduğu kuyruğa hiç iş gelmemesinden anlaşılır
      const enqueue = vi.spyOn(sink as unknown as { enqueue(j: unknown): void }, 'enqueue')
      sink.close()
      const n = sent.length
      await settle(120)
      expect(enqueue).not.toHaveBeenCalled()
      expect(sent.length).toBe(n)
    })

    it('close süren isteği iptal eder; sonuç DB\'ye yazılmaz', async () => {
      const u = mkUser('ali')
      const d = addDevice(u, 'a')
      let signal: AbortSignal | undefined
      const f = ((_u: string, init: RequestInit) => new Promise((_res, rej) => {
        signal = init.signal!
        signal.addEventListener('abort', () => rej(signal!.reason))
      })) as unknown as typeof fetch
      const sink = mkSink(f)
      sink.deliver(u, [item()])
      await vi.waitFor(() => expect(signal).toBeDefined())
      sink.close()
      expect(signal!.aborted).toBe(true)
      await settle(10)
      expect(q.getPushDevice(d)?.last_ok_at).toBeNull()
    })

    it('beklenmedik hatada günlüğe yalnız hata adı', async () => {
      const u = mkUser('ali')
      addDevice(u, 'a')
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mkSink(reply(201), { keys: async () => { throw new RangeError('https://fcm.googleapis.com/gizli') } }).deliver(u, [item()])
      await vi.waitFor(() => expect(spy).toHaveBeenCalled())
      const text = JSON.stringify(spy.mock.calls)
      spy.mockRestore()
      expect(text).toContain('RangeError')
      expect(text).not.toContain('fcm.googleapis.com')
    })

    it('özet bildirimde eylem yok', async () => {
      const u = mkUser('ali')
      const d = addDevice(u, 'a')
      mkSink(reply(201)).deliver(u, [item({ messageId: null, count: 12, tag: 'ozet' })])
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      expect(open(sent[0], d).actions).toEqual([])
    })

    it('desktop device never gets push', async () => {
      const u = mkUser('ali')
      q.insertWebSession({ idHash: 'oturum', userId: u, now: 5000, expiresAt: 1e12, ip: null, userAgent: null })
      const device = q.upsertPushDevice({ userId: u, sessionId: 'oturum', endpoint: 'desktop:cihaz', p256dh: '', auth: '', label: 'Mac', now: 1, kind: 'desktop' })
      const broadcast = vi.fn()
      mkSink(reply(201), { broadcast }).deliver(u, [item()])
      await new Promise((d) => setTimeout(d, 10))
      expect(broadcast).toHaveBeenCalledTimes(1)
      expect(sent).toEqual([])
      expect(q.getPushDevice(device)).toBeDefined()
    })

    it('oturumu bitmiş desktop cihazı liveDevices içinde silinmez', async () => {
      const u = mkUser('ali')
      const device = q.upsertPushDevice({ userId: u, sessionId: 'yok', endpoint: 'desktop:cihaz', p256dh: '', auth: '', label: 'Mac', now: 1, kind: 'desktop' })
      mkSink(reply(201)).deliver(u, [item()])
      await new Promise((d) => setTimeout(d, 10))
      expect(q.getPushDevice(device)).toBeDefined()
    })

    it('member gets no archive action', async () => {
      const u = mkUser('uye')
      const broadcast = vi.fn()
      mkSink(reply(201), { broadcast }).deliver(u, [item({ accountId: 3 })])
      expect(broadcast.mock.calls[0][1].actions).toEqual(['read'])
    })

    it('yönetici okundu, arşiv ve yanıt alır', async () => {
      const u = q.insertUser({ username: 'yon', passwordHash: hashPassword(PW), role: 'admin' })
      const broadcast = vi.fn()
      mkSink(reply(201), { broadcast }).deliver(u, [item({ accountId: 3 })])
      expect(broadcast.mock.calls[0][1].actions).toEqual(['read', 'archive', 'reply'])
    })

    it('kasa bildiriminde ve özette eylem yok', async () => {
      const u = q.insertUser({ username: 'yon', passwordHash: hashPassword(PW), role: 'admin' })
      const d = addDevice(u, 'a')
      const secure = vi.spyOn(q, 'isAccountSecure').mockImplementation((id) => id === 9)
      const broadcast = vi.fn()
      mkSink(reply(201), { broadcast }).deliver(u, [item({ accountId: 9 }), item({ messageId: null, tag: 'o' })])
      expect(broadcast.mock.calls.map((c) => c[1].actions)).toEqual([[], []])
      await vi.waitFor(() => expect(sent).toHaveLength(2))
      expect(open(sent[0], d).actions).toEqual([])
      secure.mockRestore()
    })

    it('kasa hesabının bildirimi içerik taşımaz', async () => {
      const u = mkUser('ali')
      q.userPrefSet(u, 'locale', 'en')
      const d = addDevice(u, 'a')
      const secure = vi.spyOn(q, 'isAccountSecure').mockImplementation((id) => id === 9)
      const broadcast = vi.fn()
      const notice = item({ accountId: 9, messageId: null, title: 'kasa@example.com', body: 'gizli konu', tag: 'notice:9:kasa@example.com:gizli konu' })
      mkSink(reply(201), { broadcast }).deliver(u, [notice])
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      const p = open(sent[0], d)
      expect(p.title).toBe('New mail')
      expect(p.body).toBe('')
      expect(JSON.stringify(p)).not.toContain('kasa@example.com')
      expect(JSON.stringify(p)).not.toContain('gizli konu')
      expect(broadcast).toHaveBeenCalledTimes(1)
      expect(broadcast).toHaveBeenCalledWith(u, { ...notice, tag: pushTag(notice.tag), actions: [] })
      secure.mockRestore()
    })

    it('günlüğe uç nokta yazılmaz', async () => {
      const u = mkUser('ali')
      const d = addDevice(u, 'a')
      const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
      mkSink(reply(410)).deliver(u, [item()])
      await vi.waitFor(() => expect(q.getPushDevice(d)).toBeUndefined())
      const text = JSON.stringify(spies.flatMap((s) => s.mock.calls))
      spies.forEach((s) => s.mockRestore())
      expect(text).not.toContain('fcm.googleapis.com')
    })

    it('bozuk cihaz anahtarı kuyruğu durdurmaz', async () => {
      const u = mkUser('ali')
      const ok = addDevice(u, 'a')
      q.upsertPushDevice({ userId: u, sessionId: 'oturum-a', endpoint: 'https://fcm.googleapis.com/fcm/send/bozuk', p256dh: 'kisa', auth: 'a', label: null, now: 1 })
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mkSink(reply(201)).deliver(u, [item()])
      await vi.waitFor(() => expect(q.getPushDevice(ok)?.last_ok_at).toBe(5000))
      spy.mockRestore()
    })
  })
})
