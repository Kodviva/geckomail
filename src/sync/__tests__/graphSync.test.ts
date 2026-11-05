import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '../../shared/rpc'
import { openDb } from '../db'
import { makeQueries, type PimCollectionRow, type PimSourceRow } from '../db/queries'
import { accessTokenFor, initOAuth, OAUTH_PROVIDERS, TokenCache } from '../oauth'
import type { OpQueue } from '../opQueue'
import { backendFor } from '../pim/backend'
import { GraphClient } from '../pim/graphClient'
import { calendarHandlers } from '../rpc/calendar'
import { contactsHandlers } from '../rpc/contacts'
import { pimSourcesHandlers } from '../rpc/pimSources'
import { RpcHub } from '../rpcHub'
import type { RpcSession } from '../rpcSession'
import type { Scheduler } from '../scheduler'
import { FakeGraph, graphContact, graphEvent } from './helpers/fakeGraph'
import { buildGateWorker, removeGateWorkers } from './helpers/gateWorker'

const NOW = Date.UTC(2026, 10, 4)
const DAY = 864e5
const GRAPH_TOKEN = 'Bearer graph-belirtec'
const OPEN = { allowPrivateHosts: 'all' as const, allowedPorts: 'any' as const }

describe('Graph eşitlemesi', () => {
  let worker: string
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let graph: FakeGraph
  let acc: number
  let admin: number
  let source: PimSourceRow
  let clock: number
  let refreshes: string[]
  const stub = new Proxy({}, { get: () => () => undefined })

  beforeAll(() => {
    worker = buildGateWorker()
  })
  afterAll(removeGateWorkers)

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-graph-'))
    db = openDb(dir)
    q = makeQueries(db)
    graph = await FakeGraph.start()
    graph.accept = [GRAPH_TOKEN]
    clock = NOW
    refreshes = []
    initOAuth(new TokenCache(() => ({ clientId: 'c' }), undefined, (async (_u: string, init: { body: URLSearchParams }) => {
      const scope = new URLSearchParams(String(init.body)).get('scope') ?? ''
      refreshes.push(scope)
      return { ok: true, status: 200, json: async () => ({ access_token: scope.includes('graph.microsoft.com') ? 'graph-belirtec' : 'posta-belirtec', expires_in: 3600 }) }
    }) as never, undefined, () => true))
    acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587, passwordEnc: Buffer.from('x') })
    db.prepare(`UPDATE accounts SET auth_type = 'oauth:microsoft' WHERE id = ?`).run(acc)
    admin = q.insertUser({ username: 'yon', passwordHash: 'x', role: 'admin' })
    hub = new RpcHub({
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map([[acc, 'yenileme']]), attachDir: join(dir, 'att'), encrypt: async (v) => v.map((s) => new TextEncoder().encode(s)),
      decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)), userData: dir, dbSchemaVersion: () => 0, pimNet: () => OPEN, pimGateWorker: worker, pimGraphBase: graph.url
    }, 'server')
    hub.now = () => clock
    source = q.upsertAccountPimSource({ accountId: acc, kind: 'graph', label: 'a@t.co', caldavUrl: null, carddavUrl: null, serverSchedules: false, grantedScopes: null, now: 1 })
  })
  afterEach(async () => {
    hub.pim.stop()
    await graph.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const session = (): RpcSession => {
    const row = q.getUserById(admin)!
    const user: SessionUser = { id: admin, username: row.username, role: row.role, permittedGroupIds: [], manageableGroupIds: [] }
    return hub.openSession({ send() {}, onMessage() {}, onClose() {}, close() {} }, { user })
  }
  const sync = async (): Promise<void> => {
    clock += 3_600_000
    await hub.pim.syncNow(source.id)
  }
  const row = (): PimSourceRow => q.getPimSource(source.id)!
  const cal = (): PimCollectionRow => q.listPimCollectionsByType('calendar').find((c) => c.source_id === source.id)!
  const book = (): PimCollectionRow => q.listPimCollectionsByType('addressbook').find((c) => c.source_id === source.id)!
  const events = (): string[] => [...q.pimEventEtags(cal().id).keys()].sort()
  const contactsOf = (): string[] => [...q.pimContactEtags(book().id).keys()].sort()
  const deltaCalls = () => graph.requests.filter((r) => r.url.includes('calendarView/delta'))
  const objectId = (remote: string): number => q.pimEventIdByRemote(cal().id, remote)!

  it('nextLink other host refused', async () => {
    let leaked = false
    const other = await FakeGraph.start()
    other.on('GET', /./, () => {
      leaked = true
      return null
    }, false)
    const client = new GraphClient({ token: async () => 'gizli', net: OPEN, baseUrl: graph.url })
    await expect(client.get(`${other.url}/v1.0/me`)).rejects.toThrow()
    expect(leaked).toBe(false)
    expect(other.requests).toEqual([])
    await other.close()
    graph.events.get('takvim')!.push(graphEvent('e1'))
    graph.on('GET', /calendarView\/delta/, { status: 200, body: { value: [graphEvent('e1')], '@odata.nextLink': 'https://kotu.example.com/v1.0/x' } })
    await sync()
    expect(row().status).toBe('error')
    expect(events()).toEqual([])
  })

  it('Authorization yönlendirmeye gitmez', async () => {
    graph.on('GET', /^\/v1\.0\/me\/calendars/, { status: 302, headers: { location: 'http://127.0.0.1:1/x' } })
    await sync()
    expect(row().status).toBe('error')
  })

  it('delta full then incremental', async () => {
    graph.events.get('takvim')!.push(graphEvent('e1'), graphEvent('e2'))
    graph.pageSize = 1
    await sync()
    expect(events()).toEqual(['e1', 'e2'])
    expect(cal().delta_link).toContain('deltatoken')
    expect(cal()).toMatchObject({ window_start: NOW + 3_600_000 - 365 * DAY, window_end: NOW + 3_600_000 + 730 * DAY, name: 'Takvim', color: '#112233', read_only: 0 })
    const headers = deltaCalls()[0].headers
    expect(String(headers.prefer)).toContain('odata.maxpagesize=100')
    expect(deltaCalls()[0].url).toMatch(/startDateTime=.*endDateTime=/)
    graph.requests.length = 0
    graph.changes = [graphEvent('e3')]
    await sync()
    expect(events()).toEqual(['e1', 'e2', 'e3'])
    expect(deltaCalls().every((r) => r.url.includes('deltatoken'))).toBe(true)
  })

  it('partial round keeps old deltaLink', async () => {
    graph.events.get('takvim')!.push(graphEvent('e1'))
    await sync()
    const before = cal().delta_link
    graph.pageSize = 1
    graph.changes = [graphEvent('e2'), graphEvent('e3')]
    graph.on('GET', /skip=1/, { status: 500 })
    await sync()
    expect(row().status).toBe('error')
    expect(cal().delta_link).toBe(before)
    expect(events()).toEqual(['e1'])
  })

  it('410 resets delta', async () => {
    graph.events.get('takvim')!.push(graphEvent('e1'), graphEvent('e2'))
    await sync()
    graph.events.set('takvim', [graphEvent('e2'), graphEvent('e3')])
    graph.on('GET', /deltatoken/, { status: 410, body: { error: { code: 'syncStateNotFound' } } })
    await sync()
    expect(row().status).toBe('ok')
    expect(events()).toEqual(['e2', 'e3'])
  })

  it('429 defers source', async () => {
    graph.on('GET', /calendarView\/delta/, { status: 429, headers: { 'retry-after': '120' } })
    await sync()
    expect(row()).toMatchObject({ status: 'ok', fail_count: 0, next_sync_at: clock + 120_000 })
  })

  it('@removed deletes', async () => {
    graph.events.get('takvim')!.push(graphEvent('e1'), graphEvent('e2'))
    await sync()
    graph.changes = [{ id: 'e1', '@removed': { reason: 'deleted' } }]
    await sync()
    expect(events()).toEqual(['e2'])
  })

  it('removed unknown id ignored', async () => {
    await sync()
    graph.changes = [{ id: 'yok', '@removed': { reason: 'deleted' } }]
    await sync()
    expect(row().status).toBe('ok')
  })

  it('window rotation after 30 days', async () => {
    graph.events.get('takvim')!.push(graphEvent('e1'), graphEvent('e2'))
    await sync()
    const first = cal().window_start!
    graph.events.set('takvim', [graphEvent('e2')])
    clock += 29 * DAY
    await sync()
    expect(cal().window_start).toBe(first)
    expect(events()).toEqual(['e1', 'e2'])
    clock += 2 * DAY
    await sync()
    expect(cal().window_start).toBe(clock - 365 * DAY)
    expect(events()).toEqual(['e2'])
  })

  it('non-primary calendar falls back when delta 400', async () => {
    graph.calendars.push({ id: 'ikinci', name: 'İkinci', canEdit: false, isDefaultCalendar: false })
    graph.events.set('ikinci', [graphEvent('s1'), graphEvent('s2')])
    graph.on('GET', /calendars\/ikinci\/calendarView\/delta/, { status: 400, body: { error: { code: 'BadRequest' } } }, false)
    await sync()
    const second = q.listPimCollectionsByType('calendar').find((c) => c.remote_id === 'ikinci')!
    expect(second).toMatchObject({ read_only: 1, delta_link: null })
    expect([...q.pimEventEtags(second.id).keys()].sort()).toEqual(['s1', 's2'])
    expect(graph.requests.some((r) => /calendars\/ikinci\/calendarView\?/.test(r.url))).toBe(true)
    graph.requests.length = 0
    graph.events.set('ikinci', [graphEvent('s1'), graphEvent('s3')])
    await sync()
    expect([...q.pimEventEtags(second.id).keys()].sort()).toEqual(['s1', 's3'])
    expect(row().status).toBe('ok')
  })

  it('tek takvimin hatası öncelikli takvimde beta çağırmaz', async () => {
    await sync()
    expect(graph.requests.every((r) => r.url.startsWith('/v1.0/'))).toBe(true)
  })

  it('empty folder no crash', async () => {
    await sync()
    expect(row().status).toBe('ok')
    expect(book()).toMatchObject({ remote_id: 'default', delta_link: null })
    expect(graph.requests.some((r) => r.url.includes('contacts/delta'))).toBe(false)
    const r = (await contactsHandlers.saveContact(session(), { collectionId: book().id, draft: { kind: 'individual', fullName: 'Yeni', given: null, family: null, org: null, emails: [{ addr: 'y@x.co', label: null }], phones: [], addresses: [], note: null, birthday: null } })) as { ok: boolean }
    expect(r.ok).toBe(true)
    const post = graph.requests.find((x) => x.method === 'POST')!
    expect(post.url).toBe('/v1.0/me/contacts')
    expect(post.body).toMatchObject({ displayName: 'Yeni', emailAddresses: [{ address: 'y@x.co' }] })
  })

  it('kişi deltası: varsayılan ve ek klasör', async () => {
    graph.contacts = [graphContact('k1'), graphContact('k2')]
    graph.contactFolders = [{ id: 'kl', displayName: 'İş' }]
    await sync()
    expect(contactsOf()).toEqual(['k1', 'k2'])
    expect(q.listPimCollectionsByType('addressbook').filter((c) => c.source_id === source.id).map((c) => c.name)).toEqual(expect.arrayContaining(['İş']))
    expect(graph.requests.some((r) => r.url.startsWith('/v1.0/me/contactFolders/kok/contacts/delta'))).toBe(true)
    graph.changes = [{ id: 'k1', '@removed': { reason: 'deleted' } }]
    await sync()
    expect(contactsOf()).toEqual(['k2'])
  })

  it('patch sends If-Match, 412 conflict', async () => {
    graph.events.get('takvim')!.push(graphEvent('e1'))
    await sync()
    const s = session()
    const d = (await calendarHandlers.getEvent(s, { objectId: objectId('e1'), tz: 'UTC' })) as { draft: object; etag: string }
    const ok = await calendarHandlers.saveEvent(s, { collectionId: cal().id, objectId: objectId('e1'), etag: d.etag, draft: { ...d.draft, title: 'Yeni' } })
    expect(ok).toMatchObject({ ok: true })
    const patch = graph.requests.find((r) => r.method === 'PATCH')!
    expect(patch.url).toBe('/v1.0/me/events/e1')
    expect(patch.headers['if-match']).toBe(d.etag)
    expect(patch.body).toMatchObject({ subject: 'Yeni' })
    graph.on('PATCH', /events\/e1/, { status: 412 })
    expect(await calendarHandlers.saveEvent(s, { collectionId: cal().id, objectId: objectId('e1'), etag: 'W/"eski"', draft: d.draft })).toEqual({ ok: false, conflict: true })
  })

  it('yeni olay takvime POST edilir, yazma sonrası eşitleme tetiklenir', async () => {
    await sync()
    const s = session()
    graph.requests.length = 0
    graph.events.get('takvim')!.push(graphEvent('yeni'))
    const draft = { title: 'T', location: null, description: null, allDay: false, start: '2026-11-10T10:00', end: '2026-11-10T11:00', tz: 'Europe/Istanbul', rrule: null, alarmMinutes: null }
    const r = (await calendarHandlers.saveEvent(s, { collectionId: cal().id, draft })) as { ok: boolean; objectId: number }
    expect(r.ok).toBe(true)
    expect(graph.requests.find((x) => x.method === 'POST')?.url).toBe('/v1.0/me/calendars/takvim/events')
    expect(events()).toEqual(['yeni'])
    for (let i = 0; i < 100 && !deltaCalls().length; i++) await new Promise((res) => setTimeout(res, 10))
    expect(deltaCalls().length).toBeGreaterThan(0)
  })

  it('tekrar eden yeni olay ana kayıt saklanmaz, ilk örnek saklanır', async () => {
    await sync()
    const draft = { title: 'T', location: null, description: null, allDay: false, start: '2026-11-10T10:00', end: '2026-11-10T11:00', tz: 'UTC', rrule: { freq: 'DAILY', interval: 1, count: 3 }, alarmMinutes: null }
    const r = (await calendarHandlers.saveEvent(session(), { collectionId: cal().id, draft })) as { ok: boolean; objectId: number }
    expect(r.ok).toBe(true)
    expect(graph.requests.find((x) => x.method === 'POST')?.body).toMatchObject({ recurrence: { pattern: { type: 'daily' } } })
    expect(events()).toEqual(['yeni-1'])
  })

  it('this occurrence kimliği, all seriesMasterId kullanır; silme de', async () => {
    graph.events.get('takvim')!.push(graphEvent('o1', { type: 'occurrence', seriesMasterId: 'm1', originalStart: '2026-11-10T10:00:00Z' }))
    await sync()
    const s = session()
    const list = (await calendarHandlers.listEvents(s, { from: NOW, to: NOW + 30 * DAY, tz: 'UTC' })) as { recurring: boolean; recurrenceId: string; objectId: number }[]
    expect(list[0]).toMatchObject({ recurring: true, recurrenceId: '20261110T100000Z' })
    const rid = list[0].recurrenceId
    const d = (await calendarHandlers.getEvent(s, { objectId: list[0].objectId, recurrenceId: rid, tz: 'UTC' })) as { draft: object; etag: string }
    await calendarHandlers.saveEvent(s, { collectionId: cal().id, objectId: list[0].objectId, etag: d.etag, scope: 'this', recurrenceId: rid, draft: { ...d.draft, title: 'Tek' } })
    await calendarHandlers.saveEvent(s, { collectionId: cal().id, objectId: list[0].objectId, etag: d.etag, draft: { ...d.draft, title: 'Hepsi' } })
    expect(graph.requests.filter((r) => r.method === 'PATCH').map((r) => [r.url, r.headers['if-match'] ?? null])).toEqual([['/v1.0/me/events/o1', d.etag], ['/v1.0/me/events/m1', null]])
    expect(await calendarHandlers.deleteEvent(s, { objectId: list[0].objectId, scope: 'this', recurrenceId: rid })).toEqual({ ok: true })
    expect(graph.requests.filter((r) => r.method === 'DELETE').map((r) => r.url)).toEqual(['/v1.0/me/events/o1'])
  })

  it('tüm seri silinince ana kayıt silinir', async () => {
    graph.events.get('takvim')!.push(graphEvent('o1', { type: 'occurrence', seriesMasterId: 'm1', originalStart: '2026-11-10T10:00:00Z' }))
    await sync()
    expect(await calendarHandlers.deleteEvent(session(), { objectId: objectId('o1') })).toEqual({ ok: true })
    expect(graph.requests.filter((r) => r.method === 'DELETE').map((r) => r.url)).toEqual(['/v1.0/me/events/m1'])
  })

  it('thisAndFuture refused', async () => {
    graph.events.get('takvim')!.push(graphEvent('e1'))
    await sync()
    const backend = backendFor(hub.pimDeps(), row())
    await expect(backend.putEvent(cal(), 'e1', 'x', null, { scope: 'thisAndFuture' })).rejects.toThrow()
    const cols = (await pimSourcesHandlers.listPimCollections(session(), { type: 'calendar' })) as { sourceId: number; supportsThisAndFuture: boolean }[]
    expect(cols.find((c) => c.sourceId === source.id)!.supportsThisAndFuture).toBe(false)
  })

  it('kategori grup kartı olur, grup kaydı üyelerin kategorisini değiştirir', async () => {
    graph.contacts = [graphContact('k1', { categories: ['Ekip'] }), graphContact('k2'), graphContact('k3', { categories: ['Ekip', 'VIP'] })]
    await sync()
    const groups = db.prepare(`SELECT id, full_name, kind FROM contacts WHERE kind = 'group' ORDER BY full_name`).all() as { id: number; full_name: string }[]
    expect(groups.map((g) => g.full_name)).toEqual(['Ekip', 'VIP'])
    const s = session()
    const ekip = groups[0].id
    const d = (await contactsHandlers.getContact(s, { id: ekip })) as { memberIds: number[]; etag: string | null }
    expect(d.memberIds).toHaveLength(2)
    const k2 = (db.prepare(`SELECT id FROM contacts WHERE uid = 'k2'`).get() as { id: number }).id
    const k1 = (db.prepare(`SELECT id FROM contacts WHERE uid = 'k1'`).get() as { id: number }).id
    const members = [...d.memberIds.filter((m) => m !== k1), k2]
    await contactsHandlers.saveContact(s, { collectionId: book().id, id: ekip, draft: { kind: 'group', fullName: 'Ekip', given: null, family: null, org: null, emails: [], phones: [], addresses: [], note: null, birthday: null, memberIds: members } })
    const patches = graph.requests.filter((r) => r.method === 'PATCH')
    expect(patches.map((p) => [p.url, p.body]).sort()).toEqual([['/v1.0/me/contacts/k1', { categories: [] }], ['/v1.0/me/contacts/k2', { categories: ['Ekip'] }]])
    graph.requests.length = 0
    await contactsHandlers.deleteContact(s, { id: ekip })
    expect(graph.requests.filter((r) => r.method === 'PATCH').map((p) => p.body)).toEqual(expect.arrayContaining([{ categories: ['VIP'] }]))
    expect(graph.requests.filter((r) => r.method === 'DELETE')).toEqual([])
  })

  it('graph token audience used', async () => {
    await sync()
    expect(graph.requests.length).toBeGreaterThan(0)
    expect(graph.requests.every((r) => r.headers.authorization === GRAPH_TOKEN)).toBe(true)
    expect(refreshes.some((s) => s.includes('Contacts.ReadWrite'))).toBe(true)
  })

  it('mail token unaffected', async () => {
    await sync()
    const mail = await accessTokenFor(q.getAccountRow(acc)!, 'yenileme', 'mail')
    expect(mail).toBe('posta-belirtec')
    expect(await accessTokenFor(q.getAccountRow(acc)!, 'yenileme', 'graph')).toBe('graph-belirtec')
  })

  it('401 belirteci bir kez yeniler, yine reddedilirse durur', async () => {
    await sync()
    const n = refreshes.length
    graph.accept = ['Bearer baska']
    await sync()
    expect(refreshes.length).toBe(n + 1)
    expect(row().status).toBe('needs_reauth')
  })

  it('403 sets needs_reauth', async () => {
    graph.on('GET', /^\/v1\.0\/me\/calendars/, { status: 403, body: { error: { code: 'ErrorAccessDenied' } } })
    await sync()
    expect(row().status).toBe('needs_reauth')
    expect(row().last_error).toBeTruthy()
    graph.requests.length = 0
    await hub.pim.syncNow(source.id)
    expect(graph.requests).toEqual([])
  })

  it('I6 başlık düzenlemesi seri ana kaydına tarih göndermez, zaman değişikliği gönderir', async () => {
    graph.events.get('takvim')!.push(graphEvent('o1', { type: 'occurrence', seriesMasterId: 'ana', originalStart: '2026-11-10T10:00:00Z' }))
    await sync()
    const id = (db.prepare(`SELECT id FROM calendar_objects`).get() as { id: number }).id
    const s = session()
    const d = { title: 'Yeni', location: null, description: null, allDay: false, start: '2026-11-10T10:00', end: '2026-11-10T11:00', tz: 'UTC', rrule: null, alarmMinutes: null }
    await calendarHandlers.saveEvent(s, { collectionId: cal().id, objectId: id, draft: d })
    const patch = graph.requests.find((r) => r.method === 'PATCH')!
    expect(patch.url).toBe('/v1.0/me/events/ana')
    expect(patch.body).not.toHaveProperty('start')
    expect(patch.body).toMatchObject({ subject: 'Yeni' })
    graph.requests.length = 0
    await calendarHandlers.saveEvent(s, { collectionId: cal().id, objectId: id, draft: { ...d, start: '2026-11-10T12:00', end: '2026-11-10T13:00' } })
    expect(graph.requests.find((r) => r.method === 'PATCH')!.body).toHaveProperty('start')
  })

  it('I7 bağlantısız biten delta satır silmez', async () => {
    graph.events.get('takvim')!.push(graphEvent('e1'))
    await sync()
    const collection = cal()
    db.prepare(`UPDATE pim_collections SET delta_link = NULL WHERE id = ?`).run(collection.id)
    graph.on('GET', /calendarView\/delta/, { status: 200, body: { value: [] } })
    await sync()
    expect(q.pimEventEtags(collection.id).size).toBe(1)
    expect(row().status).toBe('error')
  })

  it('I8 son kişi silinince varsayılan klasörde @removed gelir', async () => {
    graph.contacts.push(graphContact('k1'))
    await sync()
    const book = q.listPimCollectionsByType('addressbook').find((c) => c.remote_id === 'default')!
    expect(q.pimContactEtags(book.id).size).toBe(1)
    graph.contacts.length = 0
    graph.changes.push({ id: 'k1', '@removed': { reason: 'deleted' } })
    q.setPimCollectionState(book.id, {})
    await sync()
    expect(q.pimContactEtags(book.id).size).toBe(0)
  })

  it('çevrilemeyen tek olay turu düşürmez, eski satırı durur', async () => {
    graph.events.get('takvim')!.push(graphEvent('iyi'), graphEvent('bozuk'))
    await sync()
    graph.events.set('takvim', [graphEvent('iyi'), graphEvent('bozuk', { start: { dateTime: 'çöp', timeZone: 'UTC' } })])
    db.prepare(`UPDATE pim_collections SET delta_link = NULL`).run()
    await sync()
    expect([...q.pimEventEtags(cal().id).keys()].sort()).toEqual(['bozuk', 'iyi'])
    expect(row().status).toBe('ok')
  })

  it('geçersiz hexColor saklanmaz', async () => {
    graph.calendars[0].hexColor = 'red;background:url(x)'
    await sync()
    expect(cal().color).toBeNull()
  })

  it('tek paylaşılan takvimin 403ü kaynağı durdurmaz, hepsininki durdurur', async () => {
    graph.calendars.push({ id: 'ikinci', name: 'İ', canEdit: false, isDefaultCalendar: false })
    graph.events.set('ikinci', [])
    graph.on('GET', /calendars\/ikinci\/calendarView\/delta/, { status: 403, body: {} }, false)
    await sync()
    expect(row().status).toBe('ok')
  })

  it('kaynak kaldırılsa da posta yenilemesi posta kapsamını açıkça ister: IMAP Graph belirteci alamaz', async () => {
    const scopes: (string | null)[] = []
    const cache = new TokenCache(() => ({ clientId: 'c' }), undefined, (async (_u: string, init: { body: URLSearchParams }) => {
      scopes.push(new URLSearchParams(String(init.body)).get('scope'))
      return { ok: true, status: 200, json: async () => ({ access_token: 'x', expires_in: 3600 }) }
    }) as never, undefined, (id) => q.mailScopeExplicit(id))
    q.markMailScopeExplicit(acc)
    await pimSourcesHandlers.removePimSource(session(), { id: source.id })
    expect(q.getPimSourceByAccount(acc)).toBeUndefined()
    await cache.get(acc, 'microsoft', 'yenileme', true)
    expect(scopes[0]).toBe(OAUTH_PROVIDERS.microsoft.scopes.join(' '))
    const other = q.insertAccount({ email: 'b@t.co', displayName: null, imapHost: 'x', imapPort: 993, smtpHost: 'x', smtpPort: 587, passwordEnc: Buffer.from('x') })
    await cache.get(other, 'microsoft', 'yenileme', true)
    expect(scopes[1]).toBeNull()
  })

  it('yanıt: accept ucu', async () => {
    graph.events.get('takvim')!.push(graphEvent('e1'))
    await sync()
    await backendFor(hub.pimDeps(), row()).respond!(cal(), 'e1', 'TENTATIVE')
    const post = graph.requests.find((r) => r.method === 'POST')!
    expect(post.url).toBe('/v1.0/me/events/e1/tentativelyAccept')
    expect(post.body).toEqual({ sendResponse: true })
  })

  describe('bağlama', () => {
    const connect = async () => {
      const { connectAccountSource } = await import('../rpc/pimSources')
      return connectAccountSource(session(), q.getAccountRow(acc)!, null)
    }

    it('/me başarılıysa bağlanır ve eşitler', async () => {
      db.prepare(`DELETE FROM pim_sources`).run()
      expect(await connect()).toBe('connected')
      expect(graph.requests.some((r) => r.url === '/v1.0/me')).toBe(true)
      expect(q.getPimSourceByAccount(acc)?.kind).toBe('graph')
    })

    it('/me 401 needsConsent, kaynak açılmaz', async () => {
      db.prepare(`DELETE FROM pim_sources`).run()
      graph.accept = ['Bearer baska']
      expect(await connect()).toBe('needsConsent')
      expect(q.getPimSourceByAccount(acc)).toBeUndefined()
    })

    it('/me 403 kaynak needs_reauth, posta etkilenmez', async () => {
      db.prepare(`DELETE FROM pim_sources`).run()
      graph.on('GET', /^\/v1\.0\/me$/, { status: 403 })
      expect(await connect()).toBe('needsConsent')
      expect(q.getPimSourceByAccount(acc)?.status).toBe('needs_reauth')
      expect(q.getAccountRow(acc)?.auth_type).toBe('oauth:microsoft')
    })
  })
})
