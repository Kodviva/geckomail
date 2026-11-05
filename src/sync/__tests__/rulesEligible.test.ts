import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries, type HeaderInput } from '../db/queries'

// Gerçek migration'larla geçici DB: kurallar yalnızca gerçekten yeni gelen mailde çalışmalı.
// 29 Eyl bulgusu: backfill / yeni hesap / klasör sıfırlaması eski mailleri yeni satır id'siyle
// ekliyordu → forward/webhook kuralları arşivi dışarı taşıyabilirdi.
describe('kural uygunluğu (rules_eligible)', () => {
  let dir: string
  let q: ReturnType<typeof makeQueries>
  let accountId: number
  let folderId: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-rules-'))
    const db = openDb(dir)
    q = makeQueries(db)
    accountId = q.insertAccount({
      email: 'a@test.co', displayName: null, imapHost: 'mail.test.co', imapPort: 993,
      smtpHost: 'mail.test.co', smtpPort: 465, passwordEnc: Buffer.from('x')
    })
    folderId = q.upsertFolder(accountId, 'INBOX', 'inbox')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const header = (uid: number): HeaderInput => ({
    folderId, accountId, folderKind: 'inbox', uid, messageId: `<m${uid}@t>`, inReplyTo: null,
    subject: `s${uid}`, fromName: null, fromAddr: 'x@y.co', toJson: null, date: 1_700_000_000_000 + uid,
    size: 10, seen: false, flagged: false, answered: false, hasAttachments: false,
    listUnsubscribe: null, listUnsubscribePost: null
  })

  it('varsayılan (ilk senkron / backfill) kurallara girmez', () => {
    q.upsertHeader(header(1))
    q.upsertHeader(header(2))
    expect(q.messagesSince(accountId, 0, 100)).toHaveLength(0)
  })

  it('yalnız yeni-mail yolundan gelenler kurallara girer', () => {
    q.upsertHeader(header(1)) // eski
    q.upsertHeader({ ...header(3), rulesEligible: true }) // yeni gelen
    const rows = q.messagesSince(accountId, 0, 100)
    expect(rows.map((r) => r.uid)).toEqual([3])
  })

  it('var olan satır güncellenirken uygunluğu değişmez', () => {
    q.upsertHeader(header(5))
    q.upsertHeader({ ...header(5), seen: true, rulesEligible: true })
    expect(q.messagesSince(accountId, 0, 100)).toHaveLength(0)
  })
})
