// iCalendar ayrıştırma ve üretme. Ham nesne saklanır, yalnız bilinen alanlar değişir: bilinmeyen özellikler ve ATTENDEE'ler
// sunucuya geri yazılırken kaybolmaz. Hiçbir işlev bozuk girdide fırlatmaz ya da ayrıştırıcı hatasını dışarı sızdırmaz.
import { createHash, randomUUID } from 'crypto'
import ICAL from 'ical.js'
import type { EditScope, EventDraft, RecurrenceInput } from '../../shared/pim'
import { syncLog } from '../log'
import { addDays, compactDate, compactUtc, compactWall, expandObject, isInfinite, isoDate, isRecurring, ridOf, ruleIsSafe, spanOf, timeWall, zoneOf } from './recur'
import { isValidTz, tzOffsetAt, tzTransitions, utcOf, utcToWall, wallToUtc, type ResolvedTz, type Wall } from './tz'

export interface ParsedEvent {
  uid: string
  sequence: number
  recurrenceId: string | null
  component: unknown
  summary: string
  location: string | null
  description: string | null
  organizer: { addr: string; name: string | null } | null
  attendees: { addr: string; name: string | null; partstat: string; rsvp: boolean }[]
  status: string | null
  alarmsMinutes: number[]
}

export interface ParsedCalendar {
  method: string | null
  events: ParsedEvent[]
  vtimezones: Map<string, unknown>
  uid: string
}

const MAX_OBJECT_BYTES = 1_000_000
const MAX_ITERATIONS = 100_000
const PRODID = '-//GeckoMail//Calendar//EN'
const BEYOND = 8.64e15

let rangeWarned = false

const mailAddr = (v: unknown): string => String(v ?? '').replace(/^mailto:/i, '').trim().toLowerCase()
const paramStr = (p: ICAL.Property, name: string): string | null => {
  const v = p.getParameter(name)
  return typeof v === 'string' ? v : null
}
const textProp = (c: ICAL.Component, name: string): string | null => {
  const v = c.getFirstPropertyValue(name)
  return v == null || v === '' ? null : String(v)
}

const MAX_ZONE_RDATES = 500
/** Gerçek dilim gövdesi birkaç KB: akış bölünürken her nesneye kopyalanır */
const MAX_ZONE_CHARS = 64_000

/** Gömülü dilim tanımı açılırken RRULE koşar: yalnız YEARLY/MONTHLY ve sınırlı RDATE. Değilse TZID bilinmeyen sayılır. */
function zoneIsSafe(vtz: ICAL.Component): boolean {
  if (JSON.stringify(vtz.toJSON()).length > MAX_ZONE_CHARS) return false
  let rdates = 0
  for (const part of vtz.getAllSubcomponents()) {
    for (const p of part.getAllProperties('rrule')) {
      const rule = p.getFirstValue() as ICAL.Recur
      if ((rule.freq !== 'YEARLY' && rule.freq !== 'MONTHLY') || !ruleIsSafe(rule)) return false
    }
    for (const p of part.getAllProperties('rdate')) rdates += p.getValues().length
  }
  return rdates <= MAX_ZONE_RDATES
}

/** ical.js her tarihi ağaçtaki VTIMEZONE'a bağlar, `zonesOf` süzgecini tanımaz: güvensiz dilim daha ayrıştırmada ağaçtan çıkar. Değerleri çözülemeyen dilim de güvensizdir. */
function dropUnsafeZones(cal: ICAL.Component): void {
  for (const vtz of cal.getAllSubcomponents('vtimezone')) {
    let safe = false
    try {
      safe = zoneIsSafe(vtz)
    } catch {
      /* bozuk dilim */
    }
    if (!safe) cal.removeSubcomponent(vtz)
  }
}

export function roots(raw: string): ICAL.Component[] {
  const jcal = ICAL.parse(raw) as unknown[]
  const list = (typeof jcal[0] === 'string' ? [jcal] : jcal) as unknown[][]
  const out = list.map((j) => new ICAL.Component(j as never))
  out.forEach(dropUnsafeZones)
  return out
}

