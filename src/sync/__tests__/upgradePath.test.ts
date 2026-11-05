// Yükseltme kanıtı: 1.0.7 (şema 18) ve geliştirme (şema 24) kopyaları güncel göçlerle temiz açılır. Kopyalar
// üretilir; gerçek kullanıcı veritabanına dokunulmaz.
import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildFixture, seedSql } from '../../../scripts/schema-fixture.mjs'
import { DbTooNewError, migrate, MIGRATIONS, openDb } from '../db'

const MIGRATION_DIR = join(__dirname, '..', 'db', 'migrations')
const migrationFiles = (): string[] => readdirSync(MIGRATION_DIR).filter((f) => f.endsWith('.sql')).sort()
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

// Yayındaki 1.0.7'nin göçleri: bu dosyalar değişirse kurulu kullanıcıların şeması koddan ayrılır
const V107_MIGRATIONS = [
  '001_init.sql:be9b2a02b54a5b01a7f49ea0059cd21f8042b42f87ab156194fa47da98c177c4',
  '002_v1.sql:b017fa47fbc2e05fb48513eeb2c160ab6b0ece1bd7060ce154a712f19ccb5259',
  '003_auth.sql:c600a4372f4b910293a7201327f6465d0f88dc1c37d64ed0029228c77bcb1a9a',
  '004_rules.sql:e92b414742ac3859962c3600f8ffad16c289596051c2ab125422e981d9e90598',
  '005_extras.sql:7e16526e9e02c46cc50b80c947ca45936a4bc2c8f22511613b1120ba406c4730',
  '006_vault.sql:b57aa9790bc99ec45268355f5b4570033907cff1fb48105ea25fc506dbc8c384',
  '007_snooze.sql:24504f2134ecc5a7f7c3a32a8a3e3ccd9c0d6e3433324fc735a89dba7d035b23',
  '008_rules_eligible.sql:8431513e4a41b72c53f3bfad2932f89e669cdf4ec324790cf5e8c61b845c8b01',
  '009_password_changed_at.sql:5ecf56ebffe36268d463565c7d6e7aaa64e3f6b6b02e1711058a372dcc7fc328',
  '010_folder_special_use.sql:e1a56e04d81ad7ad6d6b6d7e0d626b78a4056254c0bf4e523d4fa0eae5faa602',
  '011_auto_forwarded.sql:9d09735369239b1b288336483173b314e6aa425be2f90cdff9693548b7277142',
  '012_observability.sql:787dbf51dd58eb8fbf0515a1a68d15b7f0aa98044aa8335aa8f9b49bcb20d1da',
  '013_evict_perf.sql:b17ebf72d40c3236112221365c0fdbb3d294555930acda10734ada9d62dd0c73',
  '014_thread_summary.sql:e99b0a137bc12af770b893816301fbd0514e80997322865cc3d5f5b9518b0334',
  '015_templates.sql:f481ade9caa6848a47836f3b472ebaf0584f17b7522004139dc2d27e22874ce8',
  '016_unsubscribes.sql:be17f26efa192c8061a828220868c70f0b8be77bb9d7f0777a9b1ede429997e2',
  '017_followups.sql:f89bca7666e91beb0486483c4eb80553a7dc0f45d9cc4c876e6b202e744968d7',
  '018_oauth.sql:1cbfb4665cffa8d59d5bccd6bf907e5be7521a1abd451d4c3eb50e1cf146e652'
]

/** Göçlerin kopyaladığı ya da eklediği tablolar dahil: 018 öncesinden gelen kullanıcı verisi */
const DATA_TABLES = ['users', 'groups', 'user_group_permissions', 'accounts', 'folders', 'messages', 'bodies', 'rules', 'webhooks', 'templates', 'followups', 'op_queue', 'prefs']

function counts(db: Database.Database): Record<string, number> {
  return Object.fromEntries(DATA_TABLES.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]))
}

function readState(path: string): { counts: Record<string, number>; passwords: { id: number; hex: string }[] } {
  const db = new Database(path, { readonly: true })
  const r = {
    counts: counts(db),
    passwords: (db.prepare(`SELECT id, hex(password_enc) AS hex FROM accounts ORDER BY id`).all() as { id: number; hex: string }[])
  }
  db.close()
  return r
}

