// Graph kişi ve olaylarını vCard/iCalendar'a çevirir: arayüz, açılım ve yazma tek yoldan geçer. Oluşum ve istisnalar ayrı nesnedir,
// RECURRENCE-ID taşır ama RRULE taşımaz; motor yeniden açmaz. Graph HTML gövdesi düz metne iner.
import ICAL from 'ical.js'
import type { EventDraft, RecurrenceInput } from '../../shared/pim'
import { htmlToText } from '../../shared/searchQuery'
import { compactDate, compactUtc } from './recur'
import { resolveTz, wallToUtc, type Wall } from './tz'
import { draftToCard, foldLine, escapeText, parseCard } from './vcard'

export interface GraphAddress { street?: string | null; city?: string | null; state?: string | null; countryOrRegion?: string | null; postalCode?: string | null }
export interface GraphContact {
  id: string
  displayName?: string | null
  givenName?: string | null
  surname?: string | null
  companyName?: string | null
  personalNotes?: string | null
  birthday?: string | null
  emailAddresses?: { name?: string | null; address?: string | null }[]
  businessPhones?: string[]
  homePhones?: string[]
  mobilePhone?: string | null
  businessAddress?: GraphAddress | null
  homeAddress?: GraphAddress | null
  otherAddress?: GraphAddress | null
  categories?: string[]
}
export type GraphContactInput = Omit<GraphContact, 'id'> & { emailAddresses: { name?: string | null; address: string }[] }

interface GraphTime { dateTime: string; timeZone: string }
interface GraphPerson { emailAddress?: { address?: string | null; name?: string | null } | null }
export interface GraphEvent {
  id: string
  iCalUId?: string | null
  subject?: string | null
  body?: { contentType?: string; content?: string | null } | null
  start: GraphTime
  end: GraphTime
  isAllDay?: boolean
  isCancelled?: boolean
  isReminderOn?: boolean
  reminderMinutesBeforeStart?: number
  location?: { displayName?: string | null } | null
  organizer?: GraphPerson | null
  attendees?: (GraphPerson & { status?: { response?: string | null } | null })[]
  type?: string
  seriesMasterId?: string | null
  originalStart?: string | null
}

export interface GraphRecurrence {
  pattern: { type: string; interval: number; daysOfWeek?: string[]; dayOfMonth?: number; month?: number; index?: string }
  range: { type: string; startDate: string; recurrenceTimeZone: string; endDate?: string; numberOfOccurrences?: number }
}

export interface GraphEventInput {
  subject: string
  location: { displayName: string }
  body: { contentType: 'text'; content: string }
  isAllDay: boolean
  start: GraphTime
  end: GraphTime
  isReminderOn: boolean
  reminderMinutesBeforeStart?: number
  recurrence?: GraphRecurrence | null
}

const PRODID = '-//GeckoMail//Graph//EN'
const SERIES_PROP = 'X-GECKO-SERIES-MASTER'
const PARTSTAT: Record<string, string> = { accepted: 'ACCEPTED', declined: 'DECLINED', tentativelyAccepted: 'TENTATIVE', organizer: 'ACCEPTED' }
const WEEKDAY: Record<string, string> = { MO: 'monday', TU: 'tuesday', WE: 'wednesday', TH: 'thursday', FR: 'friday', SA: 'saturday', SU: 'sunday' }
const WEEK_ORDER = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const INDEX: Record<string, string> = { '1': 'first', '2': 'second', '3': 'third', '4': 'fourth', '-1': 'last' }

const ADR_LABEL = { businessAddress: 'work', homeAddress: 'home', otherAddress: 'other' } as const

function adrLine(a: GraphAddress, label: string): string {
  const v = [a.street, a.city, a.state, a.postalCode, a.countryOrRegion].map((x) => escapeText(x ?? '')).join(';')
  return foldLine(`ADR;TYPE=${label}:;;${v}`)
}

