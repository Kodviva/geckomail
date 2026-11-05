import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  startAuthentication: vi.fn<() => Promise<unknown>>(),
  startRegistration: vi.fn<() => Promise<unknown>>()
}))
vi.mock('@simplewebauthn/browser', () => h)

import { initPasskeySupport, passkeySupported, webPasskeyAdd, webPasskeyList, webPasskeyLogin, webPasskeyRemove } from '../webPasskey'

const USER = { id: 1, username: 'ali' }
const named = (name: string): Error => Object.assign(new Error('x'), { name })
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

/** Yol başına sıradaki yanıt; gelen istekleri tutar */
function stubFetch(routes: Record<string, Response | Error>): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const r = routes[url]
    if (!r || r instanceof Error) throw r ?? new Error(`beklenmeyen: ${url}`)
    return r
  })
  return calls
}

describe('web passkey istemcisi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    h.startAuthentication.mockReset()
    h.startRegistration.mockReset()
  })

  it('giriş: seçenek → doğrulayıcı → doğrulama; yanıt aynen gider, kullanıcı döner', async () => {
    h.startAuthentication.mockResolvedValue({ id: 'k' })
    const calls = stubFetch({ '/api/passkey/login/options': json({ challenge: 'c' }), '/api/passkey/login/verify': json({ user: USER }) })
    expect(await webPasskeyLogin()).toEqual({ ok: true, user: USER })
    expect(h.startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c' } })
    expect(calls[1].init?.body).toBe(JSON.stringify({ response: { id: 'k' } }))
    expect(calls[1].init?.credentials).toBe('same-origin')
  })

  it('giriş: istemi kapatmak iptal, doğrulanmayan anahtar başarısız, kilit ve ağ ayrılır', async () => {
    h.startAuthentication.mockRejectedValueOnce(named('NotAllowedError'))
    stubFetch({ '/api/passkey/login/options': json({}) })
    expect(await webPasskeyLogin()).toEqual({ ok: false, reason: 'cancelled' })

    h.startAuthentication.mockRejectedValueOnce(named('SecurityError'))
    stubFetch({ '/api/passkey/login/options': json({}) })
    expect(await webPasskeyLogin()).toEqual({ ok: false, reason: 'failed' })

    stubFetch({ '/api/passkey/login/options': json({ reason: 'locked' }, 423) })
    expect(await webPasskeyLogin()).toEqual({ ok: false, reason: 'locked' })

    stubFetch({ '/api/passkey/login/options': new TypeError('ağ') })
    expect(await webPasskeyLogin()).toEqual({ ok: false, reason: 'network' })

    h.startAuthentication.mockResolvedValue({ id: 'k' })
    stubFetch({ '/api/passkey/login/options': json({}), '/api/passkey/login/verify': json({ reason: 'bad' }, 401) })
    expect(await webPasskeyLogin()).toEqual({ ok: false, reason: 'failed' })
    stubFetch({ '/api/passkey/login/options': json({}), '/api/passkey/login/verify': json({ reason: 'locked' }, 423) })
    expect(await webPasskeyLogin()).toEqual({ ok: false, reason: 'locked' })
    stubFetch({ '/api/passkey/login/options': json({}), '/api/passkey/login/verify': json({}, 500) })
    expect(await webPasskeyLogin()).toEqual({ ok: false, reason: 'network' })
  })

  it('ekleme sonuçları', async () => {
    h.startRegistration.mockResolvedValue({ id: 'k' })
    const calls = stubFetch({ '/api/passkey/register/options': json({}), '/api/passkey/register/verify': json({ passkey: {} }) })
    expect(await webPasskeyAdd('Telefon', { password: 'p', totp: '123456' })).toBe('ok')
    expect(calls[0].init?.body).toBe(JSON.stringify({ password: 'p', totp: '123456' }))
    expect(calls[1].init?.body).toBe(JSON.stringify({ response: { id: 'k' }, name: 'Telefon' }))
    stubFetch({ '/api/passkey/register/options': json({}), '/api/passkey/register/verify': json({}, 409) })
    expect(await webPasskeyAdd('x', { password: 'p' })).toBe('duplicate')
    stubFetch({ '/api/passkey/register/options': json({}), '/api/passkey/register/verify': json({}, 400) })
    expect(await webPasskeyAdd('x', { password: 'p' })).toBe('failed')
    stubFetch({ '/api/passkey/register/options': json({}, 500) })
    expect(await webPasskeyAdd('x', { password: 'p' })).toBe('failed')
    stubFetch({ '/api/passkey/register/options': json({ reason: 'bad' }, 401) })
    expect(await webPasskeyAdd('x', { password: 'p' })).toBe('bad')
    stubFetch({ '/api/passkey/register/options': json({ reason: 'unauthenticated' }, 401) })
    expect(await webPasskeyAdd('x', { password: 'p' })).toBe('failed')
    stubFetch({ '/api/passkey/register/options': json({ reason: 'totpRequired' }, 428) })
    expect(await webPasskeyAdd('x', { password: 'p' })).toBe('totpRequired')
    stubFetch({ '/api/passkey/register/options': json({ reason: 'locked' }, 423) })
    expect(await webPasskeyAdd('x', { password: 'p' })).toBe('locked')

    stubFetch({ '/api/passkey/register/options': json({}) })
    h.startRegistration.mockRejectedValueOnce(named('NotAllowedError'))
    expect(await webPasskeyAdd('x', { password: 'p' })).toBe('cancelled')
    h.startRegistration.mockRejectedValueOnce(named('InvalidStateError'))
    stubFetch({ '/api/passkey/register/options': json({}) })
    expect(await webPasskeyAdd('x', { password: 'p' })).toBe('duplicate')
  })

  it('liste ve silme; kimlik adreste kodlanır', async () => {
    stubFetch({ '/api/passkeys': json({ passkeys: [{ id: 'a' }] }) })
    expect(await webPasskeyList()).toEqual([{ id: 'a' }])
    stubFetch({ '/api/passkeys': json({}, 401) })
    await expect(webPasskeyList()).rejects.toThrow()
    const calls = stubFetch({ '/api/passkeys/a%2Fb': new Response(null, { status: 204 }) })
    expect(await webPasskeyRemove('a/b')).toBe(true)
    expect(calls[0].init?.method).toBe('DELETE')
    expect(await webPasskeyRemove('yok')).toBe(false)
  })

  it('tarayıcı desteği PublicKeyCredential ile', () => {
    vi.stubGlobal('window', {})
    expect(passkeySupported()).toBe(false)
    const browser = (hostname: string) => vi.stubGlobal('window', { PublicKeyCredential: class {}, location: { hostname } })
    browser('posta.example.com')
    expect(passkeySupported()).toBe(true)
    // WebAuthn IP'yi RP ID kabul etmez
    browser('192.168.1.5')
    expect(passkeySupported()).toBe(false)
    browser('[::1]')
    expect(passkeySupported()).toBe(false)
  })

  it('Electron penceresinde düğme yalnız platform doğrulayıcısı varsa görünür', async () => {
    const desktop = (uvpaa: () => Promise<boolean>) => vi.stubGlobal('window', {
      geckoDesktop: {}, location: { hostname: 'posta.example.com' },
      PublicKeyCredential: class { static isUserVerifyingPlatformAuthenticatorAvailable = uvpaa }
    })
    desktop(async () => false) // mac: configureWebAuthn çağrılmadıkça false
    await initPasskeySupport()
    expect(passkeySupported()).toBe(false)
    desktop(async () => true)
    await initPasskeySupport()
    expect(passkeySupported()).toBe(true)
    desktop(async () => { throw new Error('yok') })
    await initPasskeySupport()
    expect(passkeySupported()).toBe(false)
  })

  it('tarayıcıda platform doğrulayıcısı sorulmaz: güvenlik anahtarı da geçerli', async () => {
    const uvpaa = vi.fn(async () => false)
    vi.stubGlobal('window', { location: { hostname: 'posta.example.com' }, PublicKeyCredential: class { static isUserVerifyingPlatformAuthenticatorAvailable = uvpaa } })
    await initPasskeySupport()
    expect(uvpaa).not.toHaveBeenCalled()
    expect(passkeySupported()).toBe(true)
  })
})
