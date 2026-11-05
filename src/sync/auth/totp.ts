// TOTP (RFC 6238, HMAC-SHA1) ve base32 (RFC 4648): yalnız node:crypto, ek bağımlılık yok.
// Sır baytları hiçbir hata iletisine yazılmaz.
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

const ALFABE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(b: Buffer): string {
  let bits = 0
  let val = 0
  let out = ''
  for (const byte of b) {
    val = (val << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALFABE[(val >>> (bits - 5)) & 31]
      bits -= 5
    }
    val &= (1 << bits) - 1
  }
  if (bits > 0) out += ALFABE[(val << (5 - bits)) & 31]
  return out
}

/** Küçük harfi kabul eder, boşluk ve '=' dolgusunu yok sayar; geçersiz karakterde atar. */
export function base32Decode(s: string): Buffer {
  const temiz = s.replace(/[\s=]/g, '').toUpperCase()
  const out: number[] = []
  let bits = 0
  let val = 0
  for (const ch of temiz) {
    const i = ALFABE.indexOf(ch)
    if (i < 0) throw new Error('base32: geçersiz karakter')
    val = (val << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 0xff)
      bits -= 8
    }
    val &= (1 << bits) - 1
  }
  return Buffer.from(out)
}

export function newTotpSecret(): Buffer {
  return randomBytes(20)
}

function hotp(secret: Buffer, counter: number, digits: number): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', secret).update(msg).digest()
  const off = h[h.length - 1] & 0x0f
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}

export function totpCode(secret: Buffer, unixSec: number, digits: 6 | 8 = 6, stepSec = 30): string {
  return hotp(secret, Math.floor(unixSec / stepSec), digits)
}

/** Eşleşen adım sayacını döndürür (tekrar kullanım engeli için saklanır), yoksa null. Sabit zamanlı karşılaştırma. */
export function verifyTotp(secret: Buffer, code: string, unixSec: number, window = 1): number | null {
  if (!/^[0-9]{6}$/.test(code)) return null
  const aday = Buffer.from(code, 'ascii')
  const adim = Math.floor(unixSec / 30)
  let bulunan: number | null = null
  // erken çıkış yok: tüm pencere taranır
  for (let d = -window; d <= window; d++) {
    const c = adim + d
    if (c < 0) continue
    if (timingSafeEqual(aday, Buffer.from(hotp(secret, c, 6), 'ascii')) && bulunan === null) bulunan = c
  }
  return bulunan
}

export function otpauthUri(secret: Buffer, account: string, issuer = 'GeckoMail'): string {
  const iss = encodeURIComponent(issuer)
  return `otpauth://totp/${iss}:${encodeURIComponent(account)}?secret=${base32Encode(secret)}&issuer=${iss}&algorithm=SHA1&digits=6&period=30`
}