export function graphContactToVCard(c: GraphContact): string {
  const emails = (c.emailAddresses ?? []).flatMap((e) => (e.address ? [{ addr: e.address, label: null }] : []))
  const phones = [
    ...(c.businessPhones ?? []).map((value) => ({ value, label: 'work' })), ...(c.homePhones ?? []).map((value) => ({ value, label: 'home' })),
    ...(c.mobilePhone ? [{ value: c.mobilePhone, label: 'cell' }] : [])
  ]
  const fullName = c.displayName?.trim() || [c.givenName, c.surname].filter(Boolean).join(' ') || c.companyName || emails[0]?.addr || c.id
  const card = draftToCard({
    kind: 'individual', fullName, given: c.givenName ?? null, family: c.surname ?? null, org: c.companyName ?? null, emails, phones, addresses: [], note: c.personalNotes ?? null,
    birthday: c.birthday?.slice(0, 10) ?? null
  }, { uid: c.id, version: '3.0', now: 0 })
  const extra: string[] = []
  for (const [key, label] of Object.entries(ADR_LABEL)) {
    const a = c[key as keyof typeof ADR_LABEL]
    if (a && Object.values(a).some(Boolean)) extra.push(adrLine(a, label))
  }
  if (c.categories?.length) extra.push(foldLine(`CATEGORIES:${c.categories.map(escapeText).join(',')}`))
  return card.replace(/END:VCARD\r\n$/, `${extra.map((l) => `${l}\r\n`).join('')}END:VCARD\r\n`)
}

export function categoriesOf(raw: string): string[] {
  const m = /^CATEGORIES(?:;[^:]*)?:(.*)$/im.exec(raw.replace(/\r?\n[ \t]/g, ''))
  return m ? m[1].split(/(?<!\\),/).map((s) => s.trim().replace(/\\([,;\\])/g, '$1')).filter(Boolean) : []
}

function structuredAddresses(raw: string): Partial<Record<keyof typeof ADR_LABEL, GraphAddress>> {
  const out: Partial<Record<keyof typeof ADR_LABEL, GraphAddress>> = {}
  try {
    const card = new ICAL.Component(ICAL.parse(raw) as never)
    for (const p of card.getAllProperties('adr')) {
      const type = p.getParameter('type')
      const label = String(Array.isArray(type) ? type[0] : type ?? 'other').toLowerCase()
      const key = (Object.keys(ADR_LABEL) as (keyof typeof ADR_LABEL)[]).find((k) => ADR_LABEL[k] === label) ?? 'otherAddress'
      const v = (p.getFirstValue() as unknown as string[]).map((x) => (Array.isArray(x) ? x.join(', ') : String(x ?? '')))
      out[key] = { street: v[2] ?? '', city: v[3] ?? '', state: v[4] ?? '', postalCode: v[5] ?? '', countryOrRegion: v[6] ?? '' }
    }
  } catch {
    /* adressiz gönderilir */
  }
  return out
}

export function vcardToGraphContact(raw: string): GraphContactInput {
  const card = parseCard(raw)
  if (!card) throw new Error('pim: geçersiz kart')
  const d = card.detail
  const phones = (label: string): string[] => d.phones.filter((p) => (p.label ?? 'work') === label).map((p) => p.value)
  const birthday = d.birthday && /^\d{4}-\d{2}-\d{2}$/.test(d.birthday) ? `${d.birthday}T00:00:00Z` : null
  return {
    displayName: d.fullName, givenName: d.given, surname: d.family, companyName: d.org, personalNotes: d.note, birthday,
    emailAddresses: d.emails.slice(0, 3).map((e) => ({ name: d.fullName, address: e.addr })),
    businessPhones: phones('work').slice(0, 2), homePhones: phones('home').slice(0, 2), mobilePhone: phones('cell')[0] ?? null, ...structuredAddresses(raw), categories: categoriesOf(raw)
  }
}

const textLine = (name: string, value: string): string => foldLine(`${name}:${escapeText(value)}`)

function wallOf(iso: string): Wall {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso)
  if (!m) throw new Error('pim: geçersiz tarih')
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] }
}

function utcOfGraph(t: GraphTime): string {
  return compactUtc(wallToUtc(wallOf(t.dateTime), resolveTz(t.timeZone, new Map(), 'UTC'), 'UTC'))
}

const dateOf = (t: GraphTime): string => {
  const w = wallOf(t.dateTime)
  return compactDate({ year: w.y, month: w.mo, day: w.d })
}

