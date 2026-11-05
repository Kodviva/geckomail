// Saat dilimi: TZID çözümü (IANA, Outlook'un Windows adları, yol biçimli adlar, gömülü VTIMEZONE) ve duvar saati ↔ UTC.
import ICAL from 'ical.js'
import { WINDOWS_ZONES } from './windowsZones'

export interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number }
export type ResolvedTz = { kind: 'iana'; name: string } | { kind: 'embedded'; zone: unknown } | { kind: 'floating' } | { kind: 'utc' }

const DAY_MS = 864e5
const MAX_FORMATTERS = 500
const formatters = new Map<string, Intl.DateTimeFormat | null>()

function formatter(name: string): Intl.DateTimeFormat | null {
  let f = formatters.get(name)
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: name, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
      })
    } catch {
      f = null
    }
    // ad dışarıdan gelir: düşmanca takvim önbelleği büyütemesin
    if (formatters.size >= MAX_FORMATTERS) formatters.clear()
    formatters.set(name, f)
  }
  return f
}

export function isValidTz(name: string): boolean {
  return !!name && formatter(name) !== null
}

function ianaWall(ms: number, name: string): Wall {
  const p: Record<string, number> = {}
  for (const part of formatter(name)!.formatToParts(ms)) if (part.type !== 'literal') p[part.type] = Number(part.value)
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second }
}

/** Date.UTC 0-99 yıllarını 19xx sayar */
export function utcOf(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  if (y >= 100) return Date.UTC(y, mo - 1, d, h, mi, s)
  const t = new Date(0)
  t.setUTCFullYear(y, mo - 1, d)
  t.setUTCHours(h, mi, s, 0)
  return t.getTime()
}

const wallMs = (w: Wall): number => utcOf(w.y, w.mo, w.d, w.h, w.mi, w.s)

/** Dilimin o andaki ofseti (ms) */
const offset = (ms: number, name: string): number => wallMs(ianaWall(ms, name)) - Math.floor(ms / 1000) * 1000

/** Dilimin aralıktaki ofset geçişleri (dakika hassasiyeti); günlük tarama iki geçişi aynı günde kaçırır, gerçek dilimlerde olmaz */
export function tzTransitions(name: string, fromMs: number, toMs: number): { at: number; from: number; to: number }[] {
  const out: { at: number; from: number; to: number }[] = []
  let prev = offset(fromMs, name)
  for (let t = fromMs + DAY_MS; t <= toMs; t += DAY_MS) {
    const cur = offset(t, name)
    if (cur === prev) continue
    let lo = t - DAY_MS
    let hi = t
    while (hi - lo > 1000) {
      const mid = lo + Math.floor((hi - lo) / 2)
      if (offset(mid, name) === prev) lo = mid
      else hi = mid
    }
    out.push({ at: Math.ceil(hi / 60_000) * 60_000, from: prev, to: cur })
    prev = cur
  }
  return out
}

export const tzOffsetAt = offset

const MAX_OFFSETS = 200_000
const offsets = new Map<string, number>()

/** Intl çözümlemesi pahalı: açılımda aynı anlar binlerce kez sorulur. Güncel dilimlerde geçişler dakika başındadır. */
function offsetCached(ms: number, name: string): number {
  const key = `${name}|${Math.floor(ms / 60_000)}`
  let v = offsets.get(key)
  if (v === undefined) {
    v = offset(ms, name)
    if (offsets.size >= MAX_OFFSETS) offsets.clear()
    offsets.set(key, v)
  }
  return v
}

function ianaToUtc(w: Wall, name: string): number {
  const g = wallMs(w)
  const o1 = offsetCached(g - DAY_MS, name)
  const o2 = offsetCached(g + DAY_MS, name)
  const valid = [g - o1, g - o2].filter((c, i) => offsetCached(c, name) === (i === 0 ? o1 : o2))
  // çakışmada ilk an; boşlukta öncesindeki ofset (RFC 5545)
  return valid.length ? Math.min(...valid) : g - o1
}

function ianaFromPath(tzid: string): string | null {
  if (!tzid.startsWith('/')) return null
  const parts = tzid.split('/').filter(Boolean)
  for (const n of [3, 2]) {
    const name = parts.slice(-n).join('/')
    if (parts.length >= n && isValidTz(name)) return name
  }
  return null
}

export function resolveTz(tzid: string | null, embedded: Map<string, unknown>, viewerTz: string): ResolvedTz {
  if (!tzid) return { kind: 'floating' }
  if (!tzid.startsWith('/') && isValidTz(tzid)) return { kind: 'iana', name: tzid }
  const win = WINDOWS_ZONES[tzid]
  if (win) return { kind: 'iana', name: win }
  const fromPath = ianaFromPath(tzid)
  if (fromPath) return { kind: 'iana', name: fromPath }
  if (embedded.has(tzid)) return { kind: 'embedded', zone: embedded.get(tzid) }
  return { kind: 'iana', name: viewerTz }
}

export function wallToUtc(w: Wall, tz: ResolvedTz, viewerTz: string): number {
  switch (tz.kind) {
    case 'utc': return wallMs(w)
    case 'floating': return ianaToUtc(w, viewerTz)
    case 'iana': return ianaToUtc(w, tz.name)
    case 'embedded': {
      const t = new ICAL.Time({ year: w.y, month: w.mo, day: w.d, hour: w.h, minute: w.mi, second: w.s, isDate: false }, tz.zone as ICAL.Timezone)
      return t.toUnixTime() * 1000
    }
  }
}

export function utcToWall(ms: number, tz: ResolvedTz, viewerTz: string): Wall {
  switch (tz.kind) {
    case 'utc': {
      const d = new Date(ms)
      return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }
    }
    case 'floating': return ianaWall(ms, viewerTz)
    case 'iana': return ianaWall(ms, tz.name)
    case 'embedded': {
      const t = ICAL.Time.fromJSDate(new Date(ms), true).convertToZone(tz.zone as ICAL.Timezone)
      return { y: t.year, mo: t.month, d: t.day, h: t.hour, mi: t.minute, s: t.second }
    }
  }
}
