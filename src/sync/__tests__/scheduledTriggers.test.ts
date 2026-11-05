import { describe, expect, it } from 'vitest'
import { computeNextDailyRun } from '../scheduledTriggers'

describe('computeNextDailyRun', () => {
  it('bugün henüz geçmemişse bugünü döndürür', () => {
    const from = new Date(2026, 6, 7, 8, 0, 0).getTime() // 07 Tem 2026 08:00
    const next = computeNextDailyRun('09:00', from)
    const d = new Date(next)
    expect(d.getDate()).toBe(7)
    expect(d.getHours()).toBe(9)
  })

  it('bugün geçtiyse yarına atlar', () => {
    const from = new Date(2026, 6, 7, 10, 0, 0).getTime() // 09:00'ı geçti
    const next = computeNextDailyRun('09:00', from)
    const d = new Date(next)
    expect(d.getDate()).toBe(8)
    expect(d.getHours()).toBe(9)
  })

  it('tam eşit anda (<=) yarına atlar — aynı dakikada tekrar tetiklenmeyi önler', () => {
    const from = new Date(2026, 6, 7, 9, 0, 0, 0).getTime()
    const next = computeNextDailyRun('09:00', from)
    const d = new Date(next)
    expect(d.getDate()).toBe(8)
  })

  it('ay sonunda doğru şekilde bir sonraki aya taşar', () => {
    const from = new Date(2026, 6, 31, 10, 0, 0).getTime() // 31 Tem, 09:00 geçti
    const next = computeNextDailyRun('09:00', from)
    const d = new Date(next)
    expect(d.getMonth()).toBe(7) // Ağustos
    expect(d.getDate()).toBe(1)
  })
})
