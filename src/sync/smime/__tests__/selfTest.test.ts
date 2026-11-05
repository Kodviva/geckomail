import { describe, expect, it } from 'vitest'
import { ensurePkiEngine } from '../engine'
import { smimeSelfTest } from '../selfTest'

describe('smimeSelfTest', () => {
  it('bu çalışma zamanında geçer', async () => {
    await expect(smimeSelfTest()).resolves.toBeUndefined()
  })
  it('motor tekrar kurulabilir', () => {
    expect(() => {
      ensurePkiEngine()
      ensurePkiEngine()
    }).not.toThrow()
  })
})
