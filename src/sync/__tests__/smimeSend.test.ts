import { createHash, createPrivateKey } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sent = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../smtpSend', async (orig) => ({ ...(await orig<typeof import('../smtpSend')>()), smtpSendRaw: sent.fn }))
vi.mock('../smime/cms', async (orig) => {
  const m = await orig<typeof import('../smime/cms')>()
  return { ...m, encryptEnveloped: vi.fn(m.encryptEnveloped) }
})

import DataStream from 'nodemailer/lib/smtp-connection/data-stream'
import PostalMime from 'postal-mime'
import { t } from '../../shared/i18n'
import type { DraftOut, SessionUser, SmimeRequest } from '../../shared/rpc'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { OpQueue } from '../opQueue'
import { sendContentHash } from '../rpc/compose'
import { RpcHub } from '../rpcHub'
import type { Scheduler } from '../scheduler'
import { AT, certDer, fxBytes } from '../smime/__tests__/fx'
import { decryptEnveloped, encryptEnveloped, type DecryptKey } from '../smime/cms'
import { SmimeNoKeyError } from '../smime/errors'
import { encodeChain } from '../smime/identity'
import { pkcs7Der } from '../smime/mime'
import { openSmime, type SigEvaluator } from '../smime/open'
import { CrlCache } from '../smime/revocation'
import { readSealed } from '../smime/sealedFile'
import { createTrustStore } from '../smime/trust'
import { encrypt } from '../vault/crypto'
import { createVault, unlockVault } from '../vault/manager'
import { getVaultKey, setVaultKey } from '../vault/state'

type Session = { handle(method: string, params: unknown): Promise<unknown>; currentUser: SessionUser | null }

const SECRET = 'GIZLI-GOVDE-3391'
const dk = (n: string): DecryptKey => ({ key: createPrivateKey(fxBytes(`${n}.key`)), cert: certDer(n) })
const verified: SigEvaluator = async () => ({ sig: 'verified', notes: [], signer: null, canSaveCert: false })
const SHA1_OID = Buffer.from('06052b0e03021a', 'hex')
const DES3_OID = Buffer.from('06082a864886f70d0307', 'hex')
const RC2_OID = Buffer.from('06082a864886f70d0302', 'hex')

/** Gerçek SMTP çerçevesi: nodemailer'ın DATA akışı satır sonlarını yazar, alıcı noktaları geri alır */
async function overSmtp(raw: Buffer): Promise<Buffer> {
  const framed = new DataStream()
  const sink = new PassThrough()
  framed.pipe(sink)
  const chunks: Buffer[] = []
  sink.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise((r) => sink.on('end', r))
  framed.end(raw)
  await done
  const wire = Buffer.concat(chunks).toString('latin1').replace(/\r\n\.\r\n$/, '\r\n').replace(/^\.\./gm, '.')
  return Buffer.from(wire, 'latin1')
}

