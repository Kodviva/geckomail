import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import type { ImapFlow } from 'imapflow'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { Readable } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '../../shared/rpc'
import { clearVaultOpen, fetchAttachmentPart, fetchBody, readStoredAttachment, unsealAccountAttachments } from '../bodyFetch'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import type { OpQueue } from '../opQueue'
import { RpcHub, type RpcServerDeps } from '../rpcHub'
import { attachmentOnDisk } from '../rpc/mail'
import type { Scheduler } from '../scheduler'
import { setVaultKey } from '../vault/state'

const SECRET = 'GIZLI-ICERIK-KASA'
const RAW = ['From: o@x.co', 'To: a@t.co', 'Subject: d', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '', '--b', 'Content-Type: text/plain; charset=utf-8', '', 'merhaba', '--b',
  'Content-Type: text/plain; name="not.txt"', 'Content-Disposition: attachment; filename="not.txt"', '', SECRET, '--b--', ''].join('\r\n')

// Kasa hesabının 1 MB altı ekleri tüm kaynakla gelir ve düz yazılıyordu
describe('kasa hesabı ekleri', () => {
  let dir: string
  let attachDir: string
  let db: ReturnType<typeof openDb>
  let q: ReturnType<typeof makeQueries>
  let acc: number
  let msg: number
  const client = { getMailboxLock: async () => ({ release() {} }), download: async () => ({ content: Readable.from([Buffer.from(RAW)]) }) } as unknown as ImapFlow
  const enqueueInteractive = vi.fn()
  const deps = (): RpcServerDeps => ({ q, attachDir, scheduler: { enqueueInteractive } }) as unknown as RpcServerDeps
  const fetch = async (): Promise<NonNullable<ReturnType<typeof q.getAttachment>>> => {
    await fetchBody(q, q.getAccountRow(acc)!, { ...q.getMessage(msg)!, size: RAW.length }, client, attachDir)
    return q.attachmentsFor(msg)[0] as NonNullable<ReturnType<typeof q.getAttachment>>
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-va-'))
    attachDir = join(dir, 'attachments')
    db = openDb(dir)
    q = makeQueries(db)
    acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm', imapPort: 993, smtpHost: 'm', smtpPort: 465, passwordEnc: Buffer.from('x') })
    const folder = q.upsertFolder(acc, 'INBOX', 'inbox')
    setVaultKey(randomBytes(32))
    q.setAccountSecureFlag(acc, true)
    msg = Number(db.prepare(`INSERT INTO messages (account_id, folder_id, folder_kind, uid, subject, from_addr, date, size, enc) VALUES (?, ?, 'inbox', 1, NULL, NULL, 1, 100, 1)`).run(acc, folder).lastInsertRowid)
    enqueueInteractive.mockReset()
  })
  afterEach(() => {
    setVaultKey(null)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('tüm kaynakla gelen ek diske mühürlü iner, ad içeriği ve türü ele vermez', async () => {
    const att = await fetch()
    expect(att.disk_path).toMatch(/\.sealed$/)
    expect(basename(att.disk_path!)).not.toContain('txt')
    const onDisk = readFileSync(att.disk_path!)
    expect(onDisk.includes(SECRET)).toBe(false)
    expect(readStoredAttachment(att.disk_path!).toString()).toBe(SECRET)
    expect(readdirSync(join(attachDir, String(acc)))).toEqual([basename(att.disk_path!)]) // düz kopya yok
  })

  it('aynı ek ikinci indirmede yeni dosya bırakmaz', async () => {
    const first = (await fetch()).disk_path
    const second = (await fetch()).disk_path
    expect(second).toBe(first)
  })

  it('kasa dışı hesap eski düzende: düz dosya, uzantı korunur', async () => {
    q.setAccountSecureFlag(acc, false)
    const att = await fetch()
    expect(att.disk_path).toMatch(/\.txt$/)
    expect(readFileSync(att.disk_path!, 'utf-8')).toContain(SECRET)
  })

  it('parça parça indirilen ek de mühürlenir', async () => {
    const id = q.insertAttachment({ messageId: msg, partId: '2', filename: 'b.pdf', mime: 'application/pdf', size: 3, contentId: null, diskPath: null })
    const p = await fetchAttachmentPart(q, q.getAccountRow(acc)!, q.getMessage(msg)!, { id, part_id: '2', filename: 'b.pdf' }, client, attachDir)
    expect(p).toMatch(/\.sealed$/)
    expect(readFileSync(p).includes(SECRET)).toBe(false)
  })

  it('açmak için düz kopya ayrı klasöre yazılır, önbellek mühürlü kalır, temizlenir', async () => {
    const att = await fetch()
    const plain = await attachmentOnDisk(deps(), q.getMessage(msg)!, att)
    expect(plain.startsWith(join(attachDir, 'vault-open'))).toBe(true)
    expect(plain.endsWith('.txt')).toBe(true)
    expect(readFileSync(plain, 'utf-8')).toBe(SECRET)
    expect(q.getAttachment(att.id)?.disk_path).toBe(att.disk_path)
    clearVaultOpen(attachDir)
    expect(existsSync(plain)).toBe(false)
  })

  it('kilitliyken okunmaz, sunucuya da gidilmez', async () => {
    const att = await fetch()
    setVaultKey(null)
    expect(() => readStoredAttachment(att.disk_path!)).toThrow('Kasa kilitli')
    await expect(attachmentOnDisk(deps(), q.getMessage(msg)!, att)).rejects.toThrow('Kasa kilitli')
    expect(enqueueInteractive).not.toHaveBeenCalled()
  })

  it('kilit mühürlü önbelleği bırakır, düz kalıntıyı alır', async () => {
    const att = await fetch()
    mkdirSync(join(attachDir, String(acc)), { recursive: true })
    const legacy = join(attachDir, String(acc), 'eski.txt')
    writeFileSync(legacy, 'eski')
    q.insertAttachment({ messageId: msg, partId: '3', filename: 'eski.txt', mime: 'text/plain', size: 4, contentId: null, diskPath: legacy })
    expect(q.takeSecureAttachmentPaths()).toEqual([legacy])
    expect(q.getAttachment(att.id)?.disk_path).toBe(att.disk_path)
  })

  describe('RPC', () => {
    const admin: SessionUser = { id: 1, username: 'y', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] }
    const open = (): { handle(m: string, p: unknown): Promise<unknown>; currentUser: SessionUser; hub: RpcHub } => {
      const stub = new Proxy({}, { get: () => () => undefined })
      const hub = new RpcHub({
        q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir,
        encrypt: async (v) => v.map((s) => new TextEncoder().encode(s)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)),
        userData: dir, dbSchemaVersion: () => 0
      }, 'desktop')
      const srv = hub.openSession({ send() {}, onMessage() {}, onClose() {}, close() {} }) as unknown as { handle(m: string, p: unknown): Promise<unknown>; currentUser: SessionUser; hub: RpcHub }
      srv.currentUser = admin
      srv.hub = hub
      return srv
    }

    it('getAttachmentData mühürlüyü çözer, kilitliyken vermez', async () => {
      const srv = open()
      setVaultKey(randomBytes(32))
      const att = await fetch()
      const r = (await srv.handle('getAttachmentData', { messageId: msg, attachmentId: att.id })) as { base64: string }
      expect(Buffer.from(r.base64, 'base64').toString()).toBe(SECRET)
      setVaultKey(null)
      await expect(srv.handle('getAttachmentData', { messageId: msg, attachmentId: att.id })).rejects.toThrow('Kasa kilitli')
    })

    it('kilitleme düz kopyayı siler, mühürlü önbellek sonra da okunur', async () => {
      const hub = open().hub
      const key = randomBytes(32)
      setVaultKey(key)
      const fresh = await fetch()
      const plain = await attachmentOnDisk(deps(), q.getMessage(msg)!, fresh)
      const copy = Buffer.from(key) // kilit anahtarı bellekte sıfırlar
      hub.lockVaultNow()
      expect(existsSync(plain)).toBe(false)
      expect(existsSync(fresh.disk_path!)).toBe(true)
      setVaultKey(copy)
      expect(readStoredAttachment(fresh.disk_path!).toString()).toBe(SECRET)
    })
  })

  it('kasadan çıkan hesabın ekleri düz dosyaya döner', async () => {
    const att = await fetch()
    q.setAccountSecureFlag(acc, false)
    unsealAccountAttachments(q, acc, attachDir)
    const now = q.getAttachment(att.id)!
    expect(now.disk_path).toMatch(/\.txt$/)
    expect(readFileSync(now.disk_path!, 'utf-8')).toBe(SECRET)
    expect(existsSync(att.disk_path!)).toBe(false)
  })
})
