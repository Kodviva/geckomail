import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { evictCaches } from '../evict'

describe('tahliye (R19)', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let q: ReturnType<typeof makeQueries>
  let m1: number
  let m2: number
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-evict-'))
    db = openDb(dir)
    q = makeQueries(db)
    const acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    const f = q.upsertFolder(acc, 'INBOX', 'inbox')
    const h = (uid: number) => ({
      folderId: f, accountId: acc, folderKind: 'inbox' as const, uid, messageId: `<m${uid}@t>`, inReplyTo: null, subject: 's',
      fromName: null, fromAddr: 'x@y.co', toJson: null, date: uid, size: 1, seen: false, flagged: false, answered: false,
      hasAttachments: true, listUnsubscribe: null, listUnsubscribePost: null
    })
    m1 = q.upsertHeader(h(1)).id
    m2 = q.upsertHeader(h(2)).id
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('paylaşılan ek dosyası bir kez sayılır ve silinince tüm satırlar birlikte düşer', () => {
    const file = join(dir, 'ortak.pdf')
    writeFileSync(file, 'x'.repeat(100))
    for (const messageId of [m1, m2]) {
      q.insertAttachment({ messageId, partId: null, filename: 'a.pdf', mime: 'application/pdf', size: 100, contentId: null, diskPath: file })
    }
    evictCaches(db, q, { body: 1e12, attach: 150 }) // 100 bayt (bir kez sayılır) < 150 → dokunma
    expect(existsSync(file)).toBe(true)
    evictCaches(db, q, { body: 1e12, attach: 50 })
    expect(existsSync(file)).toBe(false)
    const rows = [...q.attachmentsFor(m1), ...q.attachmentsFor(m2)]
    expect(rows.every((r) => r.disk_path === null)).toBe(true)
  })

  it('gövde bütçesi kayıttaki uzunlukla hesaplanır', () => {
    q.saveBody(m1, 'a'.repeat(100), null, 100)
    q.saveBody(m2, 'b'.repeat(100), null, 100)
    evictCaches(db, q, { body: 150, attach: 1e12 })
    expect([q.getBodyRow(m1), q.getBodyRow(m2)].filter(Boolean)).toHaveLength(1)
  })
})
