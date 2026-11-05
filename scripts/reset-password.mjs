#!/usr/bin/env node
// Şifre kurtarma aracı: veritabanına doğrudan yerel erişim gerektirir, elle terminalde
// çalıştırılır. Yeni şifre yalnızca bu terminalde kalır — hiçbir zaman ağa/dışarıya gönderilmez.
// better-sqlite3 Electron'un Node ABI'siyle derlendiğinden system node ile çalışmaz —
// bkz. package.json "reset-password" script'i (ELECTRON_RUN_AS_NODE ile çalıştırır).
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, scryptSync } from 'node:crypto'
import Database from 'better-sqlite3'

const N = 16384
const R = 8
const P = 1
const KEYLEN = 64

// src/sync/auth/password.ts ile birebir aynı format — orada değişirse burada da değişmeli
function hashPassword(plain) {
  const salt = randomBytes(16)
  const hash = scryptSync(plain, salt, KEYLEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

const dbPath = join(homedir(), 'Library', 'Application Support', 'geckomail', 'geckomail.db')
const db = new Database(dbPath)
db.pragma('busy_timeout = 5000')

const users = db.prepare('SELECT id, username, role FROM users ORDER BY id').all()
if (!users.length) {
  console.error('Hiç kullanıcı yok — uygulamanın kendisi ilk açılışta "İlk Kurulum" ekranını gösterecektir.')
  process.exit(1)
}

console.log('Kullanıcılar:')
for (const u of users) console.log(`  ${u.id}. ${u.username} (${u.role})`)

const rl = createInterface({ input: stdin, output: stdout })
try {
  const idInput = await rl.question('\nHangi kullanıcının şifresi sıfırlansın? (id gir): ')
  const user = users.find((u) => String(u.id) === idInput.trim())
  if (!user) throw new Error('Geçersiz id.')

  // Girdi bu terminalde görünür yazılıyor (maskelenmiş readline karmaşıklığından
  // kaçınıldı) — nadiren kullanılan bir kurtarma aracı, kırılgan raw-mode kodundan daha değerli
  console.log('(yeni şifre bu ekranda görünür şekilde yazılacak)')
  const pw1 = await rl.question(`Yeni şifre (${user.username} için, en az 8 karakter): `)
  if (pw1.length < 8) throw new Error('Şifre en az 8 karakter olmalı.')
  const pw2 = await rl.question('Yeni şifre (tekrar): ')
  if (pw1 !== pw2) throw new Error('Şifreler eşleşmiyor.')

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw1), user.id)
  console.log(`\n${user.username} için şifre güncellendi. GeckoMail açıksa yeniden başlatman gerekebilir.`)
} catch (e) {
  console.error(`\n${e.message}`)
  process.exitCode = 1
} finally {
  rl.close()
}