function zonesOf(cal: ICAL.Component): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const vtz of cal.getAllSubcomponents('vtimezone')) {
    const tzid = textProp(vtz, 'tzid')
    if (tzid) out.set(tzid, new ICAL.Timezone({ component: vtz, tzid }))
  }
  return out
}

/** Taslağın gösterip değiştirebildiği hatırlatma: başlangıca göre, süreyle */
function isDraftAlarm(alarm: ICAL.Component): boolean {
  const trigger = alarm.getFirstProperty('trigger')
  return (
    trigger?.getFirstValue() instanceof ICAL.Duration && String(trigger.getParameter('related') ?? '').toUpperCase() !== 'END' &&
    String(alarm.getFirstPropertyValue('action') ?? '').toUpperCase() !== 'NONE'
  )
}

function parseEvent(ev: ICAL.Component, zones: Map<string, unknown>): ParsedEvent {
  // geçersiz tarih değeri okununca fırlatır: bozuk nesne burada elenir
  if (!ev.getFirstPropertyValue('dtstart')) throw new Error('dtstart')
  for (const name of ['dtend', 'duration', 'exdate', 'rdate', 'recurrence-id']) for (const p of ev.getAllProperties(name)) p.getValues()
  const ridProp = ev.getFirstProperty('recurrence-id')
  let recurrenceId: string | null = null
  if (ridProp) {
    const time = ridProp.getFirstValue() as ICAL.Time
    recurrenceId = ridOf(time, zoneOf(ridProp, time, zones, 'UTC'), 'UTC')
    if (ridProp.getParameter('range') && !rangeWarned) {
      rangeWarned = true
      syncLog.warn('pim: RANGE=THISANDFUTURE yalnız o örneğe uygulandı')
    }
  }
  const orgProp = ev.getFirstProperty('organizer')
  const alarmsMinutes: number[] = []
  for (const alarm of ev.getAllSubcomponents('valarm')) {
    const trigger = alarm.getFirstProperty('trigger')
    const value = trigger?.getFirstValue()
    if (isDraftAlarm(alarm)) alarmsMinutes.push(Math.round(-(value as ICAL.Duration).toSeconds() / 60) + 0)
  }
  return {
    uid: textProp(ev, 'uid') ?? '', sequence: Number(ev.getFirstPropertyValue('sequence') ?? 0) || 0, recurrenceId, component: ev,
    summary: textProp(ev, 'summary') ?? '', location: textProp(ev, 'location'), description: textProp(ev, 'description'),
    organizer: orgProp ? { addr: mailAddr(orgProp.getFirstValue()), name: paramStr(orgProp, 'cn') } : null,
    attendees: ev.getAllProperties('attendee').map((p) => ({
      addr: mailAddr(p.getFirstValue()), name: paramStr(p, 'cn'), partstat: (paramStr(p, 'partstat') ?? 'NEEDS-ACTION').toUpperCase(),
      rsvp: (paramStr(p, 'rsvp') ?? '').toUpperCase() === 'TRUE'
    })),
    status: textProp(ev, 'status')?.toUpperCase() ?? null, alarmsMinutes
  }
}

export function parseCalendar(raw: string): ParsedCalendar | null {
  try {
    if (!raw || Buffer.byteLength(raw) > MAX_OBJECT_BYTES) return null
    const cal = roots(raw)[0]
    if (cal?.name !== 'vcalendar') return null
    const vevents = cal.getAllSubcomponents('vevent')
    if (!vevents.length) return null
    const vtimezones = zonesOf(cal)
    const events = vevents.map((e) => parseEvent(e, vtimezones))
    return { method: textProp(cal, 'method')?.toUpperCase() ?? null, events, vtimezones, uid: events[0].uid }
  } catch {
    return null
  }
}

export const text = (c: ICAL.Component): string => `${c.toString()}\r\n`

function shell(prodid: string | null): ICAL.Component {
  const cal = new ICAL.Component(['vcalendar', [], []])
  setLine(cal, 'version', 'VERSION:2.0')
  cal.updatePropertyWithValue('prodid', prodid ?? PRODID)
  return cal
}

export function splitIcsFeed(raw: string): string[] {
  const r = splitIcsObjects(raw)
  return r === 'tooLarge' ? [] : r.map((o) => o.data)
}