const person = (p: GraphPerson, name: string, params = ''): string | null => {
  const addr = p.emailAddress?.address?.replace(/[\r\n]/g, '')
  if (!addr) return null
  const cn = p.emailAddress?.name?.replace(/["\r\n]/g, '')
  return foldLine(`${name}${cn ? `;CN="${cn}"` : ''}${params}:mailto:${addr}`)
}

export function graphEventToIcs(e: GraphEvent): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'BEGIN:VEVENT', textLine('UID', e.iCalUId || e.id), `DTSTAMP:${compactUtc(0)}`]
  if (e.isAllDay) lines.push(`DTSTART;VALUE=DATE:${dateOf(e.start)}`, `DTEND;VALUE=DATE:${dateOf(e.end)}`)
  else lines.push(`DTSTART:${utcOfGraph(e.start)}`, `DTEND:${utcOfGraph(e.end)}`)
  if (e.seriesMasterId) {
    lines.push(textLine(SERIES_PROP, e.seriesMasterId))
    const original = e.originalStart ? compactUtc(Date.parse(e.originalStart)) : null
    if (e.isAllDay) lines.push(`RECURRENCE-ID;VALUE=DATE:${dateOf(e.start)}`)
    else lines.push(`RECURRENCE-ID:${original ?? utcOfGraph(e.start)}`)
  }
  if (e.subject) lines.push(textLine('SUMMARY', e.subject))
  if (e.location?.displayName) lines.push(textLine('LOCATION', e.location.displayName))
  const body = e.body?.content ?? ''
  const description = (e.body?.contentType?.toLowerCase() === 'html' ? htmlToText(body) : body).trim()
  if (description) lines.push(textLine('DESCRIPTION', description))
  if (e.isCancelled) lines.push('STATUS:CANCELLED')
  const organizer = e.organizer && person(e.organizer, 'ORGANIZER')
  if (organizer) lines.push(organizer)
  for (const a of e.attendees ?? []) {
    const line = person(a, 'ATTENDEE', `;PARTSTAT=${PARTSTAT[a.status?.response ?? ''] ?? 'NEEDS-ACTION'}`)
    if (line) lines.push(line)
  }
  if (e.isReminderOn) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', textLine('DESCRIPTION', e.subject || 'Reminder'), `TRIGGER:-PT${Math.max(0, Math.floor(e.reminderMinutesBeforeStart ?? 0))}M`, 'END:VALARM')
  lines.push('END:VEVENT', 'END:VCALENDAR', '')
  return lines.join('\r\n')
}

/** Oluşumun seri ana kaydı */
export function seriesMasterOf(ics: string): string | null {
  const m = new RegExp(`^${SERIES_PROP}:(.*)$`, 'im').exec(ics.replace(/\r?\n[ \t]/g, ''))
  return m ? m[1].trim() : null
}

export function rruleToGraphRecurrence(r: RecurrenceInput, start: string, tz: string): GraphRecurrence {
  const date = new Date(`${start}T00:00:00Z`)
  const days = (r.byDay?.length ? r.byDay : [WEEK_ORDER[date.getUTCDay()]]).map((d) => /([A-Z]{2})$/.exec(d)![1])
  const interval = r.interval
  const dayOfMonth = date.getUTCDate()
  let pattern: GraphRecurrence['pattern']
  if (r.freq === 'DAILY') pattern = { type: 'daily', interval }
  else if (r.freq === 'WEEKLY') pattern = { type: 'weekly', interval, daysOfWeek: days.map((d) => WEEKDAY[d]) }
  else {
    const ordinal = r.byDay?.[0] ? /^([+-]?\d)/.exec(r.byDay[0])?.[1]?.replace('+', '') : undefined
    const relative = ordinal && INDEX[ordinal] ? { daysOfWeek: days.map((d) => WEEKDAY[d]), index: INDEX[ordinal] } : null
    if (r.freq === 'MONTHLY') pattern = relative ? { type: 'relativeMonthly', interval, ...relative } : { type: 'absoluteMonthly', interval, dayOfMonth }
    else pattern = relative ? { type: 'relativeYearly', interval, ...relative, month: date.getUTCMonth() + 1 } : { type: 'absoluteYearly', interval, dayOfMonth, month: date.getUTCMonth() + 1 }
  }
  const base = { startDate: start, recurrenceTimeZone: tz }
  const range: GraphRecurrence['range'] = r.count ? { type: 'numbered', ...base, numberOfOccurrences: r.count } : r.until ? { type: 'endDate', ...base, endDate: r.until.slice(0, 10) } : { type: 'noEnd', ...base }
  return { pattern, range }
}

const graphTime = (v: string, tz: string, allDay: boolean): GraphTime => ({ dateTime: allDay ? `${v.slice(0, 10)}T00:00:00` : `${v}:00`, timeZone: tz })

export function draftToGraphEvent(d: EventDraft): GraphEventInput {
  return {
    subject: d.title, location: { displayName: d.location ?? '' }, body: { contentType: 'text', content: d.description ?? '' }, isAllDay: d.allDay,
    start: graphTime(d.start, d.tz, d.allDay), end: graphTime(d.end, d.tz, d.allDay), isReminderOn: d.alarmMinutes != null, ...(d.alarmMinutes != null ? { reminderMinutesBeforeStart: Math.max(0, d.alarmMinutes) } : {}),
    ...(d.rrule ? { recurrence: rruleToGraphRecurrence(d.rrule, d.start.slice(0, 10), d.tz) } : {})
  }
}
