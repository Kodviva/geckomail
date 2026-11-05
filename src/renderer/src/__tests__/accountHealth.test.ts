import { describe, expect, it } from 'vitest'
import { attention, needsAction, primaryActionLabel } from '../accountHealth'

const acc = (status: string, statusDetail: string | null = null, enabled = true) =>
  ({ status, statusDetail, enabled }) as Parameters<typeof attention>[0]

describe('accountHealth', () => {
  it('auth_failed ve ilk şifre reddi (degraded) aynı: şifre dikkati', () => {
    expect(attention(acc('auth_failed'))).toBe('auth')
    expect(attention(acc('degraded', "Şifre reddedildi — 22:44'de bir kez daha denenecek"))).toBe('auth')
    expect(needsAction(acc('degraded', "Şifre reddedildi — 22:44'de bir kez daha denenecek"))).toBe(true)
  })
  it('ulaşılamıyor → sunucu', () => {
    expect(attention(acc('unreachable'))).toBe('server')
    expect(primaryActionLabel(acc('unreachable'))).toBe('Sunucu ayarları')
  })
  it('diğer degraded yalnızca uyarı, eylem sayılmaz', () => {
    expect(attention(acc('degraded', 'read ECONNRESET'))).toBe('warn')
    expect(needsAction(acc('degraded', 'read ECONNRESET'))).toBe(false)
  })
  it('kapalı ve sağlıklı hesap dikkat gerektirmez', () => {
    expect(attention(acc('auth_failed', null, false))).toBe(null)
    expect(attention(acc('ok'))).toBe(null)
    expect(primaryActionLabel(acc('ok'))).toBe('Düzenle')
  })
})