const MAX_SPLIT_OBJECTS = 20_000
/** Küçük akış dilimi nesne başına kopyalayarak süreci bitiremesin; 5 MB gerçek akış bunun çok altında kalır */
const MAX_SPLIT_CHARS = 32_000_000

/** Akışı UID başına bir takvim nesnesine böler. Sınır aşılırsa kısmi sonuç yok: eksik liste eski etkinlikleri sildirirdi. */
export function splitIcsObjects(raw: string): { uid: string; data: string }[] | 'tooLarge' {
  try {
    const groups = new Map<string, ICAL.Component[]>()
    const zones = new Map<string, ICAL.Component>()
    let prodid: string | null = null
    for (const cal of roots(raw)) {
      if (cal.name !== 'vcalendar') continue
      prodid ??= textProp(cal, 'prodid')
      for (const z of cal.getAllSubcomponents('vtimezone')) {
        const id = textProp(z, 'tzid')
        if (id) zones.set(id, z)
      }
      for (const ev of cal.getAllSubcomponents('vevent')) {
        let uid = textProp(ev, 'uid')
        if (!uid) {
          uid = `gecko-${createHash('sha1').update(ev.toString()).digest('hex')}`
          ev.updatePropertyWithValue('uid', uid)
        }
        const group = groups.get(uid)
        if (group) group.push(ev)
        else {
          if (groups.size >= MAX_SPLIT_OBJECTS) return 'tooLarge'
          groups.set(uid, [ev])
        }
      }
    }
    const [head, tail] = text(shell(prodid)).split(/(?=END:VCALENDAR)/)
    const zoneText = new Map<string, string>()
    const zoneOfId = (id: string): string => {
      let v = zoneText.get(id)
      if (v === undefined) zoneText.set(id, (v = zones.has(id) ? `${zones.get(id)!.toString()}\r\n` : ''))
      return v
    }
    const out: { uid: string; data: string }[] = []
    let total = 0
    for (const [uid, events] of groups) {
      try {
        const used = new Set(events.flatMap((e) => e.getAllProperties().map((p) => paramStr(p, 'tzid')).filter((t): t is string => !!t)))
        const body = events.map((e) => `${e.toString()}\r\n`).join('')
        const zonesPart = [...used].map(zoneOfId).join('')
        total += head.length + zonesPart.length + body.length + tail.length
        if (total > MAX_SPLIT_CHARS) return 'tooLarge'
        out.push({ uid, data: head + zonesPart + body + tail })
      } catch {
        /* tek bozuk nesne akışı durdurmaz */
      }
    }
    return out
  } catch {
    return []
  }
}

export const cloneOf = (c: ICAL.Component): ICAL.Component => new ICAL.Component(JSON.parse(JSON.stringify(c.toJSON())))

export function indexFields(raw: string, viewerTz: string): { uid: string; rangeStart: number; rangeEnd: number | null; recurring: boolean; sequence: number; organizer: string | null } | null {
  const c = parseCalendar(raw)
  if (!c) return null
  try {
    const comps = c.events.map((e) => e.component as ICAL.Component)
    const master = c.events.find((e) => !e.recurrenceId)
    const masterComp = master?.component as ICAL.Component | undefined
    const recurring = !!masterComp && isRecurring(masterComp)
    const rangeStart = Math.min(...comps.map((comp) => {
      const s = spanOf(comp, c.vtimezones, viewerTz)
      const w = timeWall(s.start)
      return wallToUtc(s.allDay ? { ...w, h: 0, mi: 0, s: 0 } : w, s.allDay ? { kind: 'floating' } : s.tz, viewerTz)
    }))
    let rangeEnd: number | null = null
    if (!masterComp || !isInfinite(masterComp)) {
      const occ = expandObject(c, rangeStart - 1, BEYOND, viewerTz)
      // sınıra takılan seri sonsuz sayılır: aralık dizini etkinliği hiç kaçırmasın
      rangeEnd = occ.length >= MAX_ITERATIONS ? null : Math.max(rangeStart, ...occ.map((o) => o.end))
    }
    return { uid: c.uid, rangeStart, rangeEnd, recurring, sequence: Math.max(...c.events.map((e) => e.sequence)), organizer: (master ?? c.events[0]).organizer?.addr ?? null }
  } catch {
    return null
  }
}

