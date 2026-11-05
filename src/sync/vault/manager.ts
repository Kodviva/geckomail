import type { VaultStatus } from '../../shared/rpc'
import type { Queries } from '../db/queries'
import { decrypt, deriveKey, deriveKeyAsync, encrypt, makeVaultCheck, newSalt, verifyVaultCheck } from './crypto'
import { getVaultKey, isVaultUnlocked, setVaultKey } from './state'
import { t } from '../../shared/i18n'

const SALT_KEY = 'vault_salt'
const CHECK_KEY = 'vault_check'
const BIO_FLAG = 'vault_biometric'
const BIO_BLOB = 'vault_biometric_blob' // kasa parolasının safeStorage-şifreli hali (base64), Touch ID kolaylığı için

export function getVaultStatus(q: Queries): VaultStatus {
  if (!q.prefGet(CHECK_KEY)) return 'none'
  return isVaultUnlocked() ? 'unlocked' : 'locked'
}

// yan etkisiz doğrulama — Touch ID etkinleştirmede "parola doğru mu" kontrolü için
export function verifyVaultPassphrase(q: Queries, passphrase: string): boolean {
  const saltB64 = q.prefGet(SALT_KEY)
  const check = q.prefGet(CHECK_KEY)
  if (!saltB64 || !check) return false
  return verifyVaultCheck(deriveKey(passphrase, Buffer.from(saltB64, 'base64')), check)
}

/** Parola RPC'leri için: scrypt 64 MB olay döngüsünde çalışmaz */
export async function verifyVaultPassphraseAsync(q: Queries, passphrase: string): Promise<boolean> {
  const saltB64 = q.prefGet(SALT_KEY)
  const check = q.prefGet(CHECK_KEY)
  if (!saltB64 || !check) return false
  return verifyVaultCheck(await deriveKeyAsync(passphrase, Buffer.from(saltB64, 'base64')), check)
}

export function isBiometricEnabled(q: Queries): boolean {
  return q.prefGet(BIO_FLAG) === '1' && !!q.prefGet(BIO_BLOB)
}
export function setBiometricBlob(q: Queries, base64: string): void {
  q.prefSet(BIO_BLOB, base64)
  q.prefSet(BIO_FLAG, '1')
}
export function getBiometricBlob(q: Queries): string | null {
  return isBiometricEnabled(q) ? (q.prefGet(BIO_BLOB) ?? null) : null
}
export function clearBiometric(q: Queries): void {
  q.prefSet(BIO_FLAG, '0')
  q.prefSet(BIO_BLOB, '')
}

// İlk kurulum: rastgele salt + parola-türevli anahtar + doğrulama token'ı. Anahtar bellekte açık kalır.
export function createVault(q: Queries, password: string): void {
  if (q.prefGet(CHECK_KEY)) throw new Error(t('sync.vault.alreadySetUp'))
  if (password.length < 8) throw new Error(t('sync.vault.passphraseTooShort'))
  const salt = newSalt()
  const key = deriveKey(password, salt)
  q.prefSet(SALT_KEY, salt.toString('base64'))
  q.prefSet(CHECK_KEY, makeVaultCheck(key))
  setVaultKey(key)
}

// Açılış: parolayı doğrula, kasa hesaplarının IMAP şifrelerini çöz creds Map'e ekle. Başarı=true.
export function unlockVault(q: Queries, creds: Map<number, string>, password: string): boolean {
  const saltB64 = q.prefGet(SALT_KEY)
  const check = q.prefGet(CHECK_KEY)
  if (!saltB64 || !check) throw new Error(t('sync.vault.notSetUp'))
  return openWithKey(q, creds, deriveKey(password, Buffer.from(saltB64, 'base64')), check)
}

export async function unlockVaultAsync(q: Queries, creds: Map<number, string>, password: string): Promise<boolean> {
  const saltB64 = q.prefGet(SALT_KEY)
  const check = q.prefGet(CHECK_KEY)
  if (!saltB64 || !check) throw new Error(t('sync.vault.notSetUp'))
  return openWithKey(q, creds, await deriveKeyAsync(password, Buffer.from(saltB64, 'base64')), check)
}

function openWithKey(q: Queries, creds: Map<number, string>, key: Buffer, check: string): boolean {
  if (!verifyVaultCheck(key, check)) return false
  setVaultKey(key)
  for (const row of q.getAccountRows()) {
    if (!row.secure) continue
    try {
      creds.set(row.id, decrypt(key, row.password_enc).toString('utf-8'))
    } catch {
      /* tek hesabın cred'i çözülemedi — diğerlerini düşürme */
    }
  }
  return true
}

// Kilit: anahtarı sıfırla, kasa hesap cred'lerini Map'ten kaldır. Scheduler onları zaten atlar.
export function lockVault(q: Queries, creds: Map<number, string>): void {
  for (const row of q.getAccountRows()) if (row.secure) creds.delete(row.id)
  setVaultKey(null)
}

// Bir hesabın IMAP şifresini kasa anahtarıyla şifreli BLOB'a çevir (canlı→kasa geçişinde kullanılır).
export function encryptAccountPassword(plainPassword: string): Buffer {
  const key = getVaultKey()
  if (!key) throw new Error(t('sync.vault.locked'))
  return encrypt(key, Buffer.from(plainPassword, 'utf-8'))
}
