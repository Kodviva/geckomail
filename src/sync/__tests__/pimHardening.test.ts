// Parça 7 gözden geçirmesinin yeniden üretilen bulguları: her test bir saldırı ya da veri kaybı senaryosudur.
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { EventDraft } from '../../shared/pim'
import { safeFetch } from '../net/safeFetch'
import { syncBatch } from '../pim/apply'
import { DavBackend } from '../pim/davBackend'
import { draftToIcs, ensureVtimezones, parseCalendar, splitIcsObjects } from '../pim/ical'
import { trialObject } from '../pim/gateTrial'
import { graphEventToIcs } from '../pim/graphMap'
import { pimHostKey, PimScheduler } from '../pim/pimScheduler'
import { alarmMoments, nextAlarmAt } from '../pim/recur'
import { authHandlers } from '../rpc/auth'
import { calendarHandlers as cal } from '../rpc/calendar'
import { contactsHandlers as con } from '../rpc/contacts'
import { pimSourcesHandlers as src } from '../rpc/pimSources'
import { buildGateWorker, hangingWorker, removeGateWorkers } from './helpers/gateWorker'
import { CAL, pimHarness, type PimHarness } from './helpers/pimHarness'

const EVIL_ZONE = ['BEGIN:VTIMEZONE', 'TZID:Evil', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'RRULE:FREQ=SECONDLY', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE']
const wrap = (...lines: string[]): string => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n')
const vevent = (uid: string, ...more: string[]): string[] => ['BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261101T000000Z', ...more, 'END:VEVENT']
const NOW = Date.UTC(2026, 10, 5)
const draft = (o: Partial<EventDraft> = {}): EventDraft => ({ title: 'A', location: null, description: null, allDay: false, start: '2026-11-20T10:00', end: '2026-11-20T11:00', tz: 'UTC', rrule: null, alarmMinutes: null, ...o })

describe('C1 düşmanca VTIMEZONE', () => {
  const hostile = wrap(...EVIL_ZONE, ...vevent('e1', 'DTSTART;TZID=Evil:20261120T100000', 'DTEND;TZID=Evil:20261120T110000', 'SUMMARY:x', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;VALUE=DATE-TIME;TZID=Evil:20261120T090000', 'END:VALARM'))

  it('roots drops the zone: ensureVtimezones returns', () => {
    const out = ensureVtimezones(hostile)
    expect(typeof out).toBe('string')
    expect(parseCalendar(hostile)!.vtimezones.size).toBe(0)
  })

  it('nextAlarmAt on an absolute trigger in a hostile zone returns', () => {
    expect(nextAlarmAt(parseCalendar(hostile)!, NOW)).toBe(Date.UTC(2026, 10, 20, 9))
  })

  it('trial sees triggers past the alarm horizon', () => {
    const far = wrap(...vevent('e2', 'DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z', 'RRULE:FREQ=YEARLY;COUNT=9'), ...vevent('e2', 'RECURRENCE-ID:20301120T100000Z', 'DTSTART:20301120T100000Z', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;VALUE=DATE-TIME:20301120T090000Z', 'END:VALARM'))
    expect(alarmMoments(parseCalendar(far)!, 'UTC')).toEqual([Date.UTC(2030, 10, 20, 9)])
    expect(trialObject(far, 'UTC', NOW)).not.toBeNull()
  })
})

describe('bilinmeyen TZID', () => {
  it('nextAlarmAt uses the viewer zone, not UTC', () => {
    const c = parseCalendar(wrap(...vevent('z', 'DTSTART;TZID=Yok/Boyle:20261120T100000', 'DTEND;TZID=Yok/Boyle:20261120T110000', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM')))!
    expect(nextAlarmAt(c, NOW, 'Europe/Istanbul')).toBe(Date.UTC(2026, 10, 20, 6, 50))
  })
})

describe('C2 akış şişirmesi', () => {
  it('object count stops the walk', () => {
    const events = Array.from({ length: 20_001 }, (_, i) => `BEGIN:VEVENT\r\nUID:u${i}\r\nDTSTART:20261120T100000Z\r\nEND:VEVENT`).join('\r\n')
    expect(splitIcsObjects(`BEGIN:VCALENDAR\r\n${events}\r\nEND:VCALENDAR\r\n`)).toBe('tooLarge')
  })

  it('oversized zone is dropped, not copied', () => {
    const big = ['BEGIN:VTIMEZONE', 'TZID:Koca', 'X-PAD:' + 'x'.repeat(70_000), 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE']
    const r = splitIcsObjects(wrap(...big, ...vevent('a', 'DTSTART;TZID=Koca:20261120T100000')))
    expect(r).not.toBe('tooLarge')
    expect((r as { data: string }[])[0].data).not.toContain('X-PAD')
  })

  it('amplification hits the output cap', () => {
    const zone = ['BEGIN:VTIMEZONE', 'TZID:Orta', 'X-PAD:' + 'x'.repeat(60_000), 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE']
    const events = Array.from({ length: 2000 }, (_, i) => vevent(`u${i}`, 'DTSTART;TZID=Orta:20261120T100000')).flat()
    expect(splitIcsObjects(wrap(...zone, ...events))).toBe('tooLarge')
  })
})

describe('I1 süre sınırı', () => {
  let srv: Server
  let timers: NodeJS.Timeout[]
  beforeEach(async () => {
    timers = []
    srv = createServer((_q, r) => {
      r.writeHead(200)
      timers.push(setInterval(() => r.write('x'), 50))
    })
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()))
  })
  afterEach(async () => {
    timers.forEach(clearInterval)
    srv.closeAllConnections()
    await new Promise((r) => srv.close(r))
  })

  it('slow drip ends at the wall-clock deadline', async () => {
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`
    const started = Date.now()
    await expect(safeFetch(url, { net: { allowPrivateHosts: 'all', allowedPorts: 'any' }, timeoutMs: 5000, deadlineMs: 300 })).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('ics host key is the real host', () => {
    expect(pimHostKey({ kind: 'ics', label: 'Feed.Example.com', caldav_url: null, carddav_url: null } as never)).toBe('feed.example.com')
    expect(pimHostKey({ kind: 'ics', label: 'a.example', caldav_url: null, carddav_url: null } as never)).not.toBe(pimHostKey({ kind: 'ics', label: 'b.example', caldav_url: null, carddav_url: null } as never))
  })
})

describe('kaynak ve yetki', () => {
  let worker: string
  let t: PimHarness
  beforeAll(() => {
    worker = buildGateWorker()
  })
  afterAll(removeGateWorkers)
  beforeEach(async () => {
    t = await pimHarness(worker)
  })
  afterEach(() => t.close())

  it('I1 run deadline frees the slot and fails the source', async () => {
    const d = { ...t.hub.pimDeps(), decrypt: () => new Promise<string[]>(() => {}) }
    const ics = t.q.insertIcsPimSource({ userId: t.manager, label: 'x.example', urlEnc: Buffer.from('u'), name: 'n', color: null, now: 1 })
    const sch = new PimScheduler(d, { runDeadlineMs: 100 })
    await sch.syncNow(ics.id)
    expect(t.q.getPimSource(ics.id)).toMatchObject({ status: 'error', fail_count: 1 })
    sch.stop()
  })

  it('I2 href cannot leave the origin', async () => {
    await t.sync()
    const b = new DavBackend(t.hub.pimDeps(), t.source) as unknown as { urlOf(c: unknown, p: string): string }
    const c = t.calendar()
    const origin = new URL(t.source.caldav_url!).origin
    for (const p of ['//evil.test/x', '///evil.test/x']) expect(new URL(b.urlOf(c, p)).origin).toBe(origin)
    expect(() => b.urlOf(c, 'https://evil.test/x')).toThrow()
  })

  it('I3 fully rejected replace keeps old rows and validators', async () => {
    t.dav.seed(`${CAL}1.ics`, wrap(...vevent('eski', 'DTSTART:20261120T100000Z')))
    await t.sync()
    const c = t.calendar()
    const batch = syncBatch(t.hub.pimDeps(), c)
    batch.sink.replaceAll([{ remoteId: 'yeni', etag: null, data: 'BEGIN:VCALENDAR\r\nbozuk' }])
    batch.sink.setState({ feedEtag: 'e2' })
    await expect(batch.commit()).rejects.toThrow()
    expect(t.q.pimEventEtags(c.id).size).toBe(1)
  })

  it('I4 manage right lost: connect refused even on a stale session', async () => {
    const s = t.session(t.manager)
    t.q.setGroupPermission(t.manager, t.group, true, false)
    await expect(src.connectAccountPim(s, { accountId: t.acc })).rejects.toThrow()
    expect(t.dav.requests).toHaveLength(0)
  })

  it('I4 permission change refreshes live sessions', async () => {
    const log: { event?: string }[] = []
    t.session(t.viewer, log)
    const stranger: { event?: string }[] = []
    t.session(t.stranger, stranger)
    const admin = t.session(t.admin)
    await authHandlers.setGroupPermission(admin, { userId: t.viewer, groupId: t.group, canView: false, canManage: false })
    await authHandlers.setGroupPermission(admin, { userId: t.stranger, groupId: t.group, canView: true, canManage: false })
    t.hub.broadcast('pim:changed', { kind: 'calendar', sourceId: t.source.id, accountId: t.acc })
    expect(log.filter((m) => m.event === 'pim:changed')).toEqual([])
    expect(stranger.filter((m) => m.event === 'pim:changed')).toHaveLength(1)
  })

  describe('yazma denetimleri', () => {
    const series = (): string => wrap(...vevent('s1', 'DTSTART:20261102T100000Z', 'DTEND:20261102T110000Z', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:s'))
    const seeded = async (): Promise<number> => {
      t.dav.seed(`${CAL}1.ics`, series())
      await t.sync()
      return (t.db.prepare(`SELECT id FROM calendar_objects`).get() as { id: number }).id
    }

    it('window beyond the absolute bound refused', async () => {
      await expect(cal.listEvents(t.session(t.manager), { from: Date.UTC(9000, 0, 1), to: Date.UTC(9000, 0, 2), tz: 'UTC' })).rejects.toThrow()
    })

    it('recurrenceId format checked', async () => {
      const objectId = await seeded()
      await expect(cal.deleteEvent(t.session(t.manager), { objectId, scope: 'this', recurrenceId: 'X\r\nBEGIN:VEVENT' })).rejects.toThrow(/geçersiz|invalid/i)
    })

    it('etag must be a string; null cannot drop If-Match', async () => {
      const objectId = await seeded()
      await expect(cal.saveEvent(t.session(t.manager), { collectionId: t.calendar().id, objectId, etag: 5, draft: draft() })).rejects.toThrow()
      await cal.saveEvent(t.session(t.manager), { collectionId: t.calendar().id, objectId, etag: null, draft: draft() })
      expect(t.dav.requests.find((r) => r.method === 'PUT')!.headers['if-match']).toBeTruthy()
    })

    it('interval above the safe cap refused, not silently one event', async () => {
      await t.sync()
      await expect(cal.saveEvent(t.session(t.manager), { collectionId: t.calendar().id, draft: draft({ rrule: { freq: 'WEEKLY', interval: 900 } }) })).rejects.toThrow()
      expect(t.dav.requests.filter((r) => r.method === 'PUT')).toEqual([])
    })

    it('object the gate rejects never reaches the server', async () => {
      await t.sync()
      t.hub.deps.pimGateWorker = hangingWorker()
      await expect(cal.saveEvent(t.session(t.manager), { collectionId: t.calendar().id, draft: draft({ title: 'HANG' }) })).rejects.toThrow()
      expect(t.dav.requests.filter((r) => r.method === 'PUT')).toEqual([])
    })

    it('thisAndFuture tail counts only what is left', () => {
      const ics = draftToIcs(draft({ start: '2026-11-16T10:00', end: '2026-11-16T11:00', rrule: { freq: 'WEEKLY', interval: 1, count: 4 } }), { base: series(), now: NOW, scope: 'thisAndFuture', uid: 'kuyruk', recurrenceId: '20261116T100000Z' })
      expect(ics).toContain('COUNT=2')
    })

    it('subscription limit holds across the await', async () => {
      for (let i = 0; i < 49; i++) t.q.insertIcsPimSource({ userId: t.manager, label: 'x', urlEnc: Buffer.from('u'), name: 'n', color: null, now: 1 })
      const feed = createServer((_q, r) => r.end(wrap(...vevent('a', 'DTSTART:20261120T100000Z'))))
      await new Promise<void>((res) => feed.listen(0, '127.0.0.1', () => res()))
      const url = `http://127.0.0.1:${(feed.address() as AddressInfo).port}/f.ics`
      const r = await Promise.allSettled([cal.addIcsSubscription(t.session(t.manager), { url, name: 'a' }), cal.addIcsSubscription(t.session(t.manager), { url, name: 'b' })])
      feed.closeAllConnections()
      await new Promise((res) => feed.close(res))
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
      expect(t.q.countIcsSources(t.manager)).toBe(50)
    })

    it('import: wrong password goes out once', async () => {
      await t.sync()
      t.dav.accept = ['Basic baska']
      const vcards = Array.from({ length: 6 }, (_, i) => `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:k${i}\r\nFN:K${i}\r\nEND:VCARD\r\n`).join('')
      t.dav.requests.length = 0
      await con.importContacts(t.session(t.manager), { collectionId: t.book().id, vcards })
      expect(t.dav.requests.filter((r) => r.method === 'PUT' && r.headers.authorization)).toHaveLength(1)
    })

    it('transient home failure keeps collections and prefs', async () => {
      await t.sync()
      const book = t.book()
      t.db.prepare(`UPDATE pim_sources SET carddav_url = ? WHERE id = ?`).run(`${t.dav.url}/.well-known/carddav`, t.source.id)
      t.dav.override('PROPFIND', '/.well-known/carddav', { status: 200, body: '<html/>' })
      await t.sync()
      expect(t.q.getPimCollection(book.id)).toBeTruthy()
    })

    it('sync right after an alarm falls due keeps it', async () => {
      t.dav.seed(`${CAL}1.ics`, wrap(...vevent('a1', 'DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM')))
      await t.sync()
      const c = t.calendar()
      const row = t.db.prepare(`SELECT remote_id, next_alarm_at FROM calendar_objects`).get() as { remote_id: string; next_alarm_at: number }
      const due = row.next_alarm_at
      t.q.upsertPimEvent(c.id, { remoteId: row.remote_id, etag: 'x', raw: 'r', nextAlarmAt: due + 864e5, now: due + 1000, fields: { uid: 'a1', rangeStart: 1, rangeEnd: 2, recurring: false, sequence: 0, organizer: null } })
      expect((t.db.prepare(`SELECT next_alarm_at AS n FROM calendar_objects`).get() as { n: number }).n).toBe(due)
    })

    it('personal source limit and password update', async () => {
      t.q.insertPersonalPimSource({ userId: t.manager, label: 'p', caldavUrl: `${t.dav.url}/dav/cal/a/`, carddavUrl: null, serverSchedules: false, username: 'a@t.co', secretEnc: Buffer.from('enc:yanlis'), now: 1 })
      const id = (t.db.prepare(`SELECT id FROM pim_sources WHERE owner_user_id = ? AND kind = 'dav'`).get(t.manager) as { id: number }).id
      t.q.markPimSourceNeedsReauth(id, 'ret')
      await expect(src.updatePersonalDavPassword(t.session(t.admin), { id, password: 'parola' })).rejects.toThrow()
      expect(await src.updatePersonalDavPassword(t.session(t.manager), { id, password: 'parola' })).toEqual({ status: 'connected' })
      expect(t.q.getPimSource(id)).toMatchObject({ status: 'ok' })
      for (let i = 0; i < 10; i++) t.q.insertPersonalPimSource({ userId: t.manager, label: 'p', caldavUrl: null, carddavUrl: null, serverSchedules: false, username: 'x', secretEnc: Buffer.from('e'), now: 1 })
      await expect(src.addPersonalDav(t.session(t.manager), { url: `${t.dav.url}/`, username: 'a@t.co', password: 'parola' })).rejects.toThrow()
    })

    it('account secret unavailable is not reported as missing consent', async () => {
      t.hub.deps.creds.delete(t.acc)
      expect(await src.connectAccountPim(t.session(t.admin), { accountId: t.acc })).toEqual({ status: 'noSecret' })
    })
  })
})

describe('Graph eşlemesi', () => {
  it('address cannot inject lines', () => {
    const raw = graphEventToIcs({ id: 'e', start: { dateTime: '2026-11-20T10:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-20T11:00:00', timeZone: 'UTC' }, organizer: { emailAddress: { address: 'a@b.co\r\nX-GECKO-SERIES-MASTER:baska' } } })
    expect(raw).not.toMatch(/^X-GECKO-SERIES-MASTER/m)
  })
})