function setLine(c: ICAL.Component, name: string, line: string | null): void {
  c.removeAllProperties(name)
  if (line) c.addProperty(ICAL.Property.fromString(line))
}

function setText(c: ICAL.Component, name: string, value: string | null): void {
  if (value) c.updatePropertyWithValue(name, value)
  else c.removeAllProperties(name)
}

function stamp(ev: ICAL.Component, now: number): void {
  const at = compactUtc(now)
  setLine(ev, 'dtstamp', `DTSTAMP:${at}`)
  setLine(ev, 'last-modified', `LAST-MODIFIED:${at}`)
}

const bumpSequence = (ev: ICAL.Component, to: number): void => setLine(ev, 'sequence', `SEQUENCE:${to}`)

function parseDraftWall(v: string): Wall {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(v)
  if (!m) throw new Error('pim: geçersiz tarih')
  const w: Wall = { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: 0 }
  // 31 Şubat gibi değerler Date'te sessizce kayar
  const back = new Date(utcOf(w.y, w.mo, w.d, w.h, w.mi))
  if (back.getUTCMonth() + 1 !== w.mo || back.getUTCDate() !== w.d || back.getUTCHours() !== w.h || back.getUTCMinutes() !== w.mi) throw new Error('pim: geçersiz tarih')
  return w
}

function draftTz(tz: string): ResolvedTz {
  if (!isValidTz(tz)) throw new Error('pim: geçersiz saat dilimi')
  return tz === 'UTC' ? { kind: 'utc' } : { kind: 'iana', name: tz }
}

function dateLine(name: string, value: string, allDay: boolean, tz: string): string {
  const w = parseDraftWall(value)
  if (allDay) return `${name};VALUE=DATE:${compactDate({ year: w.y, month: w.mo, day: w.d })}`
  return draftTz(tz).kind === 'utc' ? `${name}:${compactWall(w)}Z` : `${name};TZID=${tz}:${compactWall(w)}`
}

function ruleText(d: EventDraft): string | null {
  if (d.rruleRaw) return ICAL.Recur.fromString(d.rruleRaw).toString()
  const r = d.rrule
  if (!r) return null
  const parts = [`FREQ=${r.freq}`]
  if (r.interval > 1) parts.push(`INTERVAL=${Math.floor(r.interval)}`)
  if (r.byDay?.length) parts.push(`BYDAY=${r.byDay.join(',')}`)
  if (r.count) parts.push(`COUNT=${Math.floor(r.count)}`)
  else if (r.until) {
    const w = parseDraftWall(r.until)
    // seçilen gün dahil
    parts.push(`UNTIL=${d.allDay ? compactDate({ year: w.y, month: w.mo, day: w.d }) : compactUtc(wallToUtc({ ...w, h: 23, mi: 59, s: 59 }, draftTz(d.tz), d.tz))}`)
  }
  return ICAL.Recur.fromString(parts.join(';')).toString()
}

function applyDraft(ev: ICAL.Component, d: EventDraft): void {
  setText(ev, 'summary', d.title)
  setText(ev, 'location', d.location)
  setText(ev, 'description', d.description)
  setLine(ev, 'dtstart', dateLine('DTSTART', d.start, d.allDay, d.tz))
  setLine(ev, 'dtend', dateLine('DTEND', d.end, d.allDay, d.tz))
  ev.removeAllProperties('duration')
  applyAlarm(ev, d)
}

/** Taslak tek hatırlatma taşır: yalnız onu değiştirir, sunucudaki öteki VALARM'lar kalır */
function applyAlarm(ev: ICAL.Component, d: EventDraft): void {
  const first = ev.getAllSubcomponents('valarm').find(isDraftAlarm)
  if (d.alarmMinutes == null) {
    if (first) ev.removeSubcomponent(first)
    return
  }
  const trigger = `TRIGGER:${d.alarmMinutes > 0 ? '-' : ''}PT${Math.abs(Math.floor(d.alarmMinutes))}M`
  if (first) {
    if (Math.round(-(first.getFirstPropertyValue('trigger') as ICAL.Duration).toSeconds() / 60) !== d.alarmMinutes) setLine(first, 'trigger', trigger)
    return
  }
  const alarm = new ICAL.Component('valarm')
  setLine(alarm, 'action', 'ACTION:DISPLAY')
  setText(alarm, 'description', d.title || 'Reminder')
  alarm.addProperty(ICAL.Property.fromString(trigger))
  ev.addSubcomponent(alarm)
}

