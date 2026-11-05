import { mkdtempSync, readFileSync, rmSync } from 'fs'
import type { ImapFlow } from 'imapflow'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fetchBody } from '../bodyFetch'
import { openDb } from '../db'
import { makeQueries, type AccountRow } from '../db/queries'
import { isCalendarAttachment } from '../../shared/pim'

const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:u1', 'SUMMARY:Görüşme', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')

describe('takvim parçası', () => {
  let dir: string
  let q: ReturnType<typeof makeQueries>
  let close: () => void
  let msgId: number
  let account: AccountRow

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-bf-'))
    const db = openDb(dir)
    close = () => db.close()
    q = makeQueries(db)
    const acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm', imapPort: 993, smtpHost: 'm', smtpPort: 465, passwordEnc: Buffer.from('x') })
    account = q.getAccountRow(acc)!
    const folder = q.upsertFolder(acc, 'INBOX', 'inbox')
    db.prepare(`INSERT INTO messages (account_id, folder_id, folder_kind, uid, subject, from_addr, date, size) VALUES (?, ?, 'inbox', 1, 'd', 'o@x.co', 1, 100)`).run(acc, folder)
    msgId = (db.prepare(`SELECT id FROM messages`).get() as { id: number }).id
  })
  afterEach(() => {
    close()
    rmSync(dir, { recursive: true, force: true })
  })

  const client = (o: object): ImapFlow => ({ getMailboxLock: async () => ({ release() {} }), ...o }) as unknown as ImapFlow

  it('calendar attachment bytes intact', async () => {
    const raw = ['From: o@x.co', 'To: a@t.co', 'Subject: d', 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="b"', '', '--b', 'Content-Type: text/plain; charset=utf-8', '', 'merhaba', '--b',
      'Content-Type: text/calendar; charset=utf-8; method=REQUEST', 'Content-Transfer-Encoding: 8bit', '', ICS, '--b--', ''].join('\r\n')
    const c = client({ download: async () => ({ content: Readable.from([Buffer.from(raw)]) }) })
    await fetchBody(q, account, { ...q.getMessage(msgId)!, size: raw.length }, c, join(dir, 'att'))
    const atts = q.attachmentsFor(msgId)
    const cal = atts.find(isCalendarAttachment)!
    expect(cal.disk_path).toBeTruthy()
    const onDisk = readFileSync(cal.disk_path!, 'utf-8')
    expect(onDisk.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(onDisk).toContain('SUMMARY:Görüşme')
  })

  it('unnamed text/calendar part recorded in large message', async () => {
    const structure = { childNodes: [{ part: '1', type: 'text/plain' }, { part: '2', type: 'text/calendar', parameters: { method: 'REQUEST' }, size: 500 }, { part: '3', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'x.pdf' } }] }
    const c = client({ fetchOne: async () => ({ bodyStructure: structure }), download: async () => ({ content: Readable.from([Buffer.from('gövde')]), meta: {} }) })
    await fetchBody(q, account, { ...q.getMessage(msgId)!, size: 5_000_000 }, c, join(dir, 'att'))
    const atts = q.attachmentsFor(msgId)
    expect(atts.map((a) => a.mime)).toEqual(['text/calendar', 'application/pdf'])
    expect(atts[0]).toMatchObject({ part_id: '2', filename: null, size: 500 })
    expect(q.getBodyRow(msgId)?.text_plain).toBe('gövde')
  })
})
