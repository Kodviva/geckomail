import { describe, expect, it } from 'vitest'
import type { EventDraft } from '../../shared/pim'
import { draftToIcs, eventToDraft, indexFields, parseCalendar, removeOccurrence, setPartstat, splitIcsFeed } from '../pim/ical'
import { expandObject } from '../pim/recur'

const ics = (...event: string[]): string => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN', 'BEGIN:VEVENT', 'UID:u1', 'DTSTAMP:20260101T000000Z', ...event, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
const T = (s: string): number => Date.parse(s)
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000', '')
const NOW = T('2026-02-01T12:00:00Z')
const BERLIN = ['DTSTART;TZID=Europe/Berlin:20260323T100000', 'DTEND;TZID=Europe/Berlin:20260323T110000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Toplantı']
const SPRING = [T('2026-03-01T00:00:00Z'), T('2026-05-01T00:00:00Z')] as const
const starts = (raw: string): string[] => expandObject(parseCalendar(raw)!, SPRING[0], SPRING[1], 'UTC').map((o) => iso(o.start))
const draft = (over: Partial<EventDraft> = {}): EventDraft => ({
  title: 'Yeni', location: null, description: null, allDay: false, start: '2026-03-23T10:00', end: '2026-03-23T11:00', tz: 'Europe/Berlin', rrule: null, alarmMinutes: null, ...over
})

