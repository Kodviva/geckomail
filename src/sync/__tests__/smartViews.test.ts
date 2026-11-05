import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'

describe('akıllı posta kutuları (P2-3)', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let a1: number
  let a2: number
  let uid = 1
  const add = (acc: number, kind: string, o: { flagged?: number; att?: number; snooze?: number; hidden?: number; seen?: number; date?: number }) => {
    const f = q.upsertFolder(acc, kind, kind as 'inbox')
    return Number(
      db
        .prepare(`INSERT INTO messages (folder_id, account_id, folder_kind, uid, date, flagged, has_attachments, snooze_until, hidden, seen) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(f, acc, kind, uid++, o.date ?? uid, o.flagged ?? 0, o.att ?? 0, o.snooze ?? 0, o.hidden ?? 0, o.seen ?? 1).lastInsertRowid
    )
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-smart-'))
    db = openDb(dir)
    q = makeQueries(db)
    const mk = (e: string) => q.insertAccount({ email: e, displayName: null, imapHost: 'm', imapPort: 993, smtpHost: 'm', smtpPort: 465, passwordEnc: Buffer.from('x') })
    a1 = mk('a@t.co')
    a2 = mk('b@t.co')
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('yıldızlı: tüm klasörler, gizli/ertelenen hariç, hesap ve okunmamış filtresi', () => {
    const s1 = add(a1, 'inbox', { flagged: 1, date: 10 })
    const s2 = add(a2, 'archive', { flagged: 1, date: 20, seen: 0 })
    add(a1, 'inbox', { flagged: 1, hidden: 1 })
    add(a1, 'inbox', { flagged: 1, snooze: 99 })
    add(a1, 'inbox', {})
    expect(q.listSmart('starred', null).map((m) => m.id)).toEqual([s2, s1])
    expect(q.listSmart('starred', [a1]).map((m) => m.id)).toEqual([s1])
    expect(q.listSmart('starred', null, true).map((m) => m.id)).toEqual([s2])
  })

  it('ertelenen: dönüş zamanına göre, snoozeUntil taşır', () => {
    const late = add(a1, 'inbox', { snooze: 500 })
    const soon = add(a1, 'inbox', { snooze: 100 })
    const rows = q.listSmart('snoozed', null)
    expect(rows.map((m) => [m.id, m.snoozeUntil])).toEqual([[soon, 100], [late, 500]])
  })

  it('ekli: çöp ve spam hariç', () => {
    const inb = add(a1, 'inbox', { att: 1 })
    const sent = add(a1, 'sent', { att: 1 })
    add(a1, 'trash', { att: 1 })
    add(a1, 'junk', { att: 1 })
    expect(new Set(q.listSmart('attachments', null).map((m) => m.id))).toEqual(new Set([inb, sent]))
  })
})
