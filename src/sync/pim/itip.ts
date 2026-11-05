// iMIP/iTIP: postadaki daveti okur, yanıtı ve takvime yazılacak nesneyi üretir. Buradaki işlevler ana iş parçacığında çalışır: düşmanca
// nesneyi ayıklayan alım kapısı `gateCalendars` ÇAĞIRANDA, bunlardan önce koşar. Hiçbiri veritabanına ya da ağa dokunmaz.
import ICAL from 'ical.js'
import type { InviteInfo, InviteWarning } from '../../shared/pim'
import { cloneOf, eventsOf, parseCalendar, roots, setPartstat, text, type ParsedCalendar, type ParsedEvent } from './ical'
import { compactUtc, isRecurring, occurrenceOf, ridOf, zoneOf } from './recur'

const PRODID = '-//GeckoMail//Calendar//EN'
const METHODS: readonly string[] = ['REQUEST', 'CANCEL', 'REPLY', 'PUBLISH']
const SINGLE_ADDR = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+$/

export type StoredInvite = {
  /** null: kaynak SEQUENCE tutmuyor (Graph), bayatlık ve güncelleme hesaplanamaz */
  sequence: number | null
  organizer: string | null
}

export type InviteRead = Omit<InviteInfo, 'attachmentId' | 'existing' | 'response' | 'canAddToCalendar' | 'canRespond' | 'changes'>

const oneLine = (v: string): string => v.replace(/[\r\n]+/g, ' ').trim()

const masterOf = (c: ParsedCalendar): ParsedEvent => c.events.find((e) => !e.recurrenceId) ?? c.events[0]

/** Yanıtın gideceği adres başlığa yazılır: `mailto:a@x,b@x` iki alıcı olurdu, `http:` ve benzeri adres değildir */
function organizerOf(ev: ParsedEvent): { addr: string; name: string | null } | null {
  const value = (ev.component as ICAL.Component).getFirstProperty('organizer')?.getFirstValue()
  const m = /^mailto:(.*)$/i.exec(String(value ?? '').trim())
  return m && ev.organizer && SINGLE_ADDR.test(m[1]) ? { addr: ev.organizer.addr, name: ev.organizer.name && oneLine(ev.organizer.name) } : null
}

export function readInvite(raw: string, ctx: { fromAddr: string | null; myAddr: string; stored: StoredInvite | null; viewerTz?: string }): InviteRead | null {
  const c = parseCalendar(raw)
  if (!c) return null
  try {
    const method = c.method ?? 'PUBLISH'
    if (!METHODS.includes(method) || !c.uid || c.events.some((e) => e.uid !== c.uid)) return null
    const ev = masterOf(c)
    const recurrenceId = ev.recurrenceId
    const occ = occurrenceOf(c, recurrenceId, ctx.viewerTz ?? 'UTC')
    if (!occ) return null
    const from = ctx.fromAddr?.trim().toLowerCase() ?? null
    const me = ctx.myAddr.trim().toLowerCase()
    const organizer = organizerOf(ev)
    const sequence = Math.max(...c.events.map((e) => e.sequence))
    const storedSeq = ctx.stored?.sequence ?? null
    const reply = method === 'REPLY' ? (ev.attendees[0] ?? null) : null
    const warnings: InviteWarning[] = []
    // REPLY'yi düzenleyen değil katılımcı gönderir
    const claimed = method === 'REPLY' ? reply?.addr : organizer?.addr
    if (claimed && (claimed !== from || (method !== 'REPLY' && ctx.stored?.organizer && ctx.stored.organizer !== claimed))) warnings.push('organizerMismatch')
    if (!organizer && method !== 'PUBLISH') warnings.push('noOrganizer')
    if (method === 'REQUEST' && !ev.attendees.some((a) => a.addr === me)) warnings.push('attendeeNotFound')
    if ((method === 'REQUEST' || method === 'CANCEL') && storedSeq !== null && sequence < storedSeq) warnings.push('stale')
    return {
      method: method as InviteInfo['method'], uid: c.uid, sequence, recurrenceId, title: oneLine(ev.summary), location: ev.location && oneLine(ev.location),
      start: occ.start, end: occ.end, allDay: occ.allDay, startDate: occ.startDate, endDate: occ.endDate, tz: occ.tz,
      recurring: !recurrenceId && isRecurring(ev.component as ICAL.Component), organizer,
      attendees: ev.attendees.map((a) => ({ addr: a.addr, name: a.name, partstat: a.partstat })),
      replyFrom: reply && { addr: reply.addr, partstat: reply.partstat }, warnings, isUpdate: method === 'REQUEST' && storedSeq !== null && sequence > storedSeq
    }
  } catch {
    return null
  }
}

