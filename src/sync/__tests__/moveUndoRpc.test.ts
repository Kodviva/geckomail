import type Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '../../shared/rpc'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import type { OpQueue } from '../opQueue'
import { RpcHub } from '../rpcHub'
import type { Scheduler } from '../scheduler'

// Taşımada Geri Al: op gecikmeli kuyruğa girer, pencere içinde iptal edilip iletiler görünür olur
type Handle = { handle(method: string, params: unknown): Promise<unknown>; currentUser: SessionUser | null }

describe('taşıma geri alma', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let srv: Handle
  let acc: number
  let inbox: number
  let target: number
  let other: number
  const msgs: number[] = []
  const sent: string[] = []
  const admin: SessionUser = { id: 1, username: 'y', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] }
  const hidden = (id: number): number => (db.prepare(`SELECT hidden FROM messages WHERE id = ?`).get(id) as { hidden: number }).hidden
  const moves = (): { id: number; not_before: number | null }[] => db.prepare(`SELECT * FROM op_queue WHERE kind = 'move'`).all() as never

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-move-'))
    mkdirSync(join(dir, 'att'))
    db = openDb(dir)
    q = makeQueries(db)
    acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    inbox = q.upsertFolder(acc, 'INBOX', 'inbox')
    target = q.upsertFolder(acc, 'Projeler', 'other')
    other = q.upsertFolder(acc, 'Eski', 'other')
    msgs.length = 0
    const add = (folder: number, uid: number, kind: string): number =>
      Number(
        db.prepare(`INSERT INTO messages (folder_id, account_id, folder_kind, uid, date, subject, thread_root) VALUES (?,?,?,?,?,?,?)`)
          .run(folder, acc, kind, uid, 1000, 'konu', `<r${uid}>`).lastInsertRowid
      )
    msgs.push(add(inbox, 1, 'inbox'), add(inbox, 2, 'inbox'), add(other, 3, 'other'))
    const stub = new Proxy({}, { get: () => () => undefined })
    const fakePort = { send: (m: unknown) => void sent.push(JSON.stringify(m)), onMessage() {}, onClose() {}, close() {} }
    srv = new RpcHub({
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: async (v) => v.map((s) => new TextEncoder().encode(s)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)),
      userData: dir, dbSchemaVersion: () => 0
    }, 'desktop').openSession(fakePort) as unknown as Handle
    srv.currentUser = admin
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  type Moved = { moved: number; skipped: number; undoToken?: number }

  it('Geri Al penceresi: op gecikmeli, iptal edilince iletiler görünür', async () => {
    const before = Date.now()
    const r = (await srv.handle('moveMessages', { messageIds: msgs, targetFolderId: target })) as Moved
    expect(r).toMatchObject({ moved: 3, skipped: 0 })
    expect(moves()).toHaveLength(2) // kaynak klasör başına bir op
    for (const op of moves()) expect(op.not_before).toBeGreaterThan(before)
    expect(msgs.map(hidden)).toEqual([1, 1, 1])

    await srv.handle('undoMove', { undoToken: r.undoToken })
    expect(moves()).toHaveLength(0)
    expect(msgs.map(hidden)).toEqual([0, 0, 0])
  })

  it('uzun konunun bütün üyeleri alınır: görünüm sınırı (100) taşımayı kesmez', async () => {
    const add = db.prepare(`INSERT INTO messages (folder_id, account_id, folder_kind, uid, date, subject, thread_root) VALUES (?,?,?,?,?,?,?)`)
    for (let uid = 100; uid < 250; uid++) add.run(inbox, acc, 'inbox', uid, 1000 + uid, 'konu', '<uzun>')
    const rows = (await srv.handle('getThreadMembers', { threadRoot: '<uzun>', folderKind: 'inbox' })) as { id: number; accountId: number; folderId: number }[]
    expect(rows).toHaveLength(150)
    expect(rows[0]).toEqual({ id: expect.any(Number), accountId: acc, folderId: inbox })
    expect(await srv.handle('getThread', { threadRoot: '<uzun>', folderKind: 'inbox' })).toHaveLength(100)
  })

  it('üye konuda yalnız görebildiği hesabın iletilerini alır', async () => {
    srv.currentUser = { id: 2, username: 'u', role: 'member', permittedGroupIds: [], manageableGroupIds: [] }
    expect(await srv.handle('getThreadMembers', { threadRoot: '<r1>', folderKind: 'inbox' })).toEqual([])
    srv.currentUser = admin
    expect(await srv.handle('getThreadMembers', { threadRoot: '<r1>', folderKind: 'inbox' })).toHaveLength(1)
  })

  it('jeton bir kez geçerli', async () => {
    const r = (await srv.handle('moveMessages', { messageIds: [msgs[0]], targetFolderId: target })) as Moved
    await srv.handle('undoMove', { undoToken: r.undoToken })
    await expect(srv.handle('undoMove', { undoToken: r.undoToken })).rejects.toThrow()
  })

  it('kısmen işlenmişse iptal edilen grup yine görünür olur, çok geç hatası döner', async () => {
    const r = (await srv.handle('moveMessages', { messageIds: msgs, targetFolderId: target })) as Moved
    expect(q.claimDueOps(Date.now() + 60_000, 1)).toHaveLength(1) // kuyruk ilk grubu (INBOX) sahiplendi
    await expect(srv.handle('undoMove', { undoToken: r.undoToken })).rejects.toThrow('Çok geç')
    expect(msgs.map(hidden)).toEqual([1, 1, 0])
    expect(moves()).toHaveLength(1) // işlenen op durur
  })

  it('sahiplenilen silme de geri alınamaz (undoDelete aynı kapıdan geçer)', async () => {
    const { undoToken } = (await srv.handle('deleteMessages', { messageIds: [msgs[0]] })) as { undoToken: number }
    q.claimDueOps(Date.now() + 60_000, 10)
    await expect(srv.handle('undoDelete', { undoToken })).rejects.toThrow('Çok geç')
    expect(hidden(msgs[0])).toBe(1)
  })

  it('kısmen işlenmiş silmede iptal edilen grup yine görünür olur, çok geç hatası döner', async () => {
    const { undoToken } = (await srv.handle('deleteMessages', { messageIds: msgs })) as { undoToken: number }
    expect(q.claimDueOps(Date.now() + 60_000, 1)).toHaveLength(1) // kuyruk ilk grubu (INBOX) sahiplendi
    await expect(srv.handle('undoDelete', { undoToken })).rejects.toThrow('Çok geç')
    expect(msgs.map(hidden)).toEqual([1, 1, 0]) // iptal edilen grup op'suz gizli kalmaz
  })

  it('çıkış geri alma jetonlarını siler', async () => {
    const r = (await srv.handle('moveMessages', { messageIds: [msgs[0]], targetFolderId: target })) as Moved
    await srv.handle('logout', {})
    srv.currentUser = admin
    await expect(srv.handle('undoMove', { undoToken: r.undoToken })).rejects.toThrow()
    expect(hidden(msgs[0])).toBe(1)
  })

  it('yetki pencere içinde kalkarsa geri alınamaz', async () => {
    const r = (await srv.handle('moveMessages', { messageIds: [msgs[0]], targetFolderId: target })) as Moved
    srv.currentUser = { id: 2, username: 'u', role: 'member', permittedGroupIds: [], manageableGroupIds: [] }
    await expect(srv.handle('undoMove', { undoToken: r.undoToken })).rejects.toThrow('yetkiniz yok')
    expect(moves()).toHaveLength(1)
  })

  it('taşıma diğer oturumlara messages:changed yayınlar', async () => {
    sent.length = 0
    await srv.handle('moveMessages', { messageIds: [msgs[0]], targetFolderId: target })
    expect(sent.join()).toContain('messages:changed')
  })

  it('hiçbir şey taşınmadıysa geri alma jetonu yok', async () => {
    const r = (await srv.handle('moveMessages', { messageIds: [msgs[0]], targetFolderId: inbox })) as Moved
    expect(r).toEqual({ moved: 0, skipped: 1 })
  })
})
