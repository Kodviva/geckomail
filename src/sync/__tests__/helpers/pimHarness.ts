// Kişi ve takvim RPC testlerinin düzeneği: gerçek DB + hub + sahte DAV. Hesap "a@t.co", DAV kaynağı bir defter ve bir takvimle hazır.
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SessionUser } from '../../../shared/rpc'
import { openDb } from '../../db'
import { makeQueries, type PimCollectionRow, type PimSourceRow } from '../../db/queries'
import type { OpQueue } from '../../opQueue'
import { RpcHub } from '../../rpcHub'
import type { RpcSession } from '../../rpcSession'
import type { Scheduler } from '../../scheduler'
import { FakeDav } from './fakeDav'

export const CAL = '/dav/cal/a/ev/'
export const BOOK = '/dav/card/a/ki/'
const HEADER = `Basic ${Buffer.from('a@t.co:parola').toString('base64')}`

export interface PimHarness {
  dir: string
  db: Database.Database
  q: ReturnType<typeof makeQueries>
  hub: RpcHub
  dav: FakeDav
  acc: number
  group: number
  /** yetkisiz üye, yalnız gören üye, yöneten üye, yönetici */
  stranger: number
  viewer: number
  manager: number
  admin: number
  source: PimSourceRow
  /** Kaynağı eşitler; satırlar DAV'dan gelir */
  sync(): Promise<void>
  book(): PimCollectionRow
  calendar(): PimCollectionRow
  session(userId: number, log?: unknown[]): RpcSession
  close(): Promise<void>
}

export async function pimHarness(worker: string): Promise<PimHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'gecko-pimh-'))
  const db = openDb(dir)
  const q = makeQueries(db)
  const dav = await FakeDav.start()
  dav.accept = [HEADER]
  dav.collections.set(CAL, { type: 'calendar', name: 'İş' })
  dav.collections.set(BOOK, { type: 'addressbook', name: 'Rehber' })
  const acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
  const group = q.insertGroup('A', '#111111')
  q.setAccountGroup(acc, group)
  const stranger = q.insertUser({ username: 'yabanci', passwordHash: 'x', role: 'member' })
  const viewer = q.insertUser({ username: 'goren', passwordHash: 'x', role: 'member' })
  const manager = q.insertUser({ username: 'yoneten', passwordHash: 'x', role: 'member' })
  const admin = q.insertUser({ username: 'yon', passwordHash: 'x', role: 'admin' })
  q.setGroupPermission(viewer, group, true, false)
  q.setGroupPermission(manager, group, true, true)
  const stub = new Proxy({}, { get: () => () => undefined })
  const hub = new RpcHub({
    q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map([[acc, 'parola']]), attachDir: join(dir, 'att'),
    encrypt: async (v) => v.map((s) => new TextEncoder().encode(`enc:${s}`)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x).replace(/^enc:/, '')),
    userData: dir, dbSchemaVersion: () => 0, pimNet: () => ({ allowPrivateHosts: 'all', allowedPorts: 'any' }), pimGateWorker: worker
  }, 'server')
  const source = q.upsertAccountPimSource({ accountId: acc, kind: 'dav', label: 'a@t.co', caldavUrl: `${dav.url}/dav/cal/a/`, carddavUrl: `${dav.url}/dav/card/a/`, serverSchedules: false, grantedScopes: null, now: 1 })
  const session = (id: number, log: unknown[] = []): RpcSession => {
    const row = q.getUserById(id)!
    const user: SessionUser = { id, username: row.username, role: row.role, permittedGroupIds: q.getPermittedGroupIds(id), manageableGroupIds: q.getManageableGroupIds(id) }
    return hub.openSession({ send: (m) => log.push(m), onMessage() {}, onClose() {}, close() {} }, { user })
  }
  const pick = (type: 'addressbook' | 'calendar'): PimCollectionRow => q.listPimCollectionsByType(type).find((c) => c.source_id === source.id)!
  return {
    dir, db, q, hub, dav, acc, group, stranger, viewer, manager, admin, source, session,
    sync: () => hub.pim.syncNow(source.id),
    book: () => pick('addressbook'),
    calendar: () => pick('calendar'),
    async close() {
      hub.pim.stop()
      await dav.close()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
