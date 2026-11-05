import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'

// R26: thread_summary tetikleyicilerle güncel kalmalı — her işlemden sonra özet, mesajlardan
// kaba kuvvetle hesaplananla aynı olmalı ve listThreads eski GROUP BY sorgusuyla aynı sonucu vermeli.
describe('konuşma özeti', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let a1: number
  let a2: number
  let inbox1: number
  let inbox2: number
  let arch1: number
  let uid = 1

  const add = (folder: number, acc: number, kind: string, root: string | null, date: number, seen = 0) =>
    Number(
      db
        .prepare(`INSERT INTO messages (folder_id, account_id, folder_kind, uid, thread_root, date, seen, subject) VALUES (?,?,?,?,?,?,?,?)`)
        .run(folder, acc, kind, uid++, root, date, seen, `s${date}`).lastInsertRowid
    )

  const brute = () =>
    db
      .prepare(
        `SELECT folder_id, thread_root, account_id, folder_kind, id AS latest_id, MAX(date) AS latest_date, COUNT(*) AS cnt, SUM(seen = 0) AS unread
         FROM messages WHERE hidden = 0 AND snooze_until = 0 AND thread_root IS NOT NULL GROUP BY folder_id, thread_root ORDER BY folder_id, thread_root`
      )
      .all()
  const summary = () => db.prepare(`SELECT * FROM thread_summary ORDER BY folder_id, thread_root`).all()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-threads-'))
    db = openDb(dir)
    q = makeQueries(db)
    const acc = (email: string) =>
      q.insertAccount({ email, displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    a1 = acc('a@t.co')
    a2 = acc('b@t.co')
    inbox1 = q.upsertFolder(a1, 'INBOX', 'inbox')
    inbox2 = q.upsertFolder(a2, 'INBOX', 'inbox')
    arch1 = q.upsertFolder(a1, 'Archive', 'archive')
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('ekleme, okundu, gizleme, erteleme, taşıma ve silmede tutarlı kalır', () => {
    const m1 = add(inbox1, a1, 'inbox', '<t1>', 100)
    const m2 = add(inbox1, a1, 'inbox', '<t1>', 200)
    const m3 = add(inbox2, a2, 'inbox', '<t1>', 150) // catch-all: aynı konuşma iki hesapta
    const m4 = add(inbox1, a1, 'inbox', '<t2>', 300, 1)
    const m5 = add(inbox1, a1, 'inbox', null, 50)
    expect(summary()).toEqual(brute())
    db.prepare(`UPDATE messages SET thread_root = 'local-' || id WHERE id = ?`).run(m5)
    db.prepare(`UPDATE messages SET seen = 1 WHERE id = ?`).run(m2)
    expect(summary()).toEqual(brute())
    db.prepare(`UPDATE messages SET hidden = 1 WHERE id = ?`).run(m2)
    db.prepare(`UPDATE messages SET snooze_until = 999 WHERE id = ?`).run(m4)
    expect(summary()).toEqual(brute())
    db.prepare(`UPDATE messages SET folder_id = ?, folder_kind = 'archive' WHERE id = ?`).run(arch1, m1)
    expect(summary()).toEqual(brute())
    db.prepare(`UPDATE messages SET snooze_until = 0, hidden = 0`).run()
    db.prepare(`DELETE FROM messages WHERE id = ?`).run(m3)
    expect(summary()).toEqual(brute())
    db.prepare(`DELETE FROM folders WHERE id = ?`).run(inbox1) // ON DELETE CASCADE
    expect(summary()).toEqual(brute())
  })

  it('listThreads eski GROUP BY sorgusuyla aynı sonucu verir; sayfalama ve okunmamış filtresi', () => {
    for (let i = 0; i < 60; i++) add(i % 2 ? inbox1 : inbox2, i % 2 ? a1 : a2, 'inbox', `<r${i % 25}>`, 1000 + i, i % 3 === 0 ? 0 : 1)
    const old = (accountIds: number[] | null, unread: boolean) =>
      (
        db
          .prepare(
            `SELECT m.id, MAX(m.date) AS mdate, COUNT(*) AS c, SUM(m.seen = 0) AS u FROM messages m
             WHERE hidden = 0 AND snooze_until = 0 AND folder_kind = 'inbox' ${accountIds ? `AND account_id IN (${accountIds.join(',')})` : ''}
             GROUP BY m.thread_root ${unread ? 'HAVING u > 0' : ''} ORDER BY mdate DESC`
          )
          .all() as { id: number; c: number; u: number }[]
      ).map((r) => [r.id, r.c, r.u])
    const now = (accountIds: number[] | null, unread: boolean, limit = 100) =>
      q.listThreads({ accountIds, folderKind: 'inbox', cursor: null, limit, unreadOnly: unread }).map((r) => [r.id, r.threadCount, r.threadUnread])
    expect(now(null, false)).toEqual(old(null, false))
    expect(now([a1], false)).toEqual(old([a1], false))
    expect(now(null, true)).toEqual(old(null, true))
    const page1 = q.listThreads({ accountIds: null, folderKind: 'inbox', cursor: null, limit: 10, unreadOnly: false })
    expect(page1).toHaveLength(10)
    const last = page1[page1.length - 1]
    const page2 = q.listThreads({ accountIds: null, folderKind: 'inbox', cursor: { date: last.date, id: last.id }, limit: 10, unreadOnly: false })
    expect(page2.map((r) => r.id)).toEqual(old(null, false).slice(10, 20).map((r) => r[0]))
  })
})
