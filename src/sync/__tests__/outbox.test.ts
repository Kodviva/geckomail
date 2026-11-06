import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { setVaultKey } from '../vault/state'

describe('giden kutusu sorguları (R12)', () => {
  let dir: string
  let q: ReturnType<typeof makeQueries>
  let db: ReturnType<typeof openDb>
  let acc: number
  let folder: number
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-ob-'))
    db = openDb(dir)
    q = makeQueries(db)
    acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    folder = q.upsertFolder(acc, 'INBOX', 'inbox')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('bekleyen ve başarısız op\'lar listelenir; yeniden dene sayacı sıfırlar; eski başarısızlar budanır', () => {
    const a = q.enqueueOp(acc, 'smtp_send', { draft: { to: 'x@y.co', subject: 'S' } })
    const b = q.enqueueOp(acc, 'store_flags', { folderPath: 'INBOX', uids: [1], seen: true })
    q.opFailed(b, 'NO hata')
    const list = q.listOps(null)
    expect(list.map((o) => o.id).sort()).toEqual([a, b].sort())
    expect(list.find((o) => o.id === b)?.state).toBe('failed')
    q.opResetForRetry(b)
    expect(q.getOp(b)?.state).toBe('pending')
    q.opFailed(b, 'yine')
    expect(q.pruneFailedOps(Date.now() + 1000).removed).toBe(1)
    expect(q.listOps(null).map((o) => o.id)).toEqual([a])
  })

  it('mühürlü S/MIME op kasa dışı hesapta da kilitliyken içeriğini vermez', () => {
    setVaultKey(randomBytes(32))
    const id = q.enqueueOp(acc, 'smtp_send', { draft: { to: 'x@y.co', subject: 'S', text: 'gizli' } }, { seal: true })
    expect(q.listOps(null).find((o) => o.id === id)?.locked).toBe(false)
    setVaultKey(null)
    expect(q.listOps(null).find((o) => o.id === id)?.locked).toBe(true)
    expect(q.getOp(id)).toBeUndefined()
  })

  it('iptal edilen taşıma/silmenin gizlediği mesajlar geri görünür', () => {
    const { id } = q.upsertHeader({
      folderId: folder, accountId: acc, folderKind: 'inbox', uid: 5, messageId: '<m@t>', inReplyTo: null, subject: 's', fromName: null,
      fromAddr: 'x@y.co', toJson: null, date: 1, size: 1, seen: false, flagged: false, answered: false, hasAttachments: false,
      listUnsubscribe: null, listUnsubscribePost: null
    })
    const hidden = () => (db.prepare('SELECT hidden FROM messages WHERE id = ?').get(id) as { hidden: number }).hidden
    q.setHidden([id], true)
    expect(hidden()).toBe(1)
    q.unhideByFolderUids(acc, 'INBOX', [5])
    expect(hidden()).toBe(0)
  })
})
