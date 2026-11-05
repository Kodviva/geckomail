#!/usr/bin/env node
// Basit smoke test: production build'i (out/) gerçek electron binary'siyle başlatır,
// sync sürecinin "hazır" satırını loglamasını bekler. shared/ dışındaki (Electron'un
// kendisiyle ilgili) regresyonları yakalamak için — Playwright gibi yeni bir bağımlılık
// eklemeden, mevcut "npm run dev" sırasında zaten gözlemlenen aynı log satırını kullanır.
//   --seed <db>  verilen veritabanının kopyasıyla açar, göçlerin bittiğini de denetler
//   --upgrade    şema 18 ve 24 fikstürlerini üretip ikisini de --seed gibi açar (npm run smoke:upgrade)
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFixture, migrationCount } from './schema-fixture.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// .bin/electron.cmd Windows'ta shell'siz spawn edilemez (EINVAL): ikili doğrudan. Paket kurulumda indirmez, ilk çağrıda indirir
const electronBin = createRequire(import.meta.url)('electron')
const READY_LINE = 'sync: hazır'
const KEYLESS_LINE = 'smoke: Keychain kapalı'
const SMIME_LINE = 'sync: smime hazır' // paketli çalışma zamanı (BoringSSL) S/MIME şifrelerini sunuyor
const TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 25_000
// Windows'ta elektron penceresiz çıktı boruya düşmez: uygulama açıldı ve göçler bitti mi veritabanından okunur
const NO_STDOUT = process.platform === 'win32'

function runSmoke(seed) {
  return new Promise((resolve) => {
    // Gerçek kullanıcı verisine ASLA dokunmaz: geçici boş veri dizini (göçler de orada çalışır).
    const userData = mkdtempSync(join(tmpdir(), 'gecko-smoke-'))
    const dbPath = join(userData, 'geckomail.db')
    if (seed) copyFileSync(seed, dbPath)
    // fikstürde parolalı hesap var: motor açılışta çözmek ister, Keychain'e gidilmez
    const args = [...(seed ? ['-r', join(root, 'scripts', 'smoke-keyless.cjs')] : []), '.', `--user-data-dir=${userData}`]
    const child = spawn(electronBin, args, { cwd: root, env: { ...process.env, GECKO_SMOKE_SMIME: '1' } })

    let out = ''
    let done = false
    let timer

    function finish(ok, reason) {
      if (done) return
      done = true
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) {
        child.once('exit', () => cleanup(ok, reason))
        child.kill()
      } else cleanup(ok, reason)
    }

    function cleanup(ok, reason) {
      if (ok && seed && !NO_STDOUT && !out.includes(KEYLESS_LINE)) {
        ok = false
        reason = 'smoke-keyless.cjs yüklenmedi'
      }
      if (ok && seed) {
        const db = new Database(dbPath, { readonly: true })
        const version = db.pragma('user_version', { simple: true })
        db.close()
        if (version !== migrationCount()) {
          ok = false
          reason = `şema ${version}, beklenen ${migrationCount()}`
        }
      }
      if (ok) {
        console.log(`smoke: OK — uygulama başladı${NO_STDOUT ? ', veritabanı güncel (S/MIME satırı Windows\'ta okunamaz)' : ` ve senkron hazır oldu (${SMIME_LINE})`}${seed ? ` (${seed})` : ''}`)
      } else {
        console.error(`smoke: FAIL — ${reason}\n--- son çıktı ---\n${out.slice(-2000)}`)
      }
      try {
        rmSync(userData, { recursive: true, force: true })
      } catch {
        /* geçici dizin; OS temizler */
      }
      resolve(ok)
    }

    timer = setTimeout(() => finish(false, `${TIMEOUT_MS}ms içinde "${READY_LINE}" ve "${SMIME_LINE}" görülmedi`), TIMEOUT_MS)

    function onData(buf) {
      out += buf.toString()
      if (out.includes(READY_LINE) && out.includes(SMIME_LINE)) finish(true)
    }
    if (NO_STDOUT) {
      const poll = setInterval(() => {
        if (done) return clearInterval(poll)
        try {
          const db = new Database(dbPath, { readonly: true })
          const version = db.pragma('user_version', { simple: true })
          db.close()
          if (version === migrationCount()) {
            clearInterval(poll)
            finish(true)
          }
        } catch {
          /* dosya henüz yok ya da kilitli */
        }
      }, 2000)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (err) => finish(false, `electron başlatılamadı: ${err.message}`))
    child.on('exit', (code) => {
      if (!done) finish(false, `electron beklenmedik şekilde çıktı (kod ${code})`)
    })
  })
}

async function runUpgrade() {
  const dir = mkdtempSync(join(tmpdir(), 'gecko-fixture-'))
  try {
    let ok = true
    for (const version of [18, 24]) {
      const path = join(dir, `sema${version}.db`)
      buildFixture(path, version)
      ok = (await runSmoke(path)) && ok
    }
    return ok
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const argv = process.argv.slice(2)
const seedAt = argv.indexOf('--seed')
if (seedAt >= 0 && !argv[seedAt + 1]) {
  console.error('kullanım: node scripts/smoke.mjs [--seed <db> | --upgrade]')
  process.exit(1)
}
const ok = await (argv.includes('--upgrade') ? runUpgrade() : runSmoke(seedAt >= 0 ? argv[seedAt + 1] : null))
process.exit(ok ? 0 : 1)
