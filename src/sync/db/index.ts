import Database from 'better-sqlite3'
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { t } from '../../shared/i18n'
import migration001 from './migrations/001_init.sql?raw'
import migration002 from './migrations/002_v1.sql?raw'
import migration003 from './migrations/003_auth.sql?raw'
import migration004 from './migrations/004_rules.sql?raw'
import migration005 from './migrations/005_extras.sql?raw'
import migration006 from './migrations/006_vault.sql?raw'
import migration007 from './migrations/007_snooze.sql?raw'
import migration008 from './migrations/008_rules_eligible.sql?raw'
import migration009 from './migrations/009_password_changed_at.sql?raw'
import migration010 from './migrations/010_folder_special_use.sql?raw'
import migration011 from './migrations/011_auto_forwarded.sql?raw'
import migration012 from './migrations/012_observability.sql?raw'
import migration013 from './migrations/013_evict_perf.sql?raw'
import migration014 from './migrations/014_thread_summary.sql?raw'
import migration015 from './migrations/015_templates.sql?raw'
import migration016 from './migrations/016_unsubscribes.sql?raw'
import migration017 from './migrations/017_followups.sql?raw'
import migration018 from './migrations/018_oauth.sql?raw'
import migration019 from './migrations/019_user_scope.sql?raw'
import migration020 from './migrations/020_web_auth.sql?raw'
import migration021 from './migrations/021_passkeys.sql?raw'
import migration022 from './migrations/022_send_ids.sql?raw'
import migration023 from './migrations/023_notify_rules.sql?raw'
import migration024 from './migrations/024_followup_owner.sql?raw'
import migration025 from './migrations/025_push_devices.sql?raw'
import migration026 from './migrations/026_desktop.sql?raw'
import migration028 from './migrations/028_sieve.sql?raw'
import migration029 from './migrations/029_pim_sources.sql?raw'
import migration030 from './migrations/030_contacts.sql?raw'
import migration031 from './migrations/031_calendar.sql?raw'
import migration032 from './migrations/032_smime.sql?raw'
import migration033 from './migrations/033_mobile.sql?raw'
import migration034 from './migrations/034_smime_crl_sets.sql?raw'
import migration035 from './migrations/035_rules_pending.sql?raw'

export const MIGRATIONS = [
  migration001, migration002, migration003, migration004, migration005, migration006, migration007, migration008,
  migration009, migration010, migration011, migration012, migration013, migration014, migration015, migration016, migration017, migration018,
  migration019, migration020, migration021, migration022, migration023, migration024, migration025, migration026, migration028, migration029, migration030, migration031, migration032, migration033, migration034, migration035
]

const SNAPSHOT_KEEP = 3

/** Veritabanı bu uygulamadan daha yeni bir sürümle oluşturulmuş (sürüm düşürme): dokunma, açıkça söyle. */
export class DbTooNewError extends Error {
  constructor(
    readonly dbVersion: number,
    readonly appVersion: number
  ) {
    super(t('sync.db.tooNew', { db: String(dbVersion), app: String(appVersion) }))
    this.name = 'DbTooNewError'
  }
}

export function openDb(userDataDir: string): Database.Database {
  mkdirSync(userDataDir, { recursive: true })
  const dbPath = join(userDataDir, 'geckomail.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('cache_size = -65536')
  db.pragma('temp_store = MEMORY')
  db.pragma('foreign_keys = ON')
  try {
    migrate(db, userDataDir, dbPath)
  } catch (e) {
    if (db.open) db.close() // başarısız göçten sonra dosya tutamağı kalmasın (Windows'ta kopya/silme engellenirdi)
    throw e
  }
  return db
}

/**
 * Bekleyen migration'ları uygula. Mevcut (boş olmayan) bir DB yükseltilecekse önce anlık görüntü al:
 * otomatik güncelleme şemayı geri dönüşsüz değiştirir, bozuk bir migration'da tek kurtuluş budur.
 */
export function migrate(db: Database.Database, userDataDir: string, dbPath: string, migrations: string[] = MIGRATIONS): void {
  const version = db.pragma('user_version', { simple: true }) as number
  if (version > migrations.length) {
    db.close()
    throw new DbTooNewError(version, migrations.length)
  }
  if (version > 0 && version < migrations.length) snapshot(db, userDataDir, dbPath, version)
  for (let i = version; i < migrations.length; i++) {
    db.transaction(() => {
      db.exec(migrations[i])
      db.pragma(`user_version = ${i + 1}`)
    })()
  }
}

function snapshot(db: Database.Database, userDataDir: string, dbPath: string, version: number): void {
  const dir = join(userDataDir, 'db-snapshots')
  mkdirSync(dir, { recursive: true })
  db.pragma('wal_checkpoint(TRUNCATE)') // WAL'daki son yazımlar ana dosyaya: kopya tutarlı olsun
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(dbPath, join(dir, `geckomail-${stamp}-sema${version}.db`)) // ad = kronolojik sıra
  const old = readdirSync(dir)
    .filter((f) => /^geckomail-.+-sema\d+\.db$/.test(f))
    .sort()
    .reverse()
    .slice(SNAPSHOT_KEEP)
  for (const f of old) rmSync(join(dir, f), { force: true })
}
