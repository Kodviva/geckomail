import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { EventDetail, EventDraft, EventOccurrence } from '../../shared/pim'
import { parseCalendar } from '../pim/ical'
import { calendarHandlers as h } from '../rpc/calendar'
import { pimSourcesHandlers } from '../rpc/pimSources'
import { buildGateWorker, removeGateWorkers } from './helpers/gateWorker'
import { CAL, pimHarness, type PimHarness } from './helpers/pimHarness'

const MAR = Date.UTC(2026, 2, 1)
const APR = Date.UTC(2026, 3, 1)
const DAY = 864e5
const ics = (uid: string, ...more: string[]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z', `SUMMARY:${uid}`, ...more, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
const single = (uid: string, ...more: string[]): string => ics(uid, 'DTSTART:20260310T100000Z', 'DTEND:20260310T110000Z', ...more)
const series = (uid: string, ...more: string[]): string => ics(uid, 'DTSTART;TZID=Europe/Berlin:20260302T100000', 'DTEND;TZID=Europe/Berlin:20260302T110000', 'RRULE:FREQ=WEEKLY;COUNT=4', ...more)
const draft = (o: Partial<EventDraft> = {}): EventDraft => ({
  title: 'Toplantı', location: null, description: null, allDay: false, start: '2026-03-10T10:00', end: '2026-03-10T11:00', tz: 'Europe/Istanbul', rrule: null, alarmMinutes: null, ...o
})

describe('takvim RPC', () => {
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

  const list = async (user = t.manager, tz = 'UTC', from = MAR, to = APR): Promise<EventOccurrence[]> =>
    (await h.listEvents(t.session(user), { from, to, tz })) as EventOccurrence[]
  const objectId = (uid: string): number => (t.db.prepare(`SELECT id FROM calendar_objects WHERE uid = ?`).get(uid) as { id: number }).id
  const puts = () => t.dav.requests.filter((r) => r.method === 'PUT')
  const seeded = async (raw = series('s1')): Promise<number> => {
    t.dav.seed(`${CAL}1.ics`, raw)
    await t.sync()
    return objectId(parseCalendar(raw)!.uid)
  }

  it('every calendar method denies member without access', async () => {
    const id = await seeded()
    const cal = t.calendar().id
    const calls: Record<string, unknown> = {
      getEvent: { objectId: id, tz: 'UTC' }, saveEvent: { collectionId: cal, draft: draft() }, deleteEvent: { objectId: id }, listEvents: { from: MAR, to: APR, tz: 'UTC', collectionIds: [cal] }
    }
    for (const [name, params] of Object.entries(calls)) await expect(h[name](t.session(t.stranger), params), name).rejects.toThrow()
    expect(await h.listEvents(t.session(t.stranger), { from: MAR, to: APR, tz: 'UTC' })).toEqual([])
    expect(Object.keys(h).sort()).toEqual([...Object.keys(calls), 'addIcsSubscription'].sort())
    expect(puts()).toEqual([])
  })

  it('view-only member cannot write', async () => {
    const id = await seeded()
    const s = t.session(t.viewer)
    expect(await list(t.viewer)).toHaveLength(4)
    await expect(h.saveEvent(s, { collectionId: t.calendar().id, draft: draft() })).rejects.toThrow()
    await expect(h.deleteEvent(s, { objectId: id })).rejects.toThrow()
  })

  it('listEvents açılmış örnek döner', async () => {
    await seeded()
    const occ = await list()
    expect(occ.map((o) => o.start)).toEqual([Date.UTC(2026, 2, 2, 9), Date.UTC(2026, 2, 9, 9), Date.UTC(2026, 2, 16, 9), Date.UTC(2026, 2, 23, 9)])
    expect(occ[0]).toMatchObject({ uid: 's1', title: 's1', recurring: true, canEdit: true, recurrenceId: '20260302T090000Z', cancelled: false, tz: 'Europe/Berlin' })
    expect(new Set(occ.map((o) => o.key)).size).toBe(4)
  })

  it('listEvents window over 400 days rejected', async () => {
    await expect(h.listEvents(t.session(t.admin), { from: 0, to: 401 * DAY, tz: 'UTC' })).rejects.toThrow()
    await expect(h.listEvents(t.session(t.admin), { from: 10, to: 5, tz: 'UTC' })).rejects.toThrow()
    expect(await h.listEvents(t.session(t.admin), { from: 0, to: 400 * DAY, tz: 'Olmayan/Dilim' })).toEqual([])
  })

  it('hidden calendar excluded', async () => {
    await seeded()
    await pimSourcesHandlers.setPimCollectionPref(t.session(t.manager), { collectionId: t.calendar().id, hidden: true })
    expect(await list()).toEqual([])
    expect(await h.listEvents(t.session(t.manager), { from: MAR, to: APR, tz: 'UTC', collectionIds: [t.calendar().id] })).toEqual([])
    expect(await list(t.admin)).toHaveLength(4)
  })

  it('personal subscription invisible to admin', async () => {
    const s = t.session(t.viewer)
    await pimSourcesHandlers.listPimSources(s, {})
    const mine = (await pimSourcesHandlers.listPimCollections(s, { type: 'calendar' }) as { id: number; sourceId: number }[]).find((c) => c.sourceId !== t.source.id)!
    await h.saveEvent(s, { collectionId: mine.id, draft: draft({ title: 'Özel' }) })
    expect((await list(t.viewer)).map((o) => o.title)).toEqual(['Özel'])
    expect(await list(t.admin)).toEqual([])
    await expect(h.listEvents(t.session(t.admin), { from: MAR, to: APR, tz: 'UTC', collectionIds: [mine.id] })).rejects.toThrow()
  })

  it('create puts with if-none-match', async () => {
    await t.sync()
    const r = (await h.saveEvent(t.session(t.manager), { collectionId: t.calendar().id, draft: draft() })) as { ok: true; objectId: number; etag: string }
    expect(r).toMatchObject({ ok: true })
    const put = puts()[0]
    expect(put.headers['if-none-match']).toBe('*')
    const row = t.db.prepare(`SELECT uid, remote_id, range_start FROM calendar_objects WHERE id = ?`).get(r.objectId) as { uid: string; remote_id: string; range_start: number }
    expect(put.path).toBe(`${CAL}${row.uid}.ics`)
    expect(row.remote_id).toBe(put.path)
    expect(row.range_start).toBe(Date.UTC(2026, 2, 10, 7))
    expect(put.body).toContain('BEGIN:VTIMEZONE')
    expect(r.etag).toBe(t.dav.objects.get(put.path)!.etag)
  })

  it('put without etag refetches', async () => {
    await t.sync()
    t.dav.onPut = (path) => {
      t.dav.seed(path, single('sunucu'))
      return { status: 201 }
    }
    const r = (await h.saveEvent(t.session(t.manager), { collectionId: t.calendar().id, draft: draft() })) as { etag: string; objectId: number }
    expect(r.etag).toMatch(/^"e/)
    expect(t.db.prepare(`SELECT uid FROM calendar_objects WHERE id = ?`).get(r.objectId)).toEqual({ uid: 'sunucu' })
  })

  it('412 returns conflict, local unchanged', async () => {
    const id = await seeded(single('t1'))
    const before = t.db.prepare(`SELECT raw FROM calendar_objects WHERE id = ?`).get(id)
    expect(await h.saveEvent(t.session(t.manager), { collectionId: t.calendar().id, objectId: id, etag: '"eski"', draft: draft({ title: 'Yeni' }) })).toEqual({ ok: false, conflict: true })
    expect(t.db.prepare(`SELECT raw FROM calendar_objects WHERE id = ?`).get(id)).toEqual(before)
    expect(await h.deleteEvent(t.session(t.manager), { objectId: id, etag: '"eski"' })).toEqual({ ok: false, conflict: true })
  })

  it('this scope writes override', async () => {
    const id = await seeded()
    const [, second] = await list()
    const detail = (await h.getEvent(t.session(t.manager), { objectId: id, recurrenceId: second.recurrenceId, tz: 'Europe/Berlin' })) as EventDetail
    expect(detail.draft.start).toBe('2026-03-09T10:00')
    const r = await h.saveEvent(t.session(t.manager), {
      collectionId: t.calendar().id, objectId: id, etag: detail.etag, scope: 'this', recurrenceId: second.recurrenceId, draft: { ...detail.draft, title: 'Taşındı', start: '2026-03-09T15:00', end: '2026-03-09T16:00', rrule: null }
    })
    expect(r).toMatchObject({ ok: true })
    expect(puts()[0].body).toContain(`RECURRENCE-ID:${second.recurrenceId}`)
    const occ = await list()
    expect(occ).toHaveLength(4)
    expect(occ.find((o) => o.recurrenceId === second.recurrenceId)).toMatchObject({ title: 'Taşındı', start: Date.UTC(2026, 2, 9, 14) })
  })

  it('thisAndFuture splits series', async () => {
    const id = await seeded()
    const occ = await list()
    const third = occ[2]
    const detail = (await h.getEvent(t.session(t.manager), { objectId: id, recurrenceId: third.recurrenceId, tz: 'Europe/Berlin' })) as EventDetail
    const r = (await h.saveEvent(t.session(t.manager), {
      collectionId: t.calendar().id, objectId: id, etag: detail.etag, scope: 'thisAndFuture', recurrenceId: third.recurrenceId, draft: { ...detail.draft, title: 'Yeni seri', rrule: { freq: 'WEEKLY', interval: 1, count: 2 } }
    })) as { ok: true; objectId: number }
    expect(r).toMatchObject({ ok: true })
    expect(r.objectId).not.toBe(id)
    const after = await list()
    expect(after.map((o) => o.title)).toEqual(['s1', 's1', 'Yeni seri', 'Yeni seri'])
    expect(new Set(after.map((o) => o.uid)).size).toBe(2)
    expect(t.dav.objects.get(`${CAL}1.ics`)!.data).toMatch(/UNTIL=20260316T085959Z/)
  })

  it('thisAndFuture çakışırsa yeni seri geri alınır', async () => {
    const id = await seeded()
    const third = (await list())[2]
    const res = await h.saveEvent(t.session(t.manager), { collectionId: t.calendar().id, objectId: id, etag: '"eski"', scope: 'thisAndFuture', recurrenceId: third.recurrenceId, draft: draft() })
    expect(res).toEqual({ ok: false, conflict: true })
    expect(t.dav.objects.size).toBe(1)
    expect(await list()).toHaveLength(4)
  })

  it('delete this adds EXDATE', async () => {
    const id = await seeded()
    const [, second] = await list()
    expect(await h.deleteEvent(t.session(t.manager), { objectId: id, scope: 'this', recurrenceId: second.recurrenceId })).toEqual({ ok: true })
    expect(puts()[0].body).toContain(`EXDATE:${second.recurrenceId}`)
    expect(await list()).toHaveLength(3)
  })

  it('delete thisAndFuture ilk örnekte nesneyi siler, sonrakinde keser', async () => {
    const id = await seeded()
    const occ = await list()
    await h.deleteEvent(t.session(t.manager), { objectId: id, scope: 'thisAndFuture', recurrenceId: occ[1].recurrenceId })
    expect(await list()).toHaveLength(1)
    expect(await h.deleteEvent(t.session(t.manager), { objectId: id, scope: 'thisAndFuture', recurrenceId: occ[0].recurrenceId })).toEqual({ ok: true })
    expect(t.dav.objects.size).toBe(0)
    expect(await list()).toEqual([])
  })

  it('organizer not me canEdit false', async () => {
    await seeded(single('b1', 'ORGANIZER:mailto:baskasi@x.co'))
    const [o] = await list()
    expect(o.canEdit).toBe(false)
    await expect(h.saveEvent(t.session(t.manager), { collectionId: t.calendar().id, objectId: o.objectId, draft: draft() })).rejects.toThrow()
    expect(puts()).toEqual([])
    // silmek serbest: arayüz uzak nesnenin silineceğini sorar
    expect(await h.deleteEvent(t.session(t.manager), { objectId: o.objectId })).toEqual({ ok: true })
  })

  it('kendi organizatör olduğum ve partstat görünür', async () => {
    await seeded(single('b2', 'ORGANIZER:mailto:A@t.co', 'ATTENDEE;PARTSTAT=TENTATIVE:mailto:a@t.co'))
    const [o] = await list()
    expect(o).toMatchObject({ canEdit: true, myPartstat: 'TENTATIVE' })
    const d = (await h.getEvent(t.session(t.manager), { objectId: o.objectId, tz: 'UTC' })) as EventDetail
    expect(d.organizer).toMatchObject({ addr: 'a@t.co' })
    expect(d.attendees).toEqual([{ addr: 'a@t.co', name: null, partstat: 'TENTATIVE' }])
  })

  it('offline remote error surfaced, nothing saved locally', async () => {
    await t.sync()
    await t.dav.close()
    await expect(h.saveEvent(t.session(t.manager), { collectionId: t.calendar().id, draft: draft() })).rejects.toThrow()
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM calendar_objects`).get()).toEqual({ n: 0 })
  })

  it('thisAndFuture Graph kaynağında reddedilir', async () => {
    const id = await seeded()
    const third = (await list())[2]
    t.db.prepare(`UPDATE pim_sources SET kind = 'graph' WHERE id = ?`).run(t.source.id)
    await expect(h.saveEvent(t.session(t.manager), { collectionId: t.calendar().id, objectId: id, scope: 'thisAndFuture', recurrenceId: third.recurrenceId, draft: draft() })).rejects.toThrow()
    await expect(h.deleteEvent(t.session(t.manager), { objectId: id, scope: 'thisAndFuture', recurrenceId: third.recurrenceId })).rejects.toThrow()
    t.db.prepare(`UPDATE pim_sources SET kind = 'dav' WHERE id = ?`).run(t.source.id)
  })

  it('geçersiz taslak reddedilir, sunucuya gitmez', async () => {
    await t.sync()
    const s = t.session(t.manager)
    await expect(h.saveEvent(s, { collectionId: t.calendar().id, draft: draft({ start: 'dün' }) })).rejects.toThrow()
    await expect(h.saveEvent(s, { collectionId: t.calendar().id, draft: draft({ tz: 'Olmayan/Dilim' }) })).rejects.toThrow()
    await expect(h.saveEvent(s, { collectionId: t.calendar().id, draft: draft({ title: 'x'.repeat(2001) }) })).rejects.toThrow()
    await expect(h.saveEvent(s, { collectionId: t.calendar().id, draft: draft({ rrule: { freq: 'HOURLY' as never, interval: 1 } }) })).rejects.toThrow()
    expect(puts()).toEqual([])
  })

  it('1000 recurring month under budget', async () => {
    const cal = (await pimSourcesHandlers.listPimCollections(t.session(t.viewer), { type: 'calendar' }) as { id: number; sourceId: number }[]).find((c) => c.sourceId !== t.source.id)!
    const raw = (i: number): string => ics(`p${i}`, 'DTSTART;TZID=Europe/Berlin:20260105T100000', 'DTEND;TZID=Europe/Berlin:20260105T103000', 'RRULE:FREQ=DAILY')
    t.q.pimTransaction(() => {
      for (let i = 0; i < 1000; i++)
        t.q.upsertPimEvent(cal.id, { remoteId: `p${i}`, etag: null, raw: raw(i), nextAlarmAt: null, now: 1, fields: { uid: `p${i}`, rangeStart: Date.UTC(2026, 0, 5, 9), rangeEnd: null, recurring: true, sequence: 0, organizer: null } })
    })
    const started = performance.now()
    const occ = await list(t.viewer)
    const ms = performance.now() - started
    expect(occ).toHaveLength(31 * 1000)
    expect(ms).toBeLessThan(500 * 3)
  })
})
