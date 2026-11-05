import { describe, expect, it } from 'vitest'
import { indexFields, parseCalendar } from '../pim/ical'
import { expandObject, nextAlarmAt } from '../pim/recur'

const ics = (...event: string[]): string => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN', 'BEGIN:VEVENT', 'UID:u1', ...event, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
const two = (a: string[], b: string[]): string => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', ...a, 'END:VEVENT', 'BEGIN:VEVENT', 'UID:u1', ...b, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
const T = (s: string): number => Date.parse(s)
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000', '')
const parse = (raw: string) => {
  const c = parseCalendar(raw)
  if (!c) throw new Error('parse')
  return c
}
const starts = (raw: string, from: string, to: string, viewer = 'UTC'): string[] => expandObject(parse(raw), T(from), T(to), viewer).map((o) => iso(o.start))
const BERLIN = ['DTSTART;TZID=Europe/Berlin:20260323T100000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY']
const SPRING = ['2026-03-23T00:00:00Z', '2026-04-05T00:00:00Z'] as const

describe('expandObject', () => {
  it('weekly Berlin across DST', () => expect(starts(ics(...BERLIN), ...SPRING)).toEqual(['2026-03-23T09:00:00Z', '2026-03-30T08:00:00Z']))

  it('gap', () => expect(starts(ics('DTSTART;TZID=America/New_York:20260308T023000'), '2026-03-08T00:00:00Z', '2026-03-09T00:00:00Z')).toEqual(['2026-03-08T07:30:00Z']))
  it('overlap', () => expect(starts(ics('DTSTART;TZID=America/New_York:20261101T013000'), '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')).toEqual(['2026-11-01T05:30:00Z']))

  it('Turkey Standard Time', () => expect(starts(ics('DTSTART;TZID=Turkey Standard Time:20260115T100000'), '2026-01-15T00:00:00Z', '2026-01-16T00:00:00Z')).toEqual(['2026-01-15T07:00:00Z']))

  it('exdate in utc', () => expect(starts(ics(...BERLIN, 'EXDATE:20260330T080000Z'), ...SPRING)).toEqual(['2026-03-23T09:00:00Z']))
  it('exdate duvar saatiyle de siler', () => expect(starts(ics(...BERLIN, 'EXDATE;TZID=Europe/Berlin:20260330T100000'), ...SPRING)).toEqual(['2026-03-23T09:00:00Z']))

  it('rdate eklenir, sıralı döner', () => {
    expect(starts(ics(...BERLIN, 'RDATE:20260325T120000Z'), ...SPRING)).toEqual(['2026-03-23T09:00:00Z', '2026-03-25T12:00:00Z', '2026-03-30T08:00:00Z'])
  })

  it('override moved', () => {
    const raw = two(BERLIN, ['RECURRENCE-ID;TZID=Europe/Berlin:20260330T100000', 'DTSTART;TZID=Europe/Berlin:20260330T140000', 'DURATION:PT1H', 'SUMMARY:Taşındı'])
    const occ = expandObject(parse(raw), T(SPRING[0]), T(SPRING[1]), 'UTC')
    expect(occ.map((o) => iso(o.start))).toEqual(['2026-03-23T09:00:00Z', '2026-03-30T12:00:00Z'])
    expect(occ[1].event.summary).toBe('Taşındı')
    expect(occ[1].recurrenceId).toBe('20260330T080000Z')
  })

  it('pencere dışına taşınan örnek pencerede kalmaz', () => {
    const raw = two(BERLIN, ['RECURRENCE-ID;TZID=Europe/Berlin:20260330T100000', 'DTSTART;TZID=Europe/Berlin:20260601T100000', 'DURATION:PT1H'])
    expect(starts(raw, ...SPRING)).toEqual(['2026-03-23T09:00:00Z'])
  })

  it('pencere dışından içeri taşınan örnek görünür', () => {
    const raw = two(BERLIN, ['RECURRENCE-ID;TZID=Europe/Berlin:20260601T100000', 'DTSTART;TZID=Europe/Berlin:20260325T100000', 'DURATION:PT1H'])
    expect(starts(raw, ...SPRING)).toEqual(['2026-03-23T09:00:00Z', '2026-03-25T09:00:00Z', '2026-03-30T08:00:00Z'])
  })

  it('until inclusive', () => {
    const raw = ics('DTSTART;TZID=Europe/Istanbul:20260105T230000', 'RRULE:FREQ=WEEKLY;UNTIL=20260112T200000Z')
    expect(starts(raw, '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z')).toEqual(['2026-01-05T20:00:00Z', '2026-01-12T20:00:00Z'])
  })

  it('all day not shifted', () => {
    const [o] = expandObject(parse(ics('DTSTART;VALUE=DATE:20260329')), T('2026-03-28T00:00:00Z'), T('2026-03-30T00:00:00Z'), 'Pacific/Auckland')
    expect(o).toMatchObject({ allDay: true, startDate: '2026-03-29', endDate: '2026-03-30' })
    expect(iso(o.start)).toBe('2026-03-28T11:00:00Z')
  })

  it('tüm gün tekrar, EXDATE tarihle', () => {
    const raw = ics('DTSTART;VALUE=DATE:20260301', 'DTEND;VALUE=DATE:20260303', 'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;VALUE=DATE:20260302')
    const occ = expandObject(parse(raw), T('2026-02-01T00:00:00Z'), T('2026-04-01T00:00:00Z'), 'UTC')
    expect(occ.map((o) => [o.startDate, o.endDate])).toEqual([['2026-03-01', '2026-03-03'], ['2026-03-03', '2026-03-05']])
    expect(occ[0].recurrenceId).toBe('20260301')
  })

  it('unknown tzid', () => {
    const raw = ics('DTSTART;TZID=Mars/Olympus:20260115T100000')
    expect(starts(raw, '2026-01-15T00:00:00Z', '2026-01-16T00:00:00Z', 'Asia/Tokyo')).toEqual(['2026-01-15T01:00:00Z'])
  })

  it('floating', () => {
    const raw = ics('DTSTART:20260115T100000')
    const w = ['2026-01-14T00:00:00Z', '2026-01-17T00:00:00Z'] as const
    expect(starts(raw, ...w, 'Asia/Tokyo')).toEqual(['2026-01-15T01:00:00Z'])
    expect(starts(raw, ...w, 'Europe/Istanbul')).toEqual(['2026-01-15T07:00:00Z'])
    expect(expandObject(parse(raw), T(w[0]), T(w[1]), 'UTC')[0].tz).toBeNull()
  })

  it('FREQ=SECONDLY ignored', () => {
    expect(starts(ics('DTSTART:20260115T100000Z', 'RRULE:FREQ=SECONDLY'), '2026-01-15T00:00:00Z', '2026-01-16T00:00:00Z')).toEqual(['2026-01-15T10:00:00Z'])
    expect(starts(ics('DTSTART:20260115T100000Z', 'RRULE:FREQ=MINUTELY'), '2026-01-15T00:00:00Z', '2026-01-16T00:00:00Z')).toHaveLength(1)
  })

  it('iteration cap', () => {
    const c = parse(ics('DTSTART:20200101T100000Z', 'RRULE:FREQ=DAILY'))
    expect(expandObject(c, T('2020-01-01T00:00:00Z'), T('2021-01-01T00:00:00Z'), 'UTC', { maxIterations: 5 })).toHaveLength(5)
    // pencereye hiç ulaşılmaz: boş sonuç, istisna yok
    expect(expandObject(c, T('2026-01-01T00:00:00Z'), T('2026-02-01T00:00:00Z'), 'UTC', { maxIterations: 5 })).toEqual([])
  })

  it('count', () => {
    expect(starts(ics('DTSTART:20260105T100000Z', 'RRULE:FREQ=DAILY;COUNT=3'), '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')).toEqual(['2026-01-05T10:00:00Z', '2026-01-06T10:00:00Z', '2026-01-07T10:00:00Z'])
  })

  it('last sunday', () => {
    const raw = ics('DTSTART;TZID=Europe/Istanbul:20260125T100000', 'RRULE:FREQ=MONTHLY;BYDAY=-1SU;COUNT=3')
    expect(starts(raw, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')).toEqual(['2026-01-25T07:00:00Z', '2026-02-22T07:00:00Z', '2026-03-29T07:00:00Z'])
  })

  it('distant window', () => {
    const raw = ics('DTSTART;TZID=Europe/Berlin:19900101T090000', 'RRULE:FREQ=DAILY')
    expect(starts(raw, '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z')).toHaveLength(31)
  })

  it('pencereye taşan uzun etkinlik görünür, bitişik olan görünmez', () => {
    const raw = ics('DTSTART:20260110T220000Z', 'DTEND:20260111T020000Z')
    expect(starts(raw, '2026-01-11T00:00:00Z', '2026-01-12T00:00:00Z')).toHaveLength(1)
    expect(starts(raw, '2026-01-11T02:00:00Z', '2026-01-12T00:00:00Z')).toHaveLength(0)
    expect(starts(raw, '2026-01-09T00:00:00Z', '2026-01-10T22:00:00Z')).toHaveLength(0)
  })

  it('bozuk kural patlatmaz', () => {
    const c = parse(ics('DTSTART:20260105T100000Z', 'RRULE:FREQ=WEEKLY;BYYEARDAY=5'))
    expect(() => expandObject(c, T('2026-01-01T00:00:00Z'), T('2027-01-01T00:00:00Z'), 'UTC')).not.toThrow()
  })

  it('yalnız override olan nesne (asıl seri yok) tek örnek verir', () => {
    const raw = ics('RECURRENCE-ID:20260105T100000Z', 'DTSTART:20260105T110000Z')
    expect(starts(raw, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')).toEqual(['2026-01-05T11:00:00Z'])
  })

  it('RANGE=THISANDFUTURE yalnız o örneğe uygulanır', () => {
    const raw = two(['DTSTART:20260105T100000Z', 'RRULE:FREQ=DAILY;COUNT=3'], ['RECURRENCE-ID;RANGE=THISANDFUTURE:20260106T100000Z', 'DTSTART:20260106T150000Z'])
    expect(starts(raw, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')).toEqual(['2026-01-05T10:00:00Z', '2026-01-06T15:00:00Z', '2026-01-07T10:00:00Z'])
  })

  it('tz alanı IANA adı', () => {
    const [o] = expandObject(parse(ics('DTSTART;TZID=Turkey Standard Time:20260115T100000')), T('2026-01-01T00:00:00Z'), T('2026-02-01T00:00:00Z'), 'UTC')
    expect(o).toMatchObject({ tz: 'Europe/Istanbul', allDay: false, startDate: null, endDate: null, recurrenceId: null })
    expect(o.end).toBe(o.start)
  })
})

describe('nextAlarmAt', () => {
  const alarm = (...lines: string[]): string[] => ['BEGIN:VALARM', 'ACTION:DISPLAY', ...lines, 'END:VALARM']

  it('TRIGGER:-PT15M doğru an', () => {
    const c = parse(ics('DTSTART;TZID=Europe/Berlin:20260323T100000', ...alarm('TRIGGER:-PT15M')))
    expect(iso(nextAlarmAt(c, T('2026-03-01T00:00:00Z'))!)).toBe('2026-03-23T08:45:00Z')
    expect(nextAlarmAt(c, T('2026-03-23T09:00:00Z'))).toBeNull()
  })
  it('tekrarda sonraki örnek', () => {
    const c = parse(ics(...BERLIN, ...alarm('TRIGGER:-PT15M')))
    expect(iso(nextAlarmAt(c, T('2026-03-23T09:00:00Z'))!)).toBe('2026-03-30T07:45:00Z')
  })
  it('tüm gün ve floating için null', () => {
    expect(nextAlarmAt(parse(ics('DTSTART;VALUE=DATE:20260329', ...alarm('TRIGGER:-PT15M'))), T('2026-01-01T00:00:00Z'))).toBeNull()
    expect(nextAlarmAt(parse(ics('DTSTART:20260329T100000', ...alarm('TRIGGER:-PT15M'))), T('2026-01-01T00:00:00Z'))).toBeNull()
  })
  it('mutlak TRIGGER;VALUE=DATE-TIME', () => {
    const c = parse(ics('DTSTART:20260329T100000Z', ...alarm('TRIGGER;VALUE=DATE-TIME:20260328T090000Z')))
    expect(iso(nextAlarmAt(c, T('2026-01-01T00:00:00Z'))!)).toBe('2026-03-28T09:00:00Z')
    expect(nextAlarmAt(c, T('2026-03-28T09:00:00Z'))).toBeNull()
  })
  it('RELATED=END bitişe göre', () => {
    const c = parse(ics('DTSTART:20260329T100000Z', 'DTEND:20260329T110000Z', ...alarm('TRIGGER;RELATED=END:-PT5M')))
    expect(iso(nextAlarmAt(c, T('2026-01-01T00:00:00Z'))!)).toBe('2026-03-29T10:55:00Z')
  })
  it('alarm yoksa ya da iptalse null', () => {
    expect(nextAlarmAt(parse(ics('DTSTART:20260329T100000Z')), T('2026-01-01T00:00:00Z'))).toBeNull()
    expect(nextAlarmAt(parse(ics('DTSTART:20260329T100000Z', 'STATUS:CANCELLED', ...alarm('TRIGGER:-PT15M'))), T('2026-01-01T00:00:00Z'))).toBeNull()
  })
})

describe('düşmanca kural', () => {
  const TZ = (rule: string): string => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN', 'BEGIN:VTIMEZONE', 'TZID:Sahte/Dilim', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0100', rule, 'END:STANDARD', 'END:VTIMEZONE', 'BEGIN:VEVENT', 'UID:u1', 'DTSTART;TZID=Sahte/Dilim:20260105T100000', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')

  it.each([
    'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30', 'FREQ=HOURLY;BYMONTH=2;BYMONTHDAY=30', 'FREQ=DAILY;INTERVAL=2000000000', 'FREQ=WEEKLY;INTERVAL=2000000000',
    'FREQ=MONTHLY;INTERVAL=121', 'FREQ=YEARLY;INTERVAL=101', 'FREQ=HOURLY;INTERVAL=8785', 'FREQ=DAILY;BYMONTH=4,6;BYMONTHDAY=31',
    'FREQ=MONTHLY;BYDAY=6FR', 'FREQ=YEARLY;BYMONTH=1;BYYEARDAY=300', 'FREQ=YEARLY;BYWEEKNO=20;BYMONTH=1'
  ])('%s yalnız ilk örnek, COUNT da gerekmez', (rule) => {
    const raw = ics('DTSTART:20260105T100000Z', `RRULE:${rule}`)
    expect(starts(raw, '2026-01-01T00:00:00Z', '2030-01-01T00:00:00Z')).toEqual(['2026-01-05T10:00:00Z'])
    expect(indexFields(raw, 'UTC')).toMatchObject({ recurring: false })
    expect(nextAlarmAt(parse(raw), T('2026-01-01T00:00:00Z'))).toBeNull()
  })

  it('sınırdaki aralıklar geçerli kalır', () => {
    expect(starts(ics('DTSTART:20200105T100000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=52;COUNT=3'), '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z')).toHaveLength(3)
    expect(starts(ics('DTSTART:20240229T100000Z', 'RRULE:FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=29;COUNT=2'), '2024-01-01T00:00:00Z', '2030-01-01T00:00:00Z')).toEqual(['2024-02-29T10:00:00Z', '2028-02-29T10:00:00Z'])
  })

  it.each(['RRULE:FREQ=SECONDLY', 'RRULE:FREQ=MINUTELY;COUNT=5', 'RRULE:FREQ=DAILY', 'RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30'])('VTIMEZONE içinde %s dilimi bilinmeyen yapar', (rule) => {
    const c = parseCalendar(TZ(rule))
    expect(c).not.toBeNull()
    expect(c!.vtimezones.size).toBe(0)
    expect(expandObject(c!, T('2026-01-01T00:00:00Z'), T('2026-02-01T00:00:00Z'), 'Europe/Istanbul').map((o) => iso(o.start))).toEqual(['2026-01-05T07:00:00Z'])
  })

  it('VTIMEZONE: YEARLY geçerli, sınırsız RDATE reddedilir', () => {
    expect(parseCalendar(TZ('RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU'))!.vtimezones.size).toBe(1)
    const many = Array.from({ length: 501 }, (_, i) => `${1970 + (i % 60)}0101T00${String(i % 60).padStart(2, '0')}00`)
    expect(parseCalendar(TZ(`RDATE:${many.join(',')}`))!.vtimezones.size).toBe(0)
  })

  it('leap yearly', () => {
    expect(starts(ics('DTSTART;VALUE=DATE:20240229', 'RRULE:FREQ=YEARLY;COUNT=4'), '2024-01-01T00:00:00Z', '2040-01-01T00:00:00Z')).toEqual(
      ['2024-02-29T00:00:00Z', '2028-02-29T00:00:00Z', '2032-02-29T00:00:00Z', '2036-02-29T00:00:00Z']
    )
    expect(starts(ics('DTSTART:20240229T100000Z', 'RRULE:FREQ=YEARLY;COUNT=2'), '2024-01-01T00:00:00Z', '2040-01-01T00:00:00Z')).toEqual(['2024-02-29T10:00:00Z', '2028-02-29T10:00:00Z'])
    expect(starts(ics('DTSTART:20260115T100000Z', 'RRULE:FREQ=YEARLY;COUNT=2'), '2026-01-01T00:00:00Z', '2040-01-01T00:00:00Z')).toEqual(['2026-01-15T10:00:00Z', '2027-01-15T10:00:00Z'])
  })

  it('dev süre takvim sorgusunu düşürmez', () => {
    const raw = ics('DTSTART;VALUE=DATE:20260105', 'DURATION:P99999999W')
    const [o] = expandObject(parse(raw), T('2026-01-01T00:00:00Z'), T('2026-02-01T00:00:00Z'), 'UTC')
    expect(o.startDate).toBe('2026-01-05')
    expect(Number.isFinite(o.end)).toBe(true)
    expect(expandObject(parse(ics('DTSTART:20260105T100000Z', 'DURATION:P99999999W')), T('2026-01-01T00:00:00Z'), T('2026-02-01T00:00:00Z'), 'UTC')).toHaveLength(1)
  })
})
