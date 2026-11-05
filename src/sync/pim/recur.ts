// Tekrar açılımı. Kural her zaman duvar saatinde koşar (yaz saati geçişinde saat kaymasın); karşılaştırmalar UTC anla,
// tüm günde tarih dizesiyle yapılır. Düşmanca takvim için tur sınırı var, FREQ=SECONDLY|MINUTELY yok sayılır.
import ICAL from 'ical.js'
import type { ParsedCalendar, ParsedEvent } from './ical'
import { resolveTz, utcOf, utcToWall, wallToUtc, type ResolvedTz, type Wall } from './tz'

export interface Occ {
  recurrenceId: string | null
  start: number
  end: number
  allDay: boolean
  startDate: string | null
  endDate: string | null
  tz: string | null
  event: ParsedEvent
}

const MAX_ITERATIONS = 100_000
const DAY_MS = 864e5
/** Duvar saati ile UTC arasındaki en büyük fark */
const TZ_SLACK_MS = 2 * DAY_MS
const ALARM_HORIZON_MS = 800 * DAY_MS
/** Bir etkinlik en çok 100 yıl: Date aralığını aşan süre sorguyu düşürmesin */
const MAX_SPAN_DAYS = 36_600

const p2 = (n: number): string => String(n).padStart(2, '0')
const p4 = (n: number): string => String(n).padStart(4, '0')

export const timeWall = (t: ICAL.Time): Wall => ({ y: t.year, mo: t.month, d: t.day, h: t.hour, mi: t.minute, s: t.second })
export const compactDate = (t: { year: number; month: number; day: number }): string => `${p4(t.year)}${p2(t.month)}${p2(t.day)}`
export const isoDate = (t: { year: number; month: number; day: number }): string => `${p4(t.year)}-${p2(t.month)}-${p2(t.day)}`
export const compactWall = (w: Wall): string => `${p4(w.y)}${p2(w.mo)}${p2(w.d)}T${p2(w.h)}${p2(w.mi)}${p2(w.s)}`
export const compactUtc = (ms: number): string => `${compactWall(utcToWall(ms, { kind: 'utc' }, 'UTC'))}Z`