function applyRule(ev: ICAL.Component, d: EventDraft): void {
  const rule = ruleText(d)
  setLine(ev, 'rrule', rule ? `RRULE:${rule}` : null)
}

const ridLine = (name: string, rid: string): string => (/^\d{8}$/.test(rid) ? `${name};VALUE=DATE:${rid}` : `${name}:${rid}`)

export function eventsOf(cal: ICAL.Component): { master: ICAL.Component; list: { ev: ICAL.Component; rid: string | null }[] } {
  const zones = zonesOf(cal)
  const list = cal.getAllSubcomponents('vevent').map((ev) => {
    const prop = ev.getFirstProperty('recurrence-id')
    if (!prop) return { ev, rid: null }
    const time = prop.getFirstValue() as ICAL.Time
    return { ev, rid: ridOf(time, zoneOf(prop, time, zones, 'UTC'), 'UTC') }
  })
  return { master: (list.find((e) => !e.rid) ?? list[0]).ev, list }
}

const seqOf = (ev: ICAL.Component): number => Number(ev.getFirstPropertyValue('sequence') ?? 0) || 0

const seriesCount = (master: ICAL.Component): number | null => (master.getFirstPropertyValue('rrule') as ICAL.Recur | null)?.count ?? null

/** Kesimden önceki kural örnekleri; EXDATE sayılmaz, COUNT onları da sayar */
function occurrencesBefore(master: ICAL.Component, zones: Map<string, unknown>, rid: string): number {
  const rule = master.getFirstPropertyValue('rrule') as ICAL.Recur | null
  const prop = master.getFirstProperty('dtstart')
  if (!rule?.count || !prop || !ruleIsSafe(rule)) return 0
  const start = prop.getFirstValue() as ICAL.Time
  const tz = zoneOf(prop, start, zones, 'UTC')
  const it = rule.iterator(ICAL.Time.fromData({ year: start.year, month: start.month, day: start.day, hour: start.hour, minute: start.minute, second: start.second, isDate: start.isDate }))
  let n = 0
  for (let t = it.next(); t && n < rule.count; t = it.next()) {
    if (ridOf(t, tz, 'UTC') >= rid) break
    n++
  }
  return n
}

/** Kuyruk seri, kalan örnek kadar tekrar eder; kullanıcı sayıyı değiştirdiyse onunki geçerli */
function tailDraft(d: EventDraft, original: number | null, elapsed: number): EventDraft {
  if (!original || !elapsed) return d
  const left = Math.max(1, original - elapsed)
  if (d.rruleRaw) return { ...d, rruleRaw: d.rruleRaw.replace(new RegExp(`(^|;)COUNT=${original}(?=;|$)`), `$1COUNT=${left}`) }
  return d.rrule?.count === original ? { ...d, rrule: { ...d.rrule, count: left } } : d
}