describe('S/MIME gönderim', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let opq: OpQueue
  let srv: Session
  let acc: number
  let group: number
  let u1: number
  let u2: number
  let appended: Buffer[]
  const ev = { emitOpFailed: vi.fn(), emitChanged: vi.fn(), emitAutomationLogged: vi.fn() }

  const user = (id: number): SessionUser => ({ id, username: `u${id}`, role: 'member', permittedGroupIds: [group], manageableGroupIds: [group] })
  const contact = (name: string, email: string, capabilities: string | null = null): void =>
    q.upsertContactCert({ userId: u1, email, fingerprint: `${name}${email}`, certDer: certDer(name), chainDer: encodeChain([certDer('int')]), notAfter: Date.UTC(2100, 0, 1), capabilities, source: 'manual' })
  const addIdentity = (userId: number, name = 'alice', canEncrypt = true): void => {
    q.insertIdentity({
      userId, email: 'alice@example.test', fingerprint: `${name}${userId}`, certDer: certDer(name), chainDer: encodeChain([certDer('int')]),
      keyEnc: encrypt(getVaultKey()!, createPrivateKey(fxBytes(`${name}.key`)).export({ type: 'pkcs8', format: 'der' })).toString('base64'),
      notBefore: 0, notAfter: Date.UTC(2100, 0, 1), canSign: true, canEncrypt
    })
  }
  const draft = (o: Partial<DraftOut> = {}): DraftOut => ({ accountId: acc, to: 'bob@example.test', subject: 'Konu', text: SECRET, ...o })
  const send = (d: DraftOut, smime?: SmimeRequest, extra: object = {}) => srv.handle('sendMail', { draft: d, smime, ...extra })
  const drain = (): Promise<void> => (opq as unknown as { drain(): Promise<void> }).drain()
  const ops = () => db.prepare(`SELECT id, kind, state, attempts, last_error, payload_json FROM op_queue ORDER BY id`).all() as { id: number; kind: string; state: string; attempts: number; last_error: string | null; payload_json: string }[]
  const rawOf = (call: number): Buffer => sent.fn.mock.calls[call][3] as Buffer
  const envelopeOf = (call: number): string[] => sent.fn.mock.calls[call][4] as string[]
  const dbBytes = (): Buffer => Buffer.concat(['geckomail.db', 'geckomail.db-wal'].filter((f) => existsSync(join(dir, f))).map((f) => readFileSync(join(dir, f))))

  beforeEach(() => {
    vi.clearAllMocks()
    sent.fn.mockResolvedValue(undefined)
    dir = mkdtempSync(join(tmpdir(), 'gecko-smimetx-'))
    db = openDb(dir)
    q = makeQueries(db)
    acc = q.insertAccount({ email: 'alice@example.test', displayName: 'Alice', imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    group = q.insertGroup('G', '#111111')
    q.setAccountGroup(acc, group)
    q.upsertFolder(acc, 'Sent', 'sent')
    u1 = q.insertUser({ username: 'u1', passwordHash: 'h', role: 'member' })
    u2 = q.insertUser({ username: 'u2', passwordHash: 'h', role: 'member' })
    appended = []
    const client = { getMailboxLock: async () => ({ release() {} }), append: async (_p: string, raw: Buffer) => void appended.push(raw) }
    const scheduler = {
      enqueueInteractive: async (_id: number, fn: (c: unknown) => Promise<void>) => fn(client),
      governorFor: () => ({ tryTakeLogin: () => ({ ok: true }), onLoginSuccess() {}, onLoginFailure: () => null }),
      pollSoon() {},
      removeAccount() {}
    } as unknown as Scheduler
    opq = new OpQueue(q, scheduler, new Map([[acc, 'pw']]), join(dir, 'att'), ev)
    vi.spyOn(opq, 'kick').mockImplementation(() => {}) // kuyruk testte elle boşaltılır
    hub = new RpcHub({
      q, scheduler, opq, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: async (v) => v.map((s) => new TextEncoder().encode(s)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)),
      userData: dir, dbSchemaVersion: () => 0, smimeTrust: createTrustStore(q), smimeCrl: new CrlCache({ q, mode: () => 'off' })
    }, 'desktop')
    srv = hub.openSession({ send() {}, onMessage() {}, onClose() {}, close() {} }) as unknown as Session
    srv.currentUser = user(u1)
    createVault(q, 'kasa-parolasi')
    addIdentity(u1)
    contact('bob', 'bob@example.test')
    contact('revoked', 'carol@example.test')
  })
  afterEach(() => {
    opq.stop()
    setVaultKey(null)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('signed mail verifies through receive pipeline', async () => {
    await send(draft(), { sign: true, encrypt: false })
    await drain()
    const raw = rawOf(0)
    expect(envelopeOf(0)).toEqual(['bob@example.test'])
    const r = await openSmime(raw, { keys: () => [], evaluate: verified, at: AT })
    expect(r.info).toMatchObject({ sig: 'verified', enc: 'none' })
    expect((await PostalMime.parse(r.entity)).text?.trim()).toBe(SECRET)
    expect(raw.toString('latin1')).toMatch(/^From: "?Alice"? <alice@example\.test>/m)
    expect(raw.toString('latin1')).toMatch(/^Subject: Konu/m)
  })

  it('LF satır sonlu imzalı ileti SMTP çerçevesinden sonra doğrulanır', async () => {
    const text = `satir1\nsatir2  \n\n.nokta\nFrom x\n${SECRET}\n`
    await send(draft({ text, html: '<p>a</p>\n<p>b</p>\n' }), { sign: true, encrypt: false })
    await drain()
    const r = await openSmime(await overSmtp(rawOf(0)), { keys: () => [], evaluate: verified, at: AT })
    expect(r.info.sig).toBe('verified')
    expect((await PostalMime.parse(r.entity)).text).toContain(SECRET)
  })

  it('şifreli iletide imzalı bayt kanoniktir', async () => {
    await send(draft({ text: `bir\niki\r\nüç\r${SECRET}\n` }), { sign: true, encrypt: true })
    await drain()
    const r = await openSmime(await overSmtp(rawOf(0)), { keys: () => [dk('alice')], evaluate: verified, at: AT })
    expect(r.info).toMatchObject({ sig: 'verified', enc: 'decrypted' })
    expect(/(^|[^\r])\n/.test(r.entity.toString('latin1'))).toBe(false)
  })

  it('encrypted implies signed', async () => {
    await send(draft(), { sign: false, encrypt: true })
    await drain()
    const r = await openSmime(rawOf(0), { keys: () => [dk('bob')], evaluate: verified, at: AT })
    expect(r.info).toMatchObject({ sig: 'verified', enc: 'decrypted' })
    expect(r.info.notes).not.toContain('unauthenticated')
  })

  it('sender can decrypt sent copy', async () => {
    await send(draft(), { sign: true, encrypt: true })
    await drain()
    await drain()
    expect(appended).toHaveLength(1)
    const r = await openSmime(appended[0], { keys: () => [dk('alice')], evaluate: verified, at: AT })
    expect(r.info.enc).toBe('decrypted')
    expect((await PostalMime.parse(r.entity)).text?.trim()).toBe(SECRET)
  })

  it('recipient can decrypt', async () => {
    await send(draft(), { sign: true, encrypt: true })
    await drain()
    const r = await openSmime(rawOf(0), { keys: () => [dk('bob')], evaluate: verified, at: AT })
    expect((await PostalMime.parse(r.entity)).text?.trim()).toBe(SECRET)
    expect(rawOf(0).includes(SECRET)).toBe(false)
  })

  it('bcc gets separate envelope', async () => {
    await send(draft({ bcc: 'carol@example.test' }), { sign: true, encrypt: true })
    await drain()
    expect(sent.fn).toHaveBeenCalledTimes(2)
    expect(envelopeOf(0)).toEqual(['bob@example.test'])
    expect(envelopeOf(1)).toEqual(['carol@example.test'])
    expect(() => decryptEnveloped(pkcs7Der(rawOf(0)), [dk('revoked')])).toThrow(SmimeNoKeyError)
    expect(() => decryptEnveloped(pkcs7Der(rawOf(1)), [dk('bob')])).toThrow(SmimeNoKeyError)
    expect(decryptEnveloped(pkcs7Der(rawOf(1)), [dk('revoked')]).content.length).toBeGreaterThan(0)
    expect(decryptEnveloped(pkcs7Der(rawOf(1)), [dk('alice')]).content.length).toBeGreaterThan(0)
    for (const i of [0, 1]) {
      expect(rawOf(i).toString('latin1')).not.toMatch(/^Bcc:/im)
      expect(rawOf(i).toString('latin1')).not.toContain('carol@example.test')
    }
    expect(/^Message-ID: (.+)$/im.exec(rawOf(0).toString())?.[1]).toBe(/^Message-ID: (.+)$/im.exec(rawOf(1).toString())?.[1])
  })

  it('bcc retry skips sent parts', async () => {
    await send(draft({ bcc: 'carol@example.test' }), { sign: true, encrypt: true })
    sent.fn.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error('geçici'), { responseCode: 451, phase: 'send' }))
    await drain()
    expect(sent.fn).toHaveBeenCalledTimes(2)
    expect(ops()[0]).toMatchObject({ state: 'pending', attempts: 1 })
    expect(JSON.parse(q.getOp(ops()[0].id)!.payload_json).smimeSent).toBe(1)
    db.prepare(`UPDATE op_queue SET not_before = 0`).run()
    await drain()
    expect(sent.fn).toHaveBeenCalledTimes(3)
    expect(envelopeOf(2)).toEqual(['carol@example.test'])
    expect(ops()).toEqual([])
    expect(appended).toHaveLength(1)
  })

  it('ana parça gidince Sent kuyruğa girer; Bcc hatası kısmi sayılır, taslak gönderilmemiş gibi dönmez', async () => {
    await send(draft({ bcc: 'carol@example.test' }), { sign: true, encrypt: true })
    db.prepare(`UPDATE op_queue SET attempts = 100`).run() // son deneme
    sent.fn.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error('550 yok'), { responseCode: 550, phase: 'send' }))
    await drain()
    expect(ops()[0]).toMatchObject({ kind: 'smtp_send', state: 'failed' })
    expect(ops().map((o) => o.kind)).toEqual(['smtp_send', 'append_sent']) // teslim edilen ana parça Gönderilenler'e gidiyor
    const [, , error, d, opId, partial] = ev.emitOpFailed.mock.calls[0]
    expect(d).toBeUndefined()
    expect(partial).toBe(true)
    expect(error).toContain('Bcc')
    expect(await srv.handle('getOpDraft', { id: opId })).toBeNull()
  })

  it('düz gönderim başarısızsa olay göndereni bildirir', async () => {
    await send(draft())
    db.prepare(`UPDATE op_queue SET attempts = 100`).run()
    sent.fn.mockRejectedValueOnce(Object.assign(new Error('550 yok'), { responseCode: 550, phase: 'send' }))
    await drain()
    const [, , , d, , , sender] = ev.emitOpFailed.mock.calls[0]
    expect(d).toMatchObject({ subject: draft().subject })
    expect(sender).toBe(u1)
  })

  it('şifreli gönderimde gönderen olaya yazılır, taslak yazılmaz', async () => {
    const id = await failByExpiry()
    const [, , , d, opId, , sender] = ev.emitOpFailed.mock.calls[0]
    expect([d, opId, sender]).toEqual([undefined, id, u1])
  })

  it('imzalı iletide Bcc parçası yoktur: tek parça başarısızsa taslak döner, kısmi değildir', async () => {
    await send(draft(), { sign: true, encrypt: false })
    db.prepare(`UPDATE op_queue SET attempts = 100`).run()
    sent.fn.mockRejectedValueOnce(Object.assign(new Error('550 yok'), { responseCode: 550, phase: 'send' }))
    await drain()
    expect(ev.emitOpFailed.mock.calls[0][5]).toBeFalsy()
  })

  it('alıcısız ana zarf SMTP\'ye gitmez, Bcc parçaları yine gider', async () => {
    await send(draft({ to: 'undisclosed:;', bcc: 'carol2@example.test' }), { sign: true, encrypt: true }).catch(() => {})
    contact('bob', 'carol2@example.test')
    await send(draft({ to: 'undisclosed:;', bcc: 'carol2@example.test' }), { sign: true, encrypt: true })
    await drain()
    expect(sent.fn).toHaveBeenCalledTimes(1)
    expect(envelopeOf(0)).toEqual(['carol2@example.test'])
    expect(ops().map((o) => o.kind)).toEqual(['append_sent'])
  })

  it('yeniden denemede gönderilmiş parçalar yeniden üretilmez', async () => {
    contact('bob', 'dave@example.test')
    await send(draft({ bcc: 'carol@example.test, dave@example.test' }), { sign: true, encrypt: true })
    sent.fn.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error('geçici'), { responseCode: 451, phase: 'send' }))
    vi.mocked(encryptEnveloped).mockClear()
    await drain()
    expect(encryptEnveloped).toHaveBeenCalledTimes(2)
    db.prepare(`UPDATE op_queue SET not_before = 0`).run()
    await drain()
    expect(encryptEnveloped).toHaveBeenCalledTimes(4)
  })

  it('geri dönüştürülen op kimliği eski ilerlemeyi devralmaz', async () => {
    await send(draft({ bcc: 'carol@example.test' }), { sign: true, encrypt: true })
    sent.fn.mockImplementationOnce(async () => setVaultKey(null)).mockRejectedValueOnce(Object.assign(new Error('geçici'), { responseCode: 451, phase: 'send' }))
    await drain()
    const id = ops()[0].id
    unlockVault(q, new Map(), 'kasa-parolasi')
    await srv.handle('cancelOp', { id })
    db.prepare(`DELETE FROM op_queue`).run()
    sent.fn.mockClear()
    await send(draft({ subject: 'Yeni' }), { sign: true, encrypt: true })
    expect(ops()[0].id).toBe(id)
    await drain()
    expect(sent.fn).toHaveBeenCalledTimes(1)
  })

  it('over 20 bcc rejected', async () => {
    const bcc = Array.from({ length: 21 }, (_, i) => `k${i}@example.test`).join(', ')
    await expect(send(draft({ bcc }), { sign: true, encrypt: true })).rejects.toThrow('20')
    expect(ops()).toEqual([])
  })

  it('sent append holds ciphertext only', async () => {
    await send(draft(), { sign: true, encrypt: true })
    await drain()
    await drain()
    expect(appended[0].includes(SECRET)).toBe(false)
    expect(dbBytes().includes(SECRET)).toBe(false)
  })

  it('locked vault holds op without burning attempts', async () => {
    await send(draft(), { sign: true, encrypt: true })
    setVaultKey(null)
    await drain()
    expect(sent.fn).not.toHaveBeenCalled()
    expect(ops()[0]).toMatchObject({ state: 'pending', attempts: 0 })
    // sahiplenildikten sonra kilitlenme: deneme yanmaz, satır sıraya döner
    unlockVault(q, new Map(), 'kasa-parolasi')
    const [claimed] = q.claimDueOps(Date.now(), 1)
    setVaultKey(null)
    await (opq as unknown as { runSmtpOp(o: unknown): Promise<void> }).runSmtpOp(claimed)
    expect(ops()[0]).toMatchObject({ state: 'pending', attempts: 0 })
    expect(sent.fn).not.toHaveBeenCalled()
    unlockVault(q, new Map(), 'kasa-parolasi')
    await drain()
    expect(sent.fn).toHaveBeenCalledTimes(1)
  })

  it('parça gönderilirken kasa kilitlenirse ilerleme kaybolmaz', async () => {
    await send(draft({ bcc: 'carol@example.test' }), { sign: true, encrypt: true })
    sent.fn.mockImplementationOnce(async () => setVaultKey(null)).mockRejectedValueOnce(Object.assign(new Error('geçici'), { responseCode: 451, phase: 'send' }))
    await drain()
    expect(sent.fn).toHaveBeenCalledTimes(2)
    unlockVault(q, new Map(), 'kasa-parolasi')
    db.prepare(`UPDATE op_queue SET not_before = 0`).run()
    await drain()
    expect(sent.fn).toHaveBeenCalledTimes(3)
    expect(envelopeOf(2)).toEqual(['carol@example.test'])
  })

  it('SMTP sırasında kasa kilitlenirse Gönderilenler kopyası açılana dek bekler, zorla mühürlü yazılır', async () => {
    await send(draft(), { sign: true, encrypt: false }) // imza-yalnız: ham ileti düz metindir
    sent.fn.mockImplementationOnce(async () => setVaultKey(null))
    await drain()
    const rows = (): { kind: string; payload_json: string }[] => db.prepare(`SELECT kind, payload_json FROM op_queue`).all() as never
    expect(rows().filter((r) => r.kind === 'append_sent')).toEqual([])
    await drain() // kilitliyken de bekler
    expect(rows().filter((r) => r.kind === 'append_sent')).toEqual([])
    expect(dbBytes().includes(SECRET)).toBe(false)
    unlockVault(q, new Map(), 'kasa-parolasi')
    ;(opq as unknown as { flushHeldSent(): void }).flushHeldSent() // satır yürütülmeden görülsün
    const [row] = rows().filter((r) => r.kind === 'append_sent')
    expect(row.payload_json.startsWith('vault:')).toBe(true)
    await drain()
    expect(appended).toHaveLength(1)
    expect(dbBytes().includes(SECRET)).toBe(false)
  })

  describe('bekleyen Gönderilenler kopyası hesapla yaşar', () => {
    const held = (): unknown[] => (opq as unknown as { heldSent: unknown[] }).heldSent
    const flush = (): void => (opq as unknown as { flushHeldSent(): void }).flushHeldSent()
    const sentRows = (): unknown => db.prepare(`SELECT COUNT(*) AS n FROM op_queue WHERE kind = 'append_sent'`).get()
    beforeEach(async () => {
      await send(draft(), { sign: true, encrypt: false })
      sent.fn.mockImplementationOnce(async () => setVaultKey(null))
      await drain()
      expect(held()).toHaveLength(1)
    })

    it('hesap kimliği yeniden kullanıldıysa kopya yeni hesaba yazılmaz', () => {
      q.deleteAccount(acc)
      db.prepare(`INSERT INTO accounts (id, email, imap_host, imap_port, smtp_host, smtp_port, password_enc, created_at) VALUES (?, 'mallory@example.test', 'i', 993, 's', 465, x'00', 1)`).run(acc)
      unlockVault(q, new Map(), 'kasa-parolasi')
      flush()
      expect(held()).toEqual([])
      expect(sentRows()).toEqual({ n: 0 })
    })

    it('dropHeldSent yalnız o hesabın kopyasını siler', () => {
      opq.dropHeldSent(acc + 1)
      expect(held()).toHaveLength(1)
      opq.dropHeldSent(acc)
      expect(held()).toEqual([])
    })

    it('hesap silinince bellekteki kopya gider', async () => {
      await srv.handle('deleteAccount', { accountId: acc })
      expect(held()).toEqual([])
      unlockVault(q, new Map(), 'kasa-parolasi')
      flush()
      expect(sentRows()).toEqual({ n: 0 })
    })
  })

  describe('SMTP hesaptan uzun sürerse kopya yazılmaz', () => {
    const recycle = (): void => {
      q.deleteAccount(acc)
      db.prepare(`INSERT INTO accounts (id, email, imap_host, imap_port, smtp_host, smtp_port, password_enc, created_at) VALUES (?, 'mallory@example.test', 'i', 993, 's', 465, x'00', 1)`).run(acc)
      q.upsertFolder(acc, 'Sent', 'sent') // Sent yoksa ekleme sessizce atlanır, test bir şey kanıtlamaz
      q.enqueueOp(acc, 'store_flags', {}) // boşalan op kimliğini tutar: kopya o kimliği alsa opDone onu siler, test bir şey kanıtlamaz
    }
    const held = (): unknown[] => (opq as unknown as { heldSent: unknown[] }).heldSent
    const sentRows = (): unknown => db.prepare(`SELECT COUNT(*) AS n FROM op_queue WHERE kind = 'append_sent'`).get()

    it('kasa açıkken', async () => {
      await send(draft(), { sign: true, encrypt: false })
      sent.fn.mockImplementationOnce(async () => recycle())
      await drain()
      expect(sentRows()).toEqual({ n: 0 })
      expect(appended).toEqual([]) // drain kuyruğu boşaltır: yeni hesaba eklenmiş de olmamalı
      expect(held()).toEqual([])
    })

    it('kasa kilitlenince de bellekte tutulmaz', async () => {
      await send(draft(), { sign: true, encrypt: false })
      sent.fn.mockImplementationOnce(async () => {
        recycle()
        setVaultKey(null)
      })
      await drain()
      expect(held()).toEqual([])
    })
  })

  it('kasa hesabında düz gönderim de kilitte düz yazılmaz', async () => {
    q.setAccountSecureFlag(acc, true)
    await srv.handle('sendMail', { draft: draft({ subject: SECRET }), attachments: [] })
    sent.fn.mockImplementationOnce(async () => setVaultKey(null))
    await drain()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM op_queue WHERE kind = 'append_sent'`).get()).toEqual({ n: 0 })
    expect(dbBytes().includes(SECRET)).toBe(false)
    unlockVault(q, new Map(), 'kasa-parolasi')
    ;(opq as unknown as { flushHeldSent(): void }).flushHeldSent()
    const row = db.prepare(`SELECT payload_json FROM op_queue WHERE kind = 'append_sent'`).get() as { payload_json: string }
    expect(row.payload_json.startsWith('vault:')).toBe(true)
    await drain()
    expect(appended).toHaveLength(1)
  })

  it('scheduled op waits for unlock', async () => {
    const sendAt = Date.now() + 3_600_000
    await send(draft(), { sign: true, encrypt: true }, { sendAt })
    setVaultKey(null)
    db.prepare(`UPDATE op_queue SET not_before = 0`).run()
    await drain()
    expect(sent.fn).not.toHaveBeenCalled()
    unlockVault(q, new Map(), 'kasa-parolasi')
    await drain()
    expect(sent.fn).toHaveBeenCalledTimes(1)
    expect(/^Date: /im.test(rawOf(0).toString())).toBe(true)
  })

  it('missing recipient cert rejected before enqueue', async () => {
    await expect(send(draft({ to: 'yok@example.test' }), { sign: true, encrypt: true })).rejects.toThrow('alıcının sertifikası')
    expect(ops()).toEqual([])
  })

  it('kilitli kasa, kimliksiz gönderen ve imza-yalnız sertifika kuyruğa girmez', async () => {
    srv.currentUser = user(u2)
    await expect(send(draft(), { sign: true, encrypt: false })).rejects.toThrow('sertifika yok')
    addIdentity(u2, 'sign-only', false)
    await expect(send(draft(), { sign: true, encrypt: true })).rejects.toThrow('şifrelemeye uygun değil')
    srv.currentUser = user(u1)
    setVaultKey(null)
    await expect(send(draft(), { sign: true, encrypt: false })).rejects.toThrow('Kasayı açın')
    expect(ops()).toEqual([])
  })

  const failByExpiry = async (): Promise<number> => {
    await send(draft(), { sign: true, encrypt: true })
    q.deleteContactCert(u1, q.listContactCerts(u1).find((c) => c.email === 'bob@example.test')!.id)
    q.upsertContactCert({ userId: u1, email: 'bob@example.test', fingerprint: 'e', certDer: certDer('expired'), chainDer: '[]', notAfter: 1, capabilities: null, source: 'manual' })
    await drain()
    return ops()[0].id
  }

  it('expired recipient fails permanently and returns draft to owner only', async () => {
    const id = await failByExpiry()
    expect(ops()[0]).toMatchObject({ state: 'failed' })
    expect(sent.fn).not.toHaveBeenCalled()
    expect(((await srv.handle('getOpDraft', { id })) as DraftOut).text).toBe(SECRET)
  })

  it('failed encrypted op does not broadcast draft', async () => {
    const id = await failByExpiry()
    expect(ev.emitOpFailed).toHaveBeenCalledTimes(1)
    const [, kind, , d, opId] = ev.emitOpFailed.mock.calls[0]
    expect(kind).toBe('smtp_send')
    expect(d).toBeUndefined()
    expect(opId).toBe(id)
  })

  it('imzalı gönderim başarısızsa taslak eskisi gibi döner', async () => {
    await send(draft(), { sign: true, encrypt: false })
    q.deleteIdentity(u1, q.listIdentities(u1)[0].id)
    await drain()
    expect(ops()[0]).toMatchObject({ state: 'failed' })
    expect(ev.emitOpFailed.mock.calls[0][3]).toMatchObject({ text: SECRET })
  })

  it('other manager cannot read draft via getOpDraft', async () => {
    const id = await failByExpiry()
    srv.currentUser = user(u2)
    expect(await srv.handle('getOpDraft', { id })).toBeNull()
  })

  it('başka yetkili yeniden dener, imza sahibin anahtarıyla atılır', async () => {
    const id = await failByExpiry()
    contact('bob', 'bob@example.test')
    q.deleteContactCert(u1, q.listContactCerts(u1).find((c) => c.fingerprint === 'e')!.id)
    srv.currentUser = user(u2)
    await srv.handle('retryOp', { id })
    await drain()
    expect(sent.fn).toHaveBeenCalledTimes(1)
    const r = await openSmime(rawOf(0), { keys: () => [dk('bob')], evaluate: verified, at: AT })
    expect(r.info.enc).toBe('decrypted')
    expect(r.harvest?.signer && Buffer.from(r.harvest.signer).equals(certDer('alice'))).toBe(true)
  })

  it('encrypted outbox attachment is sealed', async () => {
    const data = new TextEncoder().encode(`${SECRET}-EK`)
    await send(draft({ attachments: [{ filename: 'gizli.txt', mime: 'text/plain', data }] }), { sign: true, encrypt: true })
    const outbox = join(dir, 'outbox')
    const [file] = readdirSync(outbox)
    expect(readFileSync(join(outbox, file)).includes(`${SECRET}-EK`)).toBe(false)
    expect(readSealed(join(outbox, file)).toString()).toBe(`${SECRET}-EK`)
    await drain()
    const r = await openSmime(rawOf(0), { keys: () => [dk('bob')], evaluate: verified, at: AT })
    const parsed = await PostalMime.parse(r.entity)
    expect(parsed.attachments[0].filename).toBe('gizli.txt')
    expect(readdirSync(outbox)).toEqual([])
  })

  describe('iptal listesi hazır değil', () => {
    /** liste saklı, kümesi yok: boyut sınırını aşan satır */
    const pendingList = (): void => {
      contact('alice', 'liste@example.test')
      q.putCrl({ url: 'http://crl.example.test/int.crl', der: Buffer.alloc(300_000), thisUpdate: 1, nextUpdate: AT * 2, fetchedAt: AT, lastErrorAt: null })
    }

    it('gönderim düz iletiyle reddedilir, kuyruğa girmez', async () => {
      pendingList()
      await expect(send(draft({ to: 'liste@example.test' }), { sign: true, encrypt: true })).rejects.toThrow(t('sync.smime.recipientPending'))
      expect(ops()).toEqual([])
    })

    it('kuyruktaki iş başarısız olmaz, bekler', async () => {
      contact('alice', 'liste@example.test')
      await send(draft({ to: 'liste@example.test' }), { sign: true, encrypt: true })
      pendingList()
      await drain()
      expect(ops()[0]).toMatchObject({ kind: 'smtp_send', state: 'pending' })
      expect(ops()[0].last_error).toBe(t('sync.smime.recipientPending'))
      expect(sent.fn).not.toHaveBeenCalled()
      expect(ev.emitOpFailed).not.toHaveBeenCalled()
    })
  })

  it('kasa kilitliyken silinen hesabın giden kutusu dosyası kalmaz', async () => {
    const data = new TextEncoder().encode('imzali-ek-duz')
    await send(draft({ attachments: [{ filename: 'ek.txt', mime: 'text/plain', data }] }), { sign: true, encrypt: false })
    await srv.handle('sendMail', { draft: draft({ attachments: [{ filename: 'ek2.txt', mime: 'text/plain', data }] }), sendAt: Date.now() + 3_600_000, smime: { sign: true, encrypt: false } })
    expect(readdirSync(join(dir, 'outbox'))).toHaveLength(2)
    setVaultKey(null)
    await srv.handle('deleteAccount', { accountId: acc })
    expect(readdirSync(join(dir, 'outbox'))).toEqual([])
  })

  it('hesap silinince başka hesabın giden kutusu dosyasına dokunulmaz', async () => {
    const data = new TextEncoder().encode('ek')
    await send(draft({ attachments: [{ filename: 'ek.txt', mime: 'text/plain', data }] }), { sign: true, encrypt: false })
    const outbox = join(dir, 'outbox')
    const other = join(outbox, `${acc + 1}-1-0-0-baska.txt`)
    const legacy = join(outbox, `${1_790_000_000_000}-0-0-eski.txt`)
    writeFileSync(other, 'x')
    writeFileSync(legacy, 'x')
    setVaultKey(null)
    await srv.handle('deleteAccount', { accountId: acc })
    expect(readdirSync(outbox).sort()).toEqual([other, legacy].map((p) => p.slice(outbox.length + 1)).sort())
  })

  it('op_queue row has no plaintext', async () => {
    await send(draft({ subject: 'GIZLI-KONU-OP' }), { sign: true, encrypt: true })
    const row = ops()[0]
    expect(row.payload_json.startsWith('{')).toBe(false)
    expect(row.payload_json).not.toContain(SECRET)
    expect(dbBytes().includes(SECRET)).toBe(false)
    expect(dbBytes().includes('GIZLI-KONU-OP')).toBe(false)
  })

  it('no sha1/3des/rc2 oid in output', async () => {
    await send(draft(), { sign: true, encrypt: true })
    await drain()
    const inner = decryptEnveloped(pkcs7Der(rawOf(0)), [dk('bob')]).content
    const sigB64 = /smime\.p7s"\r\n\r\n([\s\S]+?)\r\n--/.exec(inner.toString('latin1'))![1]
    for (const der of [pkcs7Der(rawOf(0)), Buffer.from(sigB64, 'base64')]) {
      for (const oid of [SHA1_OID, DES3_OID, RC2_OID]) expect(der.includes(oid)).toBe(false)
    }
  })

  it('send id hash differs when encrypt toggled', () => {
    const d = draft()
    const plain = sendContentHash(d, undefined)
    expect(sendContentHash(d, undefined, { sign: true, encrypt: false })).not.toBe(plain)
    const key = Buffer.alloc(32, 7)
    expect(sendContentHash(d, undefined, { sign: true, encrypt: true }, key)).not.toBe(sendContentHash(d, undefined, { sign: true, encrypt: false }))
    expect(sendContentHash(d, undefined, { sign: true, encrypt: true }, key)).toBe(sendContentHash(d, undefined, { sign: false, encrypt: true }, key))
    expect(sendContentHash(d, undefined, { sign: false, encrypt: false })).toBe(plain)
  })

  it('şifreli gönderim özeti diskte içerik tahmini sınamasına izin vermez', () => {
    const d = draft({ bcc: 'gizli@example.test' })
    const req = { sign: true, encrypt: true }
    const unsalted = createHash('sha256').update(JSON.stringify([
      d.accountId, ['bob@example.test'], [], ['gizli@example.test'], 'Konu', SECRET, '', null, [], true, true
    ])).digest('hex')
    const key = Buffer.alloc(32, 7)
    expect(sendContentHash(d, undefined, req, key)).not.toBe(unsalted)
    expect(sendContentHash(d, undefined, req, key)).toBe(sendContentHash(d, undefined, req, key))
    expect(sendContentHash(d, undefined, req, Buffer.alloc(32, 8))).not.toBe(sendContentHash(d, undefined, req, key))
    expect(sendContentHash(draft({ text: 'başka' }), undefined, req, key)).not.toBe(sendContentHash(d, undefined, req, key))
    expect(() => sendContentHash(d, undefined, req)).toThrow() // anahtarsız şifreli özet düz özete düşmez
  })

  describe('şifreli gönderim özet anahtarı', () => {
    const ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
    const seal = (b: Uint8Array): Uint8Array => b.map((x) => x ^ 0x5a)
    const sealed = vi.fn(async (v: string[]) => v.map((x) => seal(new TextEncoder().encode(x))))
    // yeniden başlatma: aynı DB ve aynı ev sahibi şifrelemesiyle yepyeni hub (bellekte anahtar yok)
    const restart = (): Session => {
      const h = new RpcHub({
        q, scheduler: {} as Scheduler, opq, creds: new Map(), attachDir: join(dir, 'att'),
        encrypt: sealed, decrypt: async (b) => b.map((x) => new TextDecoder().decode(seal(x))),
        userData: dir, dbSchemaVersion: () => 0, smimeTrust: createTrustStore(q), smimeCrl: new CrlCache({ q, mode: () => 'off' })
      }, 'server') // masaüstü kipi yeni kanalda kasayı kilitler
      const s = h.openSession({ send() {}, onMessage() {}, onClose() {}, close() {} }) as unknown as Session
      s.currentUser = user(u1)
      return s
    }
    const req = { sign: true, encrypt: true }

    it('anahtar bir kez üretilir, ev sahibi şifrelemesiyle mühürlenip tercih olarak saklanır', async () => {
      const a = restart()
      await a.handle('sendMail', { draft: draft(), smime: req, clientSendId: ID })
      const stored = q.prefGet('send_hash_key')
      expect(stored).toBeTruthy()
      const plain = sealed.mock.calls.map((c) => c[0][0]).find((x) => /^[0-9a-f]{64}$/.test(x)) ?? ''
      expect(plain).toMatch(/^[0-9a-f]{64}$/)
      expect(stored!.includes(plain)).toBe(false)
      await restart().handle('sendMail', { draft: draft({ subject: 'Başka' }), smime: req, clientSendId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e60' })
      expect(q.prefGet('send_hash_key')).toBe(stored)
    })

    it('yeniden başlatmadan sonra aynı kimlikle yeniden deneme ikinci gönderim olmaz', async () => {
      await restart().handle('sendMail', { draft: draft(), smime: req, clientSendId: ID })
      expect(ops()).toHaveLength(1)
      await restart().handle('sendMail', { draft: draft(), smime: req, clientSendId: ID })
      expect(ops()).toHaveLength(1)
    })

    describe('mühür gerçek değil (masaüstü plain politikası)', () => {
      const plainHub = (): Session => {
        const h = new RpcHub({
          q, scheduler: {} as Scheduler, opq, creds: new Map(), attachDir: join(dir, 'att'),
          encrypt: async (v) => v.map((x) => new TextEncoder().encode(x)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)),
          userData: dir, dbSchemaVersion: () => 0, smimeTrust: createTrustStore(q), smimeCrl: new CrlCache({ q, mode: () => 'off' })
        }, 'server')
        const s = h.openSession({ send() {}, onMessage() {}, onClose() {}, close() {} }) as unknown as Session
        s.currentUser = user(u1)
        return s
      }

      it('anahtar kalıcı yazılmaz, süreç içinde yeniden deneme tek gönderimdir', async () => {
        const a = plainHub()
        await a.handle('sendMail', { draft: draft(), smime: req, clientSendId: ID })
        await a.handle('sendMail', { draft: draft(), smime: req, clientSendId: ID })
        expect(ops()).toHaveLength(1)
        expect(q.prefGet('send_hash_key')).toBeFalsy()
      })

      it('önceden düz yazılmış anahtar silinir', async () => {
        q.prefSet('send_hash_key', Buffer.from('a'.repeat(64)).toString('base64'))
        await plainHub().handle('sendMail', { draft: draft(), smime: req, clientSendId: ID })
        expect(q.prefGet('send_hash_key')).toBeFalsy()
      })
    })

    it('anahtar çözülemezse yeniden üretilir, gönderim engellenmez', async () => {
      q.prefSet('send_hash_key', Buffer.from('bozuk').toString('base64'))
      await restart().handle('sendMail', { draft: draft(), smime: req, clientSendId: ID })
      expect(ops()).toHaveLength(1)
      expect(q.prefGet('send_hash_key')).not.toBe(Buffer.from('bozuk').toString('base64'))
    })
  })

  it('şifreli gönderimde ek adı outbox yolunda görünmez', async () => {
    const name = 'gizli-sozlesme.pdf'
    await send(draft({ attachments: [{ filename: name, mime: 'application/pdf', data: new Uint8Array([1, 2]) }] }), { sign: true, encrypt: true })
    expect(readdirSync(join(dir, 'outbox')).join()).not.toContain('sozlesme')
  })

  it('plain send unchanged', async () => {
    await send(draft({ bcc: 'gizli@example.test' }))
    expect(ops()[0].payload_json.startsWith('{')).toBe(true)
    await drain()
    expect(envelopeOf(0)).toBeUndefined()
    const raw = rawOf(0).toString()
    expect(raw).toContain(SECRET)
    expect(raw).not.toMatch(/pkcs7/i)
    expect(JSON.parse(ops()[0].payload_json).rawB64).toBeTruthy()
  })
})
