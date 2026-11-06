import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIGRATIONS, migrate, openDb } from '../db'
import { makeQueries } from '../db/queries'
import type { OpQueue } from '../opQueue'
import { runRulesForAccount } from '../rulesRunner'

// messages.id AUTOINCREMENT değil: silinen en yüksek kimliği yeni ileti alır
describe('kural kuyruğu id yeniden kullanımı', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let q: ReturnType<typeof makeQueries>
  let acc: number
  let inbox: number
  const opq = { kick: vi.fn() } as unknown as OpQueue
  const add = (uid: number, hidden = false): number => {
    const { id } = q.upsertHeader({
      folderId: inbox, accountId: acc, folderKind: 'inbox', uid, messageId: `<m${uid}@t>`, inReplyTo: null, subject: 'fatura', fromName: null, fromAddr: 'x@y.co',
      toJson: null, date: uid, size: 1, seen: false, flagged: false, answered: false, hasAttachments: false, listUnsubscribe: null, listUnsubscribePost: null, rulesEligible: true
    })
    if (hidden) q.setHidden([id], true)
    return id
  }
  const run = async (): Promise<{ rows: number[]; fired: number[] }> => {
    const rows: number[] = []
    const fired: number[] = []
    await runRulesForAccount(q, opq, acc, (ev) => fired.push(ev.messageId), (batch) => rows.push(...batch.map((m) => m.id)))
    return { rows, fired }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-rq-'))
    db = openDb(dir)
    q = makeQueries(db)
    acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    inbox = q.upsertFolder(acc, 'INBOX', 'inbox')
    q.insertRule({ name: 'R', accountId: acc, groupId: null, conditions: { subjectContains: 'fatura' }, actions: [{ type: 'markRead' }] })
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('silinen en yüksek id\'yi alan yeni posta kural ve bildirimden geçer', async () => {
    const first = add(1)
    expect((await run()).rows).toEqual([first])
    q.deleteMessagesLocal([first]) // kural taşıdı, sunucudan düştü
    const next = add(2)
    expect(next).toBe(first)
    const r = await run()
    expect(r.rows).toEqual([next])
    expect(r.fired).toEqual([next])
  })

  it('işlenen satır ikinci turda görülmez', async () => {
    add(1)
    await run()
    expect((await run()).rows).toEqual([])
  })

  it('tur geçerken gizli olan satır eski işaret gibi atlanır', async () => {
    add(1, true)
    const later = add(2)
    expect((await run()).rows).toEqual([later])
    q.unhideByFolderUids(acc, 'INBOX', [1])
    expect((await run()).rows).toEqual([])
  })

  it('tur başarısızsa satırlar kuyrukta kalır', async () => {
    const id = add(1)
    const spy = vi.spyOn(q, 'markRulesProcessed').mockImplementationOnce(() => {
      throw new Error('disk')
    })
    await expect(run()).rejects.toThrow('disk')
    spy.mockRestore()
    expect((await run()).rows).toEqual([id])
  })
})

describe('035 göçü', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-m35-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('user_version 34; eski işaretin gerisi işlenmiş sayılır, gerisi bekler; FTS ve FK bozulmaz', () => {
    const path = join(dir, 'geckomail.db')
    const db = new Database(path)
    migrate(db, dir, path, MIGRATIONS.slice(0, 33))
    expect(db.pragma('user_version', { simple: true })).toBe(33)
    const account = (email: string): number => Number(db.prepare(`INSERT INTO accounts (email, imap_host, imap_port, smtp_host, smtp_port, password_enc, created_at) VALUES (?, 'i', 993, 's', 465, x'00', 1)`).run(email).lastInsertRowid)
    const a = account('a@t.test')
    const b = account('b@t.test')
    const folder = (acc: number): number => Number(db.prepare(`INSERT INTO folders (account_id, path, kind) VALUES (?, 'INBOX', 'inbox')`).run(acc).lastInsertRowid)
    const fa = folder(a)
    const fb = folder(b)
    const msg = (acc: number, f: number, uid: number): number => {
      const id = Number(db.prepare(`INSERT INTO messages (folder_id, account_id, folder_kind, uid, date, rules_eligible, subject) VALUES (?, ?, 'inbox', ?, 1, 1, 'konu')`).run(f, acc, uid).lastInsertRowid)
      db.prepare(`INSERT INTO messages_fts (rowid, subject, from_text, to_text, body_text) VALUES (?, 'konu', '', '', '')`).run(id)
      return id
    }
    const done = msg(a, fa, 1)
    const pending = msg(a, fa, 2)
    const noMark = msg(b, fb, 1)
    db.prepare(`INSERT INTO prefs (key, value) VALUES (?, ?), ('rulesXwatermark:9', 'kalsın')`).run(`rules_watermark:${a}`, String(done))
    migrate(db, dir, path, MIGRATIONS)
    expect(db.pragma('user_version', { simple: true })).toBe(34)
    expect(db.prepare(`SELECT id FROM messages WHERE rules_eligible = 1 ORDER BY id`).all()).toEqual([{ id: pending }, { id: noMark }])
    expect(db.prepare(`SELECT key FROM prefs WHERE key LIKE '%watermark%'`).all()).toEqual([{ key: 'rulesXwatermark:9' }])
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'idx_msgs_rules_pending'`).get()).toBeTruthy()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'konu'`).get()).toEqual({ n: 3 })
    expect(db.pragma('foreign_key_check')).toEqual([])
    db.close()
  })
})
