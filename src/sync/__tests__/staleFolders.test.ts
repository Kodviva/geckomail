import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ImapFlow } from 'imapflow'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { isMissingMailbox } from '../imapClient'
import { ensureFolders, invalidateFolderList, pollAccount } from '../imapPoll'

// 29 Eyl "Command failed" (8 hesap): Stalwart'a taşımada silinen/yeniden adlandırılan klasörler DB'de
// kalıyor, her yoklama "NO Mailbox does not exist [SELECT …]" ile hesabı düşürüyordu.
describe('bayat klasörler', () => {
  let dir: string
  let q: ReturnType<typeof makeQueries>
  let acc: number
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-stale-'))
    q = makeQueries(openDb(dir))
    acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm', imapPort: 993, smtpHost: 'm', smtpPort: 465, passwordEnc: Buffer.from('x') })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const fakeList = (paths: string[]) =>
    ({ list: async () => paths.map((path) => ({ path, specialUse: path === 'Sent Items' ? '\\Sent' : undefined })) }) as unknown as ImapFlow

  it('sunucuda olmayan klasör listeden düşer (mesajlarıyla)', async () => {
    const row = q.getAccountRow(acc)!
    await ensureFolders(q, row, fakeList(['INBOX', 'Sent', 'Eski']))
    const eski = q.getFolders(acc).find((f) => f.path === 'Eski')!
    q.upsertHeader({
      folderId: eski.id, accountId: acc, folderKind: 'other', uid: 1, messageId: '<m@t>', inReplyTo: null, subject: 's', fromName: null,
      fromAddr: 'x@y.co', toJson: null, date: 1, size: 1, seen: false, flagged: false, answered: false, hasAttachments: false,
      listUnsubscribe: null, listUnsubscribePost: null
    })
    invalidateFolderList(q, acc)
    await ensureFolders(q, row, fakeList(['INBOX', 'Sent Items']))
    expect(q.getFolders(acc).map((f) => f.path).sort()).toEqual(['INBOX', 'Sent Items'])
    expect(q.getFolderByKind(acc, 'sent')?.path).toBe('Sent Items')
    expect(q.getMessages([1])).toEqual([])
  })

  it('INBOX içermeyen (yarım) LIST yanıtı hiçbir şey silmez', async () => {
    const row = q.getAccountRow(acc)!
    await ensureFolders(q, row, fakeList(['INBOX', 'Arşiv']))
    invalidateFolderList(q, acc)
    await ensureFolders(q, row, fakeList([]))
    expect(q.getFolders(acc)).toHaveLength(2)
  })

  it('yoklamada olmayan klasör hesabı düşürmez; liste tazelenmek üzere işaretlenir', async () => {
    const row = q.getAccountRow(acc)!
    const client = {
      list: async () => [{ path: 'INBOX' }],
      getMailboxLock: async () => {
        throw Object.assign(new Error('Command failed'), { responseStatus: 'NO', responseText: 'Mailbox does not exist', serverResponseCode: 'NONEXISTENT' })
      }
    } as unknown as ImapFlow
    await expect(pollAccount(q, row, client, 1)).resolves.toMatchObject({ changed: true })
    expect(q.prefGet(`folders_listed_${acc}`)).toBe('0')
  })

  it('isMissingMailbox: kod ya da metin; başka NO yanıtları değil', () => {
    expect(isMissingMailbox({ serverResponseCode: 'NONEXISTENT' })).toBe(true)
    expect(isMissingMailbox({ responseText: 'Mailbox does not exist' })).toBe(true)
    expect(isMissingMailbox({ responseText: 'Over quota' })).toBe(false)
    expect(isMissingMailbox(new Error('read ECONNRESET'))).toBe(false)
  })
})
