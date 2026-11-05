import type Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PimCollectionInfo, PimSourceInfo } from '../../shared/pim'
import type { SessionUser } from '../../shared/rpc'
import { accountsHandlers } from '../rpc/accounts'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import type { OpQueue } from '../opQueue'
import { initOAuth, TokenCache } from '../oauth'
import { pimSourcesHandlers } from '../rpc/pimSources'
import { systemHandlers } from '../rpc/system'
import { RpcHub } from '../rpcHub'
import type { RpcSession } from '../rpcSession'
import type { Scheduler } from '../scheduler'
import { setVaultKey } from '../vault/state'
import { FakeDav } from './helpers/fakeDav'
import { buildGateWorker, removeGateWorkers } from './helpers/gateWorker'

const discovery = vi.hoisted(() => ({ google: null as null | (() => Promise<unknown>) }))
vi.mock('../pim/discovery', async (orig) => {
  const real = await orig<typeof import('../pim/discovery')>()
  return { ...real, discoverGoogle: (...a: Parameters<typeof real.discoverGoogle>) => (discovery.google ? discovery.google() : real.discoverGoogle(...a)) }
})

const PASSWORD = 'gizli-parola-1'
const header = (u: string): string => `Basic ${Buffer.from(`${u}:${PASSWORD}`).toString('base64')}`

