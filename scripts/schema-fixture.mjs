#!/usr/bin/env node
// Yükseltme fikstürü: göçlerin ilk `version` dosyası üstüne sahte seed. Gerçek kullanıcı dosyasına dokunmaz,
// yalnız verilen yola yazar; yol zaten varsa üzerine yazılır. Kullanım: node scripts/schema-fixture.mjs <yol> <18|24>
import Database from 'better-sqlite3'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(here, '..', 'src', 'sync', 'db', 'migrations')
const seed = (name) => readFileSync(join(here, 'fixtures', name), 'utf-8')

export const migrationCount = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).length

/** seed-24 yalnız 019–024 tablolarını ekler, seed-18'in üstüne çalışır */
export function seedSql(version) {
  if (version === 18) return seed('seed-18.sql')
  if (version === 24) return seed('seed-18.sql') + seed('seed-24.sql')
  throw new Error(`desteklenmeyen fikstür şeması: ${version}`)
}

export function buildFixture(path, version) {
  const sql = seedSql(version)
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort().slice(0, version)
  const db = new Database(path)
  try {
    db.pragma('foreign_keys = ON')
    for (const f of files) db.exec(readFileSync(join(MIGRATIONS, f), 'utf-8'))
    db.exec(sql)
    db.pragma(`user_version = ${version}`)
  } finally {
    db.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [path, version] = process.argv.slice(2)
  if (!path || !version) {
    console.error('kullanım: node scripts/schema-fixture.mjs <yol> <18|24>')
    process.exit(1)
  }
  buildFixture(path, Number(version))
}
