import { describe, expect, it } from 'vitest'
import { detectAccountAnomaly } from '../anomaly'

const DAY = 86_400_000
const NOW = new Date(2026, 6, 8, 12, 0, 0).getTime()

function daysAgo(n: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => NOW - n * DAY - i * 1000)
}

describe('detectAccountAnomaly', () => {
  it('yetersiz geçmişte (yeni hesap) alarm vermez', () => {
    const dates = daysAgo(1, 10) // sadece 1 günlük geçmiş
    expect(detectAccountAnomaly(dates, NOW).isAnomaly).toBe(false)
  })

  it('normal cadence içinde alarm vermez', () => {
    const dates = [0, 1, 2, 3, 4, 5, 6].flatMap((d) => daysAgo(d, 2)) // her gün ~2 mail, bugün dahil
    const r = detectAccountAnomaly(dates, NOW)
    expect(r.isAnomaly).toBe(false)
  })

  it('taban çizgisine göre ani artış patlama sayılır', () => {
    const history = [1, 2, 3, 4, 5, 6].flatMap((d) => daysAgo(d, 2)) // taban ~2/gün
    const burst = daysAgo(0, 20) // son 24s'de 20 mail
    const r = detectAccountAnomaly([...history, ...burst], NOW)
    expect(r.isAnomaly).toBe(true)
    expect(r.kind).toBe('burst')
  })

  it('taban çizgisine göre sessizlik alarm sayılır', () => {
    const history = [1, 2, 3, 4, 5, 6].flatMap((d) => daysAgo(d, 5)) // taban ~5/gün, son 24s boş
    const r = detectAccountAnomaly(history, NOW)
    expect(r.isAnomaly).toBe(true)
    expect(r.kind).toBe('silence')
  })

  it('taban sıfırsa yalnızca gerçek patlama (≥3) alarm sayılır', () => {
    // yeterli geçmiş için 1 eski kayıt (6 gün önce) + son 24s'deki yeni mailler; ara günler boş (taban=0)
    const r1 = detectAccountAnomaly([NOW - 6 * DAY, ...daysAgo(0, 2)], NOW)
    expect(r1.isAnomaly).toBe(false)
    const r2 = detectAccountAnomaly([NOW - 6 * DAY, ...daysAgo(0, 3)], NOW)
    expect(r2.isAnomaly).toBe(true)
    expect(r2.kind).toBe('burst')
  })
})
