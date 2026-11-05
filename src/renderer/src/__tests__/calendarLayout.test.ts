import { describe, expect, it } from 'vitest'
import type { EventOccurrence } from '../../../shared/pim'
import { dayEnd, dayStart, firstDayOfWeek, isoDay, layoutDay, monthGrid, shiftDay, weekOf } from '../calendarLayout'

const occ = (key: string, start: number, end: number, extra: Partial<EventOccurrence> = {}): EventOccurrence => ({
  key, objectId: 1, collectionId: 1, uid: key, recurrenceId: null, title: key, location: null, start, end, allDay: false, startDate: null, endDate: null, tz: null, cancelled: false, recurring: false, canEdit: true, myPartstat: null, ...extra
})
const at = (h: number, m = 0): number => Date.UTC(2026, 5, 10, h, m)

describe('takvim yerleşimi', () => {
  it('overlap columns', () => {
    const blocks = layoutDay([occ('a', at(9), at(10)), occ('b', at(9, 30), at(11)), occ('c', at(10), at(10, 30)), occ('d', at(12), at(13))], '2026-06-10', 'UTC')
    const by = Object.fromEntries(blocks.map((b) => [b.key, b]))
    expect(by.a).toMatchObject({ topMin: 540, heightMin: 60, column: 0, columns: 2 })
    expect(by.b).toMatchObject({ column: 1, columns: 2 })
    expect(by.c).toMatchObject({ column: 0, columns: 2 })
    expect(by.d).toMatchObject({ column: 0, columns: 1 })
  })

  it('event spanning midnight splits', () => {
    const e = occ('g', Date.UTC(2026, 5, 10, 22), Date.UTC(2026, 5, 11, 2))
    expect(layoutDay([e], '2026-06-10', 'UTC')[0]).toMatchObject({ topMin: 1320, heightMin: 120, continuesBefore: false, continuesAfter: true })
    expect(layoutDay([e], '2026-06-11', 'UTC')[0]).toMatchObject({ topMin: 0, heightMin: 120, continuesBefore: true, continuesAfter: false })
    expect(layoutDay([e], '2026-06-12', 'UTC')).toEqual([])
  })

  it('tam gece yarısında biten sonraki güne taşmaz, tüm gün ızgaraya girmez', () => {
    const e = occ('g', Date.UTC(2026, 5, 10, 22), Date.UTC(2026, 5, 11, 0))
    expect(layoutDay([e], '2026-06-10', 'UTC')[0]).toMatchObject({ heightMin: 120, continuesAfter: false })
    expect(layoutDay([e], '2026-06-11', 'UTC')).toEqual([])
    expect(layoutDay([occ('t', at(0), at(0), { allDay: true, startDate: '2026-06-10', endDate: '2026-06-11' })], '2026-06-10', 'UTC')).toEqual([])
  })

  it('DST day block position', () => {
    // 2026-03-29 02:00'da saat 03:00 olur: 03:30 yerel, 01:30Z
    const after = occ('a', Date.UTC(2026, 2, 29, 1, 30), Date.UTC(2026, 2, 29, 2, 30))
    expect(layoutDay([after], '2026-03-29', 'Europe/Berlin')[0]).toMatchObject({ topMin: 210, heightMin: 60 })
    const across = occ('b', Date.UTC(2026, 2, 29, 0, 30), Date.UTC(2026, 2, 29, 1, 30))
    expect(layoutDay([across], '2026-03-29', 'Europe/Berlin')[0]).toMatchObject({ topMin: 90, heightMin: 120 })
  })

  it('küçük blok tıklanabilir yükseklikte', () => {
    expect(layoutDay([occ('k', at(9), at(9, 1))], '2026-06-10', 'UTC')[0].heightMin).toBeGreaterThanOrEqual(15)
  })

  it('monthGrid Pazartesi başlangıç 6 satır', () => {
    const g = monthGrid(2026, 3, 1)
    expect(g).toHaveLength(6)
    expect(g.every((w) => w.length === 7)).toBe(true)
    expect(g[0][0]).toBe('2026-02-23')
    expect(g[5][6]).toBe('2026-04-05')
    expect(monthGrid(2026, 3, 0)[0][0]).toBe('2026-03-01')
  })

  it("firstDayOfWeek('en-US')=0", () => {
    expect(firstDayOfWeek('en-US')).toBe(0)
    expect(firstDayOfWeek('tr-TR')).toBe(1)
    expect(firstDayOfWeek('bozuk_dil!')).toBe(1)
  })

  it('gün sınırları DST gününde 23 saat', () => {
    expect(dayEnd('2026-03-29', 'Europe/Berlin') - dayStart('2026-03-29', 'Europe/Berlin')).toBe(23 * 3600_000)
    expect(dayStart('2026-01-15', 'Europe/Istanbul')).toBe(Date.UTC(2026, 0, 14, 21))
    expect(isoDay(Date.UTC(2026, 0, 14, 21), 'Europe/Istanbul')).toBe('2026-01-15')
    expect(shiftDay('2026-02-28', 1)).toBe('2026-03-01')
    expect(weekOf('2026-06-10', 1)[0]).toBe('2026-06-08')
    expect(weekOf('2026-06-10', 0)[0]).toBe('2026-06-07')
  })
})
