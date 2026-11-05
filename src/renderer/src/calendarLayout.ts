// Takvim yerleşimi: gün sınırları, blok konumu, ay ızgarası. Renderer ham iCalendar görmez, yalnız motorun açtığı örnekle çalışır.
// Izgara duvar saatindedir: yaz saati gününde blok, ekrandaki saat çizgisine göre konumlanır.
import type { EventOccurrence } from '../../shared/pim'

export interface DayBlock {
  key: string
  topMin: number
  heightMin: number
  column: number
  columns: number
  continuesBefore: boolean
  continuesAfter: boolean
}

const DAY_MIN = 1440
const MIN_BLOCK = 15
const p2 = (n: number): string => String(n).padStart(2, '0')

const formatters = new Map<string, Intl.DateTimeFormat>()

function wall(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formatters.set(tz, f)
  }
  const get = Object.fromEntries(f.formatToParts(ms).map((p) => [p.type, Number(p.value)]))
  return { y: get.year, mo: get.month, d: get.day, h: get.hour, mi: get.minute, s: get.second }
}

export const isoOf = (y: number, mo: number, d: number): string => {
  const t = new Date(Date.UTC(y, mo - 1, d))
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`
}

export function isoDay(ms: number, tz: string): string {
  const w = wall(ms, tz)
  return isoOf(w.y, w.mo, w.d)
}

export function shiftDay(day: string, n: number): string {
  const [y, mo, d] = day.split('-').map(Number)
  return isoOf(y, mo, d + n)
}

/** Duvar günün ilk anı */
export function dayStart(day: string, tz: string): number {
  const [y, mo, d] = day.split('-').map(Number)
  const g = Date.UTC(y, mo - 1, d)
  const offset = (ms: number): number => {
    const w = wall(ms, tz)
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000
  }
  const first = g - offset(g)
  const at = g - offset(first)
  // gece yarısı yaz saati geçişi olan dilimde gün 01:00'de başlar
  return isoDay(at, tz) === day ? at : first
}

export const dayEnd = (day: string, tz: string): number => dayStart(shiftDay(day, 1), tz)

const minutesOf = (ms: number, tz: string): number => {
  const w = wall(ms, tz)
  return w.h * 60 + w.mi
}

export function layoutDay(occ: EventOccurrence[], day: string, tz: string): DayBlock[] {
  const start = dayStart(day, tz)
  const end = dayEnd(day, tz)
  const items = occ
    .filter((o) => !o.allDay && o.start < end && (o.end > start || (o.end === o.start && o.start >= start)))
    .map((o) => {
      const before = o.start < start
      const after = o.end > end
      const top = before ? 0 : minutesOf(o.start, tz)
      const bottom = after || o.end === end ? DAY_MIN : minutesOf(o.end, tz)
      return { key: o.key, top, height: Math.max(MIN_BLOCK, bottom - top), before, after }
    })
    .sort((a, b) => a.top - b.top || b.height - a.height)
  const out: DayBlock[] = []
  let cluster: DayBlock[] = []
  let ends: number[] = []
  let clusterEnd = -1
  const close = (): void => {
    for (const b of cluster) b.columns = ends.length
    cluster = []
    ends = []
  }
  for (const it of items) {
    if (it.top >= clusterEnd) close()
    let column = ends.findIndex((e) => e <= it.top)
    if (column < 0) column = ends.length
    ends[column] = it.top + it.height
    clusterEnd = Math.max(clusterEnd, it.top + it.height)
    const block: DayBlock = { key: it.key, topMin: it.top, heightMin: it.height, column, columns: 1, continuesBefore: it.before, continuesAfter: it.after }
    cluster.push(block)
    out.push(block)
  }
  close()
  return out
}

/** 6 × 7 tarih; `firstDay` 0 = Pazar */
export function monthGrid(year: number, month: number, firstDay: number): string[][] {
  const weekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const first = isoOf(year, month, 1 - ((weekday - firstDay + 7) % 7))
  return Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => shiftDay(first, w * 7 + d)))
}

export function weekOf(day: string, firstDay: number): string[] {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
  const first = shiftDay(day, -((weekday - firstDay + 7) % 7))
  return Array.from({ length: 7 }, (_, d) => shiftDay(first, d))
}

export function firstDayOfWeek(locale: string): number {
  try {
    const l = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } }
    const info = l.getWeekInfo?.() ?? l.weekInfo
    return info ? info.firstDay % 7 : 1
  } catch {
    return 1
  }
}

/** Günün örnekleri: tüm gün tarih dizesiyle (dilim kaydırmaz), saatli olan güne değiyorsa */
export function eventsOnDay(events: EventOccurrence[], day: string, tz: string): EventOccurrence[] {
  const start = dayStart(day, tz)
  const end = dayEnd(day, tz)
  return events.filter((o) => (o.allDay ? o.startDate! <= day && day < o.endDate! : o.start < end && (o.end > start || o.start >= start)))
}
