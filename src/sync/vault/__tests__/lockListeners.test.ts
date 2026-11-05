import { randomBytes } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getVaultKey, onVaultLock, setVaultKey } from '../state'

describe('onVaultLock', () => {
  afterEach(() => setVaultKey(null))

  it('setVaultKey(null) dinleyiciyi çağırır; açılış çağırmaz', () => {
    const cb = vi.fn()
    const off = onVaultLock(cb)
    setVaultKey(randomBytes(32))
    expect(cb).not.toHaveBeenCalled()
    setVaultKey(null)
    expect(cb).toHaveBeenCalledTimes(1)
    off()
    setVaultKey(randomBytes(32))
    setVaultKey(null)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('dinleyici hatası kilidi durdurmaz, sonraki dinleyici de çalışır', () => {
    const offs = [onVaultLock(() => { throw new Error('dinleyici') })]
    const cb = vi.fn()
    offs.push(onVaultLock(cb))
    setVaultKey(randomBytes(32))
    expect(() => setVaultKey(null)).not.toThrow()
    expect(getVaultKey()).toBeNull()
    expect(cb).toHaveBeenCalledTimes(1)
    offs.forEach((o) => o())
  })
})
