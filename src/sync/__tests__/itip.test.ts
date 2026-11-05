import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { parseCalendar } from '../pim/ical'
import { buildReply, mergeUpdate, readInvite, toStorable } from '../pim/itip'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures/itip', `${name}.ics`), 'utf-8')
const ctx = { fromAddr: 'org@x.co', myAddr: 'a@t.co', stored: null, viewerTz: 'Europe/Istanbul' }
const NOW = Date.UTC(2026, 10, 5, 12)
const ics = (lines: string[], method: string | null = 'REQUEST'): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN', ...(method ? [`METHOD:${method}`] : []), 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
const base = (...more: string[]): string[] => [
  'UID:u1', 'DTSTAMP:20261101T000000Z', 'DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z', 'SUMMARY:Toplanti', 'SEQUENCE:1',
  'ORGANIZER;CN=Org:mailto:org@x.co', 'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:a@t.co', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:b@t.co', ...more
]

describe('readInvite', () => {
  it.each([
    ['gmail', 'gmail-1@google.com', 'ayse@gmail.com', Date.UTC(2026, 10, 20, 9)],
    ['outlook', '040000008200E00074C5B7101A82E0080000000080F3', 'mehmet@contoso.com', Date.UTC(2026, 10, 20, 11)],
    ['apple', 'APPLE-1234-5678', 'elif@icloud.com', Date.UTC(2026, 10, 20, 13)],
    ['stalwart', 'stalwart-1', 'yon@example.test', Date.UTC(2026, 10, 21, 9)]
  ])('reads invite: %s', (name, uid, organizer, start) => {
    const i = readInvite(fixture(name), { ...ctx, fromAddr: organizer })!
    expect(i).toMatchObject({ method: 'REQUEST', uid, sequence: 0, recurrenceId: null, start, warnings: [] })
    expect(i.organizer?.addr).toBe(organizer)
    expect(i.attendees.some((a) => a.addr === 'a@t.co')).toBe(true)
  })

  it('stalwart DURATION becomes end', () => {
    const i = readInvite(fixture('stalwart'), { ...ctx, fromAddr: 'yon@example.test' })!
    expect(i.end - i.start).toBe(30 * 60_000)
  })

  it('recurring invite flagged', () => {
    expect(readInvite(fixture('apple'), { ...ctx, fromAddr: 'elif@icloud.com' })!.recurring).toBe(true)
    expect(readInvite(fixture('gmail'), { ...ctx, fromAddr: 'ayse@gmail.com' })!.recurring).toBe(false)
  })

  it('organizer mismatch warned', () => {
    const i = readInvite(ics(base()), { ...ctx, fromAddr: 'saldirgan@evil.co' })!
    expect(i.warnings).toContain('organizerMismatch')
    expect(i.organizer?.addr).toBe('org@x.co')
  })

  it('stored organizer differs: warned even when sender matches the invite', () => {
    const i = readInvite(ics(base()), { ...ctx, stored: { sequence: 0, organizer: 'gercek@x.co' } })!
    expect(i.warnings).toContain('organizerMismatch')
  })

  it('reply is checked against the attendee, not the organizer', () => {
    const raw = ics(['UID:u1', 'DTSTAMP:20261101T000000Z', 'DTSTART:20261120T100000Z', 'ORGANIZER:mailto:a@t.co', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:b@t.co'], 'REPLY')
    expect(readInvite(raw, { ...ctx, fromAddr: 'b@t.co' })).toMatchObject({ method: 'REPLY', replyFrom: { addr: 'b@t.co', partstat: 'ACCEPTED' }, warnings: [] })
    expect(readInvite(raw, { ...ctx, fromAddr: 'c@t.co' })!.warnings).toContain('organizerMismatch')
  })

  it('no method means publish', () => {
    expect(readInvite(ics(base(), null), ctx)!.method).toBe('PUBLISH')
  })

  it('counter and refresh are not invites', () => {
    for (const m of ['COUNTER', 'REFRESH', 'ADD', 'DECLINECOUNTER']) expect(readInvite(ics(base(), m), ctx), m).toBeNull()
  })

  it('crlf in title stripped', () => {
    const i = readInvite(ics(base('SUMMARY:Bcc\\nX-Injected: 1')), ctx)!
    expect(i.title).not.toMatch(/[\r\n]/)
  })

  it('more than one uid is not an invite', () => {
    const raw = ics(base()).replace('END:VCALENDAR', ['BEGIN:VEVENT', 'UID:baska', 'DTSTAMP:20261101T000000Z', 'DTSTART:20261121T100000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'))
    expect(readInvite(raw, ctx)).toBeNull()
  })

  it('organizer other than a single mailto address is dropped', () => {
    for (const v of ['ORGANIZER:http://evil.co/x', 'ORGANIZER:mailto:yok', 'ORGANIZER:mailto:a@x.co,b@x.co', 'ORGANIZER:mailto:a b@x.co']) {
      const raw = ics(base().map((l) => (l.startsWith('ORGANIZER') ? v : l)))
      const i = readInvite(raw, ctx)!
      expect(i.organizer, v).toBeNull()
      expect(i.warnings, v).toContain('noOrganizer')
    }
  })

  it('attendee not found warned', () => {
    expect(readInvite(ics(base()), { ...ctx, myAddr: 'takma@t.co' })!.warnings).toContain('attendeeNotFound')
  })

  it('sequence against stored: stale and update; unknown stored sequence neither', () => {
    const raw = ics(base())
    expect(readInvite(raw, { ...ctx, stored: { sequence: 2, organizer: 'org@x.co' } })).toMatchObject({ isUpdate: false, warnings: ['stale'] })
    expect(readInvite(raw, { ...ctx, stored: { sequence: 0, organizer: 'org@x.co' } })).toMatchObject({ isUpdate: true, warnings: [] })
    expect(readInvite(raw, { ...ctx, stored: { sequence: null, organizer: 'org@x.co' } })).toMatchObject({ isUpdate: false, warnings: [] })
  })

  it('occurrence invite keeps its recurrence id', () => {
    expect(readInvite(ics(base('RECURRENCE-ID:20261120T100000Z')), ctx)!.recurrenceId).toBe('20261120T100000Z')
  })
})

describe('buildReply', () => {
  const parsed = (raw: string) => parseCalendar(raw)!

  it('buildReply has one attendee, same uid and sequence, METHOD REPLY', () => {
    const raw = buildReply(parsed(ics(base())), { attendee: { addr: 'a@t.co', name: 'A' }, partstat: 'ACCEPTED', now: NOW })
    const c = parseCalendar(raw)!
    expect(c.method).toBe('REPLY')
    expect(c.events).toHaveLength(1)
    expect(c.events[0]).toMatchObject({ uid: 'u1', sequence: 1, summary: 'Toplanti' })
    expect(c.events[0].attendees).toEqual([expect.objectContaining({ addr: 'a@t.co', name: 'A', partstat: 'ACCEPTED' })])
    expect(c.events[0].organizer?.addr).toBe('org@x.co')
    expect(raw).toContain('DTSTART:20261120T100000Z')
    expect(raw).toContain('DTEND:20261120T110000Z')
    expect(raw).toContain('DTSTAMP:20261105T120000Z')
    expect(raw).toContain('PRODID')
  })

  it('reply keeps recurrence id', () => {
    const raw = buildReply(parsed(ics(base('RECURRENCE-ID:20261120T100000Z'))), { attendee: { addr: 'a@t.co', name: null }, partstat: 'DECLINED', now: NOW })
    expect(parseCalendar(raw)!.events[0].recurrenceId).toBe('20261120T100000Z')
  })

  it('reply on a master without overrides has no recurrence id, keeps the zone body and DURATION', () => {
    const outlook = buildReply(parsed(fixture('outlook')), { attendee: { addr: 'a@t.co', name: null }, partstat: 'TENTATIVE', now: NOW })
    expect(outlook).toContain('BEGIN:VTIMEZONE')
    expect(outlook).not.toContain('RECURRENCE-ID')
    expect(buildReply(parsed(fixture('stalwart')), { attendee: { addr: 'a@t.co', name: null }, partstat: 'ACCEPTED', now: NOW })).toContain('DURATION:PT30M')
  })
})

describe('toStorable', () => {
  it('toStorable strips METHOD', () => {
    const raw = ics(base())
    const out = toStorable(parseCalendar(raw)!, raw, { myAddr: 'a@t.co', partstat: 'ACCEPTED', now: NOW })
    const c = parseCalendar(out)!
    expect(c.method).toBeNull()
    expect(c.events[0].attendees.find((a) => a.addr === 'a@t.co')?.partstat).toBe('ACCEPTED')
    expect(c.events[0].attendees.find((a) => a.addr === 'b@t.co')?.partstat).toBe('ACCEPTED')
  })
  it('publish without partstat leaves attendees', () => {
    const raw = ics(base(), 'PUBLISH')
    const c = parseCalendar(toStorable(parseCalendar(raw)!, raw, { myAddr: 'a@t.co', partstat: null, now: NOW }))!
    expect(c.events[0].attendees.find((a) => a.addr === 'a@t.co')?.partstat).toBe('NEEDS-ACTION')
  })
})

describe('mergeUpdate', () => {
  const storedRaw = ics(base('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:h', 'TRIGGER:-PT10M', 'END:VALARM').map((l) => (l.startsWith('ATTENDEE;PARTSTAT=NEEDS') ? 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:a@t.co' : l)), null)
  const mine = (raw: string): string | undefined => parseCalendar(raw)!.events[0].attendees.find((a) => a.addr === 'a@t.co')?.partstat

  it('mergeUpdate resets my partstat on time change', () => {
    const incoming = ics(base().map((l) => (l.startsWith('DTSTART') ? 'DTSTART:20261120T120000Z' : l.startsWith('DTEND') ? 'DTEND:20261120T130000Z' : l)))
    const out = mergeUpdate(storedRaw, incoming, { myAddr: 'a@t.co', now: NOW })
    expect(mine(out)).toBe('NEEDS-ACTION')
    expect(out).toContain('DTSTART:20261120T120000Z')
    expect(parseCalendar(out)!.method).toBeNull()
  })

  it('keeps on title change', () => {
    const incoming = ics(base().map((l) => (l.startsWith('SUMMARY') ? 'SUMMARY:Yeni ad' : l)))
    const out = mergeUpdate(storedRaw, incoming, { myAddr: 'a@t.co', now: NOW })
    expect(mine(out)).toBe('ACCEPTED')
    expect(parseCalendar(out)!.events[0].summary).toBe('Yeni ad')
  })

  it('my reminder survives', () => {
    expect(parseCalendar(mergeUpdate(storedRaw, ics(base()), { myAddr: 'a@t.co', now: NOW }))!.events[0].alarmsMinutes).toEqual([10])
  })

  it('occurrence update touches only that occurrence', () => {
    const series = ics(base('RRULE:FREQ=WEEKLY;COUNT=4').map((l) => (l.startsWith('ATTENDEE;PARTSTAT=NEEDS') ? 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:a@t.co' : l)), null)
    const incoming = ics(base('RECURRENCE-ID:20261127T100000Z').map((l) => (l.startsWith('DTSTART') ? 'DTSTART:20261127T120000Z' : l.startsWith('DTEND') ? 'DTEND:20261127T130000Z' : l)))
    const c = parseCalendar(mergeUpdate(series, incoming, { myAddr: 'a@t.co', now: NOW }))!
    expect(c.events).toHaveLength(2)
    const [master, one] = [c.events.find((e) => !e.recurrenceId)!, c.events.find((e) => e.recurrenceId)!]
    expect(master.attendees.find((a) => a.addr === 'a@t.co')?.partstat).toBe('ACCEPTED')
    expect(one.recurrenceId).toBe('20261127T100000Z')
    expect(one.attendees.find((a) => a.addr === 'a@t.co')?.partstat).toBe('NEEDS-ACTION')
  })
})