export function buildReply(c: ParsedCalendar, o: { attendee: { addr: string; name: string | null }; partstat: string; now: number }): string {
  const ev = masterOf(c)
  const comp = ev.component as ICAL.Component
  const cal = new ICAL.Component(['vcalendar', [], []])
  cal.addProperty(ICAL.Property.fromString('METHOD:REPLY'))
  cal.addProperty(ICAL.Property.fromString('VERSION:2.0'))
  cal.updatePropertyWithValue('prodid', PRODID)
  const out = new ICAL.Component('vevent')
  const copied: ICAL.Property[] = []
  const copy = (name: string): void => {
    const p = comp.getFirstProperty(name)
    if (!p) return
    const clone = new ICAL.Property(JSON.parse(JSON.stringify(p.toJSON())))
    out.addProperty(clone)
    copied.push(clone)
  }
  for (const name of ['uid', 'sequence', 'dtstart', 'dtend', 'duration', 'recurrence-id', 'organizer']) copy(name)
  out.addProperty(ICAL.Property.fromString(`DTSTAMP:${compactUtc(o.now)}`))
  const attendee = new ICAL.Property('attendee')
  attendee.setValue(`mailto:${o.attendee.addr}`)
  attendee.setParameter('partstat', o.partstat)
  if (o.attendee.name) attendee.setParameter('cn', oneLine(o.attendee.name))
  out.addProperty(attendee)
  if (ev.summary) out.updatePropertyWithValue('summary', oneLine(ev.summary))
  const zones = new Set(copied.map((p) => p.getParameter('tzid')).filter((id): id is string => typeof id === 'string'))
  for (const id of zones) {
    const zone = c.vtimezones.get(id) as { component?: ICAL.Component } | undefined
    if (zone?.component) cal.addSubcomponent(cloneOf(zone.component))
  }
  cal.addSubcomponent(out)
  return text(cal)
}

/** Takvime yazılacak kopya: METHOD bir iletinin özelliğidir, nesnede kalırsa CalDAV sunucusu reddeder */
export function toStorable(c: ParsedCalendar, raw: string, o: { myAddr: string; partstat: string | null; now: number }): string {
  const cal = roots(raw)[0]
  cal.removeAllProperties('method')
  for (const ev of cal.getAllSubcomponents('vevent')) if (ev.getFirstPropertyValue('uid') !== c.uid) cal.removeSubcomponent(ev)
  const out = text(cal)
  return o.partstat ? setPartstat(out, o.myAddr, o.partstat, o.now) : out
}

const propText = (ev: ICAL.Component, name: string): string => ev.getFirstProperty(name)?.toICALString() ?? ''
const WHEN = ['dtstart', 'dtend', 'duration', 'rrule']
const sameTime = (a: ICAL.Component, b: ICAL.Component): boolean => WHEN.every((name) => propText(a, name) === propText(b, name))

function myPartstat(ev: ICAL.Component, me: string): ICAL.Property | undefined {
  return ev.getAllProperties('attendee').find((p) => String(p.getFirstValue()).replace(/^mailto:/i, '').trim().toLowerCase() === me)
}

/** Saat aynıysa önceki yanıtım ve hatırlatmam kalır; saat değiştiyse yanıt yeniden sorulur */
function carryOver(next: ICAL.Component, previous: ICAL.Component | undefined, me: string): void {
  const mine = myPartstat(next, me)
  if (mine) {
    const before = previous && sameTime(next, previous) ? myPartstat(previous, me)?.getParameter('partstat') : null
    mine.setParameter('partstat', typeof before === 'string' ? before : 'NEEDS-ACTION')
  }
  if (previous && !next.getFirstSubcomponent('valarm')) for (const alarm of previous.getAllSubcomponents('valarm')) next.addSubcomponent(cloneOf(alarm))
}

export function mergeUpdate(storedRaw: string, incomingRaw: string, o: { myAddr: string; now: number }): string {
  const me = o.myAddr.trim().toLowerCase()
  const stored = roots(storedRaw)[0]
  const incoming = roots(incomingRaw)[0]
  incoming.removeAllProperties('method')
  const before = eventsOf(stored)
  const after = eventsOf(incoming)
  const zones = parseCalendar(incomingRaw)?.vtimezones ?? new Map<string, unknown>()
  const previous = (rid: string | null): ICAL.Component | undefined => before.list.find((e) => e.rid === rid)?.ev
  for (const e of after.list) carryOver(e.ev, previous(e.rid), me)
  const stamp = (cal: ICAL.Component): void => {
    for (const ev of cal.getAllSubcomponents('vevent')) ev.updatePropertyWithValue('last-modified', ICAL.Time.fromJSDate(new Date(o.now), true))
  }
  if (after.list.some((e) => !e.rid) || before.list.every((e) => e.rid)) {
    stamp(incoming)
    return text(incoming)
  }
  // tek oluşum güncellemesi: seri ve öteki oluşumlar durur
  const have = new Set(stored.getAllSubcomponents('vtimezone').map((z) => String(z.getFirstPropertyValue('tzid'))))
  for (const z of incoming.getAllSubcomponents('vtimezone')) {
    if (have.has(String(z.getFirstPropertyValue('tzid')))) continue
    stored.removeSubcomponent(before.master)
    stored.addSubcomponent(cloneOf(z))
    stored.addSubcomponent(before.master)
  }
  for (const e of after.list) {
    const old = previous(e.rid)
    if (old) stored.removeSubcomponent(old)
    else {
      // oluşum kopyası yoktu: seriden gelir; saat kalıyorsa yanıtım da kalır
      const master = myPartstat(before.master, me)?.getParameter('partstat')
      const prop = e.ev.getFirstProperty('dtstart')
      const start = prop?.getFirstValue() as ICAL.Time | undefined
      const same = prop && start && ridOf(start, zoneOf(prop, start, zones, 'UTC'), 'UTC') === e.rid
      const mine = myPartstat(e.ev, me)
      if (same && mine && typeof master === 'string') mine.setParameter('partstat', master)
    }
    stored.addSubcomponent(cloneOf(e.ev))
  }
  stamp(stored)
  return text(stored)
}
