// ServerLink gerçek HTTP katmanına ve WebSocket'e karşı: çerez, köken, kapanış kodları sunucunun kendi kurallarıyla sınanır.
import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { createServer as createNetServer } from 'net'
import http from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import '../../shared/i18n/locales/all'
import { WebAuth } from '../../server/auth'
import type { ServerConfig } from '../../server/config'
import { createServerHost } from '../../server/hosts/serverHost'
import { createHttpServer } from '../../server/http'
import { hashPassword } from '../../sync/auth/password'
import { openDb } from '../../sync/db'
import { makeQueries } from '../../sync/db/queries'
import type { OpQueue } from '../../sync/opQueue'
import { RpcHub, type RpcServerDeps } from '../../sync/rpcHub'
import type { Scheduler } from '../../sync/scheduler'
import type { MigrationEvent, SealRequest } from '../../shared/importTypes'
import { sealItem } from '../../sync/importEnvelope'
import { MigrationRunner } from '../migration'
import { ServerLink, type LinkState } from '../serverLink'

vi.mock('electron', () => ({ app: {}, Notification: class {}, nativeImage: {}, BrowserWindow: class {} }))

import { shouldShow, shouldTellSignedOut } from '../notifyPresenter'

const PW = 'dogru-parola-1'
const notice = { title: 'T', body: 'B', accountId: null, messageId: null, level: 'normal' as const, tag: 't', count: 1, actions: [] }
const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createNetServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address() as AddressInfo
    s.close(() => resolve(port))
  })
})