export function draftToIcs(d: EventDraft, o: { uid?: string; base?: string; now: number; scope?: EditScope; recurrenceId?: string }): string {
  if (!o.base) {
    const cal = shell(null)
    const ev = new ICAL.Component('vevent')
    ev.updatePropertyWithValue('uid', o.uid ?? randomUUID())
    stamp(ev, o.now)
    setLine(ev, 'created', `CREATED:${compactUtc(o.now)}`)
    applyDraft(ev, d)
    applyRule(ev, d)
    cal.addSubcomponent(ev)
    return text(cal)
  }
  const cal = roots(o.base)[0]
  const { master, list } = eventsOf(cal)
  const scope = o.scope ?? 'all'
  if (scope === 'this') {
    if (!o.recurrenceId) throw new Error('pim: recurrenceId gerekli')
    let target = list.find((e) => e.rid === o.recurrenceId)?.ev
    if (!target) {
      target = cloneOf(master)
      for (const name of ['rrule', 'rdate', 'exdate']) target.removeAllProperties(name)
      setLine(target, 'recurrence-id', ridLine('RECURRENCE-ID', o.recurrenceId))
      cal.addSubcomponent(target)
    }
    applyDraft(target, d)
    bumpSequence(target, seqOf(master) + 1)
    stamp(target, o.now)
  } else if (scope === 'thisAndFuture') {
    for (const e of list) if (e.ev !== master) cal.removeSubcomponent(e.ev)
    for (const name of ['rdate', 'exdate', 'recurrence-id']) master.removeAllProperties(name)
    const elapsed = o.recurrenceId ? occurrencesBefore(master, zonesOf(cal), o.recurrenceId) : 0
    master.updatePropertyWithValue('uid', o.uid ?? randomUUID())
    applyDraft(master, d)
    applyRule(master, tailDraft(d, seriesCount(master), elapsed))
    bumpSequence(master, 0)
    stamp(master, o.now)
  } else {
    applyDraft(master, d)
    applyRule(master, d)
    bumpSequence(master, seqOf(master) + 1)
    stamp(master, o.now)
  }
  return text(cal)
}

const TZ_PROPS = ['dtstart', 'dtend', 'recurrence-id', 'exdate', 'rdate']
const TZ_BACK_MS = 366 * 864e5
const TZ_AHEAD_MS = 10 * 366 * 864e5

const offsetText = (ms: number): string => {
  const m = Math.abs(ms) / 60_000
  return `${ms < 0 ? '-' : '+'}${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`
}

/** Geçişler Intl'den, RDATE listesiyle: kural çıkarımı yok, yinelemeli etkinlik gömülü gövdeye güvenen istemcide de kaymaz */
function vtimezoneText(name: string, fromMs: number): string {
  const moves = tzTransitions(name, fromMs - TZ_BACK_MS, fromMs + TZ_AHEAD_MS)
  const body = (kind: string, from: number, to: number, ats: string[]): string[] => [
    // ical.js RDATE satırının yalnız ilk değerini okur ve RDATE varken DTSTART'ı saymaz: ilk değer dahil satır başına bir değer
    `BEGIN:${kind}`, `DTSTART:${ats[0]}`, ...ats.map((at) => `RDATE:${at}`),
    `TZOFFSETFROM:${offsetText(from)}`, `TZOFFSETTO:${offsetText(to)}`, `END:${kind}`
  ]
  const groups = new Map<string, { from: number; to: number; ats: string[] }>()
  for (const m of moves) {
    const k = `${m.from}:${m.to}`
    const g = groups.get(k) ?? { from: m.from, to: m.to, ats: [] }
    // yerel saat, geçişten önceki ofsetle (RFC 5545)
    g.ats.push(compactWall(utcToWall(m.at + m.from, { kind: 'utc' }, 'UTC')))
    groups.set(k, g)
  }
  const fixed = tzOffsetAt(fromMs, name)
  const lines = groups.size
    ? [...groups.values()].flatMap((g) => body(g.to > g.from ? 'DAYLIGHT' : 'STANDARD', g.from, g.to, g.ats))
    : body('STANDARD', fixed, fixed, ['19700101T000000'])
  return ['BEGIN:VTIMEZONE', `TZID:${name}`, ...lines, 'END:VTIMEZONE'].join('\r\n') + '\r\n'
}

/** RFC 5545 her TZID için VTIMEZONE ister; katı sunucu reddetmesin. UTC yazılmaz: yinelemeli etkinlik DST'de kayardı.
 *  Yalnız IANA adları eklenir; sunucudan gelen gömülü gövde ve tanınmayan ad olduğu gibi kalır. Bozuk girdi değişmeden döner. */
