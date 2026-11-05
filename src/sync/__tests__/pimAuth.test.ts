import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PimCollectionInfo, PimSourceInfo } from '../../shared/pim'
import type { RpcEvents, SessionUser } from '../../shared/rpc'
import { openDb } from '../db'
import { makeQueries, type PimSourceRow } from '../db/queries'
import type { OpQueue } from '../opQueue'
import { assertCollectionRead, assertCollectionWrite, canReadSource, canWriteSource, emitPimChanged, ensureLocalSource, visibleCollectionIds } from '../rpc/pimAuth'
import { RpcHub } from '../rpcHub'
import type { RpcSession } from '../rpcSession'
import type { Scheduler } from '../scheduler'

// §10.1: hesaba bağlı kaynak hesabın yetkisini izler, kişisel kaynağı yalnız sahibi görür (yönetici dahil).
describe('PIM yetkisi', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let acc: number
  let group: number
  let member: number
  let other: number
  let admin: number
  const stub = new Proxy({}, { get: () => () => undefined })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-pim-'))
    db = openDb(dir)
    q = makeQueries(db)
    acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    group = q.insertGroup('A', '#111111')
    q.setAccountGroup(acc, group)
    member = q.insertUser({ username: 'uye', passwordHash: 'x', role: 'member' })
    other = q.insertUser({ username: 'diger', passwordHash: 'x', role: 'member' })
    admin = q.insertUser({ username: 'yon', passwordHash: 'x', role: 'admin' })
    hub = new RpcHub({
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: async (v) => v.map((s) => new TextEncoder().encode(s)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)),
      userData: dir, dbSchemaVersion: () => 0
    }, 'server')
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const sent = (): unknown[] => []
  const session = (id: number, log: unknown[] = sent()): RpcSession => {
    const row = q.getUserById(id)!
    const user: SessionUser = { id, username: row.username, role: row.role, permittedGroupIds: q.getPermittedGroupIds(id), manageableGroupIds: q.getManageableGroupIds(id) }
    return hub.openSession({ send: (m) => log.push(m), onMessage() {}, onClose() {}, close() {} }, { user })
  }
  const addSource = (o: { accountId?: number; ownerUserId?: number; kind?: string }): number =>
    Number(db.prepare(`INSERT INTO pim_sources (kind, account_id, owner_user_id, label, auth, created_at) VALUES (?, ?, ?, 'K', 'none', 1)`)
      .run(o.kind ?? 'dav', o.accountId ?? null, o.ownerUserId ?? null).lastInsertRowid)
  const addCollection = (sourceId: number, readOnly = 0, type = 'calendar'): number =>
    Number(db.prepare(`INSERT INTO pim_collections (source_id, type, remote_id, name, read_only) VALUES (?, ?, 'r', 'C', ?)`).run(sourceId, type, readOnly).lastInsertRowid)
  const source = (id: number): PimSourceRow => q.getPimSource(id)!
  const events = (log: unknown[]) => (log as { event: string }[]).filter((m) => m.event === 'pim:changed')

  it("member sees account source only with group permission", () => {
    const src = source(addSource({ accountId: acc }))
    const col = addCollection(src.id)
    expect(canReadSource(session(member), src)).toBe(false)
    expect(visibleCollectionIds(session(member), 'calendar')).toEqual([])
    expect(() => assertCollectionRead(session(member), col)).toThrow()
    q.setGroupPermission(member, group, true, false)
    expect(canReadSource(session(member), src)).toBe(true)
    expect(visibleCollectionIds(session(member), 'calendar')).toEqual([col])
    expect(assertCollectionRead(session(member), col).source.id).toBe(src.id)
  })

  it("admin cannot read another user's personal source", () => {
    const src = source(addSource({ ownerUserId: member }))
    const col = addCollection(src.id)
    expect(canReadSource(session(admin), src)).toBe(false)
    expect(canWriteSource(session(admin), src)).toBe(false)
    expect(visibleCollectionIds(session(admin), 'calendar')).toEqual([])
    expect(() => assertCollectionRead(session(admin), col)).toThrow()
    // yönetici hesaba bağlı olanı görür
    expect(canReadSource(session(admin), source(addSource({ accountId: acc })))).toBe(true)
  })

  it('owner reads own personal source', () => {
    const src = source(addSource({ ownerUserId: member }))
    const col = addCollection(src.id)
    expect(canReadSource(session(member), src)).toBe(true)
    expect(canWriteSource(session(member), src)).toBe(true)
    expect(assertCollectionWrite(session(member), col).collection.id).toBe(col)
    expect(canReadSource(session(other), src)).toBe(false)
  })

  it('view without manage cannot write', () => {
    q.setGroupPermission(member, group, true, false)
    const src = source(addSource({ accountId: acc }))
    const col = addCollection(src.id)
    expect(canWriteSource(session(member), src)).toBe(false)
    expect(() => assertCollectionWrite(session(member), col)).toThrow()
    q.setGroupPermission(member, group, true, true)
    expect(canWriteSource(session(member), src)).toBe(true)
    expect(assertCollectionWrite(session(member), col).collection.id).toBe(col)
  })

  it('read_only collection write throws', () => {
    const col = addCollection(addSource({ ownerUserId: member }), 1)
    expect(assertCollectionRead(session(member), col).collection.id).toBe(col)
    expect(() => assertCollectionWrite(session(member), col)).toThrow(/salt okunur/i)
  })

  it('group removal takes effect on next call', () => {
    q.setGroupPermission(member, group, true, true)
    const src = source(addSource({ accountId: acc }))
    const col = addCollection(src.id)
    const s = session(member) // oturumdaki grup listesi bayat kalır
    expect(canWriteSource(s, src)).toBe(true)
    q.setGroupPermission(member, group, false, false)
    expect(s.currentUser!.permittedGroupIds).toEqual([group])
    expect(canReadSource(s, src)).toBe(false)
    expect(canWriteSource(s, src)).toBe(false)
    expect(visibleCollectionIds(s, 'calendar')).toEqual([])
    expect(() => assertCollectionRead(s, col)).toThrow()
  })

  it('sendToUser reaches only that user', () => {
    const a: unknown[] = []
    const a2: unknown[] = []
    const b: unknown[] = []
    session(member, a)
    session(member, a2)
    session(other, b)
    const data: RpcEvents['pim:changed'] = { kind: 'sources', sourceId: 1, accountId: null }
    hub.sendToUser(member, 'pim:changed', data)
    expect(events(a)).toEqual([{ event: 'pim:changed', data }])
    expect(events(a2)).toHaveLength(1)
    expect(events(b)).toEqual([])
  })

  it('personal source event not broadcast', () => {
    const own: unknown[] = []
    const adm: unknown[] = []
    session(member, own)
    session(admin, adm)
    emitPimChanged(hub, source(addSource({ ownerUserId: member })), 'calendar')
    expect(events(own)).toHaveLength(1)
    expect(events(adm)).toEqual([])
  })

  it('account source event follows account visibility', () => {
    q.setGroupPermission(member, group, true, false)
    const seen: unknown[] = []
    const hidden: unknown[] = []
    session(member, seen)
    session(other, hidden)
    emitPimChanged(hub, source(addSource({ accountId: acc })), 'contacts')
    expect(events(seen)).toHaveLength(1)
    expect(events(hidden)).toEqual([])
  })

  it('user delete cascades personal sources', () => {
    const src = addSource({ ownerUserId: member })
    const col = addCollection(src)
    db.prepare(`DELETE FROM users WHERE id = ?`).run(member)
    expect(q.getPimSource(src)).toBeUndefined()
    expect(q.getPimCollection(col)).toBeUndefined()
  })

  it('account delete cascades account source', () => {
    const src = addSource({ accountId: acc })
    const col = addCollection(src)
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(acc)
    expect(q.getPimSource(src)).toBeUndefined()
    expect(q.getPimCollection(col)).toBeUndefined()
  })

  it('check constraint rejects source with both owners', () => {
    expect(() => addSource({ accountId: acc, ownerUserId: member })).toThrow(/CHECK/)
    expect(() => addSource({})).toThrow(/CHECK/)
  })

  it('ensureLocalSource creates Kişilerim and Takvimim once', () => {
    const s = session(member)
    const a = ensureLocalSource(s)
    const b = ensureLocalSource(s)
    expect(b.id).toBe(a.id)
    expect(a).toMatchObject({ kind: 'local', owner_user_id: member, account_id: null })
    expect((db.prepare(`SELECT type, read_only FROM pim_collections WHERE source_id = ? ORDER BY type`).all(a.id))).toEqual([
      { type: 'addressbook', read_only: 0 }, { type: 'calendar', read_only: 0 }
    ])
    expect(ensureLocalSource(session(other)).id).not.toBe(a.id)
  })

  describe('RPC', () => {
    const call = (s: RpcSession, method: string, params: unknown = {}) => hub.invoke(s, method, params)

    it('listPimSources hides secrets and other users sources', async () => {
      const row = addSource({ ownerUserId: other })
      db.prepare(`UPDATE pim_sources SET secret_enc = x'01', username = 'gizli', ics_url_enc = x'02' WHERE id = ?`).run(row)
      const s = session(other)
      const mine = await call(s, 'listPimSources') as PimSourceInfo[]
      expect(mine.map((x) => x.id)).toContain(row)
      expect(JSON.stringify(mine)).not.toMatch(/gizli|secret|ics_url|caldav_url|username/)
      expect(Object.keys(mine[0]).sort()).toEqual(['accountId', 'canManage', 'id', 'kind', 'label', 'lastError', 'lastSyncAt', 'personal', 'status'])
      const theirs = await call(session(member), 'listPimSources') as PimSourceInfo[]
      expect(theirs.map((x) => x.id)).not.toContain(row)
    })

    it('listPimCollections merges personal prefs', async () => {
      const col = addCollection(addSource({ ownerUserId: member }))
      const s = session(member)
      await call(s, 'setPimCollectionPref', { collectionId: col, hidden: true, color: '#aabbcc', reminders: false })
      const list = await call(s, 'listPimCollections', { type: 'calendar' }) as PimCollectionInfo[]
      expect(list.find((c) => c.id === col)).toMatchObject({ hidden: true, color: '#aabbcc', reminders: false, readOnly: false })
      // kısmi güncelleme diğer alanları korur; null rengi sıfırlar
      await call(s, 'setPimCollectionPref', { collectionId: col, color: null })
      const again = await call(s, 'listPimCollections', { type: 'calendar' }) as PimCollectionInfo[]
      expect(again.find((c) => c.id === col)).toMatchObject({ hidden: true, color: null, reminders: false })
    })

    it('prefs belong to the user', async () => {
      q.setGroupPermission(member, group, true, false)
      q.setGroupPermission(other, group, true, false)
      const col = addCollection(addSource({ accountId: acc }))
      await call(session(member), 'setPimCollectionPref', { collectionId: col, hidden: true })
      const list = await call(session(other), 'listPimCollections', { type: 'calendar' }) as PimCollectionInfo[]
      expect(list.find((c) => c.id === col)?.hidden).toBe(false)
    })

    it('setPimCollectionPref refuses invisible collection and bad color', async () => {
      const col = addCollection(addSource({ ownerUserId: other }))
      await expect(call(session(member), 'setPimCollectionPref', { collectionId: col, hidden: true })).rejects.toThrow()
      await expect(call(session(other), 'setPimCollectionPref', { collectionId: col, color: 'url(x)' })).rejects.toThrow()
    })

    it('first listing creates local collections', async () => {
      const s = session(member)
      const list = await call(s, 'listPimCollections', { type: 'addressbook' }) as PimCollectionInfo[]
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ type: 'addressbook', readOnly: false, hidden: false, reminders: true })
    })
  })
})