describe('şema yükseltme yolu', () => {
  let dir: string
  let source: string
  let copyDir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-upgrade-'))
    source = join(dir, 'kaynak.db')
    copyDir = join(dir, 'kopya')
    mkdirSync(copyDir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** Kaynak fikstür üretilir, testler yalnız kopyası üzerinde çalışır */
  const copyOf = (version: 18 | 24): string => {
    buildFixture(source, version)
    const path = join(copyDir, 'geckomail.db')
    copyFileSync(source, path)
    return path
  }
  const snapshots = (): string[] => {
    try {
      return readdirSync(join(copyDir, 'db-snapshots'))
    } catch {
      return []
    }
  }

  it('migrations order equals file order', () => {
    const files = migrationFiles()
    expect(files.length).toBe(MIGRATIONS.length)
    files.forEach((f, i) => expect(MIGRATIONS[i], f).toBe(readFileSync(join(MIGRATION_DIR, f), 'utf-8')))
  })

  it('v1.0.7 migrations unchanged', () => {
    const got = migrationFiles().slice(0, 18).map((f) => `${f}:${sha256(readFileSync(join(MIGRATION_DIR, f)))}`)
    expect(got).toEqual(V107_MIGRATIONS)
  })

  it('fikstür gizli değer ve gerçek alan adı taşımaz', () => {
    buildFixture(source, 24)
    const db = new Database(source, { readonly: true })
    const emails = db.prepare(`SELECT email, imap_host, smtp_host, enabled FROM accounts`).all() as { email: string; imap_host: string; smtp_host: string; enabled: number }[]
    db.close()
    expect(emails).toHaveLength(3)
    for (const a of emails) {
      expect(a.enabled).toBe(0)
      for (const v of [a.email, a.imap_host, a.smtp_host]) expect(v.endsWith('.invalid'), v).toBe(true)
    }
  })

  for (const version of [18, 24] as const) {
    it(`schema ${version} copy opens`, () => {
      const path = copyOf(version)
      const before = readState(path)
      const sourceHash = sha256(readFileSync(source))
      expect(before.counts.messages).toBe(200)
      expect(before.counts.bodies).toBe(200)

      const db = openDb(copyDir)
      expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(db.pragma('foreign_key_check')).toEqual([])
      db.close()

      expect(readState(path)).toEqual(before)
      expect(sha256(readFileSync(source))).toBe(sourceHash)
      expect(snapshots().some((f) => f.endsWith(`-sema${version}.db`))).toBe(true)
    })
  }

  it('second open is a no-op', () => {
    const path = copyOf(18)
    openDb(copyDir).close()
    const state = readState(path)
    const snaps = snapshots()
    const db = openDb(copyDir)
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    db.close()
    expect(readState(path)).toEqual(state)
    expect(snapshots()).toEqual(snaps)
  })

  it('downgrade after upgrade refuses', () => {
    const path = copyOf(18)
    openDb(copyDir).close()
    const state = readState(path)
    const old = new Database(path)
    expect(() => migrate(old, copyDir, path, MIGRATIONS.slice(0, 18))).toThrow(DbTooNewError)
    expect(old.open).toBe(false)
    expect(readState(path)).toEqual(state)
  })

  // 353d685 öncesi dalda 024 push_devices idi: bu dalda açılmış DB şema 24 görünür ama followups.user_id yoktur,
  // 025 tabloyu ikinci kez kurmaya çalışır. Sessiz onarım yok: göç hata verir, veri olduğu gibi kalır.
  it('dev db where 024 was push_devices fails without damage', () => {
    const path = join(copyDir, 'geckomail.db')
    const dev = new Database(path)
    for (const sql of MIGRATIONS.slice(0, 23)) dev.exec(sql)
    dev.exec(MIGRATIONS[24]) // eski 024: bugünkü 025_push_devices.sql
    dev.exec(seedSql(18))
    dev.pragma('user_version = 24')
    dev.close()
    const before = readState(path)

    expect(() => openDb(copyDir)).toThrow(/push_devices/)

    const db = new Database(path, { readonly: true })
    expect(db.pragma('user_version', { simple: true })).toBe(24)
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    db.close()
    expect(readState(path)).toEqual(before)
    expect(snapshots().some((f) => f.endsWith('-sema24.db'))).toBe(true)
  })
})