export function ensureVtimezones(raw: string): string {
  try {
    const cal = roots(raw)[0]
    const events = cal.getAllSubcomponents('vevent')
    const zones = zonesOf(cal)
    const have = new Set(cal.getAllSubcomponents('vtimezone').map((z) => String(z.getFirstPropertyValue('tzid'))))
    const need = new Set<string>()
    let earliest = Infinity
    for (const ev of events) {
      for (const name of TZ_PROPS) {
        for (const p of ev.getAllProperties(name)) {
          const tzid = paramStr(p, 'tzid')
          if (tzid && !have.has(tzid) && !tzid.startsWith('/') && isValidTz(tzid)) need.add(tzid)
        }
      }
      const prop = ev.getFirstProperty('dtstart')
      const start = prop?.getFirstValue() as ICAL.Time | undefined
      if (prop && start) earliest = Math.min(earliest, wallToUtc(timeWall(start), zoneOf(prop, start, zones, 'UTC'), 'UTC'))
    }
    if (!need.size || !Number.isFinite(earliest)) return raw
    for (const ev of events) cal.removeSubcomponent(ev)
    for (const name of need) cal.addSubcomponent(new ICAL.Component(ICAL.parse(vtimezoneText(name, earliest)) as unknown as unknown[]))
    for (const ev of events) cal.addSubcomponent(ev)
    return text(cal)
  } catch {
    return raw
  }
}

function untilBefore(rid: string): string {
  if (/^\d{8}$/.test(rid)) return compactDate(addDays({ year: +rid.slice(0, 4), month: +rid.slice(4, 6), day: +rid.slice(6, 8) }, -1))
  const ms = utcOf(+rid.slice(0, 4), +rid.slice(4, 6), +rid.slice(6, 8), +rid.slice(9, 11), +rid.slice(11, 13), +rid.slice(13, 15)) - 1000
  return rid.endsWith('Z') ? compactUtc(ms) : compactUtc(ms).slice(0, -1)
}

/** RDATE'lerin kesimden önceki değerleri kalır */
function cutRdates(master: ICAL.Component, zones: Map<string, unknown>, cut: string): void {
  for (const prop of master.getAllProperties('rdate')) {
    const kept = prop.getValues().filter((v) => {
      const time = (v instanceof ICAL.Period ? v.start : v) as ICAL.Time
      return ridOf(time, zoneOf(prop, time, zones, 'UTC'), 'UTC') < cut
    })
    if (!kept.length) master.removeProperty(prop)
    else prop.setValues(kept)
  }
}

/** `thisAndFuture` ilk örnekte verilirse hiç örnek kalmaz: null döner, çağıran nesneyi siler */
export function removeOccurrence(raw: string, recurrenceId: string, mode: 'this' | 'thisAndFuture', now: number): string | null {
  const cal = roots(raw)[0]
  const { master, list } = eventsOf(cal)
  const zones = zonesOf(cal)
  if (mode === 'thisAndFuture') {
    const prop = master.getFirstProperty('dtstart') as ICAL.Property
    const start = prop.getFirstValue() as ICAL.Time
    if (ridOf(start, zoneOf(prop, start, zones, 'UTC'), 'UTC') >= recurrenceId) return null
    cutRdates(master, zones, recurrenceId)
  }
  if (mode === 'this') {
    for (const e of list) if (e.rid === recurrenceId) cal.removeSubcomponent(e.ev)
    master.addProperty(ICAL.Property.fromString(ridLine('EXDATE', recurrenceId)))
  } else {
    for (const e of list) if (e.rid && e.rid >= recurrenceId) cal.removeSubcomponent(e.ev)
    const rule = master.getFirstPropertyValue('rrule') as ICAL.Recur | null
    if (rule) {
      const kept = rule.toString().split(';').filter((p) => !/^(COUNT|UNTIL)=/.test(p))
      setLine(master, 'rrule', `RRULE:${[...kept, `UNTIL=${untilBefore(recurrenceId)}`].join(';')}`)
    }
  }
  bumpSequence(master, seqOf(master) + 1)
  stamp(master, now)
  return text(cal)
}

/** `recurrenceId` verilirse yalnız o oluşumun VEVENT'i değişir: tek oluşuma verilen yanıt seriyi etkilemez */
export function setPartstat(raw: string, addr: string, partstat: string, now: number, recurrenceId?: string | null): string {
  const cal = roots(raw)[0]
  const want = addr.trim().toLowerCase()
  let changed = false
  for (const { ev, rid } of eventsOf(cal).list) {
    if (recurrenceId && rid !== recurrenceId) continue
    let touched = false
    for (const p of ev.getAllProperties('attendee')) {
      if (mailAddr(p.getFirstValue()) !== want) continue
      p.setParameter('partstat', partstat)
      p.removeParameter('rsvp')
      touched = true
    }
    if (touched) stamp(ev, now)
    changed ||= touched
  }
  return changed ? text(cal) : raw
}

