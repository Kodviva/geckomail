import { createCipheriv, createDecipheriv, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { t } from '../../shared/i18n'

// Kasa modu at-rest şifreleme — saf, IO yok, YALNIZCA sync sürecinde (node:crypto renderer'a
// asla sızmamalı; anahtar da renderer'a gitmez). scrypt N=2^16 (~64MB, launch başına bir kez).
// src/sync/auth/password.ts'teki KDF'den ayrı: o tek-yönlü kimlik doğrulama, bu iki-yönlü şifreleme.
const SCRYPT = { N: 65536, r: 8, p: 1, maxmem: 100 * 1024 * 1024 } as const
const KEYLEN = 32
const NONCE_LEN = 12
const TAG_LEN = 16
const VAULT_CHECK_CONST = 'geckomail-vault-v1'

export function newSalt(): Buffer {
  return randomBytes(16)
}

export function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEYLEN, SCRYPT)
}

/** deriveKey'in olay döngüsünü bloklamayan hâli (sunucu: istek işlerken diğer bağlantılar beklemesin) */
export function deriveKeyAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, KEYLEN, SCRYPT, (e, k) => (e ? reject(e) : resolve(k))))
}

// blob düzeni: nonce(12) || ciphertext || tag(16)
export function encrypt(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, ct, cipher.getAuthTag()])
}

export function decrypt(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < NONCE_LEN + TAG_LEN) throw new Error(t('sync.vault.corruptData'))
  const nonce = blob.subarray(0, NONCE_LEN)
  const tag = blob.subarray(blob.length - TAG_LEN)
  const ct = blob.subarray(NONCE_LEN, blob.length - TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]) // yanlış anahtar/kurcalanma → final() atar
}

// metin kolonları TEXT olduğundan base64 sarmalanır
export function encryptText(key: Buffer, s: string): string {
  return encrypt(key, Buffer.from(s, 'utf-8')).toString('base64')
}

export function decryptText(key: Buffer, b64: string): string {
  return decrypt(key, Buffer.from(b64, 'base64')).toString('utf-8')
}

// açılış doğrulama token'ı: bilinen sabiti şifreler; çözülüp sabite eşitse parola doğru
export function makeVaultCheck(key: Buffer): string {
  return encryptText(key, VAULT_CHECK_CONST)
}

export function verifyVaultCheck(key: Buffer, check: string): boolean {
  try {
    const got = Buffer.from(decryptText(key, check), 'utf-8')
    const want = Buffer.from(VAULT_CHECK_CONST, 'utf-8')
    return got.length === want.length && timingSafeEqual(got, want)
  } catch {
    return false
  }
}
