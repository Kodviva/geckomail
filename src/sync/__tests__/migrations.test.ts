import Database from 'better-sqlite3'
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DbTooNewError, migrate, MIGRATIONS, openDb } from '../db'

describe('migration güvenliği', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'gecko-mig-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const snaps = () => {
    try {
      return readdirSync(join(dir, 'db-snapshots'))
    } catch {
      return []
    }
  }

  it('yeni kurulumda anlık görüntü alınmaz', () => {
    openDb(dir).close()
    expect(snaps()).toHaveLength(0)
  })

  it('yükseltmeden önce anlık görüntü alınır; en yeni 3 tutulur', () => {
    const path = join(dir, 'geckomail.db')
    for (let v = 5; v < MIGRATIONS.length; v++) {
      const db = new Database(path)
      if (v === 5) migrate(db, dir, path, MIGRATIONS.slice(0, 5))
      migrate(db, dir, path, MIGRATIONS.slice(0, v + 1))
      db.close()
    }
    const s = snaps()
    expect(s.length).toBe(3)
    // en yenisi son yükseltmenin öncesi (şema MIGRATIONS.length - 1)
    expect(s.sort().at(-1)).toMatch(new RegExp(`-sema${MIGRATIONS.length - 1}\\.db$`))
  })

  it('032 S/MIME tablolarını ve smime_kind sütununu ekler', () => {
    const db = openDb(dir)
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%smime%'`).all() as { name: string }[]).map((r) => r.name)
    expect(tables.sort()).toEqual(['message_smime', 'smime_contact_certs', 'smime_crl_serials', 'smime_crls', 'smime_identities', 'smime_trust_anchors'])
    expect((db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name)).toContain('smime_kind')
    db.close()
  })

  it('daha yeni şemalı DB açılmaz (sürüm düşürme)', () => {
    const path = join(dir, 'geckomail.db')
    const db = new Database(path)
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`)
    db.close()
    expect(() => openDb(dir)).toThrow(DbTooNewError)
  })
  it('026: mevcut push cihazı webpush olur, import_ledger kullanıcıyla silinir', () => {
    const path = join(dir, 'geckomail.db')
    const db = new Database(path)
    db.pragma('foreign_keys = ON')
    const at = MIGRATIONS.findIndex((m) => m.includes('import_ledger'))
    migrate(db, dir, path, MIGRATIONS.slice(0, at))
    db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at) VALUES (1, 'a', 'x', 'admin', 1)`).run()
    db.prepare(`INSERT INTO push_devices (user_id, endpoint, p256dh, auth, created_at) VALUES (1, 'https://p/1', 'p', 'a', 1)`).run()
    migrate(db, dir, path, MIGRATIONS.slice(0, at + 1))
    expect(db.prepare(`SELECT kind FROM push_devices`).get()).toEqual({ kind: 'webpush' })
    db.prepare(`INSERT INTO import_ledger (source_id, item_key, status, detail, user_id, updated_at) VALUES ('s', 'k', 'done', NULL, 1, 1)`).run()
    expect(() => db.prepare(`INSERT INTO import_ledger (source_id, item_key, status, user_id, updated_at) VALUES ('s', 'k2', 'bilinmez', 1, 1)`).run()).toThrow(/CHECK/)
    expect(() => db.prepare(`INSERT INTO import_ledger (source_id, item_key, status, user_id, updated_at) VALUES ('s', 'k', 'done', 1, 1)`).run()).toThrow(/UNIQUE/)
    db.prepare(`DELETE FROM users`).run()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM import_ledger`).get()).toEqual({ n: 0 })
    db.close()
  })
  it('029-031: PIM tabloları mevcut veriye dokunmadan eklenir', () => {
    const path = join(dir, 'geckomail.db')
    const db = new Database(path)
    const idx = MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE pim_sources'))
    migrate(db, dir, path, MIGRATIONS.slice(0, idx))
    db.prepare(`INSERT INTO users (username, password_hash, role, created_at) VALUES ('a', 'x', 'admin', 1)`).run()
    migrate(db, dir, path)
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name)
    for (const name of ['pim_sources', 'pim_collections', 'pim_collection_prefs', 'contacts', 'contact_emails', 'contact_group_members', 'calendar_objects', 'invite_responses'])
      expect(tables).toContain(name)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM users`).get()).toEqual({ n: 1 })
    db.close()
  })
  it('033: eski satırlar web oturumu olarak kalır, push_devices yalnız kind taşır', () => {
    const path = join(dir, 'geckomail.db')
    const db = new Database(path)
    migrate(db, dir, path, MIGRATIONS.slice(0, MIGRATIONS.length - 1))
    db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at) VALUES (1, 'a', 'x', 'admin', 1)`).run()
    db.prepare(`INSERT INTO web_sessions (id_hash, user_id, created_at, last_seen_at, expires_at) VALUES ('h', 1, 1, 1, 2)`).run()
    db.prepare(`INSERT INTO push_devices (user_id, web_session_id, endpoint, p256dh, auth, created_at) VALUES (1, 'h', 'e', 'p', 'a', 1)`).run()
    migrate(db, dir, path, MIGRATIONS)
    expect(db.prepare(`SELECT kind FROM web_sessions`).get()).toEqual({ kind: 'web' })
    expect(db.prepare(`SELECT kind FROM push_devices`).get()).toEqual({ kind: 'webpush' })
    expect(() => db.prepare(`UPDATE web_sessions SET kind = 'x'`).run()).toThrow(/CHECK/)
    const cols = (db.prepare(`PRAGMA table_info(push_devices)`).all() as { name: string }[]).map((c) => c.name)
    expect(cols).not.toContain('transport')
    db.close()
  })

  it('019: mevcut şablonlar paylaşılan kalır, ad sahibi başına tekil', () => {
    const path = join(dir, 'geckomail.db')
    const db = new Database(path)
    migrate(db, dir, path, MIGRATIONS.slice(0, 18))
    db.prepare(`INSERT INTO users (username, password_hash, role, created_at) VALUES ('a', 'x', 'admin', 1)`).run()
    db.prepare(`INSERT INTO templates (name, subject, body, updated_at, deleted_at) VALUES ('T', NULL, 'b', 5, NULL), ('Silinen', NULL, '', 6, 6)`).run()
    migrate(db, dir, path, MIGRATIONS.slice(0, 19))
    expect(db.prepare(`SELECT name, owner_user_id, deleted_at FROM templates ORDER BY name`).all()).toEqual([
      { name: 'Silinen', owner_user_id: null, deleted_at: 6 },
      { name: 'T', owner_user_id: null, deleted_at: null }
    ])
    // aynı ad: paylaşılan + kişisel yan yana olur; iki paylaşılan olmaz
    db.prepare(`INSERT INTO templates (owner_user_id, name, body, updated_at) VALUES (1, 'T', 'k', 7)`).run()
    expect(() => db.prepare(`INSERT INTO templates (owner_user_id, name, body, updated_at) VALUES (NULL, 'T', 'x', 8)`).run()).toThrow(/UNIQUE/)
    expect(() => db.prepare(`INSERT INTO templates (owner_user_id, name, body, updated_at) VALUES (1, 'T', 'x', 8)`).run()).toThrow(/UNIQUE/)
    db.close()
  })
  it('020: mevcut kullanıcılarda 2FA kapalı; oturumlar kullanıcıyla silinir', () => {
    const path = join(dir, 'geckomail.db')
    const db = new Database(path)
    migrate(db, dir, path, MIGRATIONS.slice(0, 19))
    db.prepare(`INSERT INTO users (username, password_hash, role, created_at) VALUES ('a', 'x', 'admin', 1)`).run()
    migrate(db, dir, path, MIGRATIONS.slice(0, 20))
    expect(db.prepare(`SELECT totp_secret_enc, totp_enabled, totp_last_step FROM users`).get()).toEqual({
      totp_secret_enc: null, totp_enabled: 0, totp_last_step: null
    })
    db.pragma('foreign_keys = ON')
    db.prepare(`INSERT INTO web_sessions (id_hash, user_id, created_at, last_seen_at, expires_at) VALUES ('h', 1, 1, 1, 2)`).run()
    db.prepare(`DELETE FROM users`).run()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM web_sessions`).get()).toEqual({ n: 0 })
    db.close()
  })
  it('021: passkey tablosu; anahtarlar kullanıcıyla silinir', () => {
    const path = join(dir, 'geckomail.db')
    const db = new Database(path)
    migrate(db, dir, path, MIGRATIONS.slice(0, 20))
    db.prepare(`INSERT INTO users (username, password_hash, role, created_at) VALUES ('a', 'x', 'admin', 1)`).run()
    migrate(db, dir, path, MIGRATIONS.slice(0, 21))
    db.pragma('foreign_keys = ON')
    db.prepare(`INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES ('k', 1, x'00', 0, NULL, 'n', 1)`).run()
    expect(db.prepare(`SELECT last_used_at FROM passkeys`).get()).toEqual({ last_used_at: null })
    expect(() => db.prepare(`INSERT INTO passkeys (id, user_id, public_key, counter, name, created_at) VALUES ('k', 1, x'00', 0, 'n', 1)`).run()).toThrow(/UNIQUE/)
    db.prepare(`DELETE FROM users`).run()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM passkeys`).get()).toEqual({ n: 0 })
    db.close()
  })
  it('023: bildirim kuralları ve hesap tercihleri; kullanıcıyla silinir', () => {
    const path = join(dir, 'geckomail.db')
    const db = new Database(path)
    migrate(db, dir, path, MIGRATIONS.slice(0, 22))
    db.prepare(`INSERT INTO users (username, password_hash, role, created_at) VALUES ('a', 'x', 'admin', 1)`).run()
    db.prepare(`INSERT INTO accounts (email, imap_host, imap_port, smtp_host, smtp_port, password_enc, created_at) VALUES ('a@t.co', 'h', 993, 'h', 465, x'00', 1)`).run()
    migrate(db, dir, path, MIGRATIONS.slice(0, 23))
    db.pragma('foreign_keys = ON')
    db.prepare(`INSERT INTO notify_rules (user_id, name, position, groups_json, level, created_at) VALUES (1, 'k', 0, '[]', 'urgent', 1)`).run()
    expect(db.prepare(`SELECT enabled FROM notify_rules`).get()).toEqual({ enabled: 1 })
    expect(() => db.prepare(`INSERT INTO notify_rules (user_id, name, position, groups_json, level, created_at) VALUES (1, 'k', 1, '[]', 'x', 1)`).run()).toThrow(/CHECK/)
    db.prepare(`INSERT INTO notify_account_prefs (user_id, account_id, mode) VALUES (1, 1, 'off')`).run()
    expect(() => db.prepare(`INSERT INTO notify_account_prefs (user_id, account_id, mode) VALUES (1, 1, 'on')`).run()).toThrow(/UNIQUE/)
    expect(() => db.prepare(`INSERT INTO notify_account_prefs (user_id, account_id, mode) VALUES (1, 2, 'maybe')`).run()).toThrow()
    db.prepare(`DELETE FROM users`).run()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM notify_rules`).get()).toEqual({ n: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM notify_account_prefs`).get()).toEqual({ n: 0 })
    db.close()
  })
  it('028 applies on a 025 database', () => {
    expect(MIGRATIONS).toHaveLength(33)
    const path = join(dir, 'geckomail.db')
    const db = new Database(path)
    migrate(db, dir, path, MIGRATIONS.slice(0, 25))
    db.prepare(`INSERT INTO accounts (email, imap_host, imap_port, smtp_host, smtp_port, password_enc, created_at) VALUES ('a@t.test', 'i', 993, 's', 465, x'00', 1)`).run()
    db.prepare(`INSERT INTO rules (name, conditions_json, actions_json, created_at) VALUES ('R', '{}', '[]', 1)`).run()
    migrate(db, dir, path, MIGRATIONS)
    expect(db.prepare(`SELECT run_on_server FROM rules`).get()).toEqual({ run_on_server: 1 })
    db.pragma('foreign_keys = ON')
    db.prepare(`INSERT INTO sieve_accounts (account_id, updated_at) VALUES (1, 1)`).run()
    db.prepare(`INSERT INTO sieve_vacation (account_id, updated_at) VALUES (1, 1)`).run()
    expect(db.prepare(`SELECT enabled, state, watched_json FROM sieve_accounts`).get()).toEqual({ enabled: 0, state: 'unknown', watched_json: '[]' })
    expect(db.prepare(`SELECT enabled, subject, days FROM sieve_vacation`).get()).toEqual({ enabled: 0, subject: '', days: 1 })
    db.prepare(`DELETE FROM accounts`).run()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sieve_accounts`).get()).toEqual({ n: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sieve_vacation`).get()).toEqual({ n: 0 })
    db.close()
  })
  it('024 ve 025 sırayla: takip sahibi, push cihazları; son göç 033', () => {
    const path = join(dir, 'geckomail.db')
    const db = new Database(path)
    migrate(db, dir, path, MIGRATIONS.slice(0, 23))
    db.prepare(`INSERT INTO users (username, password_hash, role, created_at) VALUES ('a', 'x', 'admin', 1)`).run()
    migrate(db, dir, path, MIGRATIONS.slice(0, 24))
    const cols = db.prepare(`PRAGMA table_info(followups)`).all() as { name: string }[]
    expect(cols.map((c) => c.name)).toContain('user_id')
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'push_devices'`).get()).toBeUndefined()
    migrate(db, dir, path, MIGRATIONS)
    db.pragma('foreign_keys = ON')
    db.prepare(`INSERT INTO push_devices (user_id, endpoint, p256dh, auth, created_at) VALUES (1, 'https://x/1', 'p', 'a', 1)`).run()
    db.prepare(`DELETE FROM users`).run()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM push_devices`).get()).toEqual({ n: 0 })
    db.close()
  })
})