describe('parseCalendar', () => {
  it('alanları okur', () => {
    const c = parseCalendar(ics(...BERLIN, 'LOCATION:Oda 1', 'DESCRIPTION:a\\nb', 'SEQUENCE:3', 'STATUS:CONFIRMED',
      'ORGANIZER;CN=Ali:mailto:Ali@T.co', 'ATTENDEE;CN=Ayşe;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:ayse@t.co', 'ATTENDEE:mailto:veli@t.co',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:PT0S', 'END:VALARM'))!
    expect(c.uid).toBe('u1')
    expect(c.method).toBeNull()
    expect(c.events).toHaveLength(1)
    expect(c.events[0]).toMatchObject({
      uid: 'u1', sequence: 3, recurrenceId: null, summary: 'Toplantı', location: 'Oda 1', description: 'a\nb', status: 'CONFIRMED',
      organizer: { addr: 'ali@t.co', name: 'Ali' }, alarmsMinutes: [15, 0],
      attendees: [{ addr: 'ayse@t.co', name: 'Ayşe', partstat: 'ACCEPTED', rsvp: true }, { addr: 'veli@t.co', name: null, partstat: 'NEEDS-ACTION', rsvp: false }]
    })
  })
  it('METHOD okunur', () => expect(parseCalendar(ics('DTSTART:20260101T100000Z').replace('VERSION:2.0', 'VERSION:2.0\r\nMETHOD:REQUEST'))!.method).toBe('REQUEST'))
  it('malformed object skipped', () => {
    expect(parseCalendar('çöp')).toBeNull()
    expect(parseCalendar('')).toBeNull()
    expect(parseCalendar(ics('DTSTART:gecersiz'))).toBeNull()
    expect(parseCalendar(ics('SUMMARY:başlangıç yok'))).toBeNull()
    expect(parseCalendar(ics('DTSTART:20260101T100000Z', 'RRULE:FREQ=BOGUS'))).toBeNull()
    expect(parseCalendar('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nEND:VCARD\r\n')).toBeNull()
  })
  it('1 MB üstü nesne alınmaz', () => {
    expect(parseCalendar(ics('DTSTART:20260101T100000Z', `DESCRIPTION:${'x'.repeat(1_000_001)}`))).toBeNull()
  })
  it('VEVENT içermeyen takvim null', () => expect(parseCalendar('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:t\r\nEND:VTODO\r\nEND:VCALENDAR\r\n')).toBeNull())
  it('HTML düz metin kalır', () => {
    expect(parseCalendar(ics('DTSTART:20260101T100000Z', 'SUMMARY:<script>alert(1)</script>'))!.events[0].summary).toBe('<script>alert(1)</script>')
  })
})

describe('splitIcsFeed', () => {
  const feed = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN',
    'BEGIN:VTIMEZONE', 'TZID:Bizim', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0530', 'TZOFFSETTO:+0530', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:a', 'DTSTART;TZID=Bizim:20260101T100000', 'RRULE:FREQ=DAILY', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'DTSTART:20260102T100000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a', 'RECURRENCE-ID;TZID=Bizim:20260102T100000', 'DTSTART;TZID=Bizim:20260102T110000', 'END:VEVENT',
    'END:VCALENDAR', ''].join('\r\n')
  it('UIDye göre böler, VTIMEZONE kopyalar', () => {
    const parts = splitIcsFeed(feed)
    expect(parts).toHaveLength(2)
    const a = parseCalendar(parts[0])!
    expect(a.uid).toBe('a')
    expect(a.events).toHaveLength(2)
    expect([...a.vtimezones.keys()]).toEqual(['Bizim'])
    expect(parts[1]).not.toContain('VTIMEZONE')
  })
  it('UIDsiz etkinlik atılmaz, kararlı kimlik alır', () => {
    const raw = ics('DTSTART:20260101T100000Z').replace('UID:u1\r\n', '')
    const [one] = splitIcsFeed(raw)
    expect(parseCalendar(one)!.uid).toMatch(/.+/)
    expect(splitIcsFeed(raw)).toEqual([one])
  })
  it('bozuk akış boş', () => expect(splitIcsFeed('çöp')).toEqual([]))
})

describe('indexFields', () => {
  it('tekil etkinlik', () => {
    expect(indexFields(ics('DTSTART:20260101T100000Z', 'DTEND:20260101T110000Z', 'SEQUENCE:2', 'ORGANIZER:mailto:A@t.co'), 'UTC')).toEqual({
      uid: 'u1', rangeStart: T('2026-01-01T10:00:00Z'), rangeEnd: T('2026-01-01T11:00:00Z'), recurring: false, sequence: 2, organizer: 'a@t.co'
    })
  })
  it('sonsuz seride rangeEnd null', () => {
    expect(indexFields(ics(...BERLIN), 'UTC')).toMatchObject({ recurring: true, rangeEnd: null, rangeStart: T('2026-03-23T09:00:00Z') })
  })
  it('sonlu seride son örnek', () => {
    expect(indexFields(ics('DTSTART:20260105T100000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=3'), 'UTC')).toMatchObject({ recurring: true, rangeEnd: T('2026-01-07T11:00:00Z') })
  })
  it('override aralığı genişletir', () => {
    const raw = ics('DTSTART:20260105T100000Z', 'RRULE:FREQ=DAILY;COUNT=2').replace('END:VEVENT', 'END:VEVENT\r\nBEGIN:VEVENT\r\nUID:u1\r\nRECURRENCE-ID:20260106T100000Z\r\nDTSTART:20270101T100000Z\r\nEND:VEVENT')
    expect(indexFields(raw, 'UTC')).toMatchObject({ rangeEnd: T('2027-01-01T10:00:00Z') })
  })
  it('bozuksa null', () => expect(indexFields('çöp', 'UTC')).toBeNull())
})

describe('draftToIcs', () => {
  it('yeni etkinlik geri okunur', () => {
    const raw = draftToIcs(draft({ title: 'Ad, soyad; x\ny', location: 'Oda', description: 'Not', alarmMinutes: 10 }), { uid: 'yeni-1', now: NOW })
    const c = parseCalendar(raw)!
    expect(c.uid).toBe('yeni-1')
    expect(c.events[0]).toMatchObject({ summary: 'Ad, soyad; x\ny', location: 'Oda', description: 'Not', alarmsMinutes: [10], sequence: 0 })
    expect(raw).toContain('DTSTART;TZID=Europe/Berlin:20260323T100000')
    expect(raw).toContain('DTSTAMP:20260201T120000Z')
    expect(raw).toMatch(/\r\n$/)
    expect(starts(raw)).toEqual(['2026-03-23T09:00:00Z'])
  })
  it('uid yoksa üretir', () => expect(parseCalendar(draftToIcs(draft(), { now: NOW }))!.uid).toMatch(/.{8,}/))
  it('tüm gün', () => {
    const raw = draftToIcs(draft({ allDay: true, start: '2026-03-29', end: '2026-03-31' }), { now: NOW })
    expect(raw).toContain('DTSTART;VALUE=DATE:20260329')
    expect(raw).toContain('DTEND;VALUE=DATE:20260331')
  })
  it('tekrar kuralı', () => {
    const raw = draftToIcs(draft({ rrule: { freq: 'WEEKLY', interval: 2, byDay: ['MO', 'WE'], count: 5 } }), { now: NOW })
    expect(raw).toMatch(/RRULE:.*FREQ=WEEKLY/)
    expect(raw).toMatch(/RRULE:.*COUNT=5/)
    expect(raw).toMatch(/RRULE:.*INTERVAL=2/)
    expect(raw).toMatch(/RRULE:.*BYDAY=MO,WE/)
  })
  it('until seçilen günü kapsar', () => {
    const raw = draftToIcs(draft({ rrule: { freq: 'DAILY', interval: 1, until: '2026-03-25' } }), { now: NOW })
    expect(starts(raw)).toEqual(['2026-03-23T09:00:00Z', '2026-03-24T09:00:00Z', '2026-03-25T09:00:00Z'])
  })
  it('draftToIcs preserves unknown props', () => {
    const base = ics(...BERLIN, 'X-FOO:bar', 'ATTENDEE;CN=Ayşe:mailto:ayse@t.co', 'SEQUENCE:4')
    const raw = draftToIcs(draft({ title: 'Değişti', rrule: { freq: 'WEEKLY', interval: 1 } }), { base, now: NOW })
    expect(raw).toContain('X-FOO:bar')
    expect(raw).toContain('ATTENDEE')
    const c = parseCalendar(raw)!
    expect(c.uid).toBe('u1')
    expect(c.events[0]).toMatchObject({ summary: 'Değişti', sequence: 5 })
    expect(c.events[0].attendees).toHaveLength(1)
  })
  it('rruleRaw korunur', () => {
    const raw = draftToIcs(draft({ rruleRaw: 'FREQ=MONTHLY;BYSETPOS=2;BYDAY=TU' }), { now: NOW })
    expect(raw).toContain('RRULE:FREQ=MONTHLY;BYSETPOS=2;BYDAY=TU')
  })
  it('kural kaldırılınca RRULE gider', () => {
    expect(draftToIcs(draft(), { base: ics(...BERLIN), now: NOW })).not.toContain('RRULE')
  })
  it('alarm null ise VALARM gider', () => {
    const base = ics(...BERLIN, 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT5M', 'END:VALARM')
    expect(draftToIcs(draft(), { base, now: NOW })).not.toContain('VALARM')
    expect(parseCalendar(draftToIcs(draft({ alarmMinutes: 30 }), { base, now: NOW }))!.events[0].alarmsMinutes).toEqual([30])
  })
  it('this scope adds override', () => {
    const raw = draftToIcs(draft({ title: 'Tek', start: '2026-03-30T14:00', end: '2026-03-30T15:00' }), { base: ics(...BERLIN, 'ATTENDEE:mailto:a@t.co'), now: NOW, scope: 'this', recurrenceId: '20260330T080000Z' })
    const c = parseCalendar(raw)!
    expect(c.events).toHaveLength(2)
    const over = c.events.find((e) => e.recurrenceId)!
    expect(over).toMatchObject({ recurrenceId: '20260330T080000Z', summary: 'Tek' })
    expect(over.attendees).toHaveLength(1)
    expect(c.events.find((e) => !e.recurrenceId)!.summary).toBe('Toplantı')
    expect(starts(raw).slice(0, 3)).toEqual(['2026-03-23T09:00:00Z', '2026-03-30T12:00:00Z', '2026-04-06T08:00:00Z'])
  })
  it('this var olan overrideı günceller, yenisini eklemez', () => {
    const once = draftToIcs(draft({ title: 'Bir', start: '2026-03-30T14:00', end: '2026-03-30T15:00' }), { base: ics(...BERLIN), now: NOW, scope: 'this', recurrenceId: '20260330T080000Z' })
    const twice = draftToIcs(draft({ title: 'İki', start: '2026-03-30T15:00', end: '2026-03-30T16:00' }), { base: once, now: NOW, scope: 'this', recurrenceId: '20260330T080000Z' })
    const c = parseCalendar(twice)!
    expect(c.events).toHaveLength(2)
    expect(c.events.find((e) => e.recurrenceId)!.summary).toBe('İki')
  })
  it('thisAndFuture yeni UIDli seri, bilinmeyen özellikler kalır', () => {
    const raw = draftToIcs(draft({ start: '2026-03-30T10:00', end: '2026-03-30T11:00', rrule: { freq: 'WEEKLY', interval: 1 } }), { base: ics(...BERLIN, 'X-FOO:bar'), uid: 'seri-2', now: NOW, scope: 'thisAndFuture' })
    const c = parseCalendar(raw)!
    expect(c.uid).toBe('seri-2')
    expect(c.events).toHaveLength(1)
    expect(c.events[0].sequence).toBe(0)
    expect(raw).toContain('X-FOO:bar')
  })
})

describe('removeOccurrence', () => {
  it('removeOccurrence this adds EXDATE', () => {
    const raw = removeOccurrence(ics(...BERLIN), '20260330T080000Z', 'this', NOW)!
    expect(starts(raw).slice(0, 2)).toEqual(['2026-03-23T09:00:00Z', '2026-04-06T08:00:00Z'])
  })
  it('this overrideı da siler', () => {
    const once = draftToIcs(draft({ start: '2026-03-30T14:00', end: '2026-03-30T15:00' }), { base: ics(...BERLIN), now: NOW, scope: 'this', recurrenceId: '20260330T080000Z' })
    const raw = removeOccurrence(once, '20260330T080000Z', 'this', NOW)!
    expect(parseCalendar(raw)!.events).toHaveLength(1)
    expect(starts(raw).slice(0, 2)).toEqual(['2026-03-23T09:00:00Z', '2026-04-06T08:00:00Z'])
  })
  it('thisAndFuture sets UNTIL', () => {
    const raw = removeOccurrence(ics(...BERLIN), '20260406T080000Z', 'thisAndFuture', NOW)!
    expect(starts(raw)).toEqual(['2026-03-23T09:00:00Z', '2026-03-30T08:00:00Z'])
    expect(raw).toContain('UNTIL=20260406T075959Z')
  })
  it('thisAndFuture COUNT kaldırır, sonraki overrideları siler', () => {
    const once = draftToIcs(draft({ rruleRaw: 'FREQ=WEEKLY;COUNT=10', start: '2026-04-13T14:00', end: '2026-04-13T15:00' }), { base: ics(...BERLIN), now: NOW, scope: 'this', recurrenceId: '20260413T080000Z' })
    const raw = removeOccurrence(once.replace('RRULE:FREQ=WEEKLY', 'RRULE:FREQ=WEEKLY;COUNT=10'), '20260406T080000Z', 'thisAndFuture', NOW)!
    expect(raw).not.toContain('COUNT=')
    expect(parseCalendar(raw)!.events).toHaveLength(1)
  })
  it('tüm gün', () => {
    const base = ics('DTSTART;VALUE=DATE:20260301', 'RRULE:FREQ=DAILY;COUNT=5')
    const w = (raw: string) => expandObject(parseCalendar(raw)!, SPRING[0], SPRING[1], 'UTC').map((o) => o.startDate)
    expect(w(removeOccurrence(base, '20260302', 'this', NOW)!)).toEqual(['2026-03-01', '2026-03-03', '2026-03-04', '2026-03-05'])
    expect(w(removeOccurrence(base, '20260303', 'thisAndFuture', NOW)!)).toEqual(['2026-03-01', '2026-03-02'])
  })
})

describe('setPartstat', () => {
  const base = ics('DTSTART:20260101T100000Z', 'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:Ben@t.co', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:o@t.co')
  it('yalnız verilen adresi değiştirir, büyük harf duyarsız', () => {
    const c = parseCalendar(setPartstat(base, 'ben@T.co', 'ACCEPTED', NOW))!
    expect(c.events[0].attendees.map((a) => a.partstat)).toEqual(['ACCEPTED', 'ACCEPTED'])
    const d = parseCalendar(setPartstat(base, 'ben@t.co', 'DECLINED', NOW))!
    expect(d.events[0].attendees.map((a) => [a.addr, a.partstat])).toEqual([['ben@t.co', 'DECLINED'], ['o@t.co', 'ACCEPTED']])
  })
  it('katılımcı değilse aynen döner', () => expect(setPartstat(base, 'yok@t.co', 'ACCEPTED', NOW)).toBe(base))
})

describe('eventToDraft', () => {
  it('asıl seri', () => {
    expect(eventToDraft(ics(...BERLIN, 'LOCATION:Oda', 'DESCRIPTION:Not', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM'), null, 'UTC')).toEqual({
      title: 'Toplantı', location: 'Oda', description: 'Not', allDay: false, start: '2026-03-23T10:00', end: '2026-03-23T11:00', tz: 'Europe/Berlin',
      rrule: { freq: 'WEEKLY', interval: 1 }, alarmMinutes: 15
    })
  })
  it('örnek seçilince o örneğin saati', () => {
    expect(eventToDraft(ics(...BERLIN), '20260330T080000Z', 'UTC')).toMatchObject({ start: '2026-03-30T10:00', end: '2026-03-30T11:00' })
  })
  it('override', () => {
    const raw = draftToIcs(draft({ title: 'Tek', start: '2026-03-30T14:00', end: '2026-03-30T15:00' }), { base: ics(...BERLIN), now: NOW, scope: 'this', recurrenceId: '20260330T080000Z' })
    expect(eventToDraft(raw, '20260330T080000Z', 'UTC')).toMatchObject({ title: 'Tek', start: '2026-03-30T14:00' })
  })
  it('tüm gün', () => {
    expect(eventToDraft(ics('DTSTART;VALUE=DATE:20260329', 'SUMMARY:G'), null, 'Asia/Tokyo')).toMatchObject({ allDay: true, start: '2026-03-29', end: '2026-03-30', tz: 'Asia/Tokyo' })
  })
  it('arayüzün ifade edemediği kural rruleRaw kalır', () => {
    const d = eventToDraft(ics('DTSTART:20260105T100000Z', 'RRULE:FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2'), null, 'UTC')!
    expect(d.rrule).toBeNull()
    expect(d.rruleRaw).toBe('FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2')
  })
  it('until tarihe döner, gidiş dönüş korunur', () => {
    const raw = draftToIcs(draft({ rrule: { freq: 'DAILY', interval: 1, until: '2026-03-25' } }), { now: NOW })
    expect(eventToDraft(raw, null, 'UTC')!.rrule).toEqual({ freq: 'DAILY', interval: 1, until: '2026-03-25' })
  })
  it('bozuk ham veri null', () => expect(eventToDraft('çöp', null, 'UTC')).toBeNull())
})

describe('gözden geçirme düzeltmeleri', () => {
  it('splitIcsFeed aynı UID grubunu doğrusal büyütür', () => {
    const events = Array.from({ length: 4000 }, (_, i) => `BEGIN:VEVENT\r\nUID:ayni\r\nDTSTAMP:20260101T000000Z\r\nRECURRENCE-ID:2026${String((i % 12) + 1).padStart(2, '0')}01T${String(i % 24).padStart(2, '0')}0000Z\r\nDTSTART:20260101T000000Z\r\nEND:VEVENT`)
    const started = Date.now()
    expect(splitIcsFeed(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join('\r\n')}\r\nEND:VCALENDAR\r\n`)).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('geçersiz taslak tarihi reddedilir', () => {
    for (const start of ['2026-02-30T10:00', '2026-13-01T10:00', '2026-01-01T25:00', '2026-01-01T10:61']) expect(() => draftToIcs(draft({ start }), { now: NOW }), start).toThrow()
    expect(draftToIcs(draft({ start: '2028-02-29T10:00' }), { now: NOW })).toContain('20280229T100000')
  })

  it('ilk örnekte thisAndFuture nesneyi siler', () => {
    expect(removeOccurrence(ics(...BERLIN), '20260323T090000Z', 'thisAndFuture', NOW)).toBeNull()
  })

  it('thisAndFuture kesimden sonraki RDATE değerlerini siler, öncekileri korur', () => {
    const base = ics(...BERLIN, 'RDATE:20260326T090000Z,20260410T080000Z', 'RDATE:20260415T080000Z')
    const raw = removeOccurrence(base, '20260406T080000Z', 'thisAndFuture', NOW)!
    expect(raw).toContain('20260326T090000Z')
    expect(raw).not.toContain('20260410T080000Z')
    expect(raw).not.toContain('20260415T080000Z')
    expect(starts(raw)).toEqual(['2026-03-23T09:00:00Z', '2026-03-26T09:00:00Z', '2026-03-30T08:00:00Z'])
  })

  it('düzenleme öteki VALARM eklerini korur', () => {
    const base = ics(...BERLIN, 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM', 'BEGIN:VALARM', 'ACTION:EMAIL', 'TRIGGER:-PT1H', 'END:VALARM', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;VALUE=DATE-TIME:20260101T000000Z', 'END:VALARM')
    const alarms = (raw: string): number[] => parseCalendar(raw)!.events[0].alarmsMinutes
    expect(alarms(draftToIcs(draft({ alarmMinutes: 15 }), { base, now: NOW }))).toEqual([15, 60])
    expect(alarms(draftToIcs(draft({ alarmMinutes: 30 }), { base, now: NOW }))).toEqual([30, 60])
    const removed = draftToIcs(draft(), { base, now: NOW })
    expect(alarms(removed)).toEqual([60])
    expect(removed).toContain('VALUE=DATE-TIME')
  })

  it('setPartstat yalnız katılımcının olduğu bileşeni damgalar', () => {
    const raw = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN',
      'BEGIN:VEVENT', 'UID:u1', 'DTSTAMP:20200101T000000Z', 'DTSTART:20260105T100000Z', 'ATTENDEE:mailto:a@t.co', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:u1', 'DTSTAMP:20200101T000000Z', 'DTSTART:20260106T100000Z', 'RECURRENCE-ID:20260106T100000Z', 'ATTENDEE:mailto:b@t.co', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
    const out = setPartstat(raw, 'a@t.co', 'ACCEPTED', NOW)
    expect(out.match(/DTSTAMP:20200101T000000Z/g)).toHaveLength(1)
    expect(out.match(/DTSTAMP:20260201T120000Z/g)).toHaveLength(1)
  })
})
