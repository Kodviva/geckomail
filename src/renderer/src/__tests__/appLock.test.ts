import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => ({ rpc: { stop: vi.fn(), running: true } }))
vi.mock('../rpcClient', () => rpc)
const api = vi.hoisted(() => ({ resetApiClient: vi.fn() }))
vi.mock('../apiFetch', () => api)

type G = { __geckoNative?: unknown }
const g = globalThis as unknown as G

async function load(native: boolean): Promise<typeof import('../appLock')> {
  g.__geckoNative = native ? { plugin: {}, os: 'ios', serverOrigin: null } : undefined
  vi.resetModules()
  return import('../appLock')
}

describe('shouldLock', () => {
  it('sınırlar', async () => {
    const { LOCK_TIMEOUTS, shouldLock } = await load(true)
    expect(LOCK_TIMEOUTS).toEqual([0, 60_000, 300_000, 900_000])
    const s = { enabled: true, timeoutMs: 60_000, backgroundedAt: 1000 }
    expect(shouldLock({ ...s, now: 60_999 })).toBe(false)
    expect(shouldLock({ ...s, now: 61_000 })).toBe(true)
  })

  it('0 locks immediately', async () => {
    const { shouldLock } = await load(true)
    expect(shouldLock({ enabled: true, timeoutMs: 0, backgroundedAt: 5, now: 5 })).toBe(true)
  })

  it('disabled never', async () => {
    const { shouldLock } = await load(true)
    expect(shouldLock({ enabled: false, timeoutMs: 0, backgroundedAt: 0, now: 1e12 })).toBe(false)
  })

  it('saat geri giderse kilitlenir', async () => {
    const { shouldLock } = await load(true)
    expect(shouldLock({ enabled: true, timeoutMs: 900_000, backgroundedAt: 5000, now: 4999 })).toBe(true)
  })

  it('arka plana hiç gitmediyse kilit yok', async () => {
    const { shouldLock } = await load(true)
    expect(shouldLock({ enabled: true, timeoutMs: 0, backgroundedAt: null, now: 1e12 })).toBe(false)
  })
})

