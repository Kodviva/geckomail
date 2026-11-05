import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'

// R34: UID'ler yalnız aynı UIDVALIDITY içinde anlamlı — op kuyruğa girerken değer payload'a yazılır
describe('op payload UIDVALIDITY', () => {
  let dir: string
  let q: ReturnType<typeof makeQueries>
  let acc: number
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-uv-'))
    q = makeQueries(openDb(dir))
    acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    const f = q.upsertFolder(acc, 'INBOX', 'inbox')
    q.updateFolderSync(f, { uidvalidity: 777 })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('folderPath + uids taşıyan op UIDVALIDITY kazanır', () => {
    q.enqueueOp(acc, 'store_flags', { folderPath: 'INBOX', uids: [1, 2], seen: true })
    q.enqueueOpDelayed(acc, 'trash', { folderPath: 'INBOX', uids: [3] }, 0)
    const ops = q.dueOps(Date.now() + 1, 10).map((o) => JSON.parse(o.payload_json))
    expect(ops.every((p) => p.uidValidity === 777)).toBe(true)
  })
  it('klasör bilinmiyorsa ya da uid yoksa payload değişmez', () => {
    q.enqueueOp(acc, 'mark_all_seen', { folderKind: 'inbox' })
    q.enqueueOp(acc, 'store_flags', { folderPath: 'Yok', uids: [1], seen: true })
    const ops = q.dueOps(Date.now() + 1, 10).map((o) => JSON.parse(o.payload_json))
    expect(ops.every((p) => p.uidValidity === undefined)).toBe(true)
  })
})
