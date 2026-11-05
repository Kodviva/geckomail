// Sunucu ana anahtarı: parolalar/belirteçler diskte bu anahtarla AES-256-GCM şifreli durur.
// Anahtar dosyası yalnız süreç sahibinin okuyabildiği (0600) bir dosyadır; gevşek izinli dosya reddedilir.
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeSync } from 'fs'

export const KEY_BYTES = 32
const MAGIC = Buffer.from('GKS1')
const NONCE = 12
const TAG = 16

/** Anahtarı okur; yoksa 0600 ile üretir. Hata iletileri anahtar baytı içermez. */
export function loadOrCreateMasterKey(path: string): Buffer {
  if (!existsSync(path)) {
    // yarım yazılmış anahtar görünmesin: aynı dizinde 0600 geçici dosyaya yaz, fsync, sonra linkSync ile yerine koy
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    const tfd = openSync(tmp, 'wx', 0o600)
    try {
      writeSync(tfd, randomBytes(KEY_BYTES))
      fsyncSync(tfd)
    } finally {
      closeSync(tfd)
    }
    try {
      chmodSync(tmp, 0o600) // umask ne olursa olsun
      linkSync(tmp, path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e // yarışı kaybettik: var olanı okuruz
    } finally {
      unlinkSync(tmp)
    }
  }
  const fd = openSync(path, 'r')
  let key: Buffer
  try {
    const st = fstatSync(fd)
    if ((st.mode & 0o077) !== 0) throw new Error('gecko.key.insecure')
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('gecko.key.insecure')
    key = readFileSync(fd)
  } finally {
    closeSync(fd)
  }
  if (key.length !== KEY_BYTES) throw new Error('gecko.key.size')
  return key
}

/** 'GKS1'(4) || nonce(12) || şifreli metin || etiket(16) */
export function sealWithKey(key: Buffer, plain: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE)
  const c = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([MAGIC, nonce, ct, c.getAuthTag()])
}

export function hasSealPrefix(blob: Uint8Array): boolean {
  return blob.length >= MAGIC.length && Buffer.from(blob.subarray(0, MAGIC.length)).equals(MAGIC)
}

export function openWithKey(key: Buffer, blob: Uint8Array): Uint8Array {
  if (!hasSealPrefix(blob) || blob.length < MAGIC.length + NONCE + TAG) throw new Error('gecko.key.badBlob')
  const b = Buffer.from(blob)
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(4, 4 + NONCE))
  d.setAuthTag(b.subarray(b.length - TAG))
  try {
    return Buffer.concat([d.update(b.subarray(4 + NONCE, b.length - TAG)), d.final()])
  } catch {
    throw new Error('gecko.key.badBlob')
  }
}
