// Taşıma zarfı: TLS üstüne uygulama katmanı. P-256 ECDH + HKDF-SHA256 + AES-256-GCM, öge başına geçici anahtar.
// Edilgen ters vekil düz parola görmez; TLS'i sonlandıran etkin vekil `serverKey`i değiştirebilir, köken onayı buna karşı değildir.
// Saf modül: DB ve Electron bilmez.
import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from 'crypto'
import type { Sealed } from '../shared/importTypes'

export type { Sealed } from '../shared/importTypes'

const CURVE = 'prime256v1'
const INFO = 'geckomail-import-v1'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

const aad = (importId: string, key: string): Buffer => Buffer.from(`${importId}:${key}`, 'utf-8')

/** Tuz iki açık anahtardır: türetilen anahtar iki uca bağlanır */
function contentKey(shared: Buffer, ephemeralPub: Buffer, serverPub: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeralPub, serverPub]), INFO, KEY_BYTES))
}

export function newImportKeys(): { publicKey: string; open(s: Sealed, importId: string): Buffer } {
  const ecdh = createECDH(CURVE)
  const pub = ecdh.generateKeys()
  return {
    publicKey: pub.toString('base64'),
    open(s, importId) {
      const ephemeral = Buffer.from(s.pub, 'base64')
      const iv = Buffer.from(s.iv, 'base64')
      const body = Buffer.from(s.ct, 'base64')
      if (iv.length !== IV_BYTES || body.length < TAG_BYTES) throw new Error('zarf bozuk')
      const d = createDecipheriv('aes-256-gcm', contentKey(ecdh.computeSecret(ephemeral), ephemeral, pub), iv, { authTagLength: TAG_BYTES })
      d.setAAD(aad(importId, s.key))
      d.setAuthTag(body.subarray(body.length - TAG_BYTES))
      return Buffer.concat([d.update(body.subarray(0, body.length - TAG_BYTES)), d.final()])
    }
  }
}

/** Geçersiz sunucu anahtarında `computeSecret` fırlatır */
export function sealItem(serverPub: string, importId: string, key: string, plain: Buffer): Sealed {
  const server = Buffer.from(serverPub, 'base64')
  const ecdh = createECDH(CURVE)
  const ephemeral = ecdh.generateKeys()
  const iv = randomBytes(IV_BYTES)
  const c = createCipheriv('aes-256-gcm', contentKey(ecdh.computeSecret(server), ephemeral, server), iv, { authTagLength: TAG_BYTES })
  c.setAAD(aad(importId, key))
  const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])
  return { key, pub: ephemeral.toString('base64'), iv: iv.toString('base64'), ct: body.toString('base64') }
}
