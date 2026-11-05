import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode, newTotpSecret, otpauthUri, totpCode, verifyTotp } from '../auth/totp'

// RFC 6238 ek B, SHA1 sırrı
const S = Buffer.from('12345678901234567890', 'ascii')

describe('totp', () => {
  it('RFC 6238 SHA1 vektörleri (8 hane)', () => {
    expect(totpCode(S, 59, 8)).toBe('94287082')
    expect(totpCode(S, 1111111109, 8)).toBe('07081804')
    expect(totpCode(S, 1234567890, 8)).toBe('89005924')
  })

  it('6 hane varsayılan', () => {
    expect(totpCode(S, 59)).toBe('287082')
  })

  it('verifyTotp ±1 adım kabul, ±2 red; adım sayacını döndürür', () => {
    const t = 1111111109
    const step = Math.floor(t / 30)
    expect(verifyTotp(S, totpCode(S, t), t)).toBe(step)
    expect(verifyTotp(S, totpCode(S, t - 30), t)).toBe(step - 1)
    expect(verifyTotp(S, totpCode(S, t + 30), t)).toBe(step + 1)
    expect(verifyTotp(S, totpCode(S, t - 60), t)).toBeNull()
    expect(verifyTotp(S, totpCode(S, t + 60), t)).toBeNull()
  })

  it('verifyTotp geçersiz kodu atmadan reddeder', () => {
    for (const c of ['', '12345', '1234567', 'abcdef', '12 456', '１２３４５６']) {
      expect(verifyTotp(S, c, 59)).toBeNull()
    }
  })

  it('base32 gidiş-dönüş ve RFC 4648 vektörü', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
    for (let n = 0; n < 24; n++) {
      const x = newTotpSecretOfLen(n)
      expect(base32Decode(base32Encode(x)).equals(x)).toBe(true)
    }
    expect(base32Decode('mzxw 6ytb oi======').toString()).toBe('foobar')
    expect(() => base32Decode('MZXW1')).toThrow()
  })

  it('newTotpSecret 20 bayt ve rastgele', () => {
    expect(newTotpSecret()).toHaveLength(20)
    expect(newTotpSecret().equals(newTotpSecret())).toBe(false)
  })

  it('otpauthUri biçimi ve kaçışlama', () => {
    const sec = base32Encode(S)
    expect(otpauthUri(S, 'ali', 'GeckoMail')).toBe(
      `otpauth://totp/GeckoMail:ali?secret=${sec}&issuer=GeckoMail&algorithm=SHA1&digits=6&period=30`
    )
    expect(otpauthUri(S, 'a li@x.com', 'GeckoMail')).toContain('GeckoMail:a%20li%40x.com?')
  })
})

function newTotpSecretOfLen(n: number): Buffer {
  return Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff))
}
