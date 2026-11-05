import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeckoNativePlugin } from '../platform/nativeBridge'

const rpcMock = vi.hoisted(() => ({ rpc: { isOpen: false, call: vi.fn(), revoke: vi.fn(), init: vi.fn() } }))
vi.mock('../rpcClient', () => rpcMock)

type G = { window?: unknown; __geckoNative?: unknown; fetch?: unknown; navigator?: unknown; Notification?: unknown }
const g = globalThis as unknown as G

const user = { id: 1, username: 'ada', role: 'member' }

function plugin(over: Partial<Record<keyof GeckoNativePlugin, unknown>> = {}): GeckoNativePlugin {
  return {
    accessToken: vi.fn(async () => ({ status: 'ok', token: 'gma_1', expiresAt: Date.now() + 900_000 })),
    login: vi.fn(async () => ({ ok: true, user })),
    logout: vi.fn(async () => {}),
    biometricAvailable: vi.fn(async () => ({ available: true })),
    promptBiometric: vi.fn(async () => ({ ok: true })),
    openAttachment: vi.fn(async () => {}),
    saveBytes: vi.fn(async () => ({ ok: true })),
    ...over
  } as unknown as GeckoNativePlugin
}

async function load(p: GeckoNativePlugin, os = 'ios', serverOrigin: string | null = 'https://posta.example.com'): Promise<typeof import('../platform')> {
  g.__geckoNative = { plugin: p, os, serverOrigin }
  g.window = {}
  vi.resetModules()
  const mod = await import('../platform')
  ;(await import('../appLock')).unlockApp(() => {}) // soğuk açılış kilidi AppLock'ta çözülür
  return mod
}

