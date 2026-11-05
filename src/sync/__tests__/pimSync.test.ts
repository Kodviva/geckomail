import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries, type PimSourceRow } from '../db/queries'
import type { PimDeps } from '../pim/backend'
import { syncBatch } from '../pim/apply'
import { backendFor } from '../pim/backend'
import { ensureVtimezones, parseCalendar } from '../pim/ical'
import { backoffMs, PimScheduler } from '../pim/pimScheduler'
import { expandObject } from '../pim/recur'
import { FakeDav } from './helpers/fakeDav'
import { buildGateWorker, hangingWorker, removeGateWorkers } from './helpers/gateWorker'

const HEADER = `Basic ${Buffer.from('kisi@t.co:parola').toString('base64')}`
const CAL = '/dav/cal/a/ev/'
const BOOK = '/dav/card/a/ki/'
const NOW = Date.UTC(2026, 10, 4)
const ics = (uid: string, ...more: string[]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z', 'DTSTART:20270105T100000Z', 'DTEND:20270105T110000Z', `SUMMARY:${uid}`, ...more, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
const vcf = (uid: string, email = `${uid}@t.co`): string => ['BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`, `FN:${uid}`, `EMAIL:${email}`, 'END:VCARD', ''].join('\r\n')

describe('kişi ve takvim eşitlemesi', () => {
  let worker: string
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let dav: FakeDav
  let acc: number
  let source: PimSourceRow
  let deps: PimDeps
  let sched: PimScheduler
  let clock: number
  let offline: boolean
  let events: string[]
  const creds = new Map<number, string>()

  beforeAll(() => {
    worker = buildGateWorker()
  })
  afterAll(removeGateWorkers)

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-pimsync-'))
    db = openDb(dir)
    q = makeQueries(db)
    dav = await FakeDav.start()
    dav.accept = [HEADER]
    dav.collections.set(CAL, { type: 'calendar', name: 'İş', color: '#112233FF' })
    dav.collections.set(BOOK, { type: 'addressbook', name: 'Rehber' })
    acc = q.insertAccount({ email: 'kisi@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    creds.clear()
    creds.set(acc, 'parola')
    source = q.upsertAccountPimSource({ accountId: acc, kind: 'dav', label: 'k', caldavUrl: `${dav.url}/dav/cal/a/`, carddavUrl: `${dav.url}/dav/card/a/`, serverSchedules: false, grantedScopes: null, now: 1 })
    clock = NOW
    offline = false
    events = []
    deps = {
      q, creds, decrypt: async (b) => b.map((x) => Buffer.from(x).toString()), net: () => ({ allowPrivateHosts: 'all', allowedPorts: 'any' }),
      offline: () => offline, emit: (_s, kind) => events.push(kind), now: () => clock, gateWorker: worker
    }
    sched = new PimScheduler(deps)
  })
  afterEach(async () => {
    sched.stop()
    await dav.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const row = (): PimSourceRow => q.getPimSource(source.id)!
  const cal = () => q.listPimCollectionsByType('calendar').find((c) => c.source_id === source.id)!
  const eventIds = (): string[] => [...q.pimEventEtags(cal().id).keys()].sort()
  const syncs = (): number => dav.requests.filter((r) => r.body.includes('sync-collection')).length
  const multigets = (): number => dav.requests.filter((r) => r.body.includes('multiget')).length
  const next = async (): Promise<void> => {
    clock += 3_600_000
    await sched.syncNow(source.id)
  }

  it('initial sync stores objects', async () => {
    dav.seed(`${CAL}1.ics`, ics('e1', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM'))
    dav.seed(`${BOOK}1.vcf`, vcf('k1'))
    await sched.syncNow(source.id)
    expect(cal()).toMatchObject({ name: 'İş', color: '#112233', read_only: 0 })
    const obj = db.prepare(`SELECT uid, next_alarm_at, recurring FROM calendar_objects`).get()
    expect(obj).toEqual({ uid: 'e1', next_alarm_at: Date.UTC(2027, 0, 5, 9, 45), recurring: 0 })
    expect(db.prepare(`SELECT full_name FROM contacts`).all()).toEqual([{ full_name: 'k1' }])
    expect(db.prepare(`SELECT addr FROM contact_emails`).all()).toEqual([{ addr: 'k1@t.co' }])
    expect(row()).toMatchObject({ status: 'ok', fail_count: 0, last_sync_at: NOW, next_sync_at: NOW + 300_000 })
    expect(events).toEqual(expect.arrayContaining(['contacts', 'calendar', 'sources']))
  })

  it('incremental sync token', async () => {
    dav.seed(`${CAL}1.ics`, ics('e1'))
    dav.seed(`${CAL}2.ics`, ics('e2'))
    await sched.syncNow(source.id)
    expect(cal().sync_token).toBeTruthy()
    dav.seed(`${CAL}3.ics`, ics('e3'))
    dav.seed(`${CAL}1.ics`, ics('e1', 'LOCATION:Yeni'))
    dav.drop(`${CAL}2.ics`)
    dav.requests.length = 0
    await next()
    expect(syncs()).toBeGreaterThan(0)
    expect(eventIds()).toEqual([`${CAL}1.ics`, `${CAL}3.ics`])
    expect((db.prepare(`SELECT raw FROM calendar_objects WHERE remote_id = ?`).get(`${CAL}1.ics`) as { raw: string }).raw).toContain('Yeni')
    expect(cal().sync_token).toBe(dav.token)
  })

  it('token invalid full resync without duplicates', async () => {
    dav.seed(`${CAL}1.ics`, ics('e1'))
    await sched.syncNow(source.id)
    db.prepare(`UPDATE pim_collections SET sync_token = 'bayat' WHERE id = ?`).run(cal().id)
    dav.seed(`${CAL}2.ics`, ics('e2'))
    await next()
    expect(eventIds()).toEqual([`${CAL}1.ics`, `${CAL}2.ics`])
    expect(cal().sync_token).toBe(dav.token)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM calendar_objects`).get() as { n: number }).n).toBe(2)
  })

  it('truncated en çok 20 tur sürer, kısmi sonuç işlenir', async () => {
    dav.seed(`${CAL}1.ics`, ics('e1'))
    await sched.syncNow(source.id)
    dav.seed(`${CAL}2.ics`, ics('e2'))
    const xml = { 'content-type': 'application/xml' }
    const part = (token: string) => `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${CAL}2.ics</D:href><D:propstat><D:prop><D:getetag>"x"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response><D:sync-token>${token}</D:sync-token></D:multistatus>`
    for (let i = 0; i < 25; i++) dav.override('REPORT', CAL, (r) => (r.body.includes('sync-collection') ? { status: 507, headers: xml, body: part(`tok-${dav.token.slice(4)}`) } : null))
    await next()
    expect(syncs()).toBeLessThanOrEqual(21)
    expect(eventIds()).toContain(`${CAL}2.ics`)
  })

  describe('sync-token vermeyen sunucu', () => {
    beforeEach(() => {
      dav.noSyncToken = true
    })

    it('no sync token uses ctag', async () => {
      dav.seed(`${CAL}1.ics`, ics('e1'))
      await sched.syncNow(source.id)
      expect(cal().sync_token).toBeNull()
      expect(cal().ctag).toBeTruthy()
      expect(syncs()).toBe(0)
      expect(eventIds()).toEqual([`${CAL}1.ics`])
    })

    it('ctag same no multiget', async () => {
      dav.seed(`${CAL}1.ics`, ics('e1'))
      await sched.syncNow(source.id)
      dav.requests.length = 0
      await next()
      expect(multigets()).toBe(0)
      expect(dav.requests.filter((r) => r.method === 'PROPFIND' && r.path === CAL && r.headers.depth === '1')).toHaveLength(0)
    })

    it('etag diff removes deleted', async () => {
      dav.seed(`${CAL}1.ics`, ics('e1'))
      dav.seed(`${CAL}2.ics`, ics('e2'))
      await sched.syncNow(source.id)
      dav.drop(`${CAL}2.ics`)
      dav.seed(`${CAL}3.ics`, ics('e3'))
      dav.requests.length = 0
      await next()
      expect(eventIds()).toEqual([`${CAL}1.ics`, `${CAL}3.ics`])
      // değişmeyen nesne yeniden çekilmez
      expect(dav.requests.filter((r) => r.body.includes(`${CAL}1.ics`))).toHaveLength(0)
    })

    it('multiget 501 falls back to GET', async () => {
      dav.seed(`${CAL}1.ics`, ics('e1'))
      dav.override('REPORT', CAL, { status: 501 })
      await sched.syncNow(source.id)
      expect(eventIds()).toEqual([`${CAL}1.ics`])
      expect(dav.requests.some((r) => r.method === 'GET' && r.path === `${CAL}1.ics`)).toBe(true)
    })
  })

  it('malformed object skipped others stored', async () => {
    dav.seed(`${CAL}1.ics`, ics('e1'))
    dav.seed(`${CAL}2.ics`, 'BEGIN:VCALENDAR\r\nbozuk')
    dav.seed(`${CAL}3.ics`, ics('e3', 'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30'))
    dav.seed(`${BOOK}1.vcf`, 'BEGIN:VCARD\r\nbozuk')
    dav.seed(`${BOOK}2.vcf`, vcf('k2'))
    await sched.syncNow(source.id)
    expect(eventIds()).toEqual([`${CAL}1.ics`, `${CAL}3.ics`])
    expect(db.prepare(`SELECT recurring FROM calendar_objects WHERE uid = 'e3'`).get()).toEqual({ recurring: 0 })
    expect((db.prepare(`SELECT COUNT(*) AS n FROM contacts`).get() as { n: number }).n).toBe(1)
    expect(row().status).toBe('ok')
  })

  it('başka kökene çıkan href kimlik taşımaz', async () => {
    dav.seed(`${CAL}1.ics`, ics('e1'))
    await sched.syncNow(source.id)
    const evil = await FakeDav.start()
    const xml = { 'content-type': 'application/xml' }
    dav.override('REPORT', CAL, { status: 207, headers: xml, body: `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${evil.url}/calar/x.ics</D:href><D:propstat><D:prop><D:getetag>"x"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response><D:sync-token>tok-1</D:sync-token></D:multistatus>` })
    await next()
    expect(evil.requests).toHaveLength(0)
    await evil.close()
  })

  it('401 stops source, no retry', async () => {
    dav.accept = ['Basic baska']
    await sched.syncNow(source.id)
    expect(row().status).toBe('needs_reauth')
    expect(dav.requests).toHaveLength(1)
    clock += 86_400_000
    sched.tick()
    await sched.syncNow(source.id)
    await new Promise((r) => setTimeout(r, 30))
    expect(dav.requests).toHaveLength(1)
  })

  it('backoff doubles to 6h cap', async () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([60_000, 120_000, 240_000, 480_000])
    expect(backoffMs(10)).toBe(6 * 3_600_000)
    expect(backoffMs(500)).toBe(6 * 3_600_000)
    dav.accept = null
    for (let i = 0; i < 2; i++) dav.override('PROPFIND', '/dav/cal/a/', { status: 500 })
    await sched.syncNow(source.id)
    expect(row()).toMatchObject({ status: 'error', fail_count: 1, next_sync_at: NOW + 60_000 })
    await sched.syncNow(source.id)
    expect(row()).toMatchObject({ status: 'error', fail_count: 2, next_sync_at: NOW + 120_000 })
    await sched.syncNow(source.id)
    expect(row()).toMatchObject({ status: 'ok', fail_count: 0 })
  })

  it('hata turu kısmi sonuç saklamaz, belirteç ilerlemez', async () => {
    dav.seed(`${CAL}1.ics`, ics('e1'))
    dav.override('REPORT', CAL, { status: 500 })
    await sched.syncNow(source.id)
    expect(row().status).toBe('error')
    expect(cal().sync_token).toBeNull()
    expect(eventIds()).toEqual([])
  })

  it('alım kapısı yoksa tur hata olur, veri kaybolmaz', async () => {
    dav.seed(`${CAL}1.ics`, ics('e1'))
    await sched.syncNow(source.id)
    const down = new PimScheduler({ ...deps, gateWorker: join(dir, 'yok.mjs') })
    dav.seed(`${CAL}2.ics`, ics('e2'))
    clock += 3_600_000
    await down.syncNow(source.id)
    expect(row().status).toBe('error')
    expect(eventIds()).toEqual([`${CAL}1.ics`])
    await sched.syncNow(source.id)
    expect(eventIds()).toEqual([`${CAL}1.ics`, `${CAL}2.ics`])
  })

  describe('takılan nesneler', () => {
    const hanging = (from: number): void => {
      for (let i = from; i < from + 6; i++) dav.seed(`${CAL}h${i}.ics`, ics(`h${i}`, 'X-T:HANG'))
    }

    beforeEach(() => {
      sched = new PimScheduler({ ...deps, gateWorker: hangingWorker() })
    })

    it('ertelenen varken belirteç ilerlemez, sonraki tur kalanı getirir, takılan reddedilmiş kalır', async () => {
      dav.seed(`${CAL}1.ics`, ics('e1'))
      await sched.syncNow(source.id)
      const before = cal().sync_token
      expect(before).toBeTruthy()
      hanging(0)
      dav.seed(`${CAL}2.ics`, ics('e2'))
      dav.seed(`${CAL}3.ics`, ics('e3'))
      await next()
      expect(cal().sync_token).toBe(before)
      expect(eventIds()).toEqual([`${CAL}1.ics`])
      expect(row()).toMatchObject({ status: 'ok', next_sync_at: clock + 300_000 })
      // ilk takılma ertelenir, ikincisi reddedilir: altıncı nesne sonraki turlarda aynı yolu izler
      await next()
      await next()
      expect(cal().sync_token).toBe(before)
      await next()
      expect(eventIds()).toEqual([`${CAL}1.ics`, `${CAL}2.ics`, `${CAL}3.ics`])
      expect(cal().sync_token).toBe(dav.token)
      expect(eventIds().filter((p) => p.includes('/h'))).toEqual([])
    }, 40_000)

    it('belirteçsiz sunucuda ctag da ertelenen varken saklanmaz', async () => {
      dav.noSyncToken = true
      hanging(0)
      dav.seed(`${CAL}2.ics`, ics('e2'))
      await sched.syncNow(source.id)
      expect(cal().ctag).toBeNull()
      expect(eventIds()).toEqual([])
      await next()
      await next()
      await next()
      expect(eventIds()).toEqual([`${CAL}2.ics`])
      expect(cal().ctag).toBeTruthy()
    }, 40_000)

    it('ertelenen tur da uygun nesneleri ve silmeleri saklar', async () => {
      const c = q.reconcilePimCollections(source.id, [{ type: 'calendar', remoteId: CAL, name: 'x', color: null, readOnly: false }])[0]
      const seed = syncBatch(deps, c)
      seed.sink.upsert({ remoteId: 'eski', etag: '1', data: ics('eski') })
      await seed.commit()
      const batch = syncBatch({ ...deps, gateWorker: hangingWorker() }, c)
      batch.sink.upsert({ remoteId: 'iyi', etag: '1', data: ics('iyi') })
      for (let i = 0; i < 6; i++) batch.sink.upsert({ remoteId: `h${i}`, etag: '1', data: ics(`h${i}`, 'X-T:HANG') })
      batch.sink.upsert({ remoteId: 'son', etag: '1', data: ics('son') })
      batch.sink.remove('eski')
      batch.sink.setState({ syncToken: 'yeni', ctag: 'yeni' })
      await expect(batch.commit()).resolves.toEqual({ changed: 2, skipped: 5, deferred: 2 })
      expect(cal().sync_token).toBeNull()
      expect(cal().ctag).toBeNull()
      expect(eventIds()).toEqual(['iyi'])
    }, 20_000)
  })

  it('parallel limit per host', async () => {
    const ids = [source.id, ...[1, 2, 3].map((n) => {
      const user = q.insertUser({ username: `u${n}`, passwordHash: 'x', role: 'member' })
      return q.insertPersonalPimSource({ userId: user, label: 'p', caldavUrl: `${dav.url}/dav/cal/a/`, carddavUrl: null, serverSchedules: false, username: 'kisi@t.co', secretEnc: Buffer.from('parola'), now: 1 }).id
    })]
    dav.latency = 30
    sched.tick()
    await new Promise((r) => setTimeout(r, 10))
    sched.tick()
    await new Promise((r) => setTimeout(r, 400))
    sched.tick()
    await new Promise((r) => setTimeout(r, 400))
    expect(dav.peak).toBe(2)
    expect(ids.filter((id) => q.getPimSource(id)!.last_sync_at != null)).toHaveLength(4)
  })

  it('offline skipped', async () => {
    offline = true
    sched.tick()
    await sched.syncNow(source.id)
    expect(dav.requests).toHaveLength(0)
  })

  it('vault locked skipped', async () => {
    q.setAccountSecureFlag(acc, true)
    sched.tick()
    await sched.syncNow(source.id)
    expect(dav.requests).toHaveLength(0)
    expect(row()).toMatchObject({ status: 'ok', fail_count: 0, next_sync_at: 0 })
    q.setAccountSecureFlag(acc, false)
    creds.delete(acc)
    sched.tick()
    expect(dav.requests).toHaveLength(0)
  })

  it('listeden çıkan koleksiyon nesneleriyle silinir, salt okunur işaretlenir', async () => {
    dav.seed(`${BOOK}1.vcf`, vcf('k1'))
    dav.collections.get(CAL)!.readOnly = true
    await sched.syncNow(source.id)
    expect(cal().read_only).toBe(1)
    dav.collections.delete(BOOK)
    await next()
    expect(q.listPimCollectionsByType('addressbook').filter((c) => c.source_id === source.id)).toHaveLength(0)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM contacts`).get() as { n: number }).n).toBe(0)
  })

  describe('yazma', () => {
    const fresh = async () => {
      await sched.syncNow(source.id)
      return backendFor(deps, row())
    }

    it('yeni olay If-None-Match ile, güncelleme If-Match ile gider; çakışma döner', async () => {
      const b = await fresh()
      const made = await b.putEvent(cal(), null, ics('y1'), null)
      if (made === 'conflict') throw new Error('çakışma')
      expect(made.remoteId).toMatch(/^\/dav\/cal\/a\/ev\/.+\.ics$/)
      expect(dav.requests.find((r) => r.method === 'PUT')!.headers['if-none-match']).toBe('*')
      const updated = await b.putEvent(cal(), made.remoteId, ics('y1', 'LOCATION:B'), made.etag)
      expect(updated).not.toBe('conflict')
      expect(await b.putEvent(cal(), made.remoteId, ics('y1', 'LOCATION:C'), '"eski"')).toBe('conflict')
      expect(await b.deleteEvent(cal(), made.remoteId, '"eski"')).toBe('conflict')
      expect(await b.deleteEvent(cal(), made.remoteId, null)).toBe('ok')
      expect(await b.deleteEvent(cal(), made.remoteId, null)).toBe('ok')
    })

    it('TZID etkinliğine VTIMEZONE eklenir', async () => {
      const b = await fresh()
      const raw = ics('tz1').replace('DTSTART:20270105T100000Z', 'DTSTART;TZID=Europe/Berlin:20270105T100000').replace('DTEND:20270105T110000Z', 'DTEND;TZID=Europe/Berlin:20270105T110000')
      await b.putEvent(cal(), null, raw, null)
      const sent = dav.requests.find((r) => r.method === 'PUT')!.body
      expect(sent).toContain('BEGIN:VTIMEZONE')
      expect(sent.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(sent.indexOf('BEGIN:VEVENT'))
    })
  })
})

describe('ensureVtimezones', () => {
  const berlin = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN', 'BEGIN:VEVENT', 'UID:u', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=Europe/Berlin:20260323T100000', 'DTEND;TZID=Europe/Berlin:20260323T110000', 'RRULE:FREQ=WEEKLY', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')

  it('gömülü gövde DST sonrasını da doğru verir', () => {
    const raw = ensureVtimezones(berlin)
    const parsed = parseCalendar(raw.replaceAll('Europe/Berlin', 'Gomulu/Dilim'))!
    expect(parsed.vtimezones.size).toBe(1)
    const occ = expandObject(parsed, Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 10), 'UTC').map((o) => new Date(o.start).toISOString())
    expect(occ).toEqual(['2026-03-23T09:00:00.000Z', '2026-03-30T08:00:00.000Z', '2026-04-06T08:00:00.000Z'])
  })

  it('yaz saati olmayan dilimde tek STANDARD', () => {
    const raw = ensureVtimezones(berlin.replaceAll('Europe/Berlin', 'Asia/Tokyo'))
    expect(raw).toContain('BEGIN:STANDARD')
    expect(raw).not.toContain('BEGIN:DAYLIGHT')
    expect(raw).toContain('TZOFFSETTO:+0900')
  })

  it('varolan gövde, UTC ve bilinmeyen ad değişmez', () => {
    const once = ensureVtimezones(berlin)
    expect(ensureVtimezones(once)).toBe(once)
    const utc = berlin.replaceAll(';TZID=Europe/Berlin:20260323T100000', ':20260323T100000Z').replaceAll(';TZID=Europe/Berlin:20260323T110000', ':20260323T110000Z')
    expect(ensureVtimezones(utc)).toBe(utc)
    const unknown = berlin.replaceAll('Europe/Berlin', 'Bilinmeyen Dilim')
    expect(ensureVtimezones(unknown)).toBe(unknown)
    expect(ensureVtimezones('bozuk')).toBe('bozuk')
  })
})
