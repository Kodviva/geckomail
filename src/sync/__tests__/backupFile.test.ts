import { describe, expect, it } from 'vitest'
import { isEncryptedBackup, openBackup, sealBackup, sealBackupFile } from '../backupFile'

const SQLITE = Buffer.concat([Buffer.from('SQLite format 3\u0000'), Buffer.from('gövde-verisi-çğş')])

describe('yedek dosya biçimi (R18)', () => {
  it('şifresiz yedek olduğu gibi açılır', () => {
    expect(openBackup(SQLITE).equals(SQLITE)).toBe(true)
  })
  it('parolalı yedek: içerik okunmaz, doğru parolayla açılır', () => {
    const sealed = sealBackup(SQLITE, 'güçlü-parola-1')
    expect(isEncryptedBackup(sealed)).toBe(true)
    expect(sealed.includes(Buffer.from('gövde-verisi'))).toBe(false)
    expect(openBackup(sealed, 'güçlü-parola-1').equals(SQLITE)).toBe(true)
  })
  it('yanlış/eksik parola ve yabancı dosya anlaşılır hata verir', () => {
    const sealed = sealBackup(SQLITE, 'güçlü-parola-1')
    expect(() => openBackup(sealed)).toThrow(/parolalı/)
    expect(() => openBackup(sealed, 'yanlış-parola')).toThrow(/yanlış/)
    expect(() => openBackup(Buffer.from('PK\u0003\u0004zip'))).toThrow(/yedeği değil/)
    expect(() => sealBackup(SQLITE, 'kısa')).toThrow(/8 karakter/)
  })
})

import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'

describe('gerçek veritabanı yedeği uçtan uca', () => {
  it('backupTo → mühürle → aç → geçerli GeckoMail DB (hesap sayısı okunur)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gecko-bk-'))
    const q = makeQueries(openDb(dir))
    q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    const snap = join(dir, 'yedek.sqlite')
    await q.backupTo(snap)
    const sealed = sealBackup(readFileSync(snap), 'güçlü-parola-1')
    const staged = join(dir, 'restore.db')
    writeFileSync(staged, openBackup(sealed, 'güçlü-parola-1'))
    const probe = new Database(staged, { readonly: true })
    expect((probe.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(1)
    expect(probe.pragma('user_version', { simple: true })).toBeGreaterThan(0)
    probe.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('akışlı yedek dosyası (sunucu: büyük DB belleğe alınmaz)', () => {
  it('sealBackupFile ↔ openBackup ve sealBackup ↔ openBackupFile aynı biçim', async () => {
    const { sealBackupFile, openBackupFile } = await import('../backupFile')
    const dir = mkdtempSync(join(tmpdir(), 'gecko-bks-'))
    try {
      const plain = Buffer.concat([SQLITE, Buffer.alloc(3 * 1024 * 1024, 7)])
      writeFileSync(join(dir, 'duz.db'), plain)
      await sealBackupFile(join(dir, 'duz.db'), join(dir, 'a.geckobak'), 'güçlü-parola-1')
      const sealed = readFileSync(join(dir, 'a.geckobak'))
      expect(isEncryptedBackup(sealed)).toBe(true)
      expect(openBackup(sealed, 'güçlü-parola-1').equals(plain)).toBe(true)
      writeFileSync(join(dir, 'b.geckobak'), sealBackup(plain, 'güçlü-parola-1'))
      await openBackupFile(join(dir, 'b.geckobak'), join(dir, 'b.db'), 'güçlü-parola-1')
      expect(readFileSync(join(dir, 'b.db')).equals(plain)).toBe(true)
      // şifresiz SQLite olduğu gibi kopyalanır
      await openBackupFile(join(dir, 'duz.db'), join(dir, 'c.db'))
      expect(readFileSync(join(dir, 'c.db')).equals(plain)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('openBackupFile: yanlış parola, eksik parola, yabancı dosya → kodlu hata, çıktı dosyası kalmaz', async () => {
    const { openBackupFile, BackupError } = await import('../backupFile')
    const dir = mkdtempSync(join(tmpdir(), 'gecko-bks-'))
    try {
      writeFileSync(join(dir, 'a.geckobak'), sealBackup(SQLITE, 'güçlü-parola-1'))
      writeFileSync(join(dir, 'zip'), Buffer.from('PK\u0003\u0004zip'))
      const code = async (p: Promise<void>) => p.then(() => 'ok', (e: unknown) => (e instanceof BackupError ? e.code : String(e)))
      expect(await code(openBackupFile(join(dir, 'a.geckobak'), join(dir, 'o1'), 'yanlış-parola'))).toBe('badPassphrase')
      expect(await code(openBackupFile(join(dir, 'a.geckobak'), join(dir, 'o2')))).toBe('passphraseRequired')
      expect(await code(openBackupFile(join(dir, 'zip'), join(dir, 'o3')))).toBe('notABackup')
      for (const o of ['o1', 'o2', 'o3']) expect(existsSync(join(dir, o)), o).toBe(false)
      await expect(sealBackupFile(join(dir, 'zip'), join(dir, 'k'), 'kısa')).rejects.toThrow(/8 karakter/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('openBackupFile hata ayrımı', () => {
  it('yazma hatası parola hatası sayılmaz: olduğu gibi fırlar', async () => {
    const { openBackupFile, BackupError } = await import('../backupFile')
    const dir = mkdtempSync(join(tmpdir(), 'gecko-bks-'))
    try {
      writeFileSync(join(dir, 'a.geckobak'), sealBackup(SQLITE, 'güçlü-parola-1'))
      // hedef dizin yok: yazma akışı ENOENT ile düşer (doğru parolayla bile)
      const e = await openBackupFile(join(dir, 'a.geckobak'), join(dir, 'yok', 'cikti.db'), 'güçlü-parola-1').then(() => null, (x: unknown) => x)
      expect(e).toBeInstanceOf(Error)
      expect(e).not.toBeInstanceOf(BackupError)
      expect((e as NodeJS.ErrnoException).code).toBe('ENOENT')
      // yanlış parola yine badPassphrase
      const w = await openBackupFile(join(dir, 'a.geckobak'), join(dir, 'b.db'), 'yanlış-parola').then(() => null, (x: unknown) => x)
      expect((w as InstanceType<typeof BackupError>).code).toBe('badPassphrase')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
