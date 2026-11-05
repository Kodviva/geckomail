// Yedek dosya biçimi (R18). Şifresiz: düz SQLite dosyası (.sqlite). Parolalı: 'GECKOBAK1' + tuz(16) +
// AES-256-GCM(scrypt(parola, tuz)) (.geckobak) — kasa modu kriptosu yeniden kullanılır. Yedekteki hesap
// şifreleri bu Mac'in Anahtar Zinciri'ne bağlıdır: başka Mac'te geri yüklenirse şifreler yeniden girilmeli.
// Sunucu (web yedeği) aynı biçimi akışla yazar/okur: büyük DB belleğe alınmaz (sealBackupFile/openBackupFile).
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { closeSync, createReadStream, createWriteStream, openSync, readSync, rmSync, statSync } from 'fs'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { decrypt, deriveKey, deriveKeyAsync, encrypt, newSalt } from './vault/crypto'
import { t } from '../shared/i18n'

const MAGIC = Buffer.from('GECKOBAK1')
const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000')
const SALT_LEN = 16
const NONCE_LEN = 12
const TAG_LEN = 16

export type BackupErrorCode = 'passphraseTooShort' | 'passphraseRequired' | 'badPassphrase' | 'notABackup'

/** Kodlu yedek hatası (sunucu kodu yanıta koyar; ileti arayüz dilinde, masaüstü onu gösterir) */
export class BackupError extends Error {
  constructor(readonly code: BackupErrorCode, message: string) {
    super(message)
  }
}

const err = (code: BackupErrorCode): BackupError =>
  new BackupError(code, t({
    passphraseTooShort: 'sync.backup.passphraseTooShort',
    passphraseRequired: 'sync.backup.passphraseRequired',
    badPassphrase: 'sync.backup.wrongPassphrase',
    notABackup: 'sync.backup.notABackup'
  }[code]))

export function isEncryptedBackup(buf: Buffer): boolean {
  return buf.subarray(0, MAGIC.length).equals(MAGIC)
}

export function sealBackup(plain: Buffer, passphrase: string): Buffer {
  if (passphrase.length < 8) throw err('passphraseTooShort')
  const salt = newSalt()
  return Buffer.concat([MAGIC, salt, encrypt(deriveKey(passphrase, salt), plain)])
}

/** Yedek dosyasından SQLite içeriğini çıkar; biçim/parola hatasında anlaşılır hata. */
export function openBackup(file: Buffer, passphrase?: string): Buffer {
  let plain = file
  if (isEncryptedBackup(file)) {
    if (!passphrase) throw err('passphraseRequired')
    const salt = file.subarray(MAGIC.length, MAGIC.length + SALT_LEN)
    try {
      plain = decrypt(deriveKey(passphrase, salt), file.subarray(MAGIC.length + SALT_LEN))
    } catch {
      throw err('badPassphrase')
    }
  }
  if (!plain.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) throw err('notABackup')
  return plain
}

/** Dosyanın baştan n baytı (kısa dosyada daha az) */
function head(path: string, n: number, at = 0): Buffer {
  const fd = openSync(path, 'r')
  try {
    const b = Buffer.alloc(n)
    return b.subarray(0, readSync(fd, b, 0, n, at))
  } finally {
    closeSync(fd)
  }
}

/** sealBackup'ın akışlı hâli: src (SQLite) → dest (.geckobak), aynı bayt düzeni
 *  (MAGIC + tuz + nonce + şifreli + etiket). Hata olursa dest silinir. */
export async function sealBackupFile(src: string, dest: string, passphrase: string): Promise<void> {
  if (passphrase.length < 8) throw err('passphraseTooShort')
  const salt = newSalt()
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', await deriveKeyAsync(passphrase, salt), nonce)
  // başlık önce, sonda etiket: tek geçişte, içerik belleğe alınmadan
  let first = true
  const seal = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const ct = cipher.update(chunk)
      cb(null, first ? ((first = false), Buffer.concat([MAGIC, salt, nonce, ct])) : ct)
    },
    flush(cb) {
      const fin = cipher.final()
      cb(null, Buffer.concat([first ? Buffer.concat([MAGIC, salt, nonce]) : Buffer.alloc(0), fin, cipher.getAuthTag()]))
    }
  })
  try {
    await pipeline(createReadStream(src), seal, createWriteStream(dest, { flags: 'wx', mode: 0o600 }))
  } catch (e) {
    rmSync(dest, { force: true })
    throw e
  }
}

/** openBackup'ın akışlı hâli: yedek (şifreli ya da düz SQLite) → dest düz SQLite. Etiket doğrulanmadan yazılan
 *  çıktı hatada silinir (dest çağıranın geçici dosyasıdır; yerine koymak çağırana kalır). */
export async function openBackupFile(src: string, dest: string, passphrase?: string): Promise<void> {
  const size = statSync(src).size
  const prefix = head(src, Math.max(MAGIC.length, SQLITE_HEADER.length))
  try {
    if (isEncryptedBackup(prefix)) {
      if (!passphrase) throw err('passphraseRequired')
      if (size < MAGIC.length + SALT_LEN + NONCE_LEN + TAG_LEN) throw err('notABackup')
      const salt = head(src, SALT_LEN, MAGIC.length)
      const nonce = head(src, NONCE_LEN, MAGIC.length + SALT_LEN)
      const tag = head(src, TAG_LEN, size - TAG_LEN)
      // KDF hatası (bellek vb.) parola hatası sayılmaz: olduğu gibi fırlar
      const key = await deriveKeyAsync(passphrase, salt)
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAuthTag(tag)
      const start = MAGIC.length + SALT_LEN + NONCE_LEN
      const end = size - TAG_LEN - 1
      // yalnız GCM etiket doğrulaması (yanlış anahtar ya da kurcalanmış dosya) badPassphrase'dir; disk/G-Ç
      // hataları (ENOSPC, EIO…) olduğu gibi fırlar, çağıran genel hata verir
      let authFailed = false
      const guarded = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          cb(null, decipher.update(chunk))
        },
        flush(cb) {
          try {
            cb(null, decipher.final())
          } catch {
            authFailed = true
            cb(err('badPassphrase'))
          }
        }
      })
      if (end < start) {
        // boş içerik: yalnız etiket doğrulanır
        try {
          decipher.final()
        } catch {
          throw err('badPassphrase')
        }
        throw err('notABackup')
      }
      try {
        await pipeline(createReadStream(src, { start, end }), guarded, createWriteStream(dest, { flags: 'wx', mode: 0o600 }))
      } catch (e) {
        if (authFailed) throw err('badPassphrase')
        throw e
      }
    } else {
      if (!prefix.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) throw err('notABackup')
      await pipeline(createReadStream(src), createWriteStream(dest, { flags: 'wx', mode: 0o600 }))
    }
    if (!head(dest, SQLITE_HEADER.length).equals(SQLITE_HEADER)) throw err('notABackup')
  } catch (e) {
    rmSync(dest, { force: true })
    throw e
  }
}
