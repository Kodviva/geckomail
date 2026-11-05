import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, Set<(d: unknown) => void>>(),
  complete: vi.fn(async (_state: string): Promise<{ ok: boolean; reason?: string }> => ({ ok: true }))
}))

vi.mock('../rpcClient', () => ({
  rpc: {
    on(ev: string, cb: (d: unknown) => void) {
      if (!h.handlers.has(ev)) h.handlers.set(ev, new Set())
      h.handlers.get(ev)!.add(cb)
      return () => h.handlers.get(ev)!.delete(cb)
    }
  }
}))
vi.mock('../platform', () => ({ platform: { oauthComplete: h.complete } }))
vi.mock('../store', () => ({ useStore: () => null }))

const emit = (ev: string, d: unknown): void => h.handlers.get(ev)?.forEach((cb) => cb(d))

describe('web OAuth bekleme', () => {
  beforeEach(() => {
    h.handlers.clear()
    h.complete.mockClear()
  })

  it('yeni sokette yinelenen oauth:returned akışı ikinci kez tamamlamaz', async () => {
    const { waitDone } = await import('../components/useOAuthConnect')
    const popup = { go: vi.fn(), close: vi.fn() }
    const result = waitDone('akis', 'durum', popup, { current: null })
    emit('oauth:returned', { flowId: 'baska' })
    expect(h.complete).not.toHaveBeenCalled()
    emit('oauth:returned', { flowId: 'akis' })
    emit('oauth:returned', { flowId: 'akis' })
    expect(h.complete).toHaveBeenCalledTimes(1)
    expect(h.complete).toHaveBeenCalledWith('durum')
    emit('oauth:done', { flowId: 'akis', ok: true, email: 'a@b.c', added: true })
    await expect(result).resolves.toEqual({ email: 'a@b.c', added: true })
  })

  it('kişi ve takvim bağlama sonucu oauth:done ile gelir', async () => {
    const { waitDone } = await import('../components/useOAuthConnect')
    const result = waitDone('akis', 'durum', { go: vi.fn(), close: vi.fn() }, { current: null })
    emit('oauth:done', { flowId: 'akis', ok: true, email: 'a@b.c', added: false, pimStatus: 'needsConsent' })
    await expect(result).resolves.toEqual({ email: 'a@b.c', added: false, pimStatus: 'needsConsent' })
  })
})