describe('kaynak RPC', () => {
  let worker: string
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let dav: FakeDav
  let acc: number
  let group: number
  let member: number
  let viewer: number
  let admin: number
  const stub = new Proxy({}, { get: () => () => undefined })
  const creds = new Map<number, string>()
  const OPEN = { allowPrivateHosts: 'all' as const, allowedPorts: 'any' as const }

  beforeAll(() => {
    worker = buildGateWorker()
    initOAuth(new TokenCache(() => ({ clientId: 'c' }), undefined, (async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600 }) })) as never))
  })
  afterAll(removeGateWorkers)

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-pimrpc-'))
    db = openDb(dir)
    q = makeQueries(db)
    dav = await FakeDav.start()
    dav.accept = [header('kisi@t.co')]
    dav.homes = { principal: '/dav/pal/a/', calendar: '/dav/cal/a/', addressbook: '/dav/card/a/' }
    dav.collections.set('/dav/cal/a/ev/', { type: 'calendar', name: 'İş' })
    dav.collections.set('/dav/card/a/ki/', { type: 'addressbook', name: 'Rehber' })
    const { host, port } = new URL(dav.url)
    acc = q.insertAccount({ email: 'kisi@t.co', displayName: null, imapHost: host, imapPort: Number(port), smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    creds.clear()
    creds.set(acc, PASSWORD)
    group = q.insertGroup('A', '#111111')
    q.setAccountGroup(acc, group)
    member = q.insertUser({ username: 'uye', passwordHash: 'x', role: 'member' })
    viewer = q.insertUser({ username: 'goren', passwordHash: 'x', role: 'member' })
    admin = q.insertUser({ username: 'yon', passwordHash: 'x', role: 'admin' })
    q.setGroupPermission(viewer, group, true, false)
    hub = new RpcHub({
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds, attachDir: join(dir, 'att'),
      encrypt: async (v) => v.map((s) => new TextEncoder().encode(`enc:${s}`)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x).replace(/^enc:/, '')),
      userData: dir, dbSchemaVersion: () => 0, pimNet: () => OPEN, pimGateWorker: worker
    }, 'server')
    hub.pimDiscoverOptions = { scheme: 'http', resolveSrv: (async () => []) as never }
  })
  afterEach(async () => {
    discovery.google = null
    hub.pim.stop()
    await dav.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const session = (id: number, log: unknown[] = []): RpcSession => {
    const row = q.getUserById(id)!
    const user: SessionUser = { id, username: row.username, role: row.role, permittedGroupIds: q.getPermittedGroupIds(id), manageableGroupIds: q.getManageableGroupIds(id) }
    return hub.openSession({ send: (m) => log.push(m), onMessage() {}, onClose() {}, close() {} }, { user })
  }
  const h = pimSourcesHandlers
  const settled = async (): Promise<void> => {
    for (let i = 0; i < 300 && (q.getPimSourceByAccount(acc)?.last_sync_at == null); i++) await new Promise((r) => setTimeout(r, 10))
  }
  const connected = async () => {
    expect(await h.connectAccountPim(session(admin), { accountId: acc })).toEqual({ status: 'connected' })
    await settled()
    return q.getPimSourceByAccount(acc)!
  }

  it('hesabı keşifle bağlar ve ilk eşitleme koleksiyonları getirir', async () => {
    const src = await connected()
    expect(src).toMatchObject({ kind: 'dav', auth: 'account', caldav_url: `${dav.url}/dav/cal/a/`, carddav_url: `${dav.url}/dav/card/a/`, status: 'ok' })
    expect(q.listPimCollectionsByType('calendar').map((c) => c.name)).toEqual(['İş'])
  })

  it('member without manage cannot connect', async () => {
    await expect(h.connectAccountPim(session(member), { accountId: acc })).rejects.toThrow()
    await expect(h.connectAccountPim(session(viewer), { accountId: acc })).rejects.toThrow()
    expect(dav.requests).toHaveLength(0)
  })

  it('kasa hesabı bağlanamaz, bulunamayan sunucu notFound, yanlış parola needsConsent', async () => {
    dav.accept = ['Basic baska']
    expect(await h.connectAccountPim(session(admin), { accountId: acc })).toEqual({ status: 'needsConsent' })
    expect(q.getPimSourceByAccount(acc)).toBeUndefined()
    db.prepare(`UPDATE accounts SET imap_host = 'yok.invalid' WHERE id = ?`).run(acc)
    db.prepare(`UPDATE accounts SET email = 'kisi@yok.invalid' WHERE id = ?`).run(acc)
    expect(await h.connectAccountPim(session(admin), { accountId: acc })).toEqual({ status: 'notFound' })
    q.setAccountSecureFlag(acc, true)
    await expect(h.connectAccountPim(session(admin), { accountId: acc })).rejects.toThrow()
  }, 20_000)

  it('OAuth hesabı bu yöntemle izinsiz bağlanmaz', async () => {
    db.prepare(`UPDATE accounts SET auth_type = 'oauth:google' WHERE id = ?`).run(acc)
    expect(await h.connectAccountPim(session(admin), { accountId: acc })).toEqual({ status: 'needsConsent' })
  })

  describe('Google', () => {
    beforeEach(() => db.prepare(`UPDATE accounts SET auth_type = 'oauth:google' WHERE id = ?`).run(acc))

    it('bağlanır, grup desteği yok', async () => {
      discovery.google = async () => ({ caldavHome: `${dav.url}/dav/cal/a/`, carddavHome: `${dav.url}/dav/card/a/`, principal: null, serverSchedules: false })
      const row = q.getAccountRow(acc)!
      const { connectAccountSource } = await import('../rpc/pimSources')
      dav.accept = null
      expect(await connectAccountSource(session(admin), row, 'kapsam')).toBe('connected')
      expect(q.getPimSourceByAccount(acc)).toMatchObject({ kind: 'dav', auth: 'account', granted_scopes: 'kapsam' })
      await settled()
      const list = (await h.listPimCollections(session(admin), { type: 'addressbook' })) as PimCollectionInfo[]
      expect(list[0]).toMatchObject({ name: 'Rehber', supportsGroups: false })
    })

    it('kimlik reddi needsConsent ve needs_reauth', async () => {
      discovery.google = async () => {
        const { DavAuthError } = await import('../pim/davClient')
        throw new DavAuthError(403)
      }
      const { connectAccountSource } = await import('../rpc/pimSources')
      expect(await connectAccountSource(session(admin), q.getAccountRow(acc)!, 'kapsam')).toBe('needsConsent')
      expect(q.getPimSourceByAccount(acc)).toMatchObject({ status: 'needs_reauth' })
    })
  })

  it('personal source secrets never returned', async () => {
    dav.accept = [header('ben')]
    const url = `${dav.url}/`
    expect(await h.addPersonalDav(session(member), { url, username: 'ben', password: PASSWORD })).toEqual({ status: 'connected' })
    const row = q.pimSourceCandidates(member).find((x) => x.owner_user_id === member && x.kind === 'dav')!
    expect(row).toMatchObject({ auth: 'basic', username: 'ben' })
    expect(row.secret_enc!.toString()).toBe(`enc:${PASSWORD}`)
    const json = JSON.stringify([await h.listPimSources(session(member), {}), await h.listPimCollections(session(member), { type: 'calendar' })])
    expect(json).not.toContain(PASSWORD)
    expect(json).not.toContain(url)
    expect(json).not.toContain('secret')
    // sahibi dışında kimse görmez, yönetici dahil
    const others = (await h.listPimSources(session(admin), {})) as PimSourceInfo[]
    expect(others.some((x) => x.id === row.id)).toBe(false)
  })

  it('kişisel DAV: yanlış parola saklanmaz, geçersiz girdi reddedilir', async () => {
    expect(await h.addPersonalDav(session(member), { url: `${dav.url}/`, username: 'ben', password: 'yanlis' })).toEqual({ status: 'needsConsent' })
    expect(q.pimSourceCandidates(member).filter((x) => x.owner_user_id === member && x.kind === 'dav')).toHaveLength(0)
    for (const bad of [{ url: 'ftp://a/', username: 'a', password: 'b' }, { url: `http://u:p@${new URL(dav.url).host}/`, username: 'a', password: 'b' }, { url: 'x', username: '', password: 'b' }]) {
      await expect(h.addPersonalDav(session(member), bad)).rejects.toThrow()
    }
  })

  it('removing source deletes objects', async () => {
    dav.seed('/dav/card/a/ki/1.vcf', 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:k\r\nFN:K\r\nEND:VCARD\r\n')
    const src = await connected()
    expect((db.prepare(`SELECT COUNT(*) AS n FROM contacts`).get() as { n: number }).n).toBe(1)
    await expect(h.removePimSource(session(viewer), { id: src.id })).rejects.toThrow()
    await expect(h.removePimSource(session(member), { id: src.id })).rejects.toThrow()
    await h.removePimSource(session(admin), { id: src.id })
    expect(q.getPimSource(src.id)).toBeUndefined()
    expect((db.prepare(`SELECT COUNT(*) AS n FROM contacts`).get() as { n: number }).n).toBe(0)
  })

  it('yerel kaynak kaldırılamaz', async () => {
    await h.listPimSources(session(member), {})
    const local = q.getLocalPimSource(member)!
    await expect(h.removePimSource(session(member), { id: local.id })).rejects.toThrow()
  })

  it('vault toggle wipes account source', async () => {
    const src = await connected()
    const log: unknown[] = []
    const s = session(admin, log)
    q.prefSet('vault_check', 'x')
    setVaultKey(randomBytes(32))
    try {
      await systemHandlers.setAccountSecure(s, { accountId: acc, secure: true })
    } finally {
      setVaultKey(null)
    }
    expect(q.getPimSource(src.id)).toBeUndefined()
    expect((log as { event?: string }[]).some((m) => m.event === 'pim:changed')).toBe(true)
  })

  it('password change clears needs_reauth', async () => {
    const src = await connected()
    q.markPimSourceNeedsReauth(src.id, 'ret')
    hub.pim.stop()
    await accountsHandlers.updateAccount(session(admin), { accountId: acc, patch: { password: 'yeni-parola' } })
    expect(q.getPimSource(src.id)).toMatchObject({ status: 'ok', last_error: null, next_sync_at: 0 })
  })

  it('pim:changed reaches only permitted sessions', async () => {
    const seen: Record<string, unknown[]> = { admin: [], viewer: [], member: [] }
    session(admin, seen.admin)
    session(viewer, seen.viewer)
    session(member, seen.member)
    const events = (l: unknown[]) => (l as { event?: string }[]).filter((m) => m.event === 'pim:changed')
    await connected()
    await new Promise((r) => setTimeout(r, 20))
    expect(events(seen.admin).length).toBeGreaterThan(0)
    expect(events(seen.viewer).length).toBeGreaterThan(0)
    expect(events(seen.member)).toHaveLength(0)
  })

  it('syncPimSource yetki ister, needs_reauth kaynağı denemez', async () => {
    const src = await connected()
    await expect(h.syncPimSource(session(member), { id: src.id })).rejects.toThrow()
    await expect(h.syncPimSource(session(viewer), { id: src.id })).rejects.toThrow()
    q.markPimSourceNeedsReauth(src.id, 'ret')
    dav.requests.length = 0
    await h.syncPimSource(session(admin), { id: src.id })
    expect(dav.requests).toHaveLength(0)
  })
})
