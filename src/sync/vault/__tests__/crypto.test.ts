import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decrypt, decryptText, deriveKey, encrypt, encryptText, makeVaultCheck, newSalt, verifyVaultCheck } from '../crypto'

// scrypt N=2^16 pahalı — cipher testleri ham 32-baytlık anahtarla, KDF ayrı test edilir.
const KEY = randomBytes(32)

describe('vault crypto — cipher', () => {
  it('şifrele→çöz round-trip aynı veriyi verir', () => {
    const plain = Buffer.from('kritik mail gövdesi — çğşıöü', 'utf-8')
    expect(decrypt(KEY, encrypt(KEY, plain)).equals(plain)).toBe(true)
  })

  it('metin sarmalayıcısı round-trip', () => {
    const s = 'Konu: SLA ihlali #42'
    expect(decryptText(KEY, encryptText(KEY, s))).toBe(s)
  })

  it('yanlış anahtar → GCM auth hatası (sessizce yanlış veri değil)', () => {
    const blob = encrypt(KEY, Buffer.from('gizli'))
    expect(() => decrypt(randomBytes(32), blob)).toThrow()
  })

  it('kurcalanmış ciphertext → auth hatası', () => {
    const blob = encrypt(KEY, Buffer.from('gizli'))
    blob[blob.length - 1] ^= 0xff // tag'i boz
    expect(() => decrypt(KEY, blob)).toThrow()
  })

  it('aynı girdi her seferinde farklı ciphertext (nonce rastgele)', () => {
    const a = encrypt(KEY, Buffer.from('aynı'))
    const b = encrypt(KEY, Buffer.from('aynı'))
    expect(a.equals(b)).toBe(false)
  })
})

describe('vault crypto — KDF & vault-check', () => {
  it('aynı parola+salt → aynı anahtar, farklı salt → farklı anahtar', () => {
    const salt = newSalt()
    const k1 = deriveKey('parola', salt)
    const k2 = deriveKey('parola', salt)
    const k3 = deriveKey('parola', newSalt())
    expect(k1.equals(k2)).toBe(true)
    expect(k1.equals(k3)).toBe(false)
  })

  it('vault-check doğru anahtarı kabul, yanlışı reddeder', () => {
    const salt = newSalt()
    const key = deriveKey('doğru-parola', salt)
    const check = makeVaultCheck(key)
    expect(verifyVaultCheck(key, check)).toBe(true)
    expect(verifyVaultCheck(deriveKey('yanlış-parola', salt), check)).toBe(false)
  })
})
