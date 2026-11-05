// Test yardımcısı: RFC 8291 alıcı tarafı çözümü (tarayıcının yaptığı iş).
import { createDecipheriv, hkdfSync, type ECDH } from 'crypto'

export function decryptPush(body: Buffer, ua: ECDH, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16)
  const idLen = body[20]
  const asPublic = body.subarray(21, 21 + idLen)
  const secret = ua.computeSecret(asPublic)
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, info, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const rest = body.subarray(21 + idLen)
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(rest.subarray(rest.length - 16))
  const plain = Buffer.concat([d.update(rest.subarray(0, rest.length - 16)), d.final()])
  if (plain[plain.length - 1] !== 2) throw new Error('son kayıt ayıracı yok')
  return plain.subarray(0, plain.length - 1)
}