describe('yerel platform', () => {
  const originalFetch = g.fetch
  beforeEach(() => {
    delete g.__geckoNative
    delete g.window
  })
  afterEach(async () => {
    delete g.__geckoNative
    delete g.window
    g.fetch = originalFetch
    delete g.Notification
    vi.restoreAllMocks()
  })

  it('güvenlik düzeltmesi: kilitliyken istemci belirteç istemez, açılınca sürer (T14)', async () => {
    const { createNativeApiClient } = await import('../platform/native')
    let open: () => void = () => {}
    let locked = true
    const accessToken = vi.fn(async () => ({ status: 'ok', token: 'gma_1', expiresAt: Date.now() + 900_000 }))
    const client = createNativeApiClient({
      plugin: plugin({ accessToken }), origin: 'https://posta.example.com', onRevoked: vi.fn(),
      lock: { isLocked: () => locked, whenUnlocked: () => new Promise((r) => { open = r }), lock: vi.fn() }
    })
    g.fetch = vi.fn(async () => new Response('{}'))
    const pending = client.fetch('/api/me')
    await new Promise((r) => setTimeout(r))
    expect(accessToken).not.toHaveBeenCalled()
    expect(g.fetch).not.toHaveBeenCalled()
    locked = false
    open()
    await pending
    expect(accessToken).toHaveBeenCalledTimes(1)
  })

  it('güvenlik düzeltmesi: yerel katman kilitli derse uygulama kilitlenir, belirteçsiz istek gitmez', async () => {
    const { createNativeApiClient } = await import('../platform/native')
    let locked = false
    let open: () => void = () => {}
    const accessToken = vi.fn()
      .mockResolvedValueOnce({ status: 'locked' })
      .mockResolvedValue({ status: 'ok', token: 'gma_2', expiresAt: Date.now() + 900_000 })
    const lock = vi.fn(() => { locked = true })
    const client = createNativeApiClient({
      plugin: plugin({ accessToken }), origin: 'https://posta.example.com', onRevoked: vi.fn(),
      lock: { isLocked: () => locked, whenUnlocked: () => new Promise((r) => { open = r }), lock }
    })
    g.fetch = vi.fn(async () => new Response('{}'))
    const pending = client.fetch('/api/me')
    await new Promise((r) => setTimeout(r))
    expect(lock).toHaveBeenCalledTimes(1)
    expect(g.fetch).not.toHaveBeenCalled()
    locked = false
    open()
    await pending
    expect(g.fetch).toHaveBeenCalledTimes(1)
  })

  it('reset sürmekte olan yenilemeyi iptal eder: belirteç geri gelmez (T14)', async () => {
    const { createNativeApiClient } = await import('../platform/native')
    let finish: (v: unknown) => void = () => {}
    const accessToken = vi.fn(() => new Promise((r) => { finish = r }))
    const onRevoked = vi.fn()
    const client = createNativeApiClient({ plugin: plugin({ accessToken }), origin: 'https://posta.example.com', onRevoked })
    g.fetch = vi.fn(async () => new Response('{}'))
    const first = client.fetch('/api/me').catch((e: Error) => e)
    await Promise.resolve()
    client.reset?.()
    finish({ status: 'ok', token: 'gma_eski', expiresAt: Date.now() + 900_000 })
    expect(await first).toBeInstanceOf(Error)
    expect(g.fetch).not.toHaveBeenCalled()
    const second = client.fetch('/api/me').catch(() => null)
    await Promise.resolve()
    expect(accessToken).toHaveBeenCalledTimes(2)
    finish({ status: 'ok', token: 'gma_yeni', expiresAt: Date.now() + 900_000 })
    await second
    const headers = (g.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer gma_yeni')
  })

  it('iptal edilen yenilemenin gone yanıtı oturumu düşürmez', async () => {
    const { createNativeApiClient } = await import('../platform/native')
    let finish: (v: unknown) => void = () => {}
    const onRevoked = vi.fn()
    const accessToken = vi.fn(() => new Promise((r) => { finish = r }))
    const client = createNativeApiClient({ plugin: plugin({ accessToken }), origin: 'https://posta.example.com', onRevoked })
    const first = client.fetch('/api/me').catch(() => null)
    await Promise.resolve()
    client.reset?.()
    finish({ status: 'gone' })
    await first
    expect(onRevoked).not.toHaveBeenCalled()
  })

  it('openOAuthUrl yalnız https açar', async () => {
    const open = vi.fn(() => null) // iOS'ta Safari açılsa da null döner
    const { platform } = await load(plugin())
    ;(g.window as { open?: unknown }).open = open
    for (const bad of ['javascript:alert(1)', 'http://posta.example.com', 'data:text/html,x', 'capacitor://localhost/x', 'bozuk']) {
      expect(await platform.openOAuthUrl(bad), bad).toBe(false)
    }
    expect(open).not.toHaveBeenCalled()
    expect(await platform.openOAuthUrl('https://posta.example.com')).toBe(true)
  })

  it('passkey hidden on native', async () => {
    await load(plugin())
    ;(g.window as { PublicKeyCredential?: unknown; location?: unknown }).PublicKeyCredential = class {}
    ;(g.window as { location?: unknown }).location = { hostname: 'localhost' }
    const { passkeySupported } = await import('../webPasskey')
    expect(passkeySupported()).toBe(false)
  })

  it('zorunlu 2FA kurulumu mobilde sunucuya gitmez, tarayıcıya yönlendirir', async () => {
    g.fetch = vi.fn()
    await load(plugin())
    const { webSetupBegin } = await import('../webAuth')
    expect(await webSetupBegin({ username: 'a', password: 'b' })).toEqual({ ok: false, reason: 'browser' })
    expect(g.fetch).not.toHaveBeenCalled()
  })

  it('kind web kalır, native ayrımı taşır', async () => {
    const { platform } = await load(plugin(), 'android')
    expect(platform.kind).toBe('web')
    expect(platform.native).toBe('android')
    expect(platform.serverOrigin).toBe('https://posta.example.com')
  })

  it('native platform has no pwa or service worker', async () => {
    const { platform } = await load(plugin())
    expect(platform.serverBackup).toBeNull()
    expect(platform.oauthWindow).toBeNull()
    expect(platform.oauthComplete).toBeNull()
    expect(platform.wallboard).toBeNull()
    // main.tsx ve App.tsx yerel kipte PWA ve service worker yoluna girmez
    const root = join(__dirname, '..')
    const main = readFileSync(join(root, 'main.tsx'), 'utf-8')
    expect(main).toMatch(/platform\.kind === 'web' && !platform\.native && !connectPage\) startPwa\(\)/)
    expect(main).toContain('dataset.native')
    expect(readFileSync(join(root, 'App.tsx'), 'utf-8')).toMatch(/isElectron \|\| platform\.native \|\| !\('serviceWorker' in navigator\)/)

    const sw = { ready: new Promise(() => {}), getRegistration: vi.fn(), addEventListener: vi.fn() }
    vi.stubGlobal('navigator', { serviceWorker: sw, userAgent: 'x', maxTouchPoints: 0 })
    const permission = vi.fn()
    g.Notification = Object.assign(vi.fn(), { permission: 'granted', requestPermission: permission })
    vi.stubGlobal('PushManager', class {})
    const push = await import('../webPushClient')
    expect(push.pushSupport()).toBe('unsupported')
    expect(await push.enablePush()).toBe('unsupported')
    await push.resyncPush()
    await push.suspendPush()
    await push.disablePush()
    expect(await push.pushEnabled()).toBe(false)
    expect(sw.getRegistration).not.toHaveBeenCalled()
    expect(permission).not.toHaveBeenCalled()

    const notify = await import('../webNotify')
    notify.showServerNotification({ accountId: 1, messageId: 1, title: 'T', body: 'B', tag: 't' } as never, { focused: false })
    expect(g.Notification).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('electron unaffected', async () => {
    g.window = { gecko: { touchIdAvailable: async () => false } }
    g.__geckoNative = { plugin: plugin(), os: 'ios', serverOrigin: 'https://x.example' } // Electron önceliklidir
    vi.resetModules()
    const { platform } = await import('../platform')
    expect(platform.kind).toBe('electron')
    expect(platform.native).toBeNull()
    expect(platform.serverOrigin).toBeNull()
    const f = vi.fn(async () => new Response('{}'))
    g.fetch = f
    const { apiFetch } = await import('../apiFetch')
    await apiFetch('/api/x')
    expect(f).toHaveBeenCalledWith('/api/x', { credentials: 'same-origin' }) // yerel istemci kurulmadı
  })

  it('web tarayıcısında yerel köprü yok', async () => {
    g.window = {}
    vi.resetModules()
    const { platform } = await import('../platform')
    expect(platform.kind).toBe('web')
    expect(platform.native).toBeNull()
    expect(platform.serverOrigin).toBeNull()
    expect(platform.serverBackup).not.toBeNull()
  })

  it('bozuk köprü yok sayılır', async () => {
    const { nativeBridge } = await import('../platform/nativeBridge')
    g.__geckoNative = { plugin: plugin(), os: 'windows' }
    expect(nativeBridge()).toBeNull()
    g.__geckoNative = { os: 'ios' }
    expect(nativeBridge()).toBeNull()
  })

  it('giriş ve çıkış eklentiye gider, parola sunucuya JS üzerinden gitmez', async () => {
    const p = plugin()
    const f = vi.fn(async () => new Response(JSON.stringify({ user }), { status: 200 }))
    g.fetch = f
    await load(p)
    const { webLogin, webLogout, webMe } = await import('../webAuth')
    expect(await webLogin({ username: 'ada', password: 'x', totp: '123456' })).toEqual({ ok: true, user })
    expect(p.login).toHaveBeenCalledWith({ username: 'ada', password: 'x', totp: '123456' })
    expect(f).not.toHaveBeenCalled()
    expect(await webMe()).toEqual({ user })
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://posta.example.com/api/me')
    expect(await webLogout()).toBe(true)
    expect(p.logout).toHaveBeenCalledOnce()
    expect(f).toHaveBeenCalledOnce() // çıkış /api/logout'a gitmez
  })

  it('giriş hatası nedenleri korunur, köprü hatası ağ sayılır', async () => {
    const p = plugin({ login: vi.fn(async () => ({ ok: false, reason: 'totpRequired' })) })
    await load(p)
    const { webLogin, webLogout } = await import('../webAuth')
    expect(await webLogin({ username: 'a', password: 'b' })).toEqual({ ok: false, reason: 'totpRequired' })
    vi.mocked(p.login).mockRejectedValueOnce(new Error('köprü'))
    expect(await webLogin({ username: 'a', password: 'b' })).toEqual({ ok: false, reason: 'network' })
    vi.mocked(p.logout).mockRejectedValueOnce(new Error('köprü'))
    expect(await webLogout()).toBe(false)
  })

  it('oturum yoksa webMe null döner, iptal olayı yok', async () => {
    const p = plugin({ accessToken: vi.fn(async () => ({ status: 'gone' })) })
    const { platform } = await load(p)
    expect(platform.native).toBe('ios')
    const { webMe } = await import('../webAuth')
    expect(await webMe()).toEqual({ user: null, setupRequired: false })
    const { rpc } = await import('../rpcClient')
    expect(rpc.revoke).not.toHaveBeenCalled()
  })

  it('ek ve kayıt eklentiyle, biyometrik eklentiyle', async () => {
    const p = plugin()
    const { platform } = await load(p)
    const a = { messageId: 1, attachmentId: 2, name: 'a.pdf' }
    await platform.openAttachment(a)
    await platform.revealAttachment(a)
    expect(p.openAttachment).toHaveBeenCalledTimes(2)
    expect(p.openAttachment).toHaveBeenCalledWith(a)
    expect(await platform.saveBytes('a.txt', new Uint8Array([104, 105]))).toBe(true)
    expect(p.saveBytes).toHaveBeenCalledWith({ name: 'a.txt', base64: 'aGk=' })
    expect(await platform.biometricAvailable()).toBe(true)
    expect(await platform.promptBiometric('neden')).toBe(true)
    expect(p.promptBiometric).toHaveBeenCalledWith({ reason: 'neden' })
    vi.mocked(p.saveBytes).mockRejectedValueOnce(new Error('iptal'))
    expect(await platform.saveBytes('a.txt', new Uint8Array([1]))).toBe(false)
  })

  it('yükleme apiFetch ile sunucu kökenine', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ uploadId: 'u1' }), { status: 200 }))
    g.fetch = f
    const { platform } = await load(plugin())
    const file = new File(['x'], 'ö zet.pdf')
    expect(await platform.uploadFile!(file)).toBe('u1')
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://posta.example.com/api/upload')
    expect(new Headers(init.headers).get('X-Filename')).toBe("UTF-8''%C3%B6%20zet.pdf")
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer gma_1')
    await platform.discardUpload!('u1')
    expect((f.mock.calls[1] as unknown as [string, RequestInit])[1].method).toBe('DELETE')
  })
})

describe('yerel ek açma', () => {
  const ref = { messageId: 1, attachmentId: 2, name: 'x.pdf' }

  it('eklenti hatası metne çevrilir', async () => {
    const p = plugin({ openAttachment: vi.fn(async () => { throw new Error('status:423') }) })
    const { platform } = await load(p)
    await expect(platform.openAttachment(ref)).rejects.not.toThrow('status:423')
    const q = plugin({ openAttachment: vi.fn(async () => { throw new Error('noApp') }) })
    await expect((await load(q)).platform.openAttachment(ref)).rejects.toThrow()
  })

  it('çalıştırılabilir ek sorulur, reddedilince indirilmez', async () => {
    const p = plugin()
    const { platform } = await load(p)
    const confirm = vi.fn(() => false)
    ;(g.window as { confirm?: unknown }).confirm = confirm
    await platform.openAttachment({ ...ref, name: 'kur.apk' })
    await platform.openAttachment({ ...ref, name: 'profil.mobileconfig' })
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(p.openAttachment).not.toHaveBeenCalled()
    await platform.openAttachment(ref)
    expect(p.openAttachment).toHaveBeenCalledTimes(1)
  })
})
