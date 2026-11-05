import { randomBytes } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcHub } from '../../sync/rpcHub'
import { sealWithKey } from '../keyfile'
import { createServerHost } from '../hosts/serverHost'

describe('createServerHost', () => {
  const key = randomBytes(32)
  const savedExit = process.exitCode
  afterEach(() => {
    process.exitCode = savedExit
    vi.restoreAllMocks()
  })

  it('notify hub.notifySessions çağırır, karar her zaman true', () => {
    const notifySessions = vi.fn()
    const host = createServerHost(key, () => ({ notifySessions }) as unknown as RpcHub)
    const n = { title: 'a', body: 'b' }
    host.notify(n)
    expect(notifySessions).toHaveBeenCalledTimes(1)
    expect(notifySessions.mock.calls[0][0]).toBe(n)
    expect(notifySessions.mock.calls[0][1]({ id: 1 })).toBe(true)
  })

  it('hub yokken notify atmaz', () => {
    expect(() => createServerHost(key, () => null).notify({ title: 'a', body: 'b' })).not.toThrow()
  })

  it('fatal exitCode=3 koyar', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    createServerHost(key, () => null).fatal('x')
    expect(process.exitCode).toBe(3)
  })

  it('öneksiz blob boş döner, bozuk blob yalnız kendini boşaltır', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = createServerHost(key, () => null)
    const [enc] = await host.encrypt(['parola'])
    const bad = Buffer.from(sealWithKey(key, Buffer.from('z')))
    bad[bad.length - 1] ^= 1
    const out = await host.decrypt([new Uint8Array(Buffer.from('v10xxxx')), enc, bad])
    expect(out.map((u) => Buffer.from(u).toString())).toEqual(['', 'parola', ''])
  })
})
