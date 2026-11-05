import { describe, expect, it, vi } from 'vitest'
import { flowSubmit, type FlowApi, type FlowView } from '../webLoginFlow'
import type { SessionUser } from '../../../shared/rpc'

const user = { id: 1, username: 'ayse', role: 'admin' } as unknown as SessionUser
const creds = { username: 'ayse', password: 'parola-123', code: '' }

function api(o: Partial<FlowApi> = {}): FlowApi {
  return {
    login: vi.fn(async () => ({ ok: true as const, user })),
    setupBegin: vi.fn(async () => ({ ok: true as const, otpauthUri: 'otpauth://totp/x?secret=AAAA', secretBase32: 'AAAA' })),
    setupConfirm: vi.fn(async () => ({ ok: true as const, user })),
    ...o
  }
}

const start: FlowView = { kind: 'credentials' }

describe('web giriş akışı', () => {
  it('parola doğru, 2FA yok → giriş', async () => {
    const a = api()
    expect(await flowSubmit(start, creds, a)).toEqual({ kind: 'done', user })
    expect(a.login).toHaveBeenCalledWith({ username: 'ayse', password: 'parola-123' })
  })

  it('hatalı parola / kilit / ağ → giriş ekranında ileti', async () => {
    for (const reason of ['bad', 'locked', 'network'] as const) {
      const a = api({ login: vi.fn(async () => ({ ok: false as const, reason })) })
      expect(await flowSubmit(start, creds, a)).toEqual({ kind: 'credentials', error: reason })
    }
  })

  it('totpRequired → kod alanı; kod aynı kimlik bilgileriyle gönderilir', async () => {
    const login = vi.fn<FlowApi['login']>(async () => ({ ok: false, reason: 'totpRequired' }))
    const a = api({ login })
    const v = await flowSubmit(start, creds, a)
    expect(v).toEqual({ kind: 'totp' })
    login.mockResolvedValueOnce({ ok: true, user })
    expect(await flowSubmit(v, { ...creds, code: ' 123 456 ' }, a)).toEqual({ kind: 'done', user })
    expect(login).toHaveBeenLastCalledWith({ username: 'ayse', password: 'parola-123', totp: '123456' })
  })

  it('kod ekranında yanlış kod → aynı ekran, ileti; kilit → giriş ekranı', async () => {
    const login = vi.fn<FlowApi['login']>(async () => ({ ok: false, reason: 'totpBad' }))
    const a = api({ login })
    expect(await flowSubmit({ kind: 'totp' }, { ...creds, code: '000000' }, a)).toEqual({ kind: 'totp', error: 'totpBad' })
    login.mockResolvedValueOnce({ ok: false, reason: 'locked' })
    expect(await flowSubmit({ kind: 'totp' }, { ...creds, code: '000000' }, a)).toEqual({ kind: 'credentials', error: 'locked' })
    login.mockResolvedValueOnce({ ok: false, reason: 'network' })
    expect(await flowSubmit({ kind: 'totp' }, { ...creds, code: '000000' }, a)).toEqual({ kind: 'totp', error: 'network' })
  })

  it('6 haneli olmayan kod sunucuya gitmez', async () => {
    const a = api()
    expect(await flowSubmit({ kind: 'totp' }, { ...creds, code: '12a' }, a)).toEqual({ kind: 'totp', error: 'totpBad' })
    expect(a.login).not.toHaveBeenCalled()
  })

  it('totpSetupRequired → kurulum başlar (QR + sır), kodla onaylanınca giriş', async () => {
    const a = api({ login: vi.fn(async () => ({ ok: false as const, reason: 'totpSetupRequired' as const })) })
    const v = await flowSubmit(start, creds, a)
    expect(v).toEqual({ kind: 'setup', otpauthUri: 'otpauth://totp/x?secret=AAAA', secretBase32: 'AAAA' })
    expect(a.setupBegin).toHaveBeenCalledWith({ username: 'ayse', password: 'parola-123' })
    expect(await flowSubmit(v, { ...creds, code: '654321' }, a)).toEqual({ kind: 'done', user })
    expect(a.setupConfirm).toHaveBeenCalledWith({ username: 'ayse', password: 'parola-123', code: '654321' })
  })

  it('kurulumda yanlış kod → kurulum ekranı korunur', async () => {
    const setup: FlowView = { kind: 'setup', otpauthUri: 'u', secretBase32: 'S' }
    const a = api({ setupConfirm: vi.fn(async () => ({ ok: false as const, reason: 'totpBad' as const })) })
    expect(await flowSubmit(setup, { ...creds, code: '111111' }, a)).toEqual({ ...setup, error: 'totpBad' })
  })

  it('kurulum başlatılamazsa giriş ekranı; notRequired → yeniden giriş denenir', async () => {
    const login = vi.fn<FlowApi['login']>(async () => ({ ok: false, reason: 'totpSetupRequired' }))
    const a = api({ login, setupBegin: vi.fn(async () => ({ ok: false as const, reason: 'locked' as const })) })
    expect(await flowSubmit(start, creds, a)).toEqual({ kind: 'credentials', error: 'locked' })

    const b = api({ login, setupBegin: vi.fn(async () => ({ ok: false as const, reason: 'notRequired' as const })) })
    login.mockResolvedValueOnce({ ok: false, reason: 'totpSetupRequired' }).mockResolvedValueOnce({ ok: false, reason: 'totpRequired' })
    expect(await flowSubmit(start, creds, b)).toEqual({ kind: 'totp' })
  })
})
