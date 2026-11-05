// Bildirim eylemi çekirdeği: masaüstünde pencere kapalıyken oturum yok, kim adına yapılacağı burada belirlenir.
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPassword } from '../auth/password'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { applyNotifyAction, hostActor, notifyActionsFor } from '../notifyActions'
import type { OpQueue } from '../opQueue'
import { RpcHub, type RpcServerDeps } from '../rpcHub'
import type { Scheduler } from '../scheduler'

describe('hostActor ve eylemler', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let accountId: number
  let group: number
  let messageId: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-actor-'))
    db = openDb(dir)
    q = makeQueries(db)
    const stub = new Proxy({}, { get: () => () => undefined })
    hub = new RpcHub({ q, scheduler: stub as Scheduler, opq: { kick: vi.fn() } as unknown as OpQueue, creds: new Map(), attachDir: join(dir, 'a'), userData: dir, dbSchemaVersion: () => 0 } as unknown as RpcServerDeps, 'desktop')
    accountId = Number(db.prepare(`INSERT INTO accounts (email, display_name, imap_host, imap_port, smtp_host, smtp_port, password_enc, created_at) VALUES ('a@example.test', 'A', 'h', 993, 'h', 587, ?, 1)`).run(Buffer.from('x')).lastInsertRowid)
    group = q.insertGroup('G', '#111111')
    q.setAccountGroup(accountId, group)
    const folder = Number(db.prepare(`INSERT INTO folders (account_id, path, kind) VALUES (?, 'INBOX', 'inbox')`).run(accountId).lastInsertRowid)
    messageId = Number(db.prepare(`INSERT INTO messages (folder_id, account_id, folder_kind, uid, subject, date) VALUES (?, ?, 'inbox', 7, 'Konu', 1)`).run(folder, accountId).lastInsertRowid)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const user = (username: string, role: 'admin' | 'member' = 'admin'): number => q.insertUser({ username, passwordHash: hashPassword('p'), role })
  const ops = (): number => (db.prepare(`SELECT COUNT(*) AS n FROM op_queue`).get() as { n: number }).n
  const session = (id: number, role: 'admin' | 'member' = 'admin') => hub.openSession({ send() {}, onMessage() {}, onClose() {}, close() {} }).currentUser = { id, username: 'x', role, permittedGroupIds: [], manageableGroupIds: [] }

  it('no session single user acts', () => {
    const id = user('tek')
    const actor = hostActor(hub)
    expect(actor?.id).toBe(id)
    expect(applyNotifyAction(hub, actor!, { messageId, action: 'read' })).toBe(true)
    expect(q.getMessages([messageId])[0].seen).toBeTruthy()
  })

  it('no session multi user opens window', () => {
    user('bir')
    user('iki')
    expect(hostActor(hub)).toBeNull()
  })

  it('hiç kullanıcı yoksa eylem yok, devre dışı kullanıcı sayılmaz', () => {
    expect(hostActor(hub)).toBeNull()
    const a = user('bir')
    const b = user('iki')
    db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(b)
    expect(hostActor(hub)?.id).toBe(a)
  })

  it('canlı oturum varsa onun kullanıcısı, yetkileri DB\'den', () => {
    const a = user('bir', 'member')
    user('iki')
    q.setGroupPermission(a, group, true, false)
    session(a, 'admin') // oturumdaki rol bayat
    const actor = hostActor(hub)
    expect(actor).toMatchObject({ id: a, role: 'member' })
  })

  it('member cannot archive', () => {
    const a = user('uye', 'member')
    q.setGroupPermission(a, group, true, false)
    const actor = hostActor(hub)!
    expect(applyNotifyAction(hub, actor, { messageId, action: 'archive' })).toBe(false)
    expect(q.isMessageHidden(messageId)).toBe(false)
    expect(notifyActionsFor(q, actor, { accountId, messageId })).toEqual(['read'])
  })

  it('locked vault falls back to open', () => {
    const actor = (user('tek'), hostActor(hub)!)
    db.prepare('UPDATE accounts SET secure = 1 WHERE id = ?').run(accountId)
    db.prepare('UPDATE messages SET enc = 1 WHERE id = ?').run(messageId) // anahtar yok: kilitli
    q.refreshSecureAccounts()
    expect(applyNotifyAction(hub, actor, { messageId, action: 'read' })).toBe(false)
    expect(ops()).toBe(0)
    expect(notifyActionsFor(q, actor, { accountId, messageId })).toEqual([])
  })

  it('read twice queues one op', () => {
    const actor = (user('tek'), hostActor(hub)!)
    expect(applyNotifyAction(hub, actor, { messageId, action: 'read' })).toBe(true)
    expect(applyNotifyAction(hub, actor, { messageId, action: 'read' })).toBe(true)
    expect(ops()).toBe(1)
  })
})
