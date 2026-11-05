import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComposerState, State } from '../store/types'

const h = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../rpcClient', () => ({ rpc: { call: h.call } }))
vi.mock('../platform', () => ({ platform: {}, UploadError: class {} }))
vi.mock('dompurify', () => ({ default: { sanitize: (s: string) => s } }))

const draft = (over: Partial<ComposerState> = {}): ComposerState => ({
  fromAccountId: 1, to: 'a@b.c', cc: '', bcc: '', subject: 's', text: 't', rich: false, html: '', attachments: [], ...over
})

describe('gönderim kimliği', () => {
  beforeEach(() => {
    h.call.mockReset()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  })

  const start = async (c: ComposerState) => {
    const { composeSlice } = await import('../store/compose')
    let state = { composer: c, accounts: [], toast: vi.fn() } as unknown as State
    const set = (p: Partial<State>): void => {
      state = { ...state, ...p }
    }
    const get = (): State => state
    const slice = composeSlice(set as never, get as never)
    set({ setComposer: slice.setComposer })
    return { slice, get }
  }
  const sentId = (n: number): string => (h.call.mock.calls[n][1] as { clientSendId: string }).clientSendId

  it('başarısız çağrının yeniden denemesi aynı kimlikle gider; yeni iletide yeni kimlik', async () => {
    const { slice, get } = await start(draft())
    h.call.mockRejectedValueOnce(new Error('zaman aşımı')).mockResolvedValue(null)
    await slice.send(undefined)
    expect(get().composer).not.toBeNull()
    await slice.send(undefined)
    expect(get().composer).toBeNull()
    const id = sentId(0)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(sentId(1)).toBe(id)
    const next = await start(draft())
    await next.slice.send(undefined)
    expect(sentId(2)).not.toBe(id)
  })

  it('ek boyutu çağrıda gider (yeniden denemede sunucu bilemez)', async () => {
    const { slice } = await start(draft({ attachments: [{ filename: 'a.pdf', mime: 'application/pdf', size: 7, uploadId: 'ab' }] }))
    h.call.mockResolvedValue(null)
    await slice.send(undefined)
    expect((h.call.mock.calls[0][1] as { draft: { attachments: unknown[] } }).draft.attachments).toEqual([
      { filename: 'a.pdf', mime: 'application/pdf', size: 7, uploadId: 'ab' }
    ])
  })

  it('kimlik taslakla geri gelirse korunur', async () => {
    const { slice } = await start(draft({ clientSendId: '3f2b8c1e-5d4a-4f6b-9a7e-1c2d3e4f5a6b' }))
    h.call.mockResolvedValue(null)
    await slice.send(undefined)
    expect(sentId(0)).toBe('3f2b8c1e-5d4a-4f6b-9a7e-1c2d3e4f5a6b')
  })

  it('randomUUID yoksa (güvensiz bağlam) da geçerli UUID', async () => {
    const { newSendId } = await import('../store/compose')
    const real = crypto.randomUUID
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
    try {
      expect(newSendId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: real, configurable: true })
    }
  })
})

describe('gönderim sürerken kilit ve sabit zaman', () => {
  beforeEach(() => {
    h.call.mockReset()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  })
  const start = async (c: ComposerState) => {
    const { composeSlice } = await import('../store/compose')
    let state = { composer: c, accounts: [], sending: false, toast: vi.fn() } as unknown as State
    const set = (p: Partial<State>): void => {
      state = { ...state, ...p }
    }
    const get = (): State => state
    const slice = composeSlice(set as never, get as never)
    set({ setComposer: slice.setComposer })
    return { slice, get }
  }

  it('sending bayrağı çağrı sürerken açık, bitince kapalı; ikinci gönderim yok sayılır', async () => {
    const { slice, get } = await start(draft())
    let done!: () => void
    h.call.mockReturnValue(new Promise<null>((r) => (done = () => r(null))))
    const p = slice.send(undefined)
    expect(get().sending).toBe(true)
    await slice.send(undefined)
    expect(h.call).toHaveBeenCalledTimes(1)
    done()
    await p
    expect(get().sending).toBe(false)
  })

  it('hata sonrası da sending kapanır', async () => {
    const { slice, get } = await start(draft())
    h.call.mockRejectedValue(new Error('x'))
    await slice.send(undefined)
    expect(get().sending).toBe(false)
  })

  it('preset sendAt yeniden denemede sabit kalır', async () => {
    const { slice } = await start(draft())
    h.call.mockRejectedValueOnce(new Error('zaman aşımı')).mockResolvedValue(null)
    const t0 = Date.now() + 3_600_000
    await slice.send(t0, 'inHour')
    await slice.send(t0 + 90_000, 'inHour') // bir dakika sonra yeniden tıklandı
    expect((h.call.mock.calls[0][1] as { sendAt: number }).sendAt).toBe(t0)
    expect((h.call.mock.calls[1][1] as { sendAt: number }).sendAt).toBe(t0)
  })

  it('geçmişe kalan saklı zaman yeniden hesaplanır', async () => {
    const { slice } = await start(draft())
    h.call.mockRejectedValueOnce(new Error('x')).mockResolvedValue(null)
    const past = Date.now() - 1000
    await slice.send(past, 'inHour')
    const fresh = Date.now() + 3_600_000
    await slice.send(fresh, 'inHour')
    expect((h.call.mock.calls[1][1] as { sendAt: number }).sendAt).toBe(fresh)
  })

  it('farklı hazır seçenek kendi zamanını kullanır', async () => {
    const { slice } = await start(draft())
    h.call.mockRejectedValueOnce(new Error('x')).mockResolvedValue(null)
    await slice.send(1_000, 'inHour')
    await slice.send(9_000, 'tomorrow')
    expect((h.call.mock.calls[1][1] as { sendAt: number }).sendAt).toBe(9_000)
  })
})
