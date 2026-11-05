import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ImapFlow } from 'imapflow'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { pollFolder } from '../imapPoll'
import { movedArrivals } from '../movedArrivals'

// Kullanıcı iletiyi Arşiv'den Gelen Kutusu'na sürükler: hedef eşitlemesi yeni satır ekler. Bu satır yeni posta
// sayılmamalı; yoksa sonraki gerçek postada eski ileti de bildirilir, kurallar (yönlendirme, webhook) onu yeniden işler.
describe('Gelen Kutusu\'na taşınan ileti yeni posta sayılmaz', () => {
  let dir: string
  let q: ReturnType<typeof makeQueries>
  let accountId: number
  let folderId: number

  beforeEach(() => {
    movedArrivals.reset()
    dir = mkdtempSync(join(tmpdir(), 'gecko-moveinbox-'))
    q = makeQueries(openDb(dir))
    accountId = q.insertAccount({
      email: 'a@test.co', displayName: null, imapHost: 'mail.test.co', imapPort: 993,
      smtpHost: 'mail.test.co', smtpPort: 465, passwordEnc: Buffer.from('x')
    })
    folderId = q.upsertFolder(accountId, 'INBOX', 'inbox')
    q.updateFolderSync(folderId, { uidvalidity: 1, last_seen_uidnext: 5, highest_modseq: null, last_seen_exists: 4 })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** Sunucudaki Gelen Kutusu: uidNext'e kadar uid'ler var; ids: uid -> Message-ID (yoksa <m{uid}@t>) */
  const server = (uidNext: number, ids: Record<number, string> = {}): ImapFlow => ({
    mailbox: { uidValidity: 1n, uidNext, exists: uidNext - 1 },
    getMailboxLock: async () => ({ release() {} }),
    search: async () => Array.from({ length: uidNext - 1 }, (_, i) => i + 1), // günlük tam karşılaştırma yerel satırları silmesin
    fetch: async function* (range: string) {
      const from = Number(range.split(':')[0])
      for (let uid = from; uid < uidNext; uid++) {
        yield { uid, envelope: { messageId: ids[uid] ?? `<m${uid}@t>`, subject: `s${uid}`, from: [{ address: 'x@y.co' }], date: new Date(1_700_000_000_000 + uid) }, flags: new Set<string>(), size: 10 }
      }
    }
  } as unknown as ImapFlow)

  const poll = (uidNext: number, ids?: Record<number, string>) =>
    pollFolder(q, q.getAccountRow(accountId)!, q.getFolderById(folderId)!, server(uidNext, ids), 1)
  const eligible = (): number[] => q.messagesSince(accountId, 0, 100).map((r) => r.uid)
  const MOVED = { 5: '<tasinan@t>' }

  it('taşınan ve gerçek posta aynı aralıkta: yalnız gerçek posta bildirilir ve kurallara girer (COPYUID)', async () => {
    movedArrivals.expect(accountId, 'INBOX', [{ uid: 40, messageId: '<tasinan@t>' }])
    movedArrivals.resolve(accountId, 'INBOX', [40], new Map([[40, 5]]))
    const r = await poll(7, MOVED) // uid 5 taşınan, uid 6 gerçek
    expect(r.newInboxMessages).toBe(1)
    expect(eligible()).toEqual([6])
  })

  it('sunucu COPYUID vermezse Message-ID ile tanınır', async () => {
    movedArrivals.expect(accountId, 'INBOX', [{ uid: 40, messageId: '<tasinan@t>' }])
    movedArrivals.resolve(accountId, 'INBOX', [40], undefined)
    const r = await poll(7, MOVED)
    expect(r.newInboxMessages).toBe(1)
    expect(eligible()).toEqual([6])
  })

  it('tanınamayan satır yeni sayılır: gerçek posta kaybolmaz', async () => {
    movedArrivals.expect(accountId, 'INBOX', [{ uid: 40, messageId: null }]) // Message-ID yok, COPYUID yok
    const r = await poll(7)
    expect(r.newInboxMessages).toBe(2)
    expect(eligible()).toEqual([5, 6])
  })

  it('normal poll taşıma eşitlemesinden önce gelirse (UID eşlemesi henüz yok) taşınan yine yeni sayılmaz', async () => {
    movedArrivals.expect(accountId, 'INBOX', [{ uid: 40, messageId: '<tasinan@t>' }])
    const r = await poll(7, MOVED) // taşıma bitti ama resolve henüz çağrılmadı
    expect(r.newInboxMessages).toBe(1)
    expect(eligible()).toEqual([6])
    movedArrivals.resolve(accountId, 'INBOX', [40], new Map([[40, 5]])) // sonradan gelen eşleme zararsız
    const again = await poll(7, MOVED)
    expect(again.newInboxMessages).toBe(0)
  })

  it('taşıma sonrası gelen gerçek posta tek başına bildirilir', async () => {
    movedArrivals.expect(accountId, 'INBOX', [{ uid: 40, messageId: '<tasinan@t>' }])
    movedArrivals.resolve(accountId, 'INBOX', [40], new Map([[40, 5]]))
    await poll(6, MOVED)
    const real = await poll(7, MOVED)
    expect(real.newInboxMessages).toBe(1)
    expect(eligible()).toEqual([6])
  })

  it('başarısız taşıma kaydı düşer', async () => {
    movedArrivals.expect(accountId, 'INBOX', [{ uid: 40, messageId: '<tasinan@t>' }])
    movedArrivals.cancel(accountId, 'INBOX', [40])
    expect((await poll(6, MOVED)).newInboxMessages).toBe(1)
  })
})
