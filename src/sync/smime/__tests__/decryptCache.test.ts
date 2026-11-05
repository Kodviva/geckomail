import { describe, expect, it, vi } from 'vitest'
import { DecryptedCache, type DecryptedBody } from '../decryptCache'

const body = (text: string, bytes = 0): DecryptedBody => ({
  textPlain: text, html: null, attachments: bytes ? [{ index: 0, filename: 'a', mime: 'x/y', contentId: null, content: Buffer.alloc(bytes, 1) }] : [],
  info: { sig: 'none', enc: 'decrypted', notes: [], signer: null, canSaveCert: false }, signers: []
})

describe('DecryptedCache', () => {
  it('anahtar kullanıcı + ileti', () => {
    const c = new DecryptedCache()
    c.set(1, 5, body('a'))
    expect(c.get(1, 5)?.textPlain).toBe('a')
    expect(c.get(2, 5)).toBeNull()
  })
  it('TTL dolunca düşer', () => {
    let now = 1000
    const c = new DecryptedCache({ ttlMs: 100, now: () => now })
    c.set(1, 5, body('a'))
    now = 1099
    expect(c.get(1, 5)).not.toBeNull()
    now = 1100
    expect(c.get(1, 5)).toBeNull()
  })
  it('kimse okumasa da süpürme düşürür ve zamanlayıcı süreci tutmaz', () => {
    vi.useFakeTimers()
    const unref = vi.fn()
    const real = globalThis.setInterval
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => Object.assign(real(fn, ms), { unref })) as unknown as typeof setInterval)
    try {
      let now = 1000
      const c = new DecryptedCache({ ttlMs: 100, now: () => now })
      const b = body('a', 10)
      c.set(1, 5, b)
      now = 1100
      vi.advanceTimersByTime(60_000)
      expect(spy.mock.calls[0][1]).toBe(60_000)
      expect(unref).toHaveBeenCalledOnce()
      expect(b.attachments[0].content[0]).toBe(0)
      c.stop()
    } finally {
      spy.mockRestore()
      vi.useRealTimers()
    }
  })
  it('bayt sınırında en eski atılır ve eki sıfırlanır', () => {
    const c = new DecryptedCache({ maxBytes: 1000 })
    const first = body('a', 600)
    c.set(1, 1, first)
    c.set(1, 2, body('b', 600))
    expect(c.get(1, 1)).toBeNull()
    expect(c.get(1, 2)).not.toBeNull()
    expect(first.attachments[0].content.every((b) => b === 0)).toBe(true)
  })
  it('sınırdan büyük kayıt saklanmaz', () => {
    const c = new DecryptedCache({ maxBytes: 100 })
    c.set(1, 1, body('a', 600))
    expect(c.get(1, 1)).toBeNull()
  })
  it('clearUser yalnız o kullanıcının', () => {
    const c = new DecryptedCache()
    c.set(1, 1, body('a'))
    c.set(2, 1, body('b'))
    c.clearUser(1)
    expect(c.get(1, 1)).toBeNull()
    expect(c.get(2, 1)).not.toBeNull()
    c.clear()
    expect(c.get(2, 1)).toBeNull()
  })
  it('temizlik sürerken başlayan çözüm sonucu kaydedilmez', () => {
    const c = new DecryptedCache()
    const stamp = c.stamp(1)
    c.clearUser(1)
    expect(c.setIfCurrent(1, 1, stamp, body('a'))).toBe(false)
    expect(c.get(1, 1)).toBeNull()
    const stamp2 = c.stamp(1)
    c.clear()
    expect(c.setIfCurrent(1, 1, stamp2, body('a'))).toBe(false)
    const stamp3 = c.stamp(1)
    expect(c.setIfCurrent(1, 1, stamp3, body('a'))).toBe(true)
  })
})
