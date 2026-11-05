import { describe, expect, it } from 'vitest'
import { buildHourlySeries } from '../volume'

const H = 3600_000

describe('buildHourlySeries', () => {
  it('eksik saatleri sıfırla doldurur', () => {
    const since = 10 * H
    const now = 13 * H
    const series = buildHourlySeries([{ hour: 11 * H, count: 5 }], since, now)
    expect(series.map((s) => s.count)).toEqual([0, 5, 0, 0])
    expect(series.map((s) => s.hour)).toEqual([10 * H, 11 * H, 12 * H, 13 * H])
  })

  it('saat sınırı hizalanmamış sınırlarda da doğru başlangıç/bitiş üretir', () => {
    const since = 10 * H + 1500
    const now = 11 * H + 999
    const series = buildHourlySeries([], since, now)
    expect(series).toEqual([
      { hour: 10 * H, count: 0 },
      { hour: 11 * H, count: 0 }
    ])
  })

  it('boş girdi için tek noktalık aralık üretir', () => {
    const series = buildHourlySeries([], 5 * H, 5 * H)
    expect(series).toEqual([{ hour: 5 * H, count: 0 }])
  })
})
