// POST /api/notify/action: bildirimden okundu/arşivle. Gerçek HTTP katmanı ve DB; IMAP'e gidilmez, işlem kuyruğa yazılır.
import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('POST /api/notify/action', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let server: http.Server
  let port: number
  let kick: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-action-'))
    db = openDb(dir)
    q = makeQueries(db)
    kick = vi.fn()
    const host = createServerHost(randomBytes(32), () => hub)
    const stub = new Proxy({}, { get: () => () => undefined })
    const deps: RpcServerDeps = {
      q, scheduler: stub as Scheduler, opq: { kick } as unknown as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: (v) => host.encrypt(v),
      decrypt: async (b) => (await host.decrypt(b)).map((u) => Buffer.from(u).toString('utf-8')),
      userData: dir, dbSchemaVersion: () => 0
    }
    hub = new RpcHub(deps, 'server')
    const cfg: ServerConfig = {
      dataDir: dir, listenHost: '127.0.0.1', listenPort: 0, keyFile: join(dir, 'master.key'), publicOrigin: ORIGIN, trustedProxyDepth: 0,
      webDir: join(dir, 'web')
    }
    server = createHttpServer({ cfg, hub, auth: new WebAuth(q, host) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; cookie: string }> =>
    new Promise((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port, method: 'POST', path, headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers } },
        (res) => {
          res.resume()
          res.on('end', () => resolve({ status: res.statusCode!, cookie: (res.headers['set-cookie']?.[0] ?? '').split(';')[0] }))
        }
      )
      r.on('error', reject)
      r.end(JSON.stringify(body))
    })

  const login = async (username: string, role: 'admin' | 'member' = 'member'): Promise<{ id: number; cookie: string }> => {
    const id = q.insertUser({ username, passwordHash: hashPassword(PW), role })
    return { id, cookie: (await post('/api/login', { username, password: PW })).cookie }
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
    const folderId = Number(db.prepare(`INSERT INTO folders (account_id, path, kind, special_use) VALUES (?, 'INBOX', 'inbox', 1)`).run(accountId).lastInsertRowid)
    const messageId = Number(
      db.prepare(
        `INSERT INTO messages (folder_id, account_id, folder_kind, uid, message_id, subject, from_name, from_addr, to_json, date, size, seen, preview, thread_root)
         VALUES (?, ?, 'inbox', 7, '<m@x>', 'Konu', 'G', 'g@x', '[]', ?, 10, 0, '', '<m@x>')`
      ).run(folderId, accountId, now).lastInsertRowid
    )
    return { accountId, messageId, group }
  }
  const ops = (): { kind: string; payload: Record<string, unknown> }[] =>
    (db.prepare(`SELECT kind, payload_json FROM op_queue`).all() as { kind: string; payload_json: string }[])
      .map((r) => ({ kind: r.kind, payload: JSON.parse(r.payload_json) as Record<string, unknown> }))
  const row = (id: number): { seen: number; hidden: number } => db.prepare(`SELECT seen, hidden FROM messages WHERE id = ?`).get(id) as { seen: number; hidden: number }

  it('action read marks seen: yerelde okundu, IMAP işlemi kuyrukta', async () => {
    const { messageId } = seed()
    const { cookie } = await login('ad', 'admin')
    const r = await post('/api/notify/action', { messageId, action: 'read' }, { cookie })
    expect(r.status).toBe(204)
    expect(row(messageId).seen).toBe(1)
    expect(ops()).toEqual([{ kind: 'store_flags', payload: { folderPath: 'INBOX', uids: [7], seen: true } }])
    expect(kick).toHaveBeenCalled()
  })

  it('arşivle: ileti gizlenir, taşıma kuyrukta; ikinci istek aynı işlemi yinelemez', async () => {
    const { messageId } = seed()
    const { cookie } = await login('ad', 'admin')
    expect((await post('/api/notify/action', { messageId, action: 'archive' }, { cookie })).status).toBe(204)
    expect(row(messageId).hidden).toBe(1)
    expect(ops()).toEqual([{ kind: 'move_special', payload: { folderPath: 'INBOX', uids: [7], special: 'archive' } }])
    expect((await post('/api/notify/action', { messageId, action: 'archive' }, { cookie })).status).toBe(204)
    expect(ops()).toHaveLength(1)
  })

  it('action on invisible account 403: hiçbir şey değişmez', async () => {
    const { messageId } = seed()
    const { cookie } = await login('mem')
    expect((await post('/api/notify/action', { messageId, action: 'read' }, { cookie })).status).toBe(403)
    expect((await post('/api/notify/action', { messageId, action: 'archive' }, { cookie })).status).toBe(403)
    expect(row(messageId)).toEqual({ seen: 0, hidden: 0 })
    expect(ops()).toEqual([])
  })

  it('yalnız görme izni: okundu olur (markSeen gibi), arşivleme 403 (moveSpecial gibi)', async () => {
    const { messageId, group } = seed()
    const { id, cookie } = await login('mem')
    q.setGroupPermission(id, group, true, false)
    expect((await post('/api/notify/action', { messageId, action: 'archive' }, { cookie })).status).toBe(403)
    expect(row(messageId).hidden).toBe(0)
    expect((await post('/api/notify/action', { messageId, action: 'read' }, { cookie })).status).toBe(204)
    expect(row(messageId).seen).toBe(1)
  })

  it('yönetme izni olan üye arşivler', async () => {
    const { messageId, group } = seed()
    const { id, cookie } = await login('mem')
    q.setGroupPermission(id, group, false, true)
    expect((await post('/api/notify/action', { messageId, action: 'archive' }, { cookie })).status).toBe(204)
  })

  it('kasa kilitliyken (ileti locked) eylem yok: 403, hiçbir şey değişmez', async () => {
    const { messageId } = seed()
    db.prepare(`UPDATE messages SET enc = 1 WHERE id = ?`).run(messageId) // anahtar yok: kilitli
    const { cookie } = await login('ad', 'admin')
    expect((await post('/api/notify/action', { messageId, action: 'read' }, { cookie })).status).toBe(403)
    expect((await post('/api/notify/action', { messageId, action: 'archive' }, { cookie })).status).toBe(403)
    expect(row(messageId)).toEqual({ seen: 0, hidden: 0 })
    expect(ops()).toEqual([])
  })

  it('olmayan ileti de 403: var olanla ayırt edilmez', async () => {
    seed()
    const { cookie } = await login('mem')
    expect((await post('/api/notify/action', { messageId: 999, action: 'read' }, { cookie })).status).toBe(403)
  })

  it('cross-origin 403', async () => {
    const { messageId } = seed()
    const { cookie } = await login('ad', 'admin')
    const r = await post('/api/notify/action', { messageId, action: 'read' }, { cookie, origin: 'https://kotu.example.com' })
    expect(r.status).toBe(403)
    expect(row(messageId).seen).toBe(0)
  })

  it('oturumsuz 401, JSON olmayan 415, bozuk gövde 400', async () => {
    const { messageId } = seed()
    expect((await post('/api/notify/action', { messageId, action: 'read' })).status).toBe(401)
    const { cookie } = await login('ad', 'admin')
    expect((await post('/api/notify/action', { messageId, action: 'read' }, { cookie, 'content-type': 'text/plain' })).status).toBe(415)
    expect((await post('/api/notify/action', { messageId, action: 'sil' }, { cookie })).status).toBe(400)
    expect((await post('/api/notify/action', { messageId: 'x', action: 'read' }, { cookie })).status).toBe(400)
  })
})
