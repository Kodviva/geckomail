import { describe, expect, it } from 'vitest'
import { isValidTz, resolveTz, utcOf, utcToWall, wallToUtc, type ResolvedTz, type Wall } from '../pim/tz'
import { parseCalendar } from '../pim/ical'
import { WINDOWS_ZONES } from '../pim/windowsZones'

const wall = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Wall => ({ y, mo, d, h, mi, s })
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000', '')
const iana = (name: string): ResolvedTz => ({ kind: 'iana', name })
const none = new Map<string, unknown>()

describe('resolveTz', () => {
  it('IANA adı olduğu gibi', () => expect(resolveTz('Europe/Berlin', none, 'UTC')).toEqual(iana('Europe/Berlin')))
  it('Windows adı', () => expect(resolveTz('Turkey Standard Time', none, 'UTC')).toEqual(iana('Europe/Istanbul')))
  it('yol biçimli TZID', () => {
    expect(resolveTz('/freeassociation.sourceforge.net/Tzfile/Europe/Istanbul', none, 'UTC')).toEqual(iana('Europe/Istanbul'))
    expect(resolveTz('/softwarestudio.org/Olson_20011030_5/America/Argentina/Buenos_Aires', none, 'UTC')).toEqual(iana('America/Argentina/Buenos_Aires'))
  })
  it('gömülü VTIMEZONE, tanınan addan sonra gelir', () => {
    const zone = {}
    expect(resolveTz('Bizim Dilim', new Map([['Bizim Dilim', zone]]), 'UTC')).toEqual({ kind: 'embedded', zone })
    expect(resolveTz('Europe/Berlin', new Map([['Europe/Berlin', zone]]), 'UTC')).toEqual(iana('Europe/Berlin'))
  })
  it('bilinmeyen ad izleyicinin dilimi olur', () => expect(resolveTz('Mars/Olympus', none, 'Asia/Tokyo')).toEqual(iana('Asia/Tokyo')))
  it('TZID yok: floating', () => expect(resolveTz(null, none, 'UTC')).toEqual({ kind: 'floating' }))
})

describe('isValidTz', () => {
  it('doğrular', () => {
    expect(isValidTz('Europe/Istanbul')).toBe(true)
    expect(isValidTz('Mars/Olympus')).toBe(false)
    expect(isValidTz('')).toBe(false)
  })
})

describe('wallToUtc', () => {
  it('gap', () => expect(iso(wallToUtc(wall(2026, 3, 8, 2, 30), iana('America/New_York'), 'UTC'))).toBe('2026-03-08T07:30:00Z'))
  it('overlap', () => expect(iso(wallToUtc(wall(2026, 11, 1, 1, 30), iana('America/New_York'), 'UTC'))).toBe('2026-11-01T05:30:00Z'))
  it('sıradan an', () => expect(iso(wallToUtc(wall(2026, 7, 1, 12), iana('Europe/Istanbul'), 'UTC'))).toBe('2026-07-01T09:00:00Z'))
  it('utc ve floating', () => {
    expect(iso(wallToUtc(wall(2026, 7, 1, 12), { kind: 'utc' }, 'Asia/Tokyo'))).toBe('2026-07-01T12:00:00Z')
    expect(iso(wallToUtc(wall(2026, 7, 1, 12), { kind: 'floating' }, 'Asia/Tokyo'))).toBe('2026-07-01T03:00:00Z')
  })
  it('gömülü dilim', () => {
    const c = parseCalendar(['BEGIN:VCALENDAR', 'BEGIN:VTIMEZONE', 'TZID:Bizim', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0530', 'TZOFFSETTO:+0530', 'END:STANDARD', 'END:VTIMEZONE',
      'BEGIN:VEVENT', 'UID:1', 'DTSTART;TZID=Bizim:20260115T100000', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'))!
    const tz = resolveTz('Bizim', c.vtimezones, 'UTC')
    expect(tz.kind).toBe('embedded')
    const ms = wallToUtc(wall(2026, 1, 15, 10), tz, 'UTC')
    expect(iso(ms)).toBe('2026-01-15T04:30:00Z')
    expect(utcToWall(ms, tz, 'UTC')).toEqual(wall(2026, 1, 15, 10))
  })
})

describe('utcToWall', () => {
  it('IANA, DST iki yanı', () => {
    expect(utcToWall(Date.UTC(2026, 2, 28, 12), iana('Europe/Berlin'), 'UTC')).toEqual(wall(2026, 3, 28, 13))
    expect(utcToWall(Date.UTC(2026, 2, 30, 12), iana('Europe/Berlin'), 'UTC')).toEqual(wall(2026, 3, 30, 14))
  })
  it('floating izleyici diliminde', () => expect(utcToWall(Date.UTC(2026, 0, 1), { kind: 'floating' }, 'Asia/Tokyo')).toEqual(wall(2026, 1, 1, 9)))
})

describe('windowsZones', () => {
  it('tablodaki her IANA adı geçerli', () => {
    const bad = Object.entries(WINDOWS_ZONES).filter(([, v]) => !isValidTz(v))
    expect(bad).toEqual([])
    expect(Object.keys(WINDOWS_ZONES).length).toBeGreaterThan(100)
  })
})

describe('gözden geçirme düzeltmeleri', () => {
  it('0-99 yılları 19xx sayılmaz', () => {
    expect(new Date(utcOf(50, 3, 1)).getUTCFullYear()).toBe(50)
    expect(utcOf(1970, 1, 1)).toBe(0)
    expect(new Date(wallToUtc({ y: 50, mo: 3, d: 1, h: 0, mi: 0, s: 0 }, { kind: 'utc' }, 'UTC')).getUTCFullYear()).toBe(50)
  })

  it('biçimleyici önbelleği sınırlı, geçerli dilim çalışmayı sürdürür', () => {
    for (let i = 0; i < 2000; i++) isValidTz(`Sahte/Dilim${i}`)
    expect(isValidTz('Europe/Berlin')).toBe(true)
  })
})
