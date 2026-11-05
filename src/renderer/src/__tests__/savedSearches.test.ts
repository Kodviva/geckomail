import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ kind: 'web' }))
vi.mock('../platform', () => ({ platform: { get kind() { return h.kind } } }))

class MemStorage {
  m = new Map<string, string>()
  getItem(k: string): string | null {
    return this.m.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v)
  }
  removeItem(k: string): void {
    this.m.delete(k)
  }
}

describe('kayıtlı aramalar', () => {
  let ls: MemStorage
  beforeEach(() => {
    ls = new MemStorage()
    vi.stubGlobal('localStorage', ls)
    h.kind = 'web'
  })
  afterEach(() => vi.unstubAllGlobals())

  const list = [{ name: 'a', query: 'b' }]

  it('web: kullanıcıya bağlı; başka kullanıcı görmez, kapsamsız eski değer silinir', async () => {
    const { dropUnscopedSavedSearches, initialSavedSearches, readSavedSearches, writeSavedSearches } = await import('../store/savedSearches')
    ls.setItem('gecko-saved-searches', JSON.stringify([{ name: 'eski', query: 'x' }]))
    expect(initialSavedSearches()).toEqual([])
    dropUnscopedSavedSearches()
    expect(ls.getItem('gecko-saved-searches')).toBeNull()
    writeSavedSearches(list, 7)
    expect(readSavedSearches(7)).toEqual(list)
    expect(readSavedSearches(8)).toEqual([])
    writeSavedSearches(list, undefined) // kullanıcı belli değil: yazılmaz
    expect([...ls.m.keys()]).toEqual(['gecko-saved-searches:7'])
    ls.setItem('gecko-saved-searches:9', '{bozuk')
    expect(readSavedSearches(9)).toEqual([])
  })

  it('masaüstü: tek anahtar, bugünkü gibi', async () => {
    h.kind = 'electron'
    const { initialSavedSearches, writeSavedSearches } = await import('../store/savedSearches')
    writeSavedSearches(list, undefined)
    expect(ls.getItem('gecko-saved-searches')).toBe(JSON.stringify(list))
    expect(initialSavedSearches()).toEqual(list)
  })
})
