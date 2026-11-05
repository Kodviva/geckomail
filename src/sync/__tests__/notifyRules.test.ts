import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MessageRow } from '../../shared/rpc'
import { openDb } from '../db'
import { makeQueries, type HeaderInput } from '../db/queries'
import type { OpQueue } from '../opQueue'
import { runRulesForAccount } from '../rulesRunner'

// R31: "Bildir" kural eylemi ileti başına en güçlü nedeni bildirim hattına verir (VIP kişi başına: notifyPipeline).
describe('bildirim kuralları', () => {
  let dir: string
  let q: ReturnType<typeof makeQueries>
  let accountId: number
  let folderId: number
  const opq = { kick() {} } as unknown as OpQueue

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-notify-'))
    q = makeQueries(openDb(dir))
    accountId = q.insertAccount({ email: 'a@test.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    folderId = q.upsertFolder(accountId, 'INBOX', 'inbox')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const mail = (uid: number, fromAddr: string, subject: string): HeaderInput => ({
    folderId, accountId, folderKind: 'inbox', uid, messageId: `<m${uid}@t>`, inReplyTo: null, subject, fromName: null, fromAddr, toJson: null,
    date: 1_700_000_000_000 + uid, size: 10, seen: false, flagged: false, answered: false, hasAttachments: false,
    listUnsubscribe: null, listUnsubscribePost: null, rulesEligible: true
  })

  it('Bildir kuralı; ileti başına en güçlü neden, parti işlem sonrası bir kez', async () => {
    q.insertRule({ name: 'yedek hatası', accountId: null, groupId: null, conditions: { subjectContains: 'FAILED' }, actions: [{ type: 'notify', urgent: true }] })
    q.insertRule({ name: 'fatura', accountId: null, groupId: null, conditions: { subjectContains: 'fatura' }, actions: [{ type: 'notify' }, { type: 'flag' }] })
    q.insertRule({ name: 'acil fatura', accountId: null, groupId: null, conditions: { subjectContains: 'acil fatura' }, actions: [{ type: 'notify', urgent: true }] })
    q.upsertHeader(mail(1, 'veeam@backup.co', 'Job FAILED'))
    q.upsertHeader(mail(2, 'x@y.co', 'fatura'))
    q.upsertHeader(mail(3, 'x@y.co', 'acil fatura'))
    q.upsertHeader(mail(4, 'x@y.co', 'sıradan'))
    const got: Record<string, string> = {}
    const seen: string[] = []
    const onBatch = (rows: MessageRow[], reasons: ReadonlyMap<number, string>): void => {
      for (const r of rows) {
        seen.push(r.subject!)
        const why = reasons.get(r.id)
        if (why) got[r.subject!] = why
      }
    }
    await runRulesForAccount(q, opq, accountId, () => {}, onBatch)
    expect(got).toEqual({ 'Job FAILED': 'rule-urgent', fatura: 'rule', 'acil fatura': 'rule-urgent' })
    expect(seen).toHaveLength(4)
    // aynı parti ikinci kez işlenmez (watermark)
    await runRulesForAccount(q, opq, accountId, () => {}, onBatch)
    expect(seen).toHaveLength(4)
  })
})
