import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLongPress, LONG_PRESS_MS, longPressAllowed } from '../layout/useLongPress'

describe('uzun basma (dokunmatik bağlam menüsü)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('500 ms basılı tutunca dokunulan noktada tetiklenir; ardından gelen tıklama yutulur', () => {
    const cb = vi.fn()
    const lp = createLongPress(cb)
    lp.start(40, 60, 1)
    vi.advanceTimersByTime(LONG_PRESS_MS - 1)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(cb).toHaveBeenCalledWith(40, 60)
    expect(lp.end()).toBe(true)
  })

  it('kısa dokunuş tetiklemez, tıklama yutulmaz', () => {
    const cb = vi.fn()
    const lp = createLongPress(cb)
    lp.start(40, 60, 1)
    vi.advanceTimersByTime(200)
    expect(lp.end()).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(cb).not.toHaveBeenCalled()
  })

  it('kaydırma (10 px üstü hareket) iptal eder', () => {
    const cb = vi.fn()
    const lp = createLongPress(cb)
    lp.start(40, 60, 1)
    lp.move(41, 64) // titreme payı içinde
    lp.move(40, 85) // kaydırma
    vi.advanceTimersByTime(1000)
    expect(cb).not.toHaveBeenCalled()
    expect(lp.end()).toBe(false)
  })

  it('iki parmak (yakınlaştırma) tetiklemez', () => {
    const cb = vi.fn()
    const lp = createLongPress(cb)
    lp.start(40, 60, 2)
    vi.advanceTimersByTime(1000)
    expect(cb).not.toHaveBeenCalled()
  })

  it('yasak seçicideki hedefte (düğme, seçilebilir metin) başlamaz', () => {
    const target = (hit: boolean) => ({ closest: () => (hit ? {} : null) })
    expect(longPressAllowed(target(true), 'button, .view-subject')).toBe(false)
    expect(longPressAllowed(target(false), 'button, .view-subject')).toBe(true)
    expect(longPressAllowed(target(true), undefined)).toBe(true)
  })
})
