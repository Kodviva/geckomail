// Röle deposu: tek SQLite dosyası (WAL). Motor ve cihaz kayıtları dışında hiçbir şey tutulmaz; zaman gün çözünürlüğündedir,
// tam zaman saklanmaz. Nonce ve oran sayaçları bellektedir (limits.ts, server.ts).
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import type { RelayEnv, RelayPlatform } from '../shared/relayProtocol'

export interface RelayDevice {
  id: string
  engine_id: string
  platform: RelayPlatform
  env: RelayEnv
  token: string
  last_day: number
}

/** Bu kadar gün trafiksiz cihaz, cihazsız ve sessiz motor silinir */
export const IDLE_DAYS = 90

export const dayOf = (ms: number): number => Math.floor(ms / 86_400_000)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS engines (id TEXT PRIMARY KEY, public_key BLOB NOT NULL, last_day INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, engine_id TEXT NOT NULL REFERENCES engines(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, env TEXT NOT NULL, token TEXT NOT NULL, last_day INTEGER NOT NULL,
  UNIQUE (engine_id, platform, token));
CREATE INDEX IF NOT EXISTS devices_engine ON devices(engine_id);
`

export class RelayStore {
  private readonly db: Database.Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(SCHEMA)
  }

  hasEngine(id: string): boolean {
    return this.db.prepare(`SELECT 1 FROM engines WHERE id = ?`).get(id) !== undefined
  }

  /** Yoksa oluşturur, varsa son trafik gününü yeniler */
  touchEngine(id: string, publicKey: Buffer, day: number): void {
    this.db.prepare(
      `INSERT INTO engines (id, public_key, last_day) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_day = excluded.last_day`
    ).run(id, publicKey, day)
  }

  /** Aynı üçlüde aynı kimlik; ortam ve gün yenilenir */
  upsertDevice(d: { engineId: string; platform: RelayPlatform; env: RelayEnv; token: string; day: number }): string {
    const row = this.db.prepare(
      `INSERT INTO devices (id, engine_id, platform, env, token, last_day) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(engine_id, platform, token) DO UPDATE SET env = excluded.env, last_day = excluded.last_day
       RETURNING id`
    ).get(randomBytes(16).toString('base64url'), d.engineId, d.platform, d.env, d.token, d.day) as { id: string }
    return row.id
  }

  hasDevice(engineId: string, platform: RelayPlatform, token: string): boolean {
    return this.db.prepare(`SELECT 1 FROM devices WHERE engine_id = ? AND platform = ? AND token = ?`).get(engineId, platform, token) !== undefined
  }

  deviceCount(engineId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM devices WHERE engine_id = ?`).get(engineId) as { n: number }).n
  }

  /** Motorun kendi cihazı: başka motorun cihazı görünmez */
  ownDevice(engineId: string, id: string): RelayDevice | undefined {
    return this.db.prepare(`SELECT * FROM devices WHERE id = ? AND engine_id = ?`).get(id, engineId) as RelayDevice | undefined
  }

  deleteDevice(engineId: string, id: string): boolean {
    return this.db.prepare(`DELETE FROM devices WHERE id = ? AND engine_id = ?`).run(id, engineId).changes === 1
  }

  touchDevice(id: string, day: number): void {
    this.db.prepare(`UPDATE devices SET last_day = ? WHERE id = ?`).run(day, id)
  }

  /** Günlük süpürme */
  sweep(today: number): void {
    const cutoff = today - IDLE_DAYS
    this.db.prepare(`DELETE FROM devices WHERE last_day <= ?`).run(cutoff)
    this.db.prepare(`DELETE FROM engines WHERE last_day <= ? AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.engine_id = engines.id)`).run(cutoff)
  }

  close(): void {
    this.db.close()
  }
}
