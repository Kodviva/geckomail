// Masaüstü ajanının sunucu yüzü: gerçek HTTP katmanı, WebSocket ve DB. IMAP'e gidilmez.
import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import '../../shared/i18n/locales/all'
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

const PW = 'dogru-parola-1'
const ORIGIN = 'https://posta.example.com'

interface Reply { id?: number; result?: unknown; error?: string; event?: string; data?: unknown }

describe('masaüstü ajanı sunucu yüzü', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let auth: WebAuth
  let server: http.Server
  let port: number
  const sockets: WebSocket[] = []

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-desktop-'))
    db = openDb(dir)
    q = makeQueries(db)
    const host = createServerHost(randomBytes(32), () => hub)
    const stub = new Proxy({}, { get: () => () => undefined })
    const deps: RpcServerDeps = {
      q, scheduler: stub as Scheduler, opq: { kick: vi.fn() } as unknown as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: (v) => host.encrypt(v),
      decrypt: async (b) => (await host.decrypt(b)).map((u) => Buffer.from(u).toString('utf-8')),
      userData: dir, dbSchemaVersion: () => 0
    }
    hub = new RpcHub(deps, 'server')
    auth = new WebAuth(q, host)
    const cfg: ServerConfig = {
      dataDir: dir, listenHost: '127.0.0.1', listenPort: 0, keyFile: join(dir, 'master.key'), publicOrigin: ORIGIN, trustedProxyDepth: 0,
      webDir: join(dir, 'web')
    }
    server = createHttpServer({ cfg, hub, auth })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate()
    await new Promise<void>((r) => server.close(() => r()))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const request = (method: string, path: string, body?: unknown, cookie?: string): Promise<{ status: number; text: string; cookie: string }> =>
    new Promise((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port, method, path, headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString(), cookie: (res.headers['set-cookie']?.[0] ?? '').split(';')[0] }))
        }
      )
      r.on('error', reject)
      r.end(body === undefined ? undefined : JSON.stringify(body))
    })

  const login = async (username: string, role: 'admin' | 'member' = 'member'): Promise<{ id: number; cookie: string }> => {
    const id = q.insertUser({ username, passwordHash: hashPassword(PW), role })
    return { id, cookie: (await request('POST', '/api/login', { username, password: PW })).cookie }
  }

  /** Çerezli gerçek WebSocket; `call` RPC yanıtını döner, yanıt `error` ise reddeder */
  const connect = async (cookie: string): Promise<{ ws: WebSocket; call: (method: string, params: unknown) => Promise<unknown>; closed: Promise<number> }> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { headers: { cookie, origin: ORIGIN } })
    sockets.push(ws)
    const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
    let seq = 0
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as Reply
      if (m.id === undefined) return
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (m.error !== undefined) p?.reject(new Error(String(m.error)))
      else p?.resolve(m.result)
    })
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    return {
      ws, closed,
      call: (method, params) => new Promise((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    }
  }

  /** Grupta bir hesap ve okunmamış ileti */
  const seed = (): { accountId: number; messageId: number; group: number } => {
    const now = Date.now()
    const accountId = Number(
      db.prepare(
        `INSERT INTO accounts (email, display_name, imap_host, imap_port, smtp_host, smtp_port, password_enc, created_at)
         VALUES ('a@example.test', 'A', 'h', 993, 'h', 587, ?, ?)`
      ).run(Buffer.from('x'), now).lastInsertRowid
    )
    const group = q.insertGroup('G', '#111111')
    q.setAccountGroup(accountId, group)
    const folder = Number(db.prepare(`INSERT INTO folders (account_id, path, kind) VALUES (?, 'INBOX', 'inbox')`).run(accountId).lastInsertRowid)
    const messageId = Number(
      db.prepare(
        `INSERT INTO messages (folder_id, account_id, folder_kind, uid, subject, date) VALUES (?, ?, 'inbox', 7, 'Konu', ?)`
      ).run(folder, accountId, now).lastInsertRowid
    )
    return { accountId, messageId, group }
  }

  describe('GET /api/server-info', () => {
    it('server-info exposes no version', async () => {
      const r = await request('GET', '/api/server-info')
      expect(r.status).toBe(200)
      const info = JSON.parse(r.text) as Record<string, unknown>
      expect(Object.keys(info).sort()).toEqual(['app', 'desktopApi', 'origin'])
      expect(r.text).not.toMatch(/version|\d+\.\d+\.\d+/i)
    })

    it('server-info origin equals publicOrigin', async () => {
      expect(JSON.parse((await request('GET', '/api/server-info')).text)).toEqual({ app: 'geckomail', desktopApi: 1, origin: ORIGIN })
    })
  })

  describe('registerDesktopAgent', () => {
    it('oturuma bağlı desktop cihazı yazar, yenisini açmaz', async () => {
      const u = await login('ali')
      const { call } = await connect(u.cookie)
      const r = (await call('registerDesktopAgent', { deviceId: 'cihaz-1', label: 'Mac' })) as { id: number }
      expect((await call('registerDesktopAgent', { deviceId: 'cihaz-1', label: 'Mac' }) as { id: number }).id).toBe(r.id)
      const d = q.getPushDevice(r.id)!
      expect(d).toMatchObject({ user_id: u.id, endpoint: `desktop:${u.id}:cihaz-1`, kind: 'desktop', p256dh: '', auth: '', label: 'Mac' })
      expect(d.web_session_id).toBeTruthy()
      expect(q.listPushDevices(u.id)).toHaveLength(1)
    })

    it('aynı cihaz kimliği başka kullanıcının satırını devralmaz', async () => {
      const a = await login('ali')
      const b = await login('ayse')
      const ra = (await (await connect(a.cookie)).call('registerDesktopAgent', { deviceId: 'cihaz-1', label: 'Mac' })) as { id: number }
      const rb = (await (await connect(b.cookie)).call('registerDesktopAgent', { deviceId: 'cihaz-1', label: 'Mac' })) as { id: number }
      expect(rb.id).not.toBe(ra.id)
      expect(q.getPushDevice(ra.id)!.user_id).toBe(a.id)
      expect(q.getPushDevice(rb.id)!.user_id).toBe(b.id)
    })

    it('oturum başına tek ajan satırı', async () => {
      const u = await login('ali')
      const { call } = await connect(u.cookie)
      for (const deviceId of ['c1', 'c2', 'c3']) await call('registerDesktopAgent', { deviceId, label: 'Mac' })
      expect(q.listPushDevices(u.id).map((d) => d.endpoint)).toEqual([`desktop:${u.id}:c3`])
    })

    it('web oturumu olmayan bağlantı kaydolamaz', async () => {
      const u = await login('ali')
      const user = { id: u.id, username: 'ali', role: 'member' as const, permittedGroupIds: [], manageableGroupIds: [] }
      const s = hub.openSession({ send() {}, onMessage() {}, onClose() {}, close() {} }, { user })
      await expect(hub.invoke(s, 'registerDesktopAgent', { deviceId: 'c', label: 'Mac' })).rejects.toThrow()
      expect(q.listPushDevices(u.id)).toEqual([])
    })

    it('bozuk parametre reddedilir', async () => {
      const u = await login('ali')
      const { call } = await connect(u.cookie)
      await expect(call('registerDesktopAgent', { deviceId: '../x', label: 'Mac' })).rejects.toThrow()
      await expect(call('registerDesktopAgent', { deviceId: 'a'.repeat(200), label: 'Mac' })).rejects.toThrow()
      await expect(call('registerDesktopAgent', { deviceId: 'a', label: 5 })).rejects.toThrow()
      expect(q.listPushDevices(u.id)).toEqual([])
    })
  })

  describe('cihaz listesi', () => {
    it('logout removes desktop device', async () => {
      const u = await login('ali')
      const { call } = await connect(u.cookie)
      const { id } = (await call('registerDesktopAgent', { deviceId: 'c', label: 'Mac' })) as { id: number }
      expect((await request('POST', '/api/logout', {}, u.cookie)).status).toBe(204)
      expect(q.getPushDevice(id)).toBeUndefined()
    })

    it('removing desktop device closes its session', async () => {
      const u = await login('ali')
      const agent = await connect(u.cookie)
      const { id } = (await agent.call('registerDesktopAgent', { deviceId: 'c', label: 'Mac' })) as { id: number }
      const other = (await request('POST', '/api/login', { username: 'ali', password: PW })).cookie
      expect((await request('DELETE', `/api/push/devices/${id}`, undefined, other)).status).toBe(204)
      expect(await agent.closed).toBe(4401)
      expect((await request('GET', '/api/me', undefined, u.cookie)).status).toBe(401)
      expect((await request('GET', '/api/me', undefined, other)).status).toBe(200)
    })

    it('webpush cihazı kaldırmak oturumu kapatmaz', async () => {
      const u = await login('ali')
      const { sessionId } = auth.resolve(u.cookie.split('=')[1])!
      const id = q.upsertPushDevice({ userId: u.id, sessionId, endpoint: 'https://fcm.googleapis.com/x', p256dh: 'p', auth: 'a', label: null, now: 1 })
      expect((await request('DELETE', `/api/push/devices/${id}`, undefined, u.cookie)).status).toBe(204)
      expect((await request('GET', '/api/me', undefined, u.cookie)).status).toBe(200)
    })

    it('başkasının desktop cihazı kaldırılamaz', async () => {
      const a = await login('ali')
      const b = await login('ayse')
      const agent = await connect(a.cookie)
      const { id } = (await agent.call('registerDesktopAgent', { deviceId: 'c', label: 'Mac' })) as { id: number }
      expect((await request('DELETE', `/api/push/devices/${id}`, undefined, b.cookie)).status).toBe(404)
      expect(q.getPushDevice(id)).toBeDefined()
      expect((await request('GET', '/api/me', undefined, a.cookie)).status).toBe(200)
    })
  })

  describe('notifyAction', () => {
    it('yönetici okundu ve arşivler', async () => {
      const { messageId } = seed()
      const u = await login('yonetici', 'admin')
      const { call } = await connect(u.cookie)
      expect(await call('notifyAction', { messageId, action: 'read' })).toEqual({ ok: true })
      expect(await call('notifyAction', { messageId, action: 'archive' })).toEqual({ ok: true })
      expect(q.isMessageHidden(messageId)).toBe(true)
    })

    it('notifyAction forbidden for member', async () => {
      const { messageId, group } = seed()
      const u = await login('uye')
      q.setGroupPermission(u.id, group, true, false)
      const { call } = await connect(u.cookie)
      expect(await call('notifyAction', { messageId, action: 'archive' })).toEqual({ ok: false })
      expect(q.isMessageHidden(messageId)).toBe(false)
      expect(await call('notifyAction', { messageId, action: 'read' })).toEqual({ ok: true })
    })

    it('hesabı görmeyen üye okundu da yapamaz', async () => {
      const { messageId } = seed()
      const u = await login('uye')
      const { call } = await connect(u.cookie)
      expect(await call('notifyAction', { messageId, action: 'read' })).toEqual({ ok: false })
    })

    it('reply ve bozuk parametre reddedilir', async () => {
      const { messageId } = seed()
      const u = await login('yonetici', 'admin')
      const { call } = await connect(u.cookie)
      expect(await call('notifyAction', { messageId, action: 'reply' })).toEqual({ ok: false })
      expect(await call('notifyAction', { messageId: 'x', action: 'read' })).toEqual({ ok: false })
    })

    it('izni az önce kalkan üye bayat oturumla eylem yapamaz', async () => {
      const { messageId, group } = seed()
      const u = await login('uye')
      q.setGroupPermission(u.id, group, true, true)
      const { call } = await connect(u.cookie)
      q.setGroupPermission(u.id, group, true, false)
      expect(await call('notifyAction', { messageId, action: 'archive' })).toEqual({ ok: false })
      expect(q.isMessageHidden(messageId)).toBe(false)
    })

    it('devre dışı kullanıcının bayat oturumu reddedilir', async () => {
      const { messageId, group } = seed()
      const u = await login('uye')
      q.setGroupPermission(u.id, group, true, true)
      const { call } = await connect(u.cookie)
      db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(u.id)
      await expect(call('notifyAction', { messageId, action: 'read' })).rejects.toThrow()
      await expect(call('notifyBacklog', { afterSeq: 0 })).rejects.toThrow()
    })

    it('notifyAction requires session', async () => {
      const { messageId } = seed()
      const s = hub.openSession({ send() {}, onMessage() {}, onClose() {}, close() {} })
      await expect(hub.invoke(s, 'notifyAction', { messageId, action: 'read' })).rejects.toThrow()
      await expect(hub.invoke(s, 'registerDesktopAgent', { deviceId: 'c', label: 'Mac' })).rejects.toThrow()
      await expect(hub.invoke(s, 'notifyBacklog', { afterSeq: 0 })).rejects.toThrow()
    })
  })

  describe('notifyBacklog', () => {
    const notice = { title: 'T', body: 'B', accountId: null, messageId: null, level: 'normal' as const, tag: 't', count: 1, actions: [] }

    it('bağlı olmayan ajan kaçırdığını sonradan alır, başka kullanıcınınkini almaz', async () => {
      const a = await login('ali')
      const b = await login('ayse')
      const agent = await connect(a.cookie)
      const { lastSeq } = (await agent.call('notifyBacklog', { afterSeq: 0 })) as { lastSeq: number }
      hub.notifyUser(a.id, notice)
      const r = (await agent.call('notifyBacklog', { afterSeq: lastSeq })) as { items: { title: string; seq: number }[]; lastSeq: number }
      expect(r.items.map((i) => i.title)).toEqual(['T'])
      expect(r.lastSeq).toBe(r.items[0].seq)
      const other = await connect(b.cookie)
      expect(((await other.call('notifyBacklog', { afterSeq: 0 })) as { items: unknown[] }).items).toEqual([])
    })

    it('izni bayat oturumda kalkan hesabın ögesi de verilmez', async () => {
      const { accountId, group } = seed()
      const u = await login('uye')
      q.setGroupPermission(u.id, group, true, false)
      const agent = await connect(u.cookie)
      const { lastSeq } = (await agent.call('notifyBacklog', { afterSeq: 0 })) as { lastSeq: number }
      hub.notifyUser(u.id, { ...notice, accountId })
      q.setGroupPermission(u.id, group, false, false)
      expect((await agent.call('notifyBacklog', { afterSeq: lastSeq })) as { items: unknown[] }).toMatchObject({ items: [] })
    })

    it('kasa hesabının metni kuyruğa yazılmaz, açık oturum yine görür', async () => {
      const { accountId } = seed()
      db.prepare('UPDATE accounts SET secure = 1 WHERE id = ?').run(accountId)
      q.refreshSecureAccounts()
      const u = await login('yonetici', 'admin')
      const agent = await connect(u.cookie)
      const { lastSeq } = (await agent.call('notifyBacklog', { afterSeq: 0 })) as { lastSeq: number }
      const live = new Promise<{ title: string }>((resolve) => agent.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as Reply
        if (m.event === 'server:notify') resolve(m.data as { title: string })
      }))
      hub.notifyUser(u.id, { ...notice, title: 'Gizli', body: 'Gövde', tag: 'notice:Gizli', accountId })
      expect((await live).title).toBe('Gizli')
      hub.notifySessions({ title: 'Gizli', body: 'Gövde', accountId }, () => true)
      const r = (await agent.call('notifyBacklog', { afterSeq: lastSeq })) as { items: unknown[]; truncated: boolean }
      expect(r.items).toHaveLength(2)
      expect(r.truncated).toBe(false)
      expect(JSON.stringify(r.items)).not.toMatch(/Gizli|Gövde/)
    })

    it('öge yazıldıktan sonra kasaya alınan hesabın metni okurken maskelenir', async () => {
      const { accountId, messageId } = seed()
      const u = await login('yonetici', 'admin')
      const agent = await connect(u.cookie)
      const { lastSeq } = (await agent.call('notifyBacklog', { afterSeq: 0 })) as { lastSeq: number }
      hub.notifyUser(u.id, { ...notice, title: 'Gizli', body: 'Gövde', tag: 'notice:Gizli', accountId, messageId, actions: ['read', 'archive'] })
      const plain = (await agent.call('notifyBacklog', { afterSeq: lastSeq })) as { items: { title: string }[] }
      expect(plain.items[0].title).toBe('Gizli')
      db.prepare('UPDATE accounts SET secure = 1 WHERE id = ?').run(accountId)
      q.refreshSecureAccounts()
      const { items } = (await agent.call('notifyBacklog', { afterSeq: lastSeq })) as { items: { seq: number }[] }
      expect(items).toEqual([{ ...notice, title: '', body: '', tag: `masked:${items[0].seq}`, accountId, messageId, actions: [], seq: items[0].seq }])
    })

    it('düşen öge varsa truncated döner', async () => {
      const u = await login('ali')
      const agent = await connect(u.cookie)
      const { lastSeq } = (await agent.call('notifyBacklog', { afterSeq: 0 })) as { lastSeq: number }
      for (let i = 0; i < 60; i++) hub.notifyUser(u.id, notice)
      expect((await agent.call('notifyBacklog', { afterSeq: lastSeq })) as object).toMatchObject({ truncated: true })
    })

    it('izni kalkan hesabın ögesi verilmez', async () => {
      const { accountId, group } = seed()
      const u = await login('uye')
      q.setGroupPermission(u.id, group, true, false)
      hub.notifyUser(u.id, { ...notice, accountId })
      const { call } = await connect(u.cookie)
      expect(((await call('notifyBacklog', { afterSeq: 0 })) as { items: unknown[] }).items).toHaveLength(1)
      q.setGroupPermission(u.id, group, false, false)
      await new Promise<void>((r) => server.close(() => r()))
      await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
      const again = await connect(u.cookie)
      expect(((await again.call('notifyBacklog', { afterSeq: 0 })) as { items: unknown[] }).items).toEqual([])
    })

    it('bildirim olayı sıra numarası ve eylem taşır', async () => {
      const u = await login('ali')
      const { ws } = await connect(u.cookie)
      const got = new Promise<Reply>((resolve) => ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as Reply
        if (m.event === 'server:notify') resolve(m)
      }))
      hub.notifyUser(u.id, { ...notice, actions: ['read'] })
      expect((await got).data).toMatchObject({ title: 'T', actions: ['read'], seq: expect.any(Number) })
    })
  })
})
