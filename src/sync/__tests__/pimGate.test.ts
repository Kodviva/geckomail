import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gateCalendars } from '../pim/gate'
import { brokenWorker, buildGateWorker, removeGateWorkers, scriptedWorker } from './helpers/gateWorker'

const NOW = Date.UTC(2026, 10, 4)
const ics = (...body: string[]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//T//T//EN', 'BEGIN:VEVENT', 'UID:g1', 'DTSTAMP:20260101T000000Z', ...body, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')

describe('takvim alım kapısı', () => {
  let real: string
  let scripted: string
  beforeAll(() => {
    real = buildGateWorker()
    scripted = scriptedWorker()
  })
  afterAll(removeGateWorkers)

  it('gerçek worker dizin alanlarını ve hatırlatmayı döndürür, bozuğu eler', async () => {
    const good = ics('DTSTART:20270105T100000Z', 'DTEND:20270105T110000Z', 'SUMMARY:A', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM')
    const [ok, bad] = await gateCalendars([good, 'BEGIN:VCALENDAR\r\nbozuk'], { viewerTz: 'UTC', now: NOW, workerPath: real })
    expect(ok).toMatchObject({ fields: { uid: 'g1', rangeStart: Date.UTC(2027, 0, 5, 10), recurring: false }, nextAlarmAt: Date.UTC(2027, 0, 5, 9, 45) })
    expect(bad).toBeNull()
  })

  it('takılan nesnede worker öldürülür, sonrakiler işlenir, hepsi tek worker değilse bile sıra korunur', async () => {
    const started = Date.now()
    const r = await gateCalendars(['bir', 'HANG', 'iki', 'DIE', 'uc'], { viewerTz: 'UTC', now: NOW, workerPath: scripted })
    expect(r.map((x) => (x as { fields: { uid: string } } | null)?.fields.uid ?? null)).toEqual(['bir', null, 'iki', null, 'uc'])
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('beş takılmadan sonra yığının kalanı denenmez', async () => {
    const r = await gateCalendars([...Array(7).fill('HANG'), 'son'], { viewerTz: 'UTC', now: NOW, workerPath: scripted })
    expect(r.slice(0, 5)).toEqual([null, null, null, null, null])
    expect(r.slice(5)).toEqual(['deferred', 'deferred', 'deferred'])
  }, 15_000)

  it('ilk takılma ertelenir, aynı içerik yeniden takılırsa reddedilir, sonra denenmez; bütçe sıradakilere kalır', async () => {
    const hung = new Set<string>()
    const raws = [...Array.from({ length: 6 }, (_, i) => `HANG ${i}`), 'son']
    const o = { viewerTz: 'UTC', now: NOW, workerPath: scripted, hung }
    const first = await gateCalendars(raws, o)
    expect(first).toEqual(Array(7).fill('deferred'))
    const second = await gateCalendars(raws, o)
    expect(second.slice(0, 5)).toEqual([null, null, null, null, null])
    expect(second[5]).toBe('deferred')
    const third = await gateCalendars(raws, o)
    expect(third.slice(0, 5)).toEqual([null, null, null, null, null])
    const started = Date.now()
    const fourth = await gateCalendars(raws, o)
    expect(fourth.slice(0, 6)).toEqual([null, null, null, null, null, null])
    expect(fourth[6]).toMatchObject({ fields: { uid: 'son' } })
    expect(Date.now() - started).toBeLessThan(2500)
  }, 40_000)

  it('worker başlatılamazsa fırlatır: nesne suçlu değil', async () => {
    await expect(gateCalendars(['x'], { viewerTz: 'UTC', now: NOW, workerPath: brokenWorker() })).rejects.toThrow()
    await expect(gateCalendars(['x'], { viewerTz: 'UTC', now: NOW })).rejects.toThrow()
    await expect(gateCalendars([], { viewerTz: 'UTC', now: NOW })).resolves.toEqual([])
  })

  it('güvenli görünen yavaş kural da ana iş parçacığına uğramadan sonuçlanır', async () => {
    const [r] = await gateCalendars([ics('DTSTART:20270105T100000Z', 'RRULE:FREQ=DAILY;INTERVAL=2000000000')], { viewerTz: 'UTC', now: NOW, workerPath: real })
    expect(r).toMatchObject({ fields: { recurring: false } })
  })
})
