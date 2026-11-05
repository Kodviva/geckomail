import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, resetApiClient, setApiClient, wsEndpoint, type ApiClient } from '../apiFetch'
import type { GeckoNativePlugin } from '../platform/nativeBridge'
import { createNativeApiClient } from '../platform/native'

vi.mock('../rpcClient', () => ({ rpc: { isOpen: false, call: vi.fn(), revoke: vi.fn() } }))

const ORIGIN = 'https://posta.example.com'
const g = globalThis as unknown as { fetch: unknown; window?: unknown }

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status })

function fakePlugin(tokens: ({ token: string } | 'gone' | 'network')[]): { plugin: GeckoNativePlugin; accessToken: ReturnType<typeof vi.fn> } {
  const accessToken = vi.fn(async (_o: { force?: boolean }) => {
    const next = tokens.shift() ?? 'network'
    if (next === 'gone' || next === 'network') return { status: next }
    return { status: 'ok', token: next.token, expiresAt: Date.now() + 900_000 }
  })
  return { plugin: { accessToken } as unknown as GeckoNativePlugin, accessToken }
}

describe('apiFetch', () => {
  let doFetch: ReturnType<typeof vi.fn>
  const original = g.fetch

  beforeEach(() => {
    doFetch = vi.fn(async () => json(200, {}))
    g.fetch = doFetch
  })
  afterEach(() => {
    g.fetch = original
    delete g.window
    setApiClient(null)
    vi.restoreAllMocks()
  })

  it('web client keeps same-origin credentials', async () => {
    await apiFetch('/api/me')
    expect(doFetch).toHaveBeenCalledWith('/api/me', { credentials: 'same-origin' })
    await apiFetch('/api/upload', { method: 'POST', body: 'x' })
    expect(doFetch).toHaveBeenLastCalledWith('/api/upload', { credentials: 'same-origin', method: 'POST', body: 'x' })
    g.window = { location: { protocol: 'https:', host: 'posta.example.com' } }
    expect(await wsEndpoint()).toEqual({ url: 'wss://posta.example.com/rpc' })
    g.window = { location: { protocol: 'http:', host: 'localhost:8080' } }
    expect(await wsEndpoint()).toEqual({ url: 'ws://localhost:8080/rpc' })
  })

  it('setApiClient yeni istemciye geçer, reset istemciye iletilir', async () => {
    const reset = vi.fn()
    const c: ApiClient = { fetch: vi.fn(async () => json(200, {})), wsEndpoint: async () => ({ url: 'x' }), reset }
    setApiClient(c)
    await apiFetch('/api/me')
    expect(c.fetch).toHaveBeenCalledWith('/api/me', undefined)
    expect(doFetch).not.toHaveBeenCalled()
    resetApiClient()
    expect(reset).toHaveBeenCalledOnce()
  })

  it('native adds bearer and omits credentials', async () => {
    const { plugin, accessToken } = fakePlugin([{ token: 'gma_1' }])
    const c = createNativeApiClient({ plugin, origin: ORIGIN, onRevoked: () => {} })
    await c.fetch('/api/me')
    await c.fetch('/api/upload', { method: 'POST', headers: { 'X-Filename': 'a' }, body: 'x' })
    expect(accessToken).toHaveBeenCalledOnce() // belirteç süresi içinde yeniden kullanılır
    const [url, init] = doFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${ORIGIN}/api/me`)
    expect(init.credentials).toBe('omit')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer gma_1')
    const [url2, init2] = doFetch.mock.calls[1] as [string, RequestInit]
    expect(url2).toBe(`${ORIGIN}/api/upload`)
    expect(new Headers(init2.headers).get('X-Filename')).toBe('a')
    expect(new Headers(init2.headers).get('Authorization')).toBe('Bearer gma_1')
  })

  it('native client refuses to leave the server origin', async () => {
    const { plugin, accessToken } = fakePlugin([{ token: 'gma_1' }])
    const c = createNativeApiClient({ plugin, origin: ORIGIN, onRevoked: () => {} })
    for (const p of ['https://evil.example/api/me', '//evil.example/api/me', '@evil.example/api', 'api/me']) await expect(c.fetch(p)).rejects.toThrow()
    expect(accessToken).not.toHaveBeenCalled()
    expect(doFetch).not.toHaveBeenCalled()
  })

  it('expired access refreshes once', async () => {
    const { plugin, accessToken } = fakePlugin([{ token: 'gma_1' }, { token: 'gma_2' }, { token: 'gma_3' }])
    doFetch.mockResolvedValueOnce(json(401, {})).mockResolvedValueOnce(json(200, { ok: 1 }))
    const c = createNativeApiClient({ plugin, origin: ORIGIN, onRevoked: () => {} })
    const r = await c.fetch('/api/me')
    expect(r.status).toBe(200)
    expect(accessToken).toHaveBeenCalledTimes(2)
    expect(accessToken).toHaveBeenLastCalledWith({ force: true })
    expect(new Headers((doFetch.mock.calls[1] as [string, RequestInit])[1].headers).get('Authorization')).toBe('Bearer gma_2')
    // ikinci 401 yeniden denemez
    doFetch.mockClear()
    accessToken.mockClear()
    doFetch.mockResolvedValue(json(401, {}))
    const second = await c.fetch('/api/me')
    expect(second.status).toBe(401)
    expect(doFetch).toHaveBeenCalledTimes(2)
    expect(accessToken).toHaveBeenCalledOnce()
  })

  it('aynı anda 401 alan istekler tek yenileme yapar', async () => {
    const { plugin, accessToken } = fakePlugin([{ token: 'gma_1' }, { token: 'gma_2' }])
    doFetch.mockImplementation(async (_u: string, i: RequestInit) => json(new Headers(i.headers).get('Authorization') === 'Bearer gma_2' ? 200 : 401, {}))
    const c = createNativeApiClient({ plugin, origin: ORIGIN, onRevoked: () => {} })
    const all = await Promise.all([c.fetch('/api/me'), c.fetch('/api/me'), c.fetch('/api/me')])
    expect(all.map((r) => r.status)).toEqual([200, 200, 200])
    expect(accessToken).toHaveBeenCalledTimes(2)
  })

  it('gone revokes', async () => {
    const onRevoked = vi.fn()
    const { plugin } = fakePlugin([{ token: 'gma_1' }, 'gone', 'gone'])
    doFetch.mockResolvedValue(json(401, {}))
    const c = createNativeApiClient({ plugin, origin: ORIGIN, onRevoked })
    const r = await c.fetch('/api/me')
    expect(r.status).toBe(401)
    expect(onRevoked).toHaveBeenCalledOnce()
    await c.fetch('/api/me')
    expect(onRevoked).toHaveBeenCalledOnce() // bir kez
  })

  it('oturum hiç açılmadıysa gone iptal olayı üretmez: açılış döngüsü olmaz', async () => {
    const onRevoked = vi.fn()
    const { plugin } = fakePlugin(['gone'])
    const c = createNativeApiClient({ plugin, origin: ORIGIN, onRevoked })
    expect((await c.fetch('/api/me')).status).toBe(401)
    expect(doFetch).not.toHaveBeenCalled()
    expect(onRevoked).not.toHaveBeenCalled()
  })

  it('ağ yoksa fırlatır: kopuş çıkış sayılmaz', async () => {
    const onRevoked = vi.fn()
    const { plugin, accessToken } = fakePlugin(['network'])
    const c = createNativeApiClient({ plugin, origin: ORIGIN, onRevoked })
    await expect(c.fetch('/api/me')).rejects.toThrow()
    expect(onRevoked).not.toHaveBeenCalled()
    accessToken.mockRejectedValueOnce(new Error('köprü'))
    await expect(c.fetch('/api/me')).rejects.toThrow()
  })

  it('sunucu seçilmemişse istek gitmez', async () => {
    const { plugin } = fakePlugin([])
    const c = createNativeApiClient({ plugin, origin: null, onRevoked: () => {} })
    await expect(c.fetch('/api/me')).rejects.toThrow()
    await expect(c.wsEndpoint()).rejects.toThrow()
    expect(doFetch).not.toHaveBeenCalled()
  })

  it('native wsEndpoint her çağrıda yeni bilet alır, adreste belirteç yok', async () => {
    const { plugin } = fakePlugin([{ token: 'gma_1' }])
    doFetch.mockImplementation(async () => json(200, { ticket: `gmt_${doFetch.mock.calls.length}` }))
    const c = createNativeApiClient({ plugin, origin: ORIGIN, onRevoked: () => {} })
    const a = await c.wsEndpoint()
    const b = await c.wsEndpoint()
    expect(a).toEqual({ url: 'wss://posta.example.com/rpc', protocols: ['gecko.v1', 'gecko.ticket.gmt_1'] })
    expect(b.protocols).toEqual(['gecko.v1', 'gecko.ticket.gmt_2'])
    expect((doFetch.mock.calls[0] as [string, RequestInit])[0]).toBe(`${ORIGIN}/api/mobile/ws-ticket`)
    expect((doFetch.mock.calls[0] as [string, RequestInit])[1].method).toBe('POST')
    doFetch.mockResolvedValueOnce(json(500, {}))
    await expect(c.wsEndpoint()).rejects.toThrow()
  })

  it('reset belirteci bırakır', async () => {
    const { plugin, accessToken } = fakePlugin([{ token: 'gma_1' }, { token: 'gma_2' }])
    const c = createNativeApiClient({ plugin, origin: ORIGIN, onRevoked: () => {} })
    await c.fetch('/api/me')
    c.reset?.()
    await c.fetch('/api/me')
    expect(accessToken).toHaveBeenCalledTimes(2)
    expect(new Headers((doFetch.mock.calls[1] as [string, RequestInit])[1].headers).get('Authorization')).toBe('Bearer gma_2')
  })

  it('access token never in web storage', async () => {
    const writes: string[] = []
    const store = { getItem: () => null, setItem: (k: string, v: string) => void writes.push(k, v), removeItem: () => {} }
    const stg = globalThis as unknown as { localStorage?: unknown; sessionStorage?: unknown }
    const saved = { l: stg.localStorage, s: stg.sessionStorage }
    stg.localStorage = store
    stg.sessionStorage = store
    try {
      const { plugin } = fakePlugin([{ token: 'gma_gizli' }, { token: 'gma_gizli2' }])
      doFetch.mockResolvedValueOnce(json(401, {})).mockResolvedValue(json(200, { ticket: 'gmt_gizli' }))
      const c = createNativeApiClient({ plugin, origin: ORIGIN, onRevoked: () => {} })
      await c.fetch('/api/me')
      await c.wsEndpoint()
      expect(writes).toEqual([])
      // nesnede de açık alan yok: belirteç yalnız kapanış değişkeninde
      expect(JSON.stringify(c)).not.toContain('gma_')
      expect(Object.values(c).filter((v) => typeof v === 'string')).toEqual([])
    } finally {
      stg.localStorage = saved.l
      stg.sessionStorage = saved.s
    }
    // kaynakta da kalıcı depoya giden yol yok
    const src = readFileSync(join(__dirname, '..', 'platform', 'native.ts'), 'utf-8')
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|useStore/)
  })

  it('no bare api fetch outside apiFetch', () => {
    const root = join(__dirname, '..')
    const files: string[] = []
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) {
          if (f !== '__tests__') walk(p)
        } else if (/\.tsx?$/.test(f)) files.push(p)
      }
    }
    walk(root)
    expect(files.length).toBeGreaterThan(50)
    const bare = /(?<![\w.])fetch\(\s*['"`]\/(api|oauth)/
    const any = /(?<![\w.])fetch\(/
    // yerel istemci sunucu kökeniyle tam adres kurar; sw kendi kökeninde, çerezle çalışır; nativeShare yalnız /_capacitor_file_/ okur
    const allowed = new Set(['apiFetch.ts', 'sw.ts', 'swPush.ts', 'nativeShare.ts', join('platform', 'native.ts')])
    for (const f of files) {
      const rel = relative(root, f)
      if (allowed.has(rel)) continue
      const text = readFileSync(f, 'utf-8')
      expect(bare.test(text), rel).toBe(false)
      expect(any.test(text), rel).toBe(false)
    }
    // renderer Capacitor içermez
    for (const f of files) expect(readFileSync(f, 'utf-8'), relative(root, f)).not.toMatch(/from '@capacitor\//)
  })
})
