import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_RULES } from '../../shared/notifyRules'
import type { SessionUser } from '../../shared/rpc'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import type { OpQueue } from '../opQueue'
import { RpcHub } from '../rpcHub'
import type { Scheduler } from '../scheduler'

type Handle = { handle(method: string, params: unknown): Promise<unknown>; currentUser: SessionUser | null }
type Rule = { id: number; name: string; position: number; level: string }

// §10.1: bildirim kuralları ve hesap tercihleri kişiye ait; başkasınınkine dokunulamaz.
describe('bildirim kuralları RPC', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let srv: Handle
  let accA: number
  let accB: number
  let uA: number
  let uB: number
  const stub = new Proxy({}, { get: () => () => undefined })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-nr-'))
    db = openDb(dir)
    q = makeQueries(db)
    const mk = (email: string) =>
      q.insertAccount({ email, displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    accA = mk('a@t.co')
    accB = mk('b@t.co')
    const gA = q.insertGroup('A', '#111111')
    const gB = q.insertGroup('B', '#222222')
    q.setAccountGroup(accA, gA)
    q.setAccountGroup(accB, gB)
    const user = (name: string) =>
      Number(db.prepare(`INSERT INTO users (username, password_hash, role, created_at) VALUES (?, 'x', 'member', 1)`).run(name).lastInsertRowid)
    uA = user('ua')
    uB = user('ub')
    srv = new RpcHub({
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: async (v) => v.map((s) => new TextEncoder().encode(s)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)),
      userData: dir, dbSchemaVersion: () => 0
    }, 'desktop').openSession({ send() {}, onMessage() {}, onClose() {}, close() {} }) as unknown as Handle
    as(uA, [gA])
    ;(srv as unknown as { gA: number }).gA = gA
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const as = (id: number, groups: number[]) => {
    srv.currentUser = { id, username: `u${id}`, role: 'member', permittedGroupIds: groups, manageableGroupIds: [] }
  }
  const draft = (name: string) => ({ name, enabled: true, groups: [[{ field: 'from', value: 'x@y.co' }]], level: 'normal' })
  const list = async () => (await srv.handle('listNotifyRules', {})) as Rule[]

  it('ekler, listeler, sıra artar, günceller', async () => {
    const r1 = (await srv.handle('saveNotifyRule', { rule: draft('bir') })) as Rule
    const r2 = (await srv.handle('saveNotifyRule', { rule: draft('iki') })) as Rule
    expect(r1.id).toBeGreaterThan(0)
    expect(r2.position).toBeGreaterThan(r1.position)
    await srv.handle('saveNotifyRule', { rule: { ...draft('bir-yeni'), id: r1.id, level: 'urgent' } })
    const l = await list()
    expect(l.map((r) => r.name)).toEqual(['bir-yeni', 'iki'])
    expect(l[0].level).toBe('urgent')
  })

  it('kişi başına kural sınırı: yenisi reddedilir, var olan düzenlenir, silince yer açılır, başkası etkilenmez', async () => {
    const insert = db.prepare(`INSERT INTO notify_rules (user_id, name, enabled, position, groups_json, level, created_at) VALUES (?, ?, 1, ?, '[[{"field":"from","value":"x@y.co"}]]', 'normal', 1)`)
    for (let i = 0; i < MAX_RULES - 1; i++) insert.run(uA, `k${i}`, i)
    const last = (await srv.handle('saveNotifyRule', { rule: draft('son') })) as Rule // 200. kural
    await expect(srv.handle('saveNotifyRule', { rule: draft('fazla') })).rejects.toThrow(String(MAX_RULES))
    expect(await list()).toHaveLength(MAX_RULES)
    await srv.handle('saveNotifyRule', { rule: { ...draft('son-yeni'), id: last.id } }) // sınırdayken düzenleme sürer
    await srv.handle('deleteNotifyRule', { id: last.id })
    await srv.handle('saveNotifyRule', { rule: draft('yeniden') })
    as(uB, [])
    await srv.handle('saveNotifyRule', { rule: draft('b') })
  })

  it('geçersiz kural reddedilir', async () => {
    await expect(srv.handle('saveNotifyRule', { rule: { ...draft('x'), level: 'zzz' } })).rejects.toThrow()
  })

  it('başka kullanıcının kuralı listelenmez, silinmez, güncellenmez', async () => {
    const r = (await srv.handle('saveNotifyRule', { rule: draft('benim') })) as Rule
    as(uB, [])
    expect(await list()).toEqual([])
    await srv.handle('deleteNotifyRule', { id: r.id })
    await expect(srv.handle('saveNotifyRule', { rule: { ...draft('ele'), id: r.id } })).rejects.toThrow()
    as(uA, [])
    const l = await list()
    expect(l.map((x) => x.name)).toEqual(['benim'])
  })

  it('reorder yalnız kendi kuralları; yabancı kimlik yok sayılır', async () => {
    const a = (await srv.handle('saveNotifyRule', { rule: draft('a') })) as Rule
    const b = (await srv.handle('saveNotifyRule', { rule: draft('b') })) as Rule
    as(uB, [])
    const c = (await srv.handle('saveNotifyRule', { rule: draft('c') })) as Rule
    await srv.handle('reorderNotifyRules', { ids: [c.id, b.id, a.id] })
    as(uA, [])
    expect((await list()).map((x) => x.name)).toEqual(['a', 'b'])
    await srv.handle('reorderNotifyRules', { ids: [b.id, a.id] })
    expect((await list()).map((x) => x.name)).toEqual(['b', 'a'])
    as(uB, [])
    expect((await list()).map((x) => x.name)).toEqual(['c'])
  })

  it('hesap tercihi: on/off/default; görmediği hesapta hata', async () => {
    const gA = (srv as unknown as { gA: number }).gA
    as(uA, [gA])
    await srv.handle('setNotifyAccountPref', { accountId: accA, mode: 'off' })
    expect(await srv.handle('getNotifyAccountPrefs', {})).toEqual([{ accountId: accA, mode: 'off' }])
    await srv.handle('setNotifyAccountPref', { accountId: accA, mode: 'on' })
    expect(await srv.handle('getNotifyAccountPrefs', {})).toEqual([{ accountId: accA, mode: 'on' }])
    await srv.handle('setNotifyAccountPref', { accountId: accA, mode: 'default' })
    expect(await srv.handle('getNotifyAccountPrefs', {})).toEqual([])
    await expect(srv.handle('setNotifyAccountPref', { accountId: accB, mode: 'off' })).rejects.toThrow('yetkiniz yok')
    await expect(srv.handle('setNotifyAccountPref', { accountId: accA, mode: 'bad' })).rejects.toThrow()
  })

  it('kullanıcı silinince kayıtlar gider', async () => {
    await srv.handle('saveNotifyRule', { rule: draft('a') })
    await srv.handle('setNotifyAccountPref', { accountId: accA, mode: 'off' })
    db.pragma('foreign_keys = ON')
    db.prepare(`DELETE FROM users WHERE id = ?`).run(uA)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM notify_rules`).get()).toEqual({ n: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM notify_account_prefs`).get()).toEqual({ n: 0 })
  })
})