describe('kilit durumu', () => {
  beforeEach(() => {
    rpc.rpc.stop.mockClear()
    api.resetApiClient.mockClear()
  })

  it('lock clears access token', async () => {
    const { isLocked, lockApp } = await load(true)
    lockApp()
    expect(isLocked()).toBe(true)
    expect(api.resetApiClient).toHaveBeenCalledTimes(1)
    expect(rpc.rpc.stop).toHaveBeenCalledTimes(1)
  })

  it('açılış ayarı okunana dek mobilde kilitli başlar, web hiç kilitlenmez', async () => {
    expect((await load(true)).isLocked()).toBe(true)
    expect((await load(false)).isLocked()).toBe(false)
  })

  it('girişsiz ekranda kilit açılınca bağlantı kurulmaz', async () => {
    const { lockApp, unlockApp } = await load(true)
    rpc.rpc.running = false
    lockApp()
    const resume = vi.fn()
    unlockApp(resume)
    rpc.rpc.running = true
    expect(resume).not.toHaveBeenCalled()
  })

  it('kilitliyken istenen bağlantı açılınca kurulur', async () => {
    const { deferRpcStart, unlockApp } = await load(true)
    deferRpcStart()
    const resume = vi.fn()
    unlockApp(resume)
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('açılınca yalnız durdurulmuş bağlantı yeniden başlar, dinleyici haber alır', async () => {
    const { lockApp, onLockChange, unlockApp } = await load(true)
    const seen: boolean[] = []
    const off = onLockChange((v) => seen.push(v))
    const resume = vi.fn()
    unlockApp(resume) // açılış ayarı: kilit yok, bağlantı hiç durmadı
    expect(resume).not.toHaveBeenCalled()
    lockApp()
    unlockApp(resume)
    expect(resume).toHaveBeenCalledTimes(1)
    off()
    lockApp()
    expect(seen).toEqual([false, true, false])
  })
})

describe('kilit ekranından çıkış', () => {
  it('kilit kalkar, bekleyenler sürer, bağlantı yeniden kurulmaz', async () => {
    const m = await load(true)
    rpc.rpc.running = true
    m.lockApp() // açık bağlantı durdu: normalde açılınca geri gelirdi
    m.rememberLockConfig({ enabled: true, timeoutMs: 60_000 })
    const waited = vi.fn()
    void m.whenUnlocked().then(waited)
    m.releaseLockAfterSignOut()
    await Promise.resolve()
    expect(m.isLocked()).toBe(false)
    expect(waited).toHaveBeenCalledTimes(1)
    expect(m.lockConfig()).toEqual({ enabled: false, timeoutMs: 60_000 })
    const resume = vi.fn()
    m.lockApp()
    rpc.rpc.running = false
    m.unlockApp(resume)
    rpc.rpc.running = true
    expect(resume).toHaveBeenCalledTimes(1) // ilk lockApp bayrağı sıfırlandı, ikinci kilit bağlantıyı yine durdurdu
  })

  it('bağlantı hiç kurulmamışsa çıkıştan sonra kurulmaz', async () => {
    const m = await load(true)
    rpc.rpc.running = false
    m.deferRpcStart()
    m.releaseLockAfterSignOut()
    const resume = vi.fn()
    m.lockApp()
    m.unlockApp(resume)
    rpc.rpc.running = true
    expect(resume).not.toHaveBeenCalled()
  })
})

describe('güvenlik düzeltmesi: kilit ayarı ve geçişler', () => {
  const state = (over: object = {}) => ({ enabled: true, timeoutMs: 60_000, locked: false, uptimeMs: 1000, ...over })
  const plugin = (...reads: unknown[]) => {
    const getLock = vi.fn(async () => {
      const r = reads.length > 1 ? reads.shift() : reads[0]
      if (r instanceof Error) throw r
      return r
    })
    return { getLock } as unknown as import('../platform/nativeBridge').GeckoNativePlugin
  }
  beforeEach(() => {
    rpc.rpc.stop.mockClear()
    api.resetApiClient.mockClear()
  })

  it('stale config: ayarda açılan kilit bir sonraki dönüşte geçerli', async () => {
    const m = await load(true)
    m.rememberLockConfig({ enabled: false, timeoutMs: 0 })
    m.unlockApp(vi.fn())
    m.rememberLockConfig({ enabled: true, timeoutMs: 0 })
    const p = plugin(state({ timeoutMs: 0 }))
    await m.appStateChanged(false, p)
    expect(m.isLocked()).toBe(true)
  })

  it('ayar her geçişte yeniden okunur', async () => {
    const m = await load(true)
    m.rememberLockConfig({ enabled: false, timeoutMs: 0 })
    m.unlockApp(vi.fn())
    const p = plugin(state({ uptimeMs: 1000 }), state({ uptimeMs: 62_000 }))
    await m.appStateChanged(false, p)
    expect(m.isLocked()).toBe(false)
    expect(await m.appStateChanged(true, p)).toBe(true)
    expect(m.isLocked()).toBe(true)
    expect(p.getLock).toHaveBeenCalledTimes(2)
  })

  it('kilit açıkken okuma hatası kilitler', async () => {
    const m = await load(true)
    m.rememberLockConfig({ enabled: true, timeoutMs: 900_000 })
    m.unlockApp(vi.fn())
    expect(await m.appStateChanged(true, plugin(new Error('köprü')))).toBe(true)
    expect(m.isLocked()).toBe(true)
  })

  it('yerel katman kilitli diyorsa kilitlenir', async () => {
    const m = await load(true)
    m.rememberLockConfig({ enabled: true, timeoutMs: 900_000 })
    m.unlockApp(vi.fn())
    expect(await m.appStateChanged(true, plugin(state({ locked: true })))).toBe(true)
    expect(m.isLocked()).toBe(true)
  })

  it('soğuk açılışta okuma hatası kilitli kalır', async () => {
    const m = await load(true)
    expect(await m.resolveColdLock(plugin(new Error('köprü')), vi.fn())).toBe('prompt')
    expect(m.isLocked()).toBe(true)
  })

  it('soğuk açılışta kilit kapalıysa açılır, açıksa ister', async () => {
    const m = await load(true)
    expect(await m.resolveColdLock(plugin(state()), vi.fn())).toBe('prompt')
    expect(m.isLocked()).toBe(true)
    const n = await load(true)
    expect(await n.resolveColdLock(plugin(state({ enabled: false })), vi.fn())).toBe('open')
    expect(n.isLocked()).toBe(false)
  })

  it('kimlik sorusu sürerken geçişler yok sayılır: Face ID etkin olmayan duruma düşürür', async () => {
    const m = await load(true)
    m.rememberLockConfig({ enabled: true, timeoutMs: 0 })
    m.unlockApp(vi.fn())
    const p = plugin(state({ timeoutMs: 0 }))
    await m.duringPrompt(async () => {
      await m.appStateChanged(false, p)
      expect(await m.appStateChanged(true, p)).toBe(false)
    })
    expect(m.isLocked()).toBe(false)
    expect(p.getLock).not.toHaveBeenCalled()
  })

  it('whenUnlocked kilit açılınca çözülür', async () => {
    const m = await load(true)
    let done = false
    void m.whenUnlocked().then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)
    m.unlockApp(vi.fn())
    await new Promise((r) => setTimeout(r))
    expect(done).toBe(true)
  })
})