function ruleToInput(rule: ICAL.Recur, tz: ResolvedTz, viewerTz: string): RecurrenceInput | null {
  const str = rule.toString()
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq) || /WKST=/.test(str)) return null
  if (Object.keys(rule.parts ?? {}).some((k) => k !== 'BYDAY')) return null
  const byDay = rule.getComponent('byday').map(String)
  if (byDay.some((d) => !/^[A-Z]{2}$/.test(d))) return null
  const out: RecurrenceInput = { freq: rule.freq as RecurrenceInput['freq'], interval: rule.interval || 1 }
  if (byDay.length) out.byDay = byDay
  if (rule.count) out.count = rule.count
  if (rule.until) {
    const u = rule.until
    const w = u.isDate || u.zone?.tzid !== 'UTC' ? timeWall(u) : utcToWall(wallToUtc(timeWall(u), { kind: 'utc' }, viewerTz), tz, viewerTz)
    out.until = isoDate({ year: w.y, month: w.mo, day: w.d })
  }
  return out
}

const p2 = (n: number): string => String(n).padStart(2, '0')
const fmtWall = (w: Wall): string => `${isoDate({ year: w.y, month: w.mo, day: w.d })}T${p2(w.h)}:${p2(w.mi)}`

export function eventToDraft(raw: string, recurrenceId: string | null, viewerTz: string): EventDraft | null {
  const c = parseCalendar(raw)
  if (!c) return null
  try {
    const master = c.events.find((e) => !e.recurrenceId)
    const override = recurrenceId ? c.events.find((e) => e.recurrenceId === recurrenceId) : undefined
    const ev = override ?? master ?? c.events[0]
    const comp = ev.component as ICAL.Component
    const span = spanOf(comp, c.vtimezones, viewerTz)
    const base = {
      title: ev.summary, location: ev.location, description: ev.description, alarmMinutes: ev.alarmsMinutes[0] ?? null, rrule: null as RecurrenceInput | null
    }
    let rruleRaw: string | undefined
    const rule = !override && ev === master ? (comp.getFirstPropertyValue('rrule') as ICAL.Recur | null) : null
    const tzName = span.tz.kind === 'iana' ? span.tz.name : span.tz.kind === 'utc' ? 'UTC' : viewerTz
    const show: ResolvedTz = span.tz.kind === 'floating' || span.tz.kind === 'embedded' ? { kind: 'iana', name: viewerTz } : span.tz
    if (rule) {
      base.rrule = ruleToInput(rule, span.tz, viewerTz)
      if (!base.rrule) rruleRaw = rule.toString()
    }
    const useOcc = recurrenceId && !override
    if (span.allDay) {
      const day = useOcc && /^\d{8}/.test(recurrenceId) ? { year: +recurrenceId.slice(0, 4), month: +recurrenceId.slice(4, 6), day: +recurrenceId.slice(6, 8) } : span.start
      return { ...base, allDay: true, start: isoDate(day), end: isoDate(addDays(day, span.days)), tz: viewerTz, ...(rruleRaw ? { rruleRaw } : {}) }
    }
    let startMs = wallToUtc(timeWall(span.start), span.tz, viewerTz)
    if (useOcc) {
      const w: Wall = { y: +recurrenceId.slice(0, 4), mo: +recurrenceId.slice(4, 6), d: +recurrenceId.slice(6, 8), h: +recurrenceId.slice(9, 11), mi: +recurrenceId.slice(11, 13), s: +recurrenceId.slice(13, 15) }
      startMs = wallToUtc(w, recurrenceId.endsWith('Z') ? { kind: 'utc' } : { kind: 'floating' }, viewerTz)
    }
    return {
      ...base, allDay: false, start: fmtWall(utcToWall(startMs, show, viewerTz)), end: fmtWall(utcToWall(startMs + span.durationMs, show, viewerTz)), tz: tzName,
      ...(rruleRaw ? { rruleRaw } : {})
    }
  } catch {
    return null
  }
}