/** Koşul sağlanana dek bekler */
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('koşul gerçekleşmedi')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('ServerLink', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let auth: WebAuth
  let server: http.Server
  let port: number
  let origin: string
  const links: ServerLink[] = []
  const clients: WebSocket[] = []

  /** Testin kapatabilmesi için oluşturulan soketler izlenir */
  class TrackedSocket extends WebSocket {
    constructor(...a: ConstructorParameters<typeof WebSocket>) {
      super(...a)
      clients.push(this)
    }
  }

  const boot = async (publicOrigin?: string): Promise<void> => {
    port = await freePort()
    origin = `http://127.0.0.1:${port}`
    const host = createServerHost(randomBytes(32), () => hub)
    const stub = new Proxy({}, { get: () => () => undefined })
    const deps: RpcServerDeps = {
      q, scheduler: stub as Scheduler, opq: { kick: vi.fn() } as unknown as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: (v) => host.encrypt(v), decrypt: async (b) => (await host.decrypt(b)).map((u) => Buffer.from(u).toString('utf-8')),
      userData: dir, dbSchemaVersion: () => 0
    }
    hub = new RpcHub(deps, 'server')
    auth = new WebAuth(q, host)
    const cfg: ServerConfig = {
      dataDir: dir, listenHost: '127.0.0.1', listenPort: port, keyFile: join(dir, 'master.key'), publicOrigin: publicOrigin ?? origin,
      trustedProxyDepth: 0, webDir: join(dir, 'web')
    }
    server = createHttpServer({ cfg, hub, auth })
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  }

  const login = (username = 'ali'): Promise<{ id: number; token: string }> => new Promise((resolve, reject) => {
    const id = q.insertUser({ username, passwordHash: hashPassword(PW), role: 'member' })
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/login', headers: { origin, 'content-type': 'application/json' } }, (res) => {
      res.resume()
      res.on('end', () => resolve({ id, token: (res.headers['set-cookie']?.[0] ?? '').split(';')[0].split('=')[1] }))
    })
    r.on('error', reject)
    r.end(JSON.stringify({ username, password: PW }))
  })

  const link = (token: string | null, over: Partial<ConstructorParameters<typeof ServerLink>[0]> = {}) => {
    const states: LinkState[] = []
    const events: { event: string; data: unknown }[] = []
    const l = new ServerLink({
      origin, cookie: async () => token, userAgent: 'GeckoMail test', WebSocketImpl: TrackedSocket as unknown as typeof WebSocket,
      backoffMs: [20], deviceId: 'cihaz', label: 'Mac', onState: (s) => states.push(s), onEvent: (event, data) => events.push({ event, data }), ...over
    })
    links.push(l)
    const notified = (): { title: string }[] => events.filter((e) => e.event === 'server:notify').map((e) => e.data as { title: string })
    return { l, states, events, notified }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-link-'))
    db = openDb(dir)
    q = makeQueries(db)
    await boot()
  })
  afterEach(async () => {
    for (const l of links.splice(0)) l.stop()
    clients.length = 0
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections() })
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Bağlandı ve ajan kaydı, kaçan bildirim sorgusu bitti */
  const synced = async (t: ReturnType<typeof link>): Promise<void> => until(() => t.states.at(-1) === 'online' && t.events.some((e) => e.event === 'agent:ready'))

  it('connects with cookie and origin', async () => {
    const u = await login()
    const t = link(u.token)
    t.l.start()
    await synced(t)
    expect(t.states).toEqual(['online'])
    expect(q.listPushDevices(u.id)).toMatchObject([{ endpoint: `desktop:${u.id}:cihaz`, kind: 'desktop', label: 'Mac' }])
    expect(await t.l.call('notifyAction', { messageId: 999, action: 'read' })).toEqual({ ok: false })
  })

  it('registerAgent kapalıysa hazır olur, cihaz satırı bırakmaz', async () => {
    const u = await login()
    const t = link(u.token, { registerAgent: false })
    t.l.start()
    await synced(t)
    expect(q.listPushDevices(u.id)).toEqual([])
  })

  it('her bağlantıda yeniden kaydolur', async () => {
    const u = await login()
    const t = link(u.token)
    t.l.start()
    await synced(t)
    q.deletePushDevicesForUser(u.id)
    clients[0].terminate()
    await until(() => q.listPushDevices(u.id).length === 1)
  })

  it('wrong origin rejected', async () => {
    const u = await login()
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections() })
    await boot('https://baska.example')
    const t = link(u.token)
    t.l.start()
    await until(() => clients.length >= 2)
    expect(t.states).toEqual(['offline']) // 403 oturum sorunu değil: denemeye devam
  })

  it('server:notify reaches agent with no window', async () => {
    const u = await login()
    const t = link(u.token)
    t.l.start()
    await synced(t)
    hub.notifyUser(u.id, { ...notice, title: 'canlı' })
    await until(() => t.notified().length === 1)
    expect(t.notified()[0].title).toBe('canlı')
  })

  it('no backlog on first connect', async () => {
    const u = await login()
    hub.notifyUser(u.id, { ...notice, title: 'eski' })
    const t = link(u.token)
    t.l.start()
    await synced(t)
    expect(t.notified()).toEqual([])
    hub.notifyUser(u.id, { ...notice, title: 'yeni' })
    await until(() => t.notified().length === 1)
    expect(t.notified()[0].title).toBe('yeni')
  })

  const reconnect = async (t: ReturnType<typeof link>, whileDown: () => void): Promise<void> => {
    const ready = t.events.filter((e) => e.event === 'agent:ready').length
    const socket = clients.at(-1)!
    const closed = new Promise((r) => socket.once('close', r))
    socket.terminate()
    await closed
    whileDown()
    await until(() => t.events.filter((e) => e.event === 'agent:ready').length > ready)
  }

  it('backlog after reconnect shows missed items', async () => {
    const u = await login()
    const t = link(u.token, { backoffMs: [60] })
    t.l.start()
    await synced(t)
    hub.notifyUser(u.id, { ...notice, title: 'görüldü' })
    await until(() => t.notified().length === 1)
    await reconnect(t, () => hub.notifyUser(u.id, { ...notice, title: 'kaçan' }))
    expect(t.notified().map((n) => n.title)).toEqual(['görüldü', 'kaçan'])
    expect(t.events.some((e) => e.event === 'agent:summary')).toBe(false)
    await reconnect(t, () => {})
    expect(t.notified()).toHaveLength(2) // aynı öge iki kez gösterilmez
  })

  it('more than five becomes summary', async () => {
    const u = await login()
    const t = link(u.token, { backoffMs: [60] })
    t.l.start()
    await synced(t)
    await reconnect(t, () => { for (let i = 0; i < 6; i++) hub.notifyUser(u.id, notice) })
    expect(t.notified()).toEqual([])
    expect(t.events.filter((e) => e.event === 'agent:summary').map((e) => e.data)).toEqual([{ count: 6, truncated: false }])
  })

  it('düşen öge varsa ajan söyler', async () => {
    const u = await login()
    const t = link(u.token, { backoffMs: [60] })
    t.l.start()
    await synced(t)
    await reconnect(t, () => { for (let i = 0; i < 60; i++) hub.notifyUser(u.id, notice) })
    expect(t.events.filter((e) => e.event === 'agent:summary').map((e) => e.data)).toEqual([{ count: 50, truncated: true }])
  })

  it('4401 stops retrying', async () => {
    const u = await login()
    const opens = (): number => clients.length
    const t = link(u.token)
    t.l.start()
    await synced(t)
    hub.closeSessionsWhere(() => true)
    await until(() => t.states.at(-1) === 'signedOut')
    await new Promise((r) => setTimeout(r, 100))
    expect(opens()).toBe(1)
    t.l.nudge() // uyanış da yeniden denetmez: geçersiz oturumla kapıyı dövme
    await new Promise((r) => setTimeout(r, 50))
    expect(opens()).toBe(1)
  })

  it('401 on upgrade means signedOut', async () => {
    const t = link('gecersiz')
    t.l.start()
    await until(() => t.states.at(-1) === 'signedOut')
    await new Promise((r) => setTimeout(r, 80))
    expect(t.states).toEqual(['signedOut'])
  })

  it('çerez yoksa bağlanılmaz', async () => {
    const t = link(null)
    t.l.start()
    await until(() => t.states.length === 1)
    expect(t.states).toEqual(['signedOut'])
    expect(clients).toHaveLength(0)
  })

  it('stop sonrası yeniden denenmez, bekleyen çağrı reddedilir', async () => {
    const u = await login()
    const t = link(u.token)
    t.l.start()
    await synced(t)
    t.l.stop()
    await expect(t.l.call('notifyAction', {})).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 60))
    expect(clients).toHaveLength(1)
  })

  it('token never in logs', async () => {
    const lines: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a) => void lines.push(a.map(String).join(' '))))
    const u = await login()
    const t = link(u.token)
    t.l.start()
    await synced(t)
    await expect(t.l.call('olmayanYontem', {})).rejects.toThrow()
    hub.closeSessionsWhere(() => true)
    await until(() => t.states.at(-1) === 'signedOut')
    spies.forEach((s) => s.mockRestore())
    expect(lines.join('\n')).not.toContain(u.token)
    expect(JSON.stringify(t.events)).not.toContain(u.token)
  })

  describe('sessiz bağlantı', () => {
    let wss: WebSocketServer
    let fakeOrigin: string
    const accepted: WebSocket[] = []
    beforeEach(async () => {
      accepted.length = 0
      wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
      await new Promise((r) => wss.once('listening', r))
      fakeOrigin = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`
      // RPC'ye yanıt verir ama ping atmaz
      wss.on('connection', (ws) => {
        accepted.push(ws)
        ws.on('message', (raw) => {
          const { id, method } = JSON.parse(raw.toString()) as { id: number; method: string }
          ws.send(JSON.stringify({ id, ok: true, result: method === 'notifyBacklog' ? { items: [], lastSeq: 1, truncated: false } : { id: 1 } }))
        })
      })
    })
    afterEach(() => new Promise<void>((r) => {
      for (const c of wss.clients) c.terminate()
      wss.close(() => r())
    }))

    it('silence terminates socket', async () => {
      const t = link('j', { origin: fakeOrigin, silenceMs: 60, backoffMs: [10] })
      t.l.start()
      await until(() => accepted.length === 2)
      expect(t.states).toContain('offline')
    })

    it('ping çerçevesi sessizlik sayılmaz', async () => {
      const t = link('j', { origin: fakeOrigin, silenceMs: 90 })
      t.l.start()
      await until(() => accepted.length === 1)
      const ping = setInterval(() => accepted[0].ping(), 20)
      await new Promise((r) => setTimeout(r, 200))
      clearInterval(ping)
      expect(accepted).toHaveLength(1)
    })

    it('uyanışta saat atlaması ölü soketi hemen düşürür', async () => {
      let clock = 1000
      const t = link('j', { origin: fakeOrigin, silenceMs: 60_000, now: () => clock, backoffMs: [10] })
      t.l.start()
      await synced(t)
      clock += 3_600_000 // bilgisayar uyudu: zamanlayıcılar durmuştu
      t.l.nudge()
      await until(() => accepted.length === 2)
    })

    it('nudge reconnects at once', async () => {
      const t = link('j', { origin: fakeOrigin, backoffMs: [60_000] })
      t.l.start()
      await synced(t)
      accepted[0].terminate()
      await until(() => t.states.at(-1) === 'offline')
      t.l.nudge()
      await until(() => accepted.length === 2)
    })
  })

  describe('taşıma gerçek bağlantıdan', () => {
    const PASSWORD = 'yerel-gercek-parola-93'
    const account = { email: 'a@t.co', displayName: 'Ad', imapHost: 'm.t.co', imapPort: 993, imapTls: 'tls', smtpHost: 'm.t.co', smtpPort: 465, smtpTls: 'tls', color: '#111111', signature: null, allowInvalidCerts: false, groupName: null, authType: 'password', secure: false, password: PASSWORD }
    const plan = [{ key: 'account:a@t.co', kind: 'account' as const, label: 'a@t.co', blocked: null }, { key: 'pref:pollCadenceSec', kind: 'pref' as const, label: 'p', blocked: null }]
    const payload: Record<string, unknown> = { 'account:a@t.co': { kind: 'account', data: account }, 'pref:pollCadenceSec': { kind: 'pref', data: { key: 'pollCadenceSec', value: '60' } } }
    const engine = {
      plan: async () => plan,
      seal: async (r: SealRequest) => r.keys.map((key) => sealItem(r.serverKey, r.importId, key, Buffer.from(JSON.stringify(payload[key]))))
    }

    it('yönetici: hesap ve tercih sunucuda, parola master anahtarla, defterde sır yok', async () => {
      const u = await login()
      db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(u.id)
      const t = link(u.token)
      t.l.start()
      await synced(t)
      const events: MigrationEvent[] = []
      await new MigrationRunner({ link: t.l, engine, confirm: async () => true, onEvent: (e) => events.push(e) }).run('kaynak', origin)
      expect(events.at(-1)).toMatchObject({ phase: 'done', done: 2, total: 2 })
      const row = q.getAccountRows()[0]
      expect(row.email).toBe('a@t.co')
      expect(Buffer.from(row.password_enc).toString('latin1')).not.toContain(PASSWORD)
      expect(q.prefGet('pollCadenceSec')).toBe('60')
      expect(JSON.stringify(db.prepare('SELECT * FROM import_ledger').all())).not.toContain(PASSWORD)
    })

    it('üye reddedilir, hiçbir şey yazılmaz', async () => {
      const u = await login()
      const t = link(u.token)
      t.l.start()
      await synced(t)
      const events: MigrationEvent[] = []
      const seal = vi.fn(engine.seal)
      await new MigrationRunner({ link: t.l, engine: { ...engine, seal }, confirm: async () => true, onEvent: (e) => events.push(e) }).run('kaynak', origin)
      expect(events.at(-1)).toMatchObject({ phase: 'paused', reason: 'connection' })
      expect(seal).not.toHaveBeenCalled()
      expect(q.getAccountRows()).toEqual([])
    })

    it('oturum rolü sync:hello ile görülür', async () => {
      const u = await login()
      const t = link(u.token)
      t.l.start()
      await synced(t)
      expect(t.events.find((e) => e.event === 'sync:hello')?.data).toMatchObject({ user: { role: 'member' } })
    })
  })
})

describe('shouldTellSignedOut', () => {
  it('süresi biten ajan söyler: pencere kapalıyken ya da oturum açıkken düşünce', () => {
    expect(shouldTellSignedOut({ focused: false, everOnline: true, hasWindow: true })).toBe(true)
    expect(shouldTellSignedOut({ focused: false, everOnline: true, hasWindow: false })).toBe(true)
    expect(shouldTellSignedOut({ focused: false, everOnline: false, hasWindow: false })).toBe(true) // gizli açılışta çerez dolmuş
  })
  it('giriş ekranı görünüyorsa söylemez: kendi çıkışı ya da ilk açılış', () => {
    expect(shouldTellSignedOut({ focused: true, everOnline: true, hasWindow: true })).toBe(false)
    expect(shouldTellSignedOut({ focused: false, everOnline: false, hasWindow: true })).toBe(false)
  })
})

describe('shouldShow', () => {
  it('odakta normal gösterilmez, acil gösterilir; odak dışında hepsi', () => {
    expect(shouldShow({ focused: true, level: 'normal' })).toBe(false)
    expect(shouldShow({ focused: true, level: 'urgent' })).toBe(true)
    expect(shouldShow({ focused: false, level: 'normal' })).toBe(true)
  })
})
