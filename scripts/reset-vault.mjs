#!/usr/bin/env node
// YIKICI kasa sıfırlama: kasa parolası kaybolduğunda son çare. Kasa verisi çözülemediğinden
// tüm kasa hesapları + yerel mailleri ile S/MIME kimlikleri SİLİNİR (sunucudaki mailler etkilenmez —
// hesabı yeniden ekleyebilirsin; S/MIME anahtarı .p12 yedeğinden geri yüklenir). Elle, terminalde, çift onayla. better-sqlite3 Electron ABI'si gerektirir —
// bkz. package.json "reset-vault" (ELECTRON_RUN_AS_NODE ile çalışır).
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const dbPath = join(homedir(), 'Library', 'Application Support', 'geckomail', 'geckomail.db')
const db = new Database(dbPath)
db.pragma('busy_timeout = 5000')
db.pragma('foreign_keys = ON') // hesap silince folders→messages→bodies/attachments cascade'i için şart

const secure = db.prepare('SELECT id, email FROM accounts WHERE secure = 1').all()
// şema 032 öncesi DB'de tablo yoktur
const hasSmime = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'smime_identities'").get()
const identities = hasSmime ? db.prepare('SELECT email FROM smime_identities ORDER BY email').all() : []
if (!secure.length && !identities.length) {
  console.log('Kasa hesabı yok — silinecek bir şey yok. (Kasa parolasını unuttuysan ama kasa hesabın yoksa hiçbir veri kilitli değildir.)')
  process.exit(0)
}

console.log('Aşağıdaki KASA hesapları ve tüm yerel mailleri SİLİNECEK (sunucudaki mailler kalır):')
for (const a of secure) console.log(`  - ${a.email}`)
if (identities.length) {
  console.log('Aşağıdaki S/MIME kimlikleri SİLİNECEK; .p12 yedeği yoksa bu anahtarlara şifrelenmiş postalar bir daha okunamaz:')
  for (const i of identities) console.log(`  - ${i.email}`)
}

const rl = createInterface({ input: stdin, output: stdout })
try {
  const c1 = await rl.question('\nBu geri alınamaz. Devam için büyük harfle EVET yaz: ')
  if (c1.trim() !== 'EVET') throw new Error('İptal edildi.')
  const c2 = await rl.question(`${secure.length} hesabı ve ${identities.length} S/MIME kimliğini silmeyi onaylamak için tekrar EVET yaz: `)
  if (c2.trim() !== 'EVET') throw new Error('İptal edildi.')

  db.transaction(() => {
    const del = db.prepare('DELETE FROM accounts WHERE id = ?')
    for (const a of secure) del.run(a.id) // folders→messages→bodies/attachments cascade
    if (hasSmime) db.prepare('DELETE FROM smime_identities').run()
    // S/MIME op'u kasa dışı hesapta da mühürlü olabilir; eski anahtar gidince sonsuza dek çözülemezdi
    db.prepare("DELETE FROM op_queue WHERE payload_json LIKE 'vault:%'").run()
    db.prepare("DELETE FROM prefs WHERE key IN ('vault_salt', 'vault_check', 'vault_biometric', 'vault_biometric_blob', 'vault_pass_fails')").run()
  })()

  console.log(`\n${secure.length} kasa hesabı ve ${identities.length} S/MIME kimliği silindi, kasa sıfırlandı. Hesapları yeniden ekleyip istersen yeni bir kasa kurabilirsin.`)
} catch (e) {
  console.error(`\n${e.message}`)
  process.exitCode = 1
} finally {
  rl.close()
}
