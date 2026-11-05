import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'

const DAY = 86_400_000

describe('takip hatırlatıcısı (R30)', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let acc: number
  let other: number
  let uid = 1
  const T0 = 1_800_000_000_000
  const msg = (a: number, kind: string, o: { mid?: string; irt?: string | null; root?: string | null; from?: string; date: number }) => {
    const f = q.upsertFolder(a, kind === 'sent' ? 'Sent' : 'INBOX', kind as 'inbox')
    return Number(
      db
        .prepare(`INSERT INTO messages (folder_id, account_id, folder_kind, uid, message_id, in_reply_to, thread_root, from_addr, date) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(f, a, kind, uid++, o.mid ?? null, o.irt ?? null, o.root ?? null, o.from ?? 'musteri@x.co', o.date).lastInsertRowid
    )
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-fu-'))
    db = openDb(dir)
    q = makeQueries(db)
    const mk = (email: string) =>
      q.insertAccount({ email, displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    acc = mk('destek@firma.co')
    other = mk('satis@firma.co')
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const add = (mid: string, opId: number | null = null) =>
    q.addFollowup({ accountId: acc, opId, messageId: mid, subject: 'Teklif', to: 'musteri@x.co', dueAt: T0 + 3 * DAY }, T0)

  it('In-Reply-To ile gelen yanıt takibi kapatır', () => {
    add('<a@firma.co>')
    msg(acc, 'inbox', { irt: '<a@firma.co>', root: '<a@firma.co>', date: T0 + DAY })
    expect(q.resolveRepliedFollowups(T0 + DAY)).toBe(1)
    expect(q.listFollowups(null)).toEqual([])
  })

  it('gönderilen mail senkronlanıp yerel konuşma kökü aldıysa aynı kökteki yanıt da sayılır', () => {
    add('<b@firma.co>')
    msg(acc, 'sent', { mid: '<b@firma.co>', root: 'local-99', from: 'destek@firma.co', date: T0 })
    msg(acc, 'inbox', { irt: '<baska@x.co>', root: 'local-99', date: T0 + DAY })
    expect(q.resolveRepliedFollowups()).toBe(1)
  })

  it('kendi mailimiz, gönderimden önceki mail, başka hesap ve çöp yanıt sayılmaz', () => {
    add('<c@firma.co>')
    msg(acc, 'inbox', { irt: '<c@firma.co>', from: 'Destek@Firma.co', date: T0 + DAY }) // kendimiz (bcc/cc kopyası)
    msg(acc, 'inbox', { irt: '<c@firma.co>', date: T0 - DAY }) // önce
    msg(other, 'inbox', { irt: '<c@firma.co>', date: T0 + DAY }) // başka hesap
    msg(acc, 'trash', { irt: '<c@firma.co>', date: T0 + DAY })
    expect(q.resolveRepliedFollowups()).toBe(0)
  })

  it('süresi dolan due olur (bir kez bildirilir); gönderim bekliyorsa ya da başarısızsa olmaz; ertele ve kapat', () => {
    const f1 = add('<d@firma.co>')
    const opId = q.enqueueOp(acc, 'smtp_send', { draft: {} })
    add('<e@firma.co>', opId)
    expect(q.markDueFollowups(T0 + DAY)).toEqual([])
    expect(q.markDueFollowups(T0 + 4 * DAY).map((f) => f.id)).toEqual([f1])
    expect(q.markDueFollowups(T0 + 5 * DAY)).toEqual([]) // tekrar bildirilmez
    expect(q.listFollowups(null).filter((f) => f.state === 'due')).toHaveLength(1)
    const list = q.listFollowups(null)
    expect(list.map((f) => [f.state, f.pendingSend])).toEqual([['due', false], ['waiting', true]])
    q.snoozeFollowup(f1, T0 + 10 * DAY)
    expect(q.listFollowups(null).filter((f) => f.state === 'due')).toHaveLength(0)
    q.closeFollowup(f1)
    q.deleteFollowupsForOp(opId)
    expect(q.listFollowups(null)).toEqual([])
  })

  it('hesap filtresi', () => {
    add('<f@firma.co>')
    expect(q.listFollowups([other])).toEqual([])
    expect(q.listFollowups([])).toEqual([])
    expect(q.listFollowups([acc])).toHaveLength(1)
  })
})
