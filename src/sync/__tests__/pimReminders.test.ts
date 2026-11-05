import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { tFor } from '../../shared/i18n'
import { syncBatch } from '../pim/apply'
import { deliverDueReminders } from '../pim/reminders'
import { pimSourcesHandlers } from '../rpc/pimSources'
import { buildGateWorker, removeGateWorkers } from './helpers/gateWorker'
import { pimHarness, type PimHarness } from './helpers/pimHarness'

const START = Date.UTC(2027, 0, 5, 10)
const ALARM = START - 15 * 60_000
const ics = (...more: string[]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN', 'BEGIN:VEVENT', 'UID:r1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Toplantı', ...more, 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
const timed = ics('DTSTART:20270105T100000Z', 'DTEND:20270105T110000Z')

type Notice = { title: string; body: (loc: 'tr') => string; accountId: number | null; userIds: number[] }

describe('hatırlatmalar', () => {
  let worker: string
  let t: PimHarness
  let sent: Notice[]
  let outcome: 'queued' | 'retry' | 'nobody'
  const pipe = { notice: (n: unknown) => (sent.push(n as Notice), outcome) }

  beforeAll(() => {
    worker = buildGateWorker()
  })
  afterAll(removeGateWorkers)
  beforeEach(async () => {
    t = await pimHarness(worker)
    await t.sync()
    sent = []
    outcome = 'queued'
  })
  afterEach(() => t.close())

  const store = async (raw: string, now = Date.UTC(2026, 11, 1)): Promise<void> => {
    const batch = syncBatch({ ...t.hub.pimDeps(), now: () => now }, t.calendar())
    batch.sink.upsert({ remoteId: 'r1', etag: null, data: raw })
    await batch.commit()
  }
  const nextAlarm = (): number | null => (t.db.prepare(`SELECT next_alarm_at AS a FROM calendar_objects`).get() as { a: number | null }).a

  it('zamanı gelen hatırlatma gider, metin ve alıcılar doğru', async () => {
    await store(timed)
    expect(nextAlarm()).toBe(ALARM)
    expect(deliverDueReminders(t.q, pipe, ALARM - 1)).toBe(0)
    expect(deliverDueReminders(t.q, pipe, ALARM + 1000)).toBe(1)
    expect(sent[0]).toMatchObject({ title: 'Toplantı', accountId: t.acc })
    expect(sent[0].userIds.sort()).toEqual([t.viewer, t.manager, t.admin].sort())
    expect(sent[0].body('tr')).toBe(tFor('tr', 'calendar.reminder.startsIn', { minutes: 15 }))
  })

  it('fires once across restart', async () => {
    await store(timed)
    expect(deliverDueReminders(t.q, pipe, ALARM + 1000)).toBe(1)
    expect(nextAlarm()).toBeNull()
    expect(deliverDueReminders(t.q, pipe, ALARM + 2000)).toBe(0)
    expect(sent).toHaveLength(1)
  })

  it('older than 1 hour skipped', async () => {
    await store(timed)
    expect(deliverDueReminders(t.q, pipe, ALARM + 3_600_001)).toBe(0)
    expect(sent).toEqual([])
    expect(nextAlarm()).toBeNull()
  })

  it('reminders off for user excluded', async () => {
    await store(timed)
    await pimSourcesHandlers.setPimCollectionPref(t.session(t.viewer), { collectionId: t.calendar().id, reminders: false })
    deliverDueReminders(t.q, pipe, ALARM + 1000)
    expect(sent[0].userIds).not.toContain(t.viewer)
    expect(sent[0].userIds).toContain(t.manager)
  })

  it('herkes kapattıysa bildirim yok, saat yine ilerler', async () => {
    await store(timed)
    for (const u of [t.viewer, t.manager, t.admin]) t.q.setPimCollectionPref(u, t.calendar().id, { reminders: false })
    expect(deliverDueReminders(t.q, pipe, ALARM + 1000)).toBe(0)
    expect(nextAlarm()).toBeNull()
  })

  it('member without view gets none', async () => {
    await store(timed)
    deliverDueReminders(t.q, pipe, ALARM + 1000)
    expect(sent[0].userIds).not.toContain(t.stranger)
  })

  it('kişisel takvim yalnız sahibine, hesapsız', async () => {
    const s = t.session(t.viewer)
    const mine = (await pimSourcesHandlers.listPimCollections(s, { type: 'calendar' }) as { id: number; sourceId: number }[]).find((c) => c.sourceId !== t.source.id)!
    const c = t.q.getPimCollection(mine.id)!
    const batch = syncBatch({ ...t.hub.pimDeps(), now: () => Date.UTC(2026, 11, 1) }, c)
    batch.sink.upsert({ remoteId: 'p1', etag: null, data: timed })
    await batch.commit()
    deliverDueReminders(t.q, pipe, ALARM + 1000)
    expect(sent[0]).toMatchObject({ accountId: null, userIds: [t.viewer] })
  })

  it('all day has no alarm', async () => {
    await store(ics('DTSTART;VALUE=DATE:20270105'))
    expect(nextAlarm()).toBeNull()
  })

  it('next occurrence scheduled', async () => {
    await store(ics('DTSTART:20270105T100000Z', 'DTEND:20270105T110000Z', 'RRULE:FREQ=DAILY;COUNT=3'))
    deliverDueReminders(t.q, pipe, ALARM + 1000)
    expect(nextAlarm()).toBe(ALARM + 864e5)
    deliverDueReminders(t.q, pipe, ALARM + 864e5 + 1000)
    expect(sent).toHaveLength(2)
  })

  it('quiet hours not retried', async () => {
    await store(timed)
    outcome = 'retry'
    deliverDueReminders(t.q, pipe, ALARM + 1000)
    outcome = 'queued'
    deliverDueReminders(t.q, pipe, ALARM + 2000)
    expect(sent).toHaveLength(1)
  })
})
