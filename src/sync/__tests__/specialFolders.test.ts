import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'

// Stalwart'a taşınmış hesaplarda Sent/Trash/Junk çiftleri var ("Sent" + "Sent Items" …).
// Sunucunun SPECIAL-USE ile işaretlediği klasör seçilmeli — sıra/ekleme sırası değil.
describe('özel klasör seçimi', () => {
  let dir: string
  let q: ReturnType<typeof makeQueries>
  let acc: number
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-folders-'))
    q = makeQueries(openDb(dir))
    acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('SPECIAL-USE işaretli klasör, önce eklenen isim-eşleşmesine tercih edilir', () => {
    q.upsertFolder(acc, 'Sent', 'sent') // isimden tahmin, önce eklendi
    q.upsertFolder(acc, 'Sent Items', 'sent', true) // sunucu \Sent diyor
    expect(q.getFolderByKind(acc, 'sent')?.path).toBe('Sent Items')
  })

  it('işaret sonradan gelirse de güncellenir; kaybolursa düşer', () => {
    q.upsertFolder(acc, 'Deleted Items', 'trash')
    q.upsertFolder(acc, 'Trash', 'trash')
    q.upsertFolder(acc, 'Trash', 'trash', true)
    expect(q.getFolderByKind(acc, 'trash')?.path).toBe('Trash')
    q.upsertFolder(acc, 'Trash', 'trash', false)
    q.upsertFolder(acc, 'Deleted Items', 'trash', true)
    expect(q.getFolderByKind(acc, 'trash')?.path).toBe('Deleted Items')
  })
})
