import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const send = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../smtpSend', async (orig) => ({ ...(await orig<typeof import('../smtpSend')>()), smtpSendRaw: send.fn }))

import { t } from '../../shared/i18n'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { LoginDeniedError, OfflineError } from '../net/sessionPool'
import { OpQueue } from '../opQueue'
import { RpcHub } from '../rpcHub'
import type { Scheduler } from '../scheduler'
import { setVaultKey } from '../vault/state'
import type { SessionUser } from '../../shared/rpc'

// Kuyruğun hata yolları: silme hedefi, yeniden başlatma, kapanış, kalıcı hata sonrası yerel durum
describe('kuyruk kurtarma', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let q: ReturnType<typeof makeQueries>
  let acc: number
  let inbox: number
  const messageMove = vi.fn()
  const messageDelete = vi.fn()
  const mailboxCreate = vi.fn()
  const list = vi.fn()
  const client = { getMailboxLock: async () => ({ release() {} }), mailbox: { uidValidity: 1n }, messageMove, messageDelete, mailboxCreate, list }
  const enqueueInteractive = vi.fn()
  const scheduler = {
    enqueueInteractive,
    pollSoon: vi.fn(),
    governorFor: () => ({ tryTakeLogin: () => ({ ok: true }), onLoginSuccess() {}, onLoginFailure() {} })
  } as unknown as Scheduler
  const events = { emitOpFailed: vi.fn(), emitChanged: vi.fn(), emitAutomationLogged: vi.fn() }
  const made: OpQueue[] = []
  const queue = (): OpQueue => {
    const o = new OpQueue(q, scheduler, new Map([[acc, 'parola']]), dir, events)
    made.push(o)
    return o
  }
  const drain = (o: OpQueue): Promise<void> => (o as unknown as { drain(): Promise<void> }).drain()
  const row = (id: number) => db.prepare(`SELECT state, attempts, not_before, last_error FROM op_queue WHERE id = ?`).get(id) as { state: string; attempts: number; not_before: number; last_error: string | null } | undefined
  const message = (uid: number, folder = inbox, kind = 'inbox', hidden = 0): number =>
    Number(db.prepare(`INSERT INTO messages (folder_id, account_id, folder_kind, uid, date, subject, thread_root, hidden) VALUES (?,?,?,?,?,?,?,?)`)
      .run(folder, acc, kind, uid, 1000, 'k', `<r${uid}>`, hidden).lastInsertRowid)
  const hidden = (id: number): number => (db.prepare(`SELECT hidden FROM messages WHERE id = ?`).get(id) as { hidden: number }).hidden

  beforeEach(() => {
    vi.clearAllMocks()
    messageMove.mockResolvedValue(true)
    messageDelete.mockResolvedValue(true)
    mailboxCreate.mockImplementation(async (p: string) => ({ path: p, created: true }))
    list.mockResolvedValue([{ path: 'INBOX', specialUse: '\\Inbox' }])
    enqueueInteractive.mockImplementation(async (_id: number, fn: (c: unknown) => Promise<void>) => fn(client))
    send.fn.mockReset()
    send.fn.mockResolvedValue(undefined)
    dir = mkdtempSync(join(tmpdir(), 'gecko-rec-'))
    db = openDb(dir)
    q = makeQueries(db)
    acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    inbox = q.upsertFolder(acc, 'INBOX', 'inbox')
  })
  afterEach(async () => {
    await Promise.all(made.splice(0).map((o) => o.stop(0))) // gecikmeli kick kapanan DB'ye değmesin
    setVaultKey(null)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const trashOp = (folderPath = 'INBOX'): number => q.enqueueOp(acc, 'trash', { folderPath, uids: [1] })

  describe('silme', () => {
    it('Çöp Kutusu yoksa oluşturulur, ileti taşınır, kalıcı silinmez', async () => {
      mailboxCreate.mockResolvedValue({ path: 'INBOX.Trash', created: true }) // ad alanı önekli sunucu
      const id = trashOp()
      await drain(queue())
      expect(mailboxCreate).toHaveBeenCalledWith('Trash')
      expect(messageMove).toHaveBeenCalledWith('1', 'INBOX.Trash', { uid: true })
      expect(messageDelete).not.toHaveBeenCalled()
      expect(q.getFolderByKind(acc, 'trash')?.path).toBe('INBOX.Trash')
      expect(row(id)).toBeUndefined()
    })

    it('yerelde bilinmeyen Çöp Kutusu liste tazelenince bulunur: ikincisi açılmaz', async () => {
      list.mockResolvedValue([{ path: 'INBOX', specialUse: '\\Inbox' }, { path: 'Çöp Kutusu' }])
      trashOp()
      await drain(queue())
      expect(mailboxCreate).not.toHaveBeenCalled()
      expect(messageMove).toHaveBeenCalledWith('1', 'Çöp Kutusu', { uid: true })
    })

    it('oluşturulamazsa op yeniden denenir, kalıcı silmeye düşmez', async () => {
      mailboxCreate.mockRejectedValue(new Error('NO izin yok'))
      const id = trashOp()
      await drain(queue())
      expect(messageDelete).not.toHaveBeenCalled()
      expect(row(id)).toMatchObject({ state: 'pending', attempts: 1 })
    })

    it('ileti zaten Çöp Kutusu\'ndaysa kalıcı silinir (ikinci çöp klasörü dahil)', async () => {
      q.upsertFolder(acc, 'Trash', 'trash', true)
      q.upsertFolder(acc, 'Deleted Items', 'trash')
      trashOp('Trash')
      trashOp('Deleted Items')
      await drain(queue())
      expect(messageDelete).toHaveBeenCalledTimes(2)
      expect(messageMove).not.toHaveBeenCalled()
    })
  })

  describe('yeniden başlatma ve kapanış', () => {
    const sendOp = (): number => q.enqueueOp(acc, 'smtp_send', { draft: { accountId: acc, to: 'x@y.co', subject: 's', text: 't' }, attachments: [], meta: { messageId: `<${Math.random()}@t>`, date: 1 } })

    it('açılışta running gönderim başarısız olur, otomatik yinelenmez; diğer op sıraya döner', async () => {
      const mail = sendOp()
      const flags = q.enqueueOp(acc, 'store_flags', { folderPath: 'INBOX', uids: [1], seen: true })
      q.claimDueOps(Date.now() + 1, 10)
      const o = queue()
      o.start()
      await o.stop()
      expect(row(mail)).toMatchObject({ state: 'failed', last_error: t('sync.op.sendUncertain') })
      expect(row(flags)?.state).toBe('pending')
      await drain(queue())
      expect(send.fn).not.toHaveBeenCalled()
    })

    it('kapanış gönderilmekte olanı bekler, sıradaki başlamaz', async () => {
      let finish = (): void => {}
      send.fn.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)))
      const first = sendOp()
      const second = sendOp()
      const o = queue()
      const turn = drain(o)
      await vi.waitFor(() => expect(send.fn).toHaveBeenCalledTimes(1))
      let stopped = false
      const stop = o.stop().then(() => (stopped = true))
      await new Promise((r) => setTimeout(r, 20))
      expect(stopped).toBe(false)
      finish()
      await stop
      await turn
      expect(row(first)).toBeUndefined()
      expect(row(second)?.state).toBe('pending') // açılışta belirsiz sayılmaz
      expect(send.fn).toHaveBeenCalledTimes(1)
    })

    it('kapanış sonsuza dek beklemez, süresi dolunca satır running kalır', async () => {
      send.fn.mockImplementationOnce(() => new Promise(() => {}))
      const id = sendOp()
      const o = queue()
      void drain(o)
      await vi.waitFor(() => expect(send.fn).toHaveBeenCalledTimes(1))
      await o.stop(5)
      expect(row(id)?.state).toBe('running')
    })

    it('kapanıştan sonra kick yeni tur açmaz', async () => {
      const id = sendOp()
      const o = queue()
      await o.stop()
      await drain(o)
      expect(row(id)?.state).toBe('pending')
      expect(send.fn).not.toHaveBeenCalled()
    })
  })

  describe('kalıcı hatada gizli satır', () => {
    const fail = async (kind: string, payload: object): Promise<number> => {
      const id = q.enqueueOp(acc, kind, payload)
      db.prepare(`UPDATE op_queue SET attempts = 4 WHERE id = ?`).run(id)
      await drain(queue())
      return id
    }
    beforeEach(() => {
      messageMove.mockRejectedValue(new Error('NO izin yok'))
    })

    it.each([
      ['move', { targetPath: 'Projeler' }],
      ['move_special', { special: 'archive' }],
      ['move_named', { targetFolderName: 'Projeler' }]
    ])('%s geri görünür', async (kind, extra) => {
      const m = message(1, inbox, 'inbox', 1)
      const other = message(2, inbox, 'inbox', 1) // başka op'un gizlediği satır
      const id = await fail(kind, { folderPath: 'INBOX', uids: [1], ...extra })
      expect(row(id)?.state).toBe('failed')
      expect(hidden(m)).toBe(0)
      expect(hidden(other)).toBe(1)
      expect(events.emitChanged).toHaveBeenCalledWith(acc)
    })

    it('yeniden denenecek hata satırı gizli bırakır', async () => {
      const m = message(1, inbox, 'inbox', 1)
      q.enqueueOp(acc, 'move', { folderPath: 'INBOX', uids: [1], targetPath: 'Projeler' })
      await drain(queue())
      expect(hidden(m)).toBe(1)
    })
  })

  describe('deneme hakkı', () => {
    it.each([
      ['OfflineError', new OfflineError(), 30_000],
      ['LoginDeniedError', new LoginDeniedError('parola gerekli'), 300_000]
    ])('%s hak yakmaz, ertelenir', async (_n, err, wait) => {
      enqueueInteractive.mockRejectedValue(err)
      const id = q.enqueueOp(acc, 'store_flags', { folderPath: 'INBOX', uids: [1], seen: true })
      db.prepare(`UPDATE op_queue SET attempts = 4 WHERE id = ?`).run(id) // sınırda: yanarsa kalıcı olurdu
      const before = Date.now()
      await drain(queue())
      const r = row(id)!
      expect(r).toMatchObject({ state: 'pending', attempts: 4, last_error: err.message })
      expect(r.not_before).toBeGreaterThanOrEqual(before + wait)
    })

    it('diğer bağlantı hatası hak yakar', async () => {
      enqueueInteractive.mockRejectedValue(new Error('patladı'))
      const id = q.enqueueOp(acc, 'store_flags', { folderPath: 'INBOX', uids: [1], seen: true })
      await drain(queue())
      expect(row(id)).toMatchObject({ state: 'pending', attempts: 1 })
    })
  })

  describe('giden kutusu ekleri', () => {
    const outbox = (): string => {
      const d = join(dir, 'outbox')
      mkdirSync(d, { recursive: true })
      return d
    }
    const failedSend = async (path: string): Promise<number> => {
      writeFileSync(path, 'ek')
      send.fn.mockRejectedValueOnce(Object.assign(new Error('535'), { responseCode: 535 })) // auth: tek seferde kalıcı
      const id = q.enqueueOp(acc, 'smtp_send', { draft: { accountId: acc, to: 'x@y.co', subject: 's', text: 't' }, attachments: [{ path, filename: 'e.txt', mime: 'text/plain' }], meta: { messageId: '<e@t>', date: 1 } })
      await drain(queue())
      expect(row(id)?.state).toBe('failed')
      return id
    }

    it('kalıcı hatada ek durur, yeniden deneme onunla gönderir ve siler', async () => {
      const path = join(outbox(), `${acc}-ek.txt`)
      const id = await failedSend(path)
      expect(existsSync(path)).toBe(true)
      expect(events.emitOpFailed.mock.calls[0][3]).toMatchObject({ subject: 's' }) // taslak yine döner
      q.opResetForRetry(id)
      await drain(queue())
      expect(row(id)).toBeUndefined()
      expect(existsSync(path)).toBe(false)
      expect(send.fn).toHaveBeenCalledTimes(2)
    })

    it('budama satırla birlikte eki siler, yenisine dokunmaz', async () => {
      const path = join(outbox(), `${acc}-ek.txt`)
      const id = await failedSend(path)
      queue().pruneFailedOps(Date.now() - 1000)
      expect(existsSync(path)).toBe(true)
      queue().pruneFailedOps(Date.now() + 1000)
      expect(row(id)).toBeUndefined()
      expect(existsSync(path)).toBe(false)
    })

    it('kilitliyken mühürlü satır budanmaz: ek yolu kaybolmaz', () => {
      setVaultKey(randomBytes(32))
      const path = join(outbox(), `${acc}-gizli.bin`)
      writeFileSync(path, 'x')
      const id = q.enqueueOp(acc, 'smtp_send', { draft: { to: 'x@y.co', subject: 's' }, attachments: [{ path }] }, { seal: true })
      q.opFailed(id, 'hata')
      setVaultKey(null)
      expect(q.pruneFailedOps(Date.now() + 1000)).toEqual({ removed: 0, outboxFiles: [] })
      setVaultKey(randomBytes(32))
    })

    it('budama eski sürümün gizli bıraktığı satırı açar', () => {
      const m = message(1, inbox, 'inbox', 1)
      const id = q.enqueueOp(acc, 'move', { folderPath: 'INBOX', uids: [1], targetPath: 'P' })
      q.opFailed(id, 'eski hata')
      q.pruneFailedOps(Date.now() + 1000)
      expect(hidden(m)).toBe(0)
    })
  })

  it('başarısız taşıma iptali satırı geri gösterir', async () => {
    const admin: SessionUser = { id: 1, username: 'y', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] }
    const stub = new Proxy({}, { get: () => () => undefined })
    const srv = new RpcHub({
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: async (v) => v.map((s) => new TextEncoder().encode(s)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)),
      userData: dir, dbSchemaVersion: () => 0
    }, 'desktop').openSession({ send() {}, onMessage() {}, onClose() {}, close() {} }) as unknown as { handle(m: string, p: unknown): Promise<unknown>; currentUser: SessionUser }
    srv.currentUser = admin
    const m = message(1, inbox, 'inbox', 1)
    const id = q.enqueueOp(acc, 'move', { folderPath: 'INBOX', uids: [1], targetPath: 'P' })
    q.opFailed(id, 'eski sürümde kaldı')
    await srv.handle('cancelOp', { id })
    expect(hidden(m)).toBe(0)
  })
})