export function addDays(t: { year: number; month: number; day: number }, n: number): { year: number; month: number; day: number } {
  const d = new Date(utcOf(t.year, t.month, t.day + n))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

export function zoneOf(prop: ICAL.Property, time: ICAL.Time, vtimezones: Map<string, unknown>, viewerTz: string): ResolvedTz {
  if (time.isDate) return { kind: 'floating' }
  if (time.zone?.tzid === 'UTC') return { kind: 'utc' }
  const tzid = prop.getParameter('tzid')
  return resolveTz(typeof tzid === 'string' ? tzid : null, vtimezones, viewerTz)
}

/** Örneğin kararlı kimliği: `YYYYMMDD`, floating duvar saati ya da UTC `...Z` */
export function ridOf(time: ICAL.Time, tz: ResolvedTz, viewerTz: string): string {
  if (time.isDate) return compactDate(time)
  if (tz.kind === 'floating') return compactWall(timeWall(time))
  return compactUtc(wallToUtc(timeWall(time), tz, viewerTz))
}

export interface EventSpan {
  start: ICAL.Time
  tz: ResolvedTz
  allDay: boolean
  /** Saatli etkinlikte süre */
  durationMs: number
  /** Tüm günde gün sayısı */
  days: number
}

export function spanOf(comp: ICAL.Component, vtimezones: Map<string, unknown>, viewerTz: string): EventSpan {
  const prop = comp.getFirstProperty('dtstart') as ICAL.Property
  const start = prop.getFirstValue() as ICAL.Time
  const tz = zoneOf(prop, start, vtimezones, viewerTz)
  const allDay = start.isDate
  const endProp = comp.getFirstProperty('dtend')
  const duration = comp.getFirstPropertyValue('duration') as ICAL.Duration | null
  let durationMs = 0
  let days = 1
  if (endProp) {
    const end = endProp.getFirstValue() as ICAL.Time
    if (allDay) days = Math.max(1, Math.round((utcOf(end.year, end.month, end.day) - utcOf(start.year, start.month, start.day)) / DAY_MS))
    else durationMs = Math.max(0, wallToUtc(timeWall(end), zoneOf(endProp, end, vtimezones, viewerTz), viewerTz) - wallToUtc(timeWall(start), tz, viewerTz))
  } else if (duration) {
    if (allDay) days = Math.max(1, Math.round(duration.toSeconds() / 86400))
    else durationMs = Math.max(0, duration.toSeconds() * 1000)
  }
  return { start, tz, allDay, durationMs: Math.min(durationMs, MAX_SPAN_DAYS * DAY_MS), days: Math.min(days, MAX_SPAN_DAYS) }
}

const tzName = (tz: ResolvedTz): string | null => (tz.kind === 'iana' ? tz.name : tz.kind === 'utc' ? 'UTC' : null)

function buildOcc(event: ParsedEvent, span: EventSpan, wall: ICAL.Time | Wall, ms: number | null, recurrenceId: string | null, viewerTz: string): Occ {
  if (span.allDay) {
    const t = wall as ICAL.Time
    const end = addDays(t, span.days)
    const at = (d: { year: number; month: number; day: number }): number => wallToUtc({ y: d.year, mo: d.month, d: d.day, h: 0, mi: 0, s: 0 }, { kind: 'floating' }, viewerTz)
    return { recurrenceId, start: at(t), end: at(end), allDay: true, startDate: isoDate(t), endDate: isoDate(end), tz: null, event }
  }
  return { recurrenceId, start: ms!, end: ms! + span.durationMs, allDay: false, startDate: null, endDate: null, tz: tzName(span.tz), event }
}

export const INTERVAL_CAPS: Record<string, number> = { HOURLY: 8784, DAILY: 3660, WEEKLY: 520, MONTHLY: 120, YEARLY: 100 }
const BY_RANGES: Record<string, { min: number; max: number; noZero?: boolean }> = {
  BYSECOND: { min: 0, max: 60 }, BYMINUTE: { min: 0, max: 59 }, BYHOUR: { min: 0, max: 23 }, BYMONTH: { min: 1, max: 12 },
  BYMONTHDAY: { min: -31, max: 31, noZero: true }, BYYEARDAY: { min: -366, max: 366, noZero: true },
  BYWEEKNO: { min: -53, max: 53, noZero: true }, BYSETPOS: { min: -366, max: 366, noZero: true }
}
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** ical.js sağlanamayan kuralda tek `next()` içinde döner, tur sınırı ve try/catch işe yaramaz: yineleyiciye girmeden elenir.
 *  SECONDLY ve MINUTELY burada da reddedilir. Kalan olasılıkları alım kapısı (gate.ts) ayrı süreçte dener. */
export function ruleIsSafe(rule: ICAL.Recur): boolean {
  const cap = INTERVAL_CAPS[rule.freq]
  const interval = rule.interval ?? 1
  if (!cap || !Number.isInteger(interval) || interval < 1 || interval > cap) return false
  const parts = (rule.parts ?? {}) as Record<string, (number | string)[]>
  for (const [name, range] of Object.entries(BY_RANGES)) {
    const ok = (v: number | string): boolean => Number.isInteger(v) && (v as number) >= range.min && (v as number) <= range.max && !(range.noZero && v === 0)
    if (parts[name] && !parts[name].every(ok)) return false
  }
  const maxWeekday = rule.freq === 'MONTHLY' || parts.BYMONTH ? 5 : 53
  for (const d of parts.BYDAY ?? []) {
    const m = /^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(String(d))
    if (!m || (m[1] && (Number(m[1]) === 0 || Math.abs(Number(m[1])) > maxWeekday))) return false
  }
  const narrowed = !!(parts.BYMONTH || parts.BYMONTHDAY)
  if (narrowed && (parts.BYYEARDAY || parts.BYWEEKNO)) return false
  if (parts.BYMONTHDAY) {
    const months = (parts.BYMONTH as number[] | undefined) ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    if (!months.some((m) => (parts.BYMONTHDAY as number[]).some((d) => Math.abs(d) <= MONTH_DAYS[m - 1]))) return false
  }
  return true
}

function effectiveRule(comp: ICAL.Component): ICAL.Recur | null {
  const rule = comp.getFirstPropertyValue('rrule') as ICAL.Recur | null
  return rule && ruleIsSafe(rule) ? rule : null
}

export const isRecurring = (comp: ICAL.Component): boolean => !!effectiveRule(comp) || !!comp.getFirstProperty('rdate')
export const isInfinite = (comp: ICAL.Component): boolean => !!effectiveRule(comp)?.isFinite && !effectiveRule(comp)!.isFinite()

/** UNTIL duvar saatine çevrilir: yineleyici floating değerleri UTC gibi karşılaştırır. Yalın YEARLY açık ay ve günle koşar:
 *  ical.js 29 Şubat'ı artık olmayan yılda 1 Mart'a kaydırır, RFC 5545 geçersiz tarihi atlar. */
function wallRule(rule: ICAL.Recur, span: EventSpan, viewerTz: string): ICAL.Recur {
  const until = rule.until
  const plainYearly = rule.freq === 'YEARLY' && !Object.keys(rule.parts ?? {}).length
  if (!until && !plainYearly) return rule
  const r = rule.clone()
  if (plainYearly) {
    r.setComponent('BYMONTH', [span.start.month])
    r.setComponent('BYMONTHDAY', [span.start.day])
  }
  if (!until) return r
  if (span.allDay) r.until = ICAL.Time.fromData({ year: until.year, month: until.month, day: until.day, isDate: true })
  else if (until.isDate) r.until = ICAL.Time.fromData({ year: until.year, month: until.month, day: until.day, hour: 23, minute: 59, second: 59, isDate: false })
  else if (until.zone?.tzid === 'UTC') {
    const w = utcToWall(wallToUtc(timeWall(until), { kind: 'utc' }, viewerTz), span.tz, viewerTz)
    r.until = ICAL.Time.fromData({ year: w.y, month: w.mo, day: w.d, hour: w.h, minute: w.mi, second: w.s, isDate: false })
  }
  return r
}

const timesOf = (comp: ICAL.Component, name: string): { prop: ICAL.Property; time: ICAL.Time }[] =>
  comp.getAllProperties(name).flatMap((prop) =>
    prop.getValues().map((v) => ({ prop, time: (v instanceof ICAL.Period ? v.start : v) as ICAL.Time }))
  )

export function expandObject(c: ParsedCalendar, fromMs: number, toMs: number, viewerTz: string, o?: { maxIterations?: number }): Occ[] {
  const out: Occ[] = []
  const inWindow = (occ: Occ): boolean => occ.start < toMs && (occ.end > fromMs || occ.start >= fromMs)
  const add = (occ: Occ): void => {
    if (inWindow(occ)) out.push(occ)
  }
  const master = c.events.find((e) => !e.recurrenceId)
  const overrides = c.events.filter((e) => e.recurrenceId)
  const comp = (e: ParsedEvent): ICAL.Component => e.component as ICAL.Component

  const masterOccs = (m: ParsedEvent): void => {
    const span = spanOf(comp(m), c.vtimezones, viewerTz)
    const keyOf = (time: ICAL.Time, tz: ResolvedTz): string | number =>
      span.allDay ? compactDate(time) : wallToUtc(timeWall(time), tz, viewerTz)
    const skip = new Set<string | number>()
    for (const { prop, time } of timesOf(comp(m), 'exdate')) skip.add(keyOf(time, zoneOf(prop, time, c.vtimezones, viewerTz)))
    for (const e of overrides) {
      const prop = comp(e).getFirstProperty('recurrence-id') as ICAL.Property
      const time = prop.getFirstValue() as ICAL.Time
      skip.add(keyOf(time, zoneOf(prop, time, c.vtimezones, viewerTz)))
    }
    const startKey = keyOf(span.start, span.tz)
    const rule = effectiveRule(comp(m))
    const rdates = timesOf(comp(m), 'rdate')
    const recurring = !!rule || rdates.length > 0
    const emit = (t: ICAL.Time, ms: number | null, key: string | number): void => {
      if (skip.has(key)) return
      skip.add(key) // aynı an hem RRULE hem RDATE ile gelebilir
      const rid = recurring ? (span.allDay ? compactDate(t) : span.tz.kind === 'floating' ? compactWall(timeWall(t)) : compactUtc(ms!)) : null
      add(buildOcc(m, span, t.clone(), ms, rid, viewerTz))
    }
    if (rule) {
      const low = fromMs - span.durationMs - (span.days + 2) * DAY_MS
      const high = toMs + TZ_SLACK_MS
      const floatStart = ICAL.Time.fromData({ ...floatFields(span.start), isDate: span.allDay })
      let produced = 0
      try {
        const it = wallRule(rule, span, viewerTz).iterator(floatStart)
        const max = o?.maxIterations ?? MAX_ITERATIONS
        for (let n = 0; n < max; n++) {
          const t = it.next()
          if (!t) break
          produced++
          const wall = timeWall(t)
          const naive = utcOf(wall.y, wall.mo, wall.d, wall.h, wall.mi, wall.s)
          if (naive > high) break
          if (naive < low) continue
          if (span.allDay) emit(t, null, compactDate(t))
          else {
            const ms = wallToUtc(wall, span.tz, viewerTz)
            emit(t, ms, ms)
          }
        }
      } catch {
        // bozuk kural: yalnız ilk örnek
      }
      if (!produced) emit(span.start, span.allDay ? null : (startKey as number), startKey)
    } else {
      emit(span.start, span.allDay ? null : (startKey as number), startKey)
    }
    for (const { prop, time } of rdates) {
      const key = keyOf(time, zoneOf(prop, time, c.vtimezones, viewerTz))
      emit(time, span.allDay ? null : (key as number), key)
    }
  }

  // bozuk tek nesne takvim sorgusunu düşürmez: elde kalanlar döner
  try {
    if (master) masterOccs(master)
    for (const e of overrides) {
      const span = spanOf(comp(e), c.vtimezones, viewerTz)
      const prop = comp(e).getFirstProperty('recurrence-id') as ICAL.Property
      const time = prop.getFirstValue() as ICAL.Time
      const rid = ridOf(time, zoneOf(prop, time, c.vtimezones, viewerTz), viewerTz)
      add(buildOcc(e, span, span.start, span.allDay ? null : wallToUtc(timeWall(span.start), span.tz, viewerTz), rid, viewerTz))
    }
  } catch {
    /* yukarıda */
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Tek örnek: taşınmış override kendi saatinde bulunur. Bulunamazsa nesnenin ilk örneği. */
export function occurrenceOf(c: ParsedCalendar, recurrenceId: string | null, viewerTz: string): Occ | null {
  const ev = (recurrenceId ? c.events.find((e) => e.recurrenceId === recurrenceId) : undefined) ?? c.events.find((e) => !e.recurrenceId) ?? c.events[0]
  const span = spanOf(ev.component as ICAL.Component, c.vtimezones, viewerTz)
  const own = wallToUtc(timeWall(span.start), span.allDay ? { kind: 'floating' } : span.tz, viewerTz)
  const rid = recurrenceId ? /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(recurrenceId) : null
  const anchor = rid ? utcOf(+rid[1], +rid[2], +rid[3], +(rid[4] ?? 0), +(rid[5] ?? 0), +(rid[6] ?? 0)) : own
  const occs = expandObject(c, Math.min(own, anchor) - TZ_SLACK_MS, Math.max(own, anchor) + TZ_SLACK_MS + span.durationMs + span.days * DAY_MS, viewerTz)
  return occs.find((o) => o.recurrenceId === recurrenceId) ?? occs[0] ?? null
}

function floatFields(t: ICAL.Time): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  return { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second }
}

/** Hatırlatmanın anı: ayrıştırılmış tarihte `toUnixTime` çağrılmaz, ical.js ağaçtaki dilimi sınırsız açar */
function triggerAt(prop: ICAL.Property, c: ParsedCalendar, viewerTz: string, occ: { start: number; end: number } | null): number | null {
  const value = prop.getFirstValue()
  if (value instanceof ICAL.Time) return wallToUtc(timeWall(value), zoneOf(prop, value, c.vtimezones, viewerTz), viewerTz)
  if (value instanceof ICAL.Duration && occ) return (String(prop.getParameter('related') ?? '').toUpperCase() === 'END' ? occ.end : occ.start) + value.toSeconds() * 1000
  return null
}

/** Mutlak hatırlatmaların hepsi, ufuktan bağımsız: alım kapısı worker'da dener, ana iş parçacığı uzak bir oluşumda sürpriz görmez */
export function alarmMoments(c: ParsedCalendar, viewerTz: string): number[] {
  return c.events.flatMap((e) => (e.component as ICAL.Component).getAllSubcomponents('valarm')).flatMap((alarm) => {
    const prop = alarm.getFirstProperty('trigger')
    const at = prop && triggerAt(prop, c, viewerTz, null)
    return at == null ? [] : [at]
  })
}

/** Sonraki hatırlatma anı. Yalnız saatli ve saat dilimli etkinlikler: tüm gün ve floating hatırlatılmaz. Bilinmeyen TZID görenin dilimiyle çözülür. */
export function nextAlarmAt(c: ParsedCalendar, afterMs: number, viewerTz = 'UTC'): number | null {
  let best: number | null = null
  for (const occ of expandObject(c, afterMs - TZ_SLACK_MS, afterMs + ALARM_HORIZON_MS, viewerTz)) {
    const comp = occ.event.component as ICAL.Component
    if (occ.allDay || occ.event.status === 'CANCELLED') continue
    if (spanOf(comp, c.vtimezones, viewerTz).tz.kind === 'floating') continue
    for (const alarm of comp.getAllSubcomponents('valarm')) {
      const prop = alarm.getFirstProperty('trigger')
      if (!prop || String(alarm.getFirstPropertyValue('action') ?? '').toUpperCase() === 'NONE') continue
      const at = triggerAt(prop, c, viewerTz, occ)
      if (at !== null && at > afterMs && (best === null || at < best)) best = at
    }
  }
  return best
}
