import { describe, expect, it } from 'vitest'
import { extractUnsubscribeUrl, isOneClickUnsubscribe } from '../unsubscribe'

describe('isOneClickUnsubscribe', () => {
  it('https URL + doğru Post header ile true döner', () => {
    expect(
      isOneClickUnsubscribe('<https://example.com/unsub?id=1>', 'List-Unsubscribe=One-Click')
    ).toBe(true)
  })

  it('yalnızca mailto: varsa false döner (tek-tık desteklenmez)', () => {
    expect(isOneClickUnsubscribe('<mailto:unsub@example.com>', 'List-Unsubscribe=One-Click')).toBe(false)
  })

  it('Post header eksikse false döner', () => {
    expect(isOneClickUnsubscribe('<https://example.com/unsub>', null)).toBe(false)
  })

  it('List-Unsubscribe hiç yoksa false döner', () => {
    expect(isOneClickUnsubscribe(null, 'List-Unsubscribe=One-Click')).toBe(false)
  })

  it('mailto ve https birlikte listelenmişse https tercih edilerek true döner', () => {
    expect(
      isOneClickUnsubscribe('<mailto:unsub@example.com>, <https://example.com/unsub>', 'List-Unsubscribe=One-Click')
    ).toBe(true)
  })
})

describe('extractUnsubscribeUrl', () => {
  it('açılı parantez içindeki https URL\'i çıkarır', () => {
    expect(extractUnsubscribeUrl('<https://example.com/unsub?id=42>')).toBe('https://example.com/unsub?id=42')
  })

  it('URL yoksa null döner', () => {
    expect(extractUnsubscribeUrl('<mailto:unsub@example.com>')).toBeNull()
    expect(extractUnsubscribeUrl(null)).toBeNull()
  })
})
