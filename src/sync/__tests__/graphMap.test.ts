import { describe, expect, it } from 'vitest'
import type { EventDraft } from '../../shared/pim'
import { draftToGraphEvent, graphContactToVCard, graphEventToIcs, rruleToGraphRecurrence, vcardToGraphContact } from '../pim/graphMap'
import { indexFields, parseCalendar } from '../pim/ical'
import { expandObject, nextAlarmAt } from '../pim/recur'
import { parseCard } from '../pim/vcard'
import { graphEvent } from './helpers/fakeGraph'

const FROM = Date.UTC(2026, 10, 1)
const TO = Date.UTC(2026, 11, 1)

describe('Graph eşlemesi', () => {
  it('occurrence stored non-recurring not re-expanded', () => {
    const raw = graphEventToIcs(graphEvent('o1', { type: 'occurrence', seriesMasterId: 'm1', originalStart: '2026-11-10T10:00:00Z' }))
    expect(indexFields(raw, 'UTC')).toMatchObject({ uid: 'uid-o1', recurring: false, rangeStart: Date.UTC(2026, 10, 10, 10) })
    const c = parseCalendar(raw)!
    expect(expandObject(c, FROM, TO, 'UTC')).toHaveLength(1)
    expect(c.events[0].recurrenceId).toBe('20261110T100000Z')
  })

  it('tekil olay örnek kimliği taşımaz, UTC DTSTART', () => {
    const raw = graphEventToIcs(graphEvent('s1', { start: { dateTime: '2026-11-10T13:00:00.0000000', timeZone: 'Turkey Standard Time' }, end: { dateTime: '2026-11-10T14:00:00.0000000', timeZone: 'Turkey Standard Time' } }))
    expect(raw).toContain('DTSTART:20261110T100000Z')
    expect(raw).not.toContain('RECURRENCE-ID')
  })

  it('all day keeps date', () => {
    const raw = graphEventToIcs(graphEvent('a1', { isAllDay: true, start: { dateTime: '2026-11-10T00:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-11T00:00:00.0000000', timeZone: 'UTC' } }))
    expect(raw).toContain('DTSTART;VALUE=DATE:20261110')
    const [o] = expandObject(parseCalendar(raw)!, FROM, TO, 'Pacific/Auckland')
    expect(o).toMatchObject({ allDay: true, startDate: '2026-11-10', endDate: '2026-11-11' })
  })

  it('isReminderOn creates alarm', () => {
    const raw = graphEventToIcs(graphEvent('r1', { isReminderOn: true, reminderMinutesBeforeStart: 15 }))
    expect(nextAlarmAt(parseCalendar(raw)!, FROM)).toBe(Date.UTC(2026, 10, 10, 9, 45))
    expect(graphEventToIcs(graphEvent('r2'))).not.toContain('VALARM')
  })

  it('html body becomes text', () => {
    const raw = graphEventToIcs(graphEvent('h1', { body: { contentType: 'html', content: '<div><b>Merhaba</b><br>dünya<script>alert(1)</script></div>' } }))
    const ev = parseCalendar(raw)!.events[0]
    expect(ev.description).toContain('Merhaba')
    expect(ev.description).toContain('dünya')
    expect(ev.description).not.toMatch(/<|alert/)
  })

  it('katılımcı, düzenleyen, iptal ve özel karakter korunur', () => {
    const raw = graphEventToIcs(graphEvent('p1', {
      subject: 'Bütçe; 2027, plan', isCancelled: true, location: { displayName: 'Salon A' }, organizer: { emailAddress: { address: 'Patron@x.co', name: 'Patron' } },
      attendees: [{ emailAddress: { address: 'a@x.co', name: 'A' }, status: { response: 'tentativelyAccepted' } }]
    }))
    const ev = parseCalendar(raw)!.events[0]
    expect(ev).toMatchObject({ summary: 'Bütçe; 2027, plan', location: 'Salon A', status: 'CANCELLED', organizer: { addr: 'patron@x.co', name: 'Patron' } })
    expect(ev.attendees).toEqual([{ addr: 'a@x.co', name: 'A', partstat: 'TENTATIVE', rsvp: false }])
  })

  it('contact map roundtrip', () => {
    const input = {
      id: 'c1', displayName: 'Ayşe Kaya', givenName: 'Ayşe', surname: 'Kaya', companyName: 'Şirket', personalNotes: 'not, satır',
      emailAddresses: [{ name: 'Ayşe', address: 'ayse@x.co' }, { name: null, address: 'a2@x.co' }], businessPhones: ['+90 212'], homePhones: ['+90 216'], mobilePhone: '+90 555',
      businessAddress: { street: 'Cad 1', city: 'Ankara', state: '', countryOrRegion: 'TR', postalCode: '06100' }, birthday: '1990-05-12T00:00:00Z', categories: ['Ekip']
    }
    const raw = graphContactToVCard(input)
    const card = parseCard(raw)!
    expect(card).toMatchObject({ uid: 'c1', fullName: 'Ayşe Kaya', org: 'Şirket', detail: { given: 'Ayşe', family: 'Kaya', birthday: '1990-05-12', note: 'not, satır' } })
    expect(card.detail.addresses[0].value).toContain('Ankara')
    const back = vcardToGraphContact(raw)
    expect(back).toMatchObject({
      displayName: 'Ayşe Kaya', givenName: 'Ayşe', surname: 'Kaya', companyName: 'Şirket', personalNotes: 'not, satır', businessPhones: ['+90 212'], homePhones: ['+90 216'], mobilePhone: '+90 555',
      birthday: '1990-05-12T00:00:00Z', categories: ['Ekip']
    })
    expect(back.emailAddresses.map((e) => e.address)).toEqual(['ayse@x.co', 'a2@x.co'])
    expect(back.businessAddress).toEqual({ street: 'Cad 1', city: 'Ankara', state: '', countryOrRegion: 'TR', postalCode: '06100' })
  })

  it('rrule WEEKLY MO,WE maps to weekly daysOfWeek', () => {
    expect(rruleToGraphRecurrence({ freq: 'WEEKLY', interval: 2, byDay: ['MO', 'WE'] }, '2026-11-02', 'Europe/Istanbul')).toEqual({
      pattern: { type: 'weekly', interval: 2, daysOfWeek: ['monday', 'wednesday'] },
      range: { type: 'noEnd', startDate: '2026-11-02', recurrenceTimeZone: 'Europe/Istanbul' }
    })
  })

  it('diğer kurallar', () => {
    expect(rruleToGraphRecurrence({ freq: 'WEEKLY', interval: 1, count: 3 }, '2026-11-04', 'UTC')).toMatchObject({ pattern: { daysOfWeek: ['wednesday'] }, range: { type: 'numbered', numberOfOccurrences: 3 } })
    expect(rruleToGraphRecurrence({ freq: 'DAILY', interval: 1, until: '2026-12-01' }, '2026-11-04', 'UTC')).toMatchObject({ pattern: { type: 'daily' }, range: { type: 'endDate', endDate: '2026-12-01' } })
    expect(rruleToGraphRecurrence({ freq: 'MONTHLY', interval: 1 }, '2026-11-04', 'UTC').pattern).toEqual({ type: 'absoluteMonthly', interval: 1, dayOfMonth: 4 })
    expect(rruleToGraphRecurrence({ freq: 'MONTHLY', interval: 1, byDay: ['-1SU'] }, '2026-11-29', 'UTC').pattern).toEqual({ type: 'relativeMonthly', interval: 1, daysOfWeek: ['sunday'], index: 'last' })
    expect(rruleToGraphRecurrence({ freq: 'YEARLY', interval: 1 }, '2026-11-04', 'UTC').pattern).toEqual({ type: 'absoluteYearly', interval: 1, dayOfMonth: 4, month: 11 })
  })

  it('draftToGraphEvent düz metin gövde, tüm gün ve hatırlatma', () => {
    const d: EventDraft = { title: 'T', location: 'L', description: 'D', allDay: true, start: '2026-11-10', end: '2026-11-11', tz: 'Europe/Istanbul', rrule: null, alarmMinutes: 30 }
    expect(draftToGraphEvent(d)).toMatchObject({
      subject: 'T', location: { displayName: 'L' }, body: { contentType: 'text', content: 'D' }, isAllDay: true, start: { dateTime: '2026-11-10T00:00:00', timeZone: 'Europe/Istanbul' }, end: { dateTime: '2026-11-11T00:00:00' }, isReminderOn: true, reminderMinutesBeforeStart: 30
    })
    expect(draftToGraphEvent({ ...d, allDay: false, start: '2026-11-10T09:30', end: '2026-11-10T10:00', alarmMinutes: null })).toMatchObject({ start: { dateTime: '2026-11-10T09:30:00' }, isReminderOn: false })
  })
})
