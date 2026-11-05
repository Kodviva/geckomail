import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pollFolder = vi.hoisted(() => vi.fn())
vi.mock('../imapPoll', async (orig) => ({ ...(await orig<typeof import('../imapPoll')>()), pollFolder }))

import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { movedArrivals } from '../movedArrivals'
import { OpQueue } from '../opQueue'
import type { Scheduler } from '../scheduler'

// Kuyruk: sahiplenme, açılışta kurtarma, taşıma sonrası hedef klasör eşitlemesi
describe('OpQueue', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let q: ReturnType<typeof makeQueries>
  let acc: number
  const emitChanged = vi.fn()
  const messageMove = vi.fn()
  const client = { getMailboxLock: async () => ({ release() {} }), mailbox: { uidValidity: 1n }, messageMove }
  const scheduler = {
    enqueueInteractive: async (_id: number, fn: (c: unknown) => Promise<void>) => fn(client),
    pollSoon: vi.fn()
  } as unknown as Scheduler
  const events = { emitOpFailed: vi.fn(), emitChanged, emitAutomationLogged: vi.fn() }
  const drain = (o: OpQueue): Promise<void> => (o as unknown as { drain(): Promise<void> }).drain()
  const opState = (id: number): string | undefined => (db.prepare(`SELECT state FROM op_queue WHERE id = ?`).get(id) as { state: string } | undefined)?.state

  beforeEach(() => {
    vi.clearAllMocks()
    pollFolder.mockResolvedValue({ changed: true, newInboxMessages: 0 })
    messageMove.mockResolvedValue(true)
    dir = mkdtempSync(join(tmpdir(), 'gecko-opq-'))
    db = openDb(dir)
    q = makeQueries(db)
    acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    q.upsertFolder(acc, 'INBOX', 'inbox')
    q.upsertFolder(acc, 'Projeler', 'other')
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const queue = (): OpQueue => new OpQueue(q, scheduler, new Map(), dir, events)
  const move = (): number => q.enqueueOp(acc, 'move', { folderPath: 'INBOX', uids: [1], targetPath: 'Projeler' })

  describe('kural taşıması', () => {
    const consumed = (path: string): boolean => movedArrivals.consume(acc, path, 77, '<kural@t>')
    const expected = (): void => {
      expect(consumed('Projeler')).toBe(true)
    }
    beforeEach(() => {
      messageMove.mockResolvedValue({ uidMap: new Map([[1, 77]]) })
      q.upsertHeader({
        folderId: q.getFolders(acc).find((f) => f.path === 'INBOX')!.id, accountId: acc, folderKind: 'inbox', uid: 1, messageId: '<kural@t>', inReplyTo: null,
        subject: 's', fromName: null, fromAddr: 'x@y.co', toJson: null, date: 1, size: 1, seen: false, flagged: false, answered: false, hasAttachments: false,
        listUnsubscribe: null, listUnsubscribePost: null
      })
    })

    it('move_named hedefte yeni posta sayılmaz: kural ikinci kez tetiklenmez', async () => {
      q.enqueueOp(acc, 'move_named', { folderPath: 'INBOX', uids: [1], targetFolderName: 'Projeler' })
      await drain(queue())
      expected()
      expect(pollFolder).not.toHaveBeenCalled()
    })

    it('move_special de kayıt açar', async () => {
      const arch = q.upsertFolder(acc, 'Arsiv', 'archive')
      expect(arch).toBeGreaterThan(0)
      q.enqueueOp(acc, 'move_special', { folderPath: 'INBOX', uids: [1], special: 'archive' })
      await drain(queue())
      expect(consumed('Arsiv')).toBe(true)
    })

    it('başarısız taşıma kaydı bırakmaz', async () => {
      messageMove.mockRejectedValue(new Error('koptu'))
      q.enqueueOp(acc, 'move_named', { folderPath: 'INBOX', uids: [1], targetFolderName: 'Projeler' })
      await drain(queue())
      expect(consumed('Projeler')).toBe(false)
    })

    it('izlenen hedef hemen eşitlenir: kayıt süresi dolmadan satır görülür', async () => {
      q.upsertSieveAccount(acc, { watched_json: JSON.stringify(['Projeler']) }, 1)
      q.enqueueOp(acc, 'move_named', { folderPath: 'INBOX', uids: [1], targetFolderName: 'Projeler' })
      await drain(queue())
      expect(pollFolder.mock.calls[0][2]).toMatchObject({ path: 'Projeler' })
    })
  })

  it('başarılı taşıma hedef klasörü eşitler ve listeyi tazeletir', async () => {
    const id = move()
    await drain(queue())
    expect(messageMove).toHaveBeenCalledWith('1', 'Projeler', { uid: true })
    expect(opState(id)).toBeUndefined()
    expect(pollFolder).toHaveBeenCalledTimes(1)
    expect(pollFolder.mock.calls[0][2]).toMatchObject({ path: 'Projeler' })
    expect(emitChanged).toHaveBeenCalledWith(acc)
  })

  it('taşınan iletiler hedefte yeni posta sayılmaz: Message-ID kaydı taşımadan önce, UID eşlemesi sonra', async () => {
    const inbox = q.getFolders(acc).find((f) => f.path === 'INBOX')!.id
    db.prepare(`INSERT INTO messages (folder_id, account_id, folder_kind, uid, message_id, date, subject, thread_root) VALUES (?,?,?,?,?,?,?,?)`)
      .run(inbox, acc, 'inbox', 1, '<tasinan@t>', 1000, 'k', '<tasinan@t>')
    messageMove.mockResolvedValue({ path: 'INBOX', destination: 'Projeler', uidMap: new Map([[1, 77]]) })
    move()
    await drain(queue())
    expect(movedArrivals.consume(acc, 'Projeler', 77, null)).toBe(true) // UID ile
    movedArrivals.reset()
    messageMove.mockResolvedValue(true) // sunucu eşleme vermedi
    move()
    await drain(queue())
    expect(movedArrivals.consume(acc, 'Projeler', 99, '<tasinan@t>')).toBe(true) // Message-ID ile
    movedArrivals.reset()
    messageMove.mockRejectedValue(new Error('koptu'))
    move()
    await drain(queue())
    expect(movedArrivals.consume(acc, 'Projeler', 99, '<tasinan@t>')).toBe(false) // başarısız taşımada kayıt düşer
  })

  it('eşitleme hatası tamamlanan taşımayı yeniden denetmez', async () => {
    pollFolder.mockRejectedValue(new Error('koptu'))
    const id = move()
    await drain(queue())
    expect(opState(id)).toBeUndefined()
    expect(emitChanged).toHaveBeenCalledWith(acc)
  })

  it('eşitlemenin eşzamanlı hatası retryOrFail\'e ulaşmaz, aynı gruptaki sıradaki op sürer', async () => {
    const first = move()
    const second = move()
    const o = queue()
    const retry = vi.spyOn(o as unknown as { retryOrFail(): void }, 'retryOrFail')
    vi.spyOn(q, 'getFolders').mockImplementation(() => {
      throw new Error('db')
    })
    await drain(o)
    expect(retry).not.toHaveBeenCalled()
    expect(messageMove).toHaveBeenCalledTimes(2)
    expect(opState(first)).toBeUndefined()
    expect(opState(second)).toBeUndefined()
  })

  it('webhook sahiplenmesi fırlatırsa sahiplenilen op\'lar sıraya döner', async () => {
    const id = move()
    vi.spyOn(q, 'claimDueWebhookOps').mockImplementation(() => {
      throw new Error('db')
    })
    await expect(drain(queue())).rejects.toThrow('db')
    expect(opState(id)).toBe('pending')
  })

  it('başarısız taşımada hedef eşitlenmez, op yeniden denenir', async () => {
    messageMove.mockRejectedValue(new Error('imap'))
    const id = move()
    await drain(queue())
    expect(pollFolder).not.toHaveBeenCalled()
    expect(opState(id)).toBe('pending')
  })

  it('işlenen op running: Geri Al ve ikinci tur onu alamaz', async () => {
    let release!: () => void
    messageMove.mockReturnValue(new Promise((r) => (release = () => r(true))))
    const id = move()
    const o = queue()
    const run = drain(o)
    await vi.waitFor(() => expect(messageMove).toHaveBeenCalled())
    expect(opState(id)).toBe('running')
    expect(q.deletePendingOps([id])).toBe(0)
    expect(q.dueOps(Date.now() + 1, 10)).toHaveLength(0)
    release()
    await run
    expect(opState(id)).toBeUndefined()
  })

  it('açılışta running kalan op sıraya döner', () => {
    const id = move()
    q.claimDueOps(Date.now() + 1, 10)
    expect(opState(id)).toBe('running')
    const o = queue()
    o.start()
    o.stop()
    expect(opState(id)).toBe('pending')
  })

  it('kuyruk hemen çalıştıramadığı SMTP op\'unu sıraya verir', async () => {
    const id = q.enqueueOp(acc, 'smtp_send', { draft: {} })
    const o = queue()
    ;(o as unknown as { smtpBusy: boolean }).smtpBusy = true
    await drain(o)
    expect(opState(id)).toBe('pending')
  })

  it('webhook şeridi boş yuvadan fazlasını sahiplenmez', async () => {
    const ids = Array.from({ length: 6 }, () => q.enqueueOp(0, 'call_webhook', { webhookId: 999, body: {} }))
    await drain(queue())
    // bilinmeyen webhook sessizce düşer: tur başına dört, kalanı beklemede
    expect(ids.filter((i) => opState(i) === 'pending')).toHaveLength(2)
    expect(ids.filter((i) => opState(i) === 'running')).toHaveLength(0)
  })

  it('sayılar running olanı da bekleyen sayar: takip erken dolmaz, giden kutusunda görünür', () => {
    move()
    q.claimDueOps(Date.now() + 1, 10)
    expect(q.listOps(null).map((o) => o.state)).toEqual(['pending'])
  })
})
