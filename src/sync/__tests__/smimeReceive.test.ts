import { createPrivateKey } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '../../shared/i18n'
import type { AttachmentInfo, BodyResult, SessionUser } from '../../shared/rpc'
import type { SmimeInfo } from '../../shared/smime'
import { fetchBody, fetchNotifyBodyText } from '../bodyFetch'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { hasAttachmentParts } from '../imapPoll'
import { OpQueue } from '../opQueue'
import { authHandlers } from '../rpc/auth'
import { RpcHub } from '../rpcHub'
import type { RpcSession } from '../rpcSession'
import type { Scheduler } from '../scheduler'
import { AT, certDer, fxBytes } from '../smime/__tests__/fx'
import { encryptEnveloped, signDetached } from '../smime/cms'
import { CrlCache } from '../smime/revocation'
import { harvestContactCert, makeEvaluator } from '../smime/receive'
import { createTrustStore } from '../smime/trust'
import { encrypt } from '../vault/crypto'
import { createVault } from '../vault/manager'
import { getVaultKey, setVaultKey } from '../vault/state'

vi.mock('../net/safeFetch', () => ({ safeFetch: vi.fn(async () => { throw new Error('ağ yok') }) }))

type Session = { handle(method: string, params: unknown): Promise<unknown>; currentUser: SessionUser | null }
type Ready = Extract<BodyResult, { state: 'ready' }> & { smime?: SmimeInfo }

const SECRET = 'GIZLI-IZ-METNI-7421'
const key = (n: string) => createPrivateKey(fxBytes(`${n}.key`))
const INNER = Buffer.from(`From: alice@example.test\r\nTo: bob@example.test\r\nSubject: konu\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${SECRET}\r\n`)
const HTML = Buffer.from(`From: alice@example.test\r\nSubject: konu\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>${SECRET}</p>\r\n`)
const ATTACH = Buffer.from(
  `From: alice@example.test\r\nSubject: konu\r\nContent-Type: multipart/mixed; boundary="m"\r\n\r\n--m\r\nContent-Type: text/plain\r\n\r\n${SECRET}\r\n--m\r\n` +
  `Content-Type: application/pdf; name="gizli.pdf"\r\nContent-Disposition: attachment; filename="gizli.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(SECRET + '-EK').toString('base64')}\r\n--m--\r\n`
)
const head = (from = 'alice@example.test', extra = ''): string => `From: ${from}\r\nTo: bob@example.test\r\nSubject: konu\r\nDate: Mon, 1 Jan 2029 00:00:00 +0000\r\nMIME-Version: 1.0\r\n${extra}`

async function signed(cert: string, body: Buffer, o: { from?: string; chain?: string[]; boundary?: string; keyName?: string } = {}): Promise<Buffer> {
  const { der, micalg } = await signDetached(body, { key: key(o.keyName ?? cert), cert: certDer(cert), chain: (o.chain ?? ['int']).map(certDer) })
  const b = o.boundary ?? 'sb'
  return Buffer.concat([
    Buffer.from(`${head(o.from)}Content-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=${micalg}; boundary="${b}"\r\n\r\n--${b}\r\n`),
    body,
    Buffer.from(`\r\n--${b}\r\nContent-Type: application/pkcs7-signature; name=smime.p7s\r\nContent-Disposition: attachment; filename=smime.p7s\r\nContent-Transfer-Encoding: base64\r\n\r\n${der.toString('base64')}\r\n--${b}--\r\n`)
  ])
}
const p7mime = (der: Buffer, type = 'enveloped-data'): Buffer =>
  Buffer.from(`${head()}Content-Type: application/pkcs7-mime; smime-type=${type}; name=smime.p7m\r\nContent-Transfer-Encoding: base64\r\n\r\n${der.toString('base64')}\r\n`)
const enveloped = (inner: Buffer): Buffer => p7mime(encryptEnveloped(inner, [{ cert: certDer('alice'), oaep: false }]))

describe('S/MIME alma hattı', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let acc: number
  let group: number
  let u1: number
  let u2: number
  let folder: number
  let uid: number
  let raws: Map<number, { raw: Buffer; internal: number; structure?: unknown }>
  let imapCalls: number
  let srv: Session
  let other: Session
  let crl: CrlCache

  const client = {
    getMailboxLock: async () => ({ release() {} }),
    download: async (u: string, part?: string) => {
      imapCalls++
      return { content: Readable.from([part ? Buffer.from('parca metni') : raws.get(Number(u))!.raw]) }
    },
    fetchOne: async (u: string) => {
      const m = raws.get(Number(u))!
      return { internalDate: new Date(m.internal), bodyStructure: m.structure }
    }
  }
  const user = (id: number): SessionUser => ({ id, username: `u${id}`, role: 'member', permittedGroupIds: [group], manageableGroupIds: [group] })
  const addMessage = (raw: Buffer, o: { kind?: 'signed' | 'encrypted' | null; internal?: number; accountId?: number; size?: number; structure?: unknown } = {}): number => {
    uid++
    raws.set(uid, { raw, internal: o.internal ?? AT, structure: o.structure })
    return q.upsertHeader({
      folderId: folder, accountId: o.accountId ?? acc, folderKind: 'inbox', uid, messageId: `<${uid}@t>`, inReplyTo: null, subject: 'konu', fromName: null,
      fromAddr: 'alice@example.test', toJson: null, date: 1, size: o.size ?? raw.length, seen: false, flagged: false, answered: false, hasAttachments: false,
      listUnsubscribe: null, listUnsubscribePost: null, smimeKind: o.kind ?? null
    }).id
  }
  const addIdentity = (userId: number): void => {
    const pkcs8 = key('alice').export({ type: 'pkcs8', format: 'der' })
    q.insertIdentity({
      userId, email: 'alice@example.test', fingerprint: `fp${userId}`, certDer: certDer('alice'), chainDer: '[]',
      keyEnc: encrypt(getVaultKey()!, pkcs8).toString('base64'), notBefore: 0, notAfter: Date.UTC(2100, 0, 1), canSign: true, canEncrypt: true
    })
  }
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5))
  async function open(id: number, s: Session = srv): Promise<Ready> {
    for (let i = 0; i < 200; i++) {
      const r = (await s.handle('getBody', { messageId: id })) as BodyResult
      if (r.state === 'ready') return r as Ready
      if (r.state === 'error') throw new Error(r.error)
      await flush()
    }
    throw new Error('zaman aşımı')
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-smimerx-'))
    db = openDb(dir)
    q = makeQueries(db)
    acc = q.insertAccount({ email: 'bob@example.test', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    group = q.insertGroup('G', '#111111')
    q.setAccountGroup(acc, group)
    folder = q.upsertFolder(acc, 'INBOX', 'inbox')
    u1 = q.insertUser({ username: 'u1', passwordHash: 'h', role: 'member' })
    u2 = q.insertUser({ username: 'u2', passwordHash: 'h', role: 'member' })
    q.addAnchor({ fingerprint: 'root', certDer: certDer('root'), label: 't', addedBy: null })
    uid = 100
    raws = new Map()
    imapCalls = 0
    const stub = new Proxy({}, { get: () => () => undefined })
    const scheduler = {
      enqueueInteractive: async (id: number, fn: (c: unknown, row: unknown) => Promise<unknown>) => fn(client, q.getAccountRow(id)),
      dropSession() {}
    }
    crl = new CrlCache({ q, mode: () => 'crl', fetchUrl: async () => fxBytes('int-empty.crl.der') })
    hub = new RpcHub({
      q, scheduler: scheduler as unknown as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: async (v) => v.map((s) => new TextEncoder().encode(s)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)),
      userData: dir, dbSchemaVersion: () => 0, smimeTrust: createTrustStore(q), smimeCrl: crl
    }, 'server')
    const port = () => ({ send() {}, onMessage() {}, onClose() {}, close() {} })
    srv = hub.openSession(port(), { user: user(u1) }) as unknown as Session
    other = hub.openSession(port(), { user: user(u2) }) as unknown as Session
    createVault(q, 'kasa-parolasi')
  })
  afterEach(() => {
    setVaultKey(null)
    crl.stop()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('imzalı', () => {
    it('verified end to end', async () => {
      const id = addMessage(await signed('alice', INNER), { kind: 'signed' })
      const r = await open(id)
      expect(r.smime).toMatchObject({ sig: 'verified', enc: 'none' })
      expect(r.smime?.signer?.email).toBe('alice@example.test')
      expect(r.textPlain).toContain(SECRET)
      expect(JSON.stringify(r)).not.toContain('evidence')
    })
    it('boş imzalı varlık doğrulandı sayılmaz', async () => {
      const r = await open(addMessage(await signed('alice', Buffer.alloc(0)), { kind: 'signed' }))
      expect(r.smime?.sig).toBe('unsupported')
    })
    it('kaldırılan kök doğrulanmış sonucu hemen düşürür', async () => {
      const id = addMessage(await signed('alice', INNER), { kind: 'signed' })
      expect((await open(id)).smime?.sig).toBe('verified')
      for (const a of q.listAnchors()) q.removeAnchor(a.fingerprint)
      expect((await open(id)).smime?.sig).toBe('untrusted')
    })
    it('tampered body → invalid', async () => {
      const raw = Buffer.from((await signed('alice', INNER)).toString('latin1').replace(SECRET, 'DEGISTI'), 'latin1')
      expect((await open(addMessage(raw, { kind: 'signed' }))).smime?.sig).toBe('invalid')
    })
    it('self-signed never verified', async () => {
      const r = await open(addMessage(await signed('self-signed', INNER, { chain: [] }), { kind: 'signed' }))
      expect(r.smime).toMatchObject({ sig: 'untrusted', canSaveCert: true })
      expect(r.smime?.notes).toContain('self_signed')
    })
    it('address mismatch', async () => {
      expect((await open(addMessage(await signed('alice', INNER, { from: 'baskasi@example.test' }), { kind: 'signed' }))).smime?.sig).toBe('address_mismatch')
    })
    it('from with two addresses → mismatch', async () => {
      const raw = await signed('alice', INNER, { from: 'alice@example.test, baskasi@example.test' })
      expect((await open(addMessage(raw, { kind: 'signed' }))).smime?.sig).toBe('address_mismatch')
    })
    it('date header cannot rescue expired cert', async () => {
      const raw = await signed('expired', INNER, { from: 'alice@example.test' })
      const expiredId = addMessage(raw, { kind: 'signed', internal: Date.UTC(2029, 0, 1) })
      expect((await open(expiredId)).smime?.sig).toBe('expired')
    })
    it('unsigned third part not displayed', async () => {
      const s = (await signed('alice', INNER)).toString('latin1')
      const after = Buffer.from(`${s}\r\n--sb\r\nContent-Type: text/html\r\n\r\n<b>SALDIRGAN</b>\r\n--sb--\r\n`, 'latin1')
      const r = await open(addMessage(after, { kind: 'signed' }))
      expect(r.smime?.sig).toBe('verified')
      expect(`${r.textPlain}${r.html}`).not.toContain('SALDIRGAN')
      const inside = Buffer.from(s.replace('--sb--', '--sb\r\nContent-Type: text/plain\r\n\r\nSALDIRGAN\r\n--sb--'), 'latin1')
      expect((await open(addMessage(inside, { kind: 'signed' }))).smime?.sig).toBe('unsupported')
    })
    it('p7s not listed as attachment', async () => {
      const r = await open(addMessage(await signed('alice', ATTACH), { kind: 'signed' }))
      expect(r.attachments.map((a) => a.filename)).toEqual(['gizli.pdf'])
      expect(hasAttachmentParts({ type: 'application/pkcs7-mime', parameters: { name: 'smime.p7m' } })).toBe(false)
      expect(hasAttachmentParts({ childNodes: [{ type: 'text/plain' }, { type: 'application/pkcs7-signature', disposition: 'attachment' }] })).toBe(false)
      expect(hasAttachmentParts({ childNodes: [{ type: 'text/plain' }, { type: 'application/pkcs7-mime', disposition: 'attachment' }] })).toBe(true)
    })
    it('opaque signed renders inner and indexes it', async () => {
      const der = fxBytes('sig-sha256.der')
      const id = addMessage(p7mime(der, 'signed-data'), { kind: 'signed', internal: AT })
      const r = await open(id)
      expect(r.textPlain).toContain('gizli metin')
      expect(r.smime?.sig).not.toBe('none')
      expect(q.ftsSearch('gizli', null, 10).map((m) => m.id)).toContain(id)
    })
    it('signature in nested part stays none', async () => {
      const s = await signed('alice', INNER)
      const raw = Buffer.concat([Buffer.from(`${head()}Content-Type: multipart/mixed; boundary="o"\r\n\r\n--o\r\n`), s, Buffer.from('\r\n--o--\r\n')])
      const r = await open(addMessage(raw))
      expect(r.smime).toBeUndefined()
    })
    it('imzalı dış kabuk içinde şifreli gövde diske yazılmaz', async () => {
      const inner = enveloped(HTML)
      const id = addMessage(await signed('alice', inner), { kind: 'signed' })
      const msg = q.getMessage(id)!
      await fetchBody(q, q.getAccountRow(acc)!, msg, client as never, join(dir, 'att'))
      expect(q.getMessage(id)?.smimeKind).toBe('encrypted')
      expect(q.getBodyRow(id)).toMatchObject({ text_plain: null, html: null })
    })
    it('büyük iletide tüm ham iner, sınırı aşan imzalı too_large alır', async () => {
      const big = Buffer.concat([Buffer.from('Content-Type: text/plain\r\n\r\n'), Buffer.alloc(2_000_000, 0x61)])
      const id = addMessage(await signed('alice', big), { kind: 'signed' })
      expect((await open(id)).smime?.sig).toBe('verified')
      const huge = addMessage(Buffer.alloc(31_000_000, 0x41), { kind: 'signed', size: 31_000_000, structure: { type: 'text/plain', part: '1' } })
      const r = await open(huge)
      expect(r.smime?.notes).toContain('too_large')
      expect(r.smime?.sig).toBe('unsupported')
      expect(r.textPlain).toBe('parca metni')
    })
  })

  describe('şifreli', () => {
    const encryptedMsg = (inner = INNER): number => addMessage(enveloped(inner), { kind: 'encrypted' })
    const dbBytes = (): Buffer => Buffer.concat(['geckomail.db', 'geckomail.db-wal'].filter((f) => existsSync(join(dir, f))).map((f) => readFileSync(join(dir, f))))

    beforeEach(() => addIdentity(u1))

    it('no plaintext in sqlite', async () => {
      const id = encryptedMsg()
      const r = await open(id)
      expect(r.textPlain).toContain(SECRET)
      await fetchBody(q, q.getAccountRow(acc)!, q.getMessage(id)!, client as never, join(dir, 'att'))
      expect(dbBytes().includes(SECRET)).toBe(false)
    })
    it('no attachment file written', async () => {
      const id = encryptedMsg(ATTACH)
      const r = await open(id)
      const a = r.attachments[0] as AttachmentInfo & { smimeIndex?: number }
      expect(a).toMatchObject({ filename: 'gizli.pdf', smimeIndex: 0, id: -1, diskPath: null })
      expect(existsSync(join(dir, 'att')) ? readdirSync(join(dir, 'att'), { recursive: true }) : []).toEqual([])
      const data = (await srv.handle('getSmimeAttachment', { messageId: id, index: 0 })) as { base64: string; filename: string }
      expect(Buffer.from(data.base64, 'base64').toString()).toBe(`${SECRET}-EK`)
      expect(dbBytes().includes('gizli.pdf')).toBe(false)
    })
    it('fts search finds subject not body', async () => {
      const id = encryptedMsg()
      await fetchBody(q, q.getAccountRow(acc)!, q.getMessage(id)!, client as never, join(dir, 'att'))
      await open(id)
      expect(q.ftsSearch('konu', null, 10).map((m) => m.id)).toContain(id)
      expect(q.ftsSearch(SECRET, null, 10)).toEqual([])
    })
    it('preview empty', async () => {
      const id = encryptedMsg()
      await fetchBody(q, q.getAccountRow(acc)!, q.getMessage(id)!, client as never, join(dir, 'att'))
      expect(q.getMessage(id)?.preview ?? '').toBe('')
      expect(q.getMessage(id)?.hasAttachments).toBe(false)
    })
    it('bodies row has nulls', async () => {
      const id = encryptedMsg()
      await fetchBody(q, q.getAccountRow(acc)!, q.getMessage(id)!, client as never, join(dir, 'att'))
      expect(q.getBodyRow(id)).toMatchObject({ text_plain: null, html: null })
    })
    it('member without key sees no_key', async () => {
      const id = encryptedMsg()
      const before = imapCalls
      expect((await open(id, other)).smime?.enc).toBe('no_key')
      expect(imapCalls).toBe(before)
    })
    it('decrypted cache isolated per user', async () => {
      const id = encryptedMsg()
      expect((await open(id)).smime?.enc).toBe('decrypted')
      const r = await open(id, other)
      expect(r.textPlain).toBeNull()
      expect(r.smime?.enc).toBe('no_key')
      await expect(other.handle('getSmimeAttachment', { messageId: id, index: 0 })).rejects.toThrow()
    })
    it('vault lock clears decrypted cache', async () => {
      const id = encryptedMsg()
      await open(id)
      expect(hub.smimeCache.get(u1, id)).not.toBeNull()
      hub.lockVaultNow()
      expect(hub.smimeCache.get(u1, id)).toBeNull()
      expect((await open(id)).smime?.enc).toBe('locked')
    })
    it('user logout clears only theirs', async () => {
      addIdentity(u2)
      const id = encryptedMsg()
      await open(id)
      await open(id, other)
      await authHandlers.logout(srv as unknown as RpcSession, {})
      expect(hub.smimeCache.get(u1, id)).toBeNull()
      expect(hub.smimeCache.get(u2, id)).not.toBeNull()
    })
    it('kimlik silinince önbellek gider', async () => {
      const id = encryptedMsg()
      await open(id)
      await srv.handle('smimeRemoveIdentity', { id: q.listIdentities(u1)[0].id, confirmEmail: 'alice@example.test' })
      expect(hub.smimeCache.get(u1, id)).toBeNull()
    })
    it('locked vault returns locked without imap', async () => {
      const id = encryptedMsg()
      setVaultKey(null)
      const before = imapCalls
      expect(await srv.handle('getBody', { messageId: id })).toMatchObject({ state: 'ready', textPlain: null, html: null, attachments: [], smime: { enc: 'locked' } })
      expect(imapCalls).toBe(before)
    })
    it('çözüm sürerken kilitlenirse düz metin önbelleğe girmez', async () => {
      const id = encryptedMsg()
      const first = (await srv.handle('getBody', { messageId: id })) as BodyResult
      expect(first.state).toBe('fetching')
      setVaultKey(null)
      await flush()
      await flush()
      expect(hub.smimeCache.get(u1, id)).toBeNull()
    })
    it('bozuk içerik enc failed', async () => {
      const raw = Buffer.from(enveloped(INNER).toString('latin1').replace(/Transfer-Encoding: base64\r\n\r\n..../, 'Transfer-Encoding: base64\r\n\r\nAAAA'), 'latin1')
      const r = await open(addMessage(raw, { kind: 'encrypted' }))
      expect(r.smime?.enc).toBe('failed')
      expect(r.textPlain).toBeNull()
    })
    it('ham sınırını aşan şifreli ileti too_large', async () => {
      const id = addMessage(Buffer.alloc(31_000_000, 0x41), { kind: 'encrypted', size: 31_000_000 })
      const r = await open(id)
      expect(r.smime).toMatchObject({ enc: 'failed' })
      expect(r.smime?.notes).toContain('too_large')
    })

    describe('EFAIL', () => {
      it('unauthenticated html dropped server side', async () => {
        const r = await open(encryptedMsg(HTML))
        expect(r.smime?.notes).toContain('unauthenticated')
        expect(r.html).toBeNull()
        expect(r.textPlain).toContain(SECRET)
      })
      it('imzalı iç gövdede html kalır, dış imza html açmaz', async () => {
        const id = addMessage(enveloped(await signed('alice', HTML)), { kind: 'encrypted' })
        expect((await open(id)).html).toContain(SECRET)
        const outer = await signed('alice', enveloped(HTML))
        const id2 = addMessage(outer, { kind: 'encrypted' })
        const r = await open(id2)
        expect(r.smime?.notes).toContain('unauthenticated')
        expect(r.html).toBeNull()
      })
      it('encrypted part under multipart/mixed not decrypted', async () => {
        const part = encryptEnveloped(HTML, [{ cert: certDer('alice'), oaep: false }]).toString('base64')
        const raw = Buffer.from(
          `${head()}Content-Type: multipart/mixed; boundary="o"\r\n\r\n--o\r\nContent-Type: text/html\r\n\r\n<img src="http://kotu.test/?` +
          `\r\n--o\r\nContent-Type: application/pkcs7-mime; smime-type=enveloped-data; name=x.p7m\r\nContent-Transfer-Encoding: base64\r\n\r\n${part}\r\n--o--\r\n`
        )
        const r = await open(addMessage(raw))
        expect(r.smime).toBeUndefined()
        expect(`${r.textPlain}${r.html}`).not.toContain(SECRET)
      })
      it('remote images refused for encrypted', async () => {
        const { safeFetch } = await import('../net/safeFetch')
        const id = encryptedMsg()
        q.saveBody(id, null, '<img src="https://kotu.test/x.png">', 10)
        expect(await srv.handle('fetchRemoteImages', { messageId: id })).toEqual({ images: {} })
        expect(safeFetch).not.toHaveBeenCalled()
      })
      it('outer attacker html not merged', async () => {
        const raw = Buffer.from(enveloped(INNER).toString('latin1').replace('MIME-Version', 'Content-Type: text/html\r\nMIME-Version'), 'latin1')
        const r = await open(addMessage(raw, { kind: 'encrypted' }))
        expect(r.html).toBeNull()
        expect(r.textPlain).toBeNull()
        expect(r.smime?.sig).toBe('unsupported')
      })
    })
  })

  describe('sertifika toplama', () => {
    const contacts = (u: number): string[] => q.listContactCerts(u).map((c) => c.email)

    it('harvest only when verified', async () => {
      await open(addMessage(await signed('alice', INNER), { kind: 'signed' }))
      expect(contacts(u1)).toEqual(['alice@example.test'])
      const row = q.listContactCerts(u1)[0]
      expect(JSON.parse(row.capabilities!)).toContain('2.16.840.1.101.3.4.1.42')
    })
    it('self-signed not harvested', async () => {
      await open(addMessage(await signed('self-signed', INNER, { chain: [] }), { kind: 'signed' }))
      expect(contacts(u1)).toEqual([])
    })
    it('vault account not harvested', async () => {
      q.setAccountSecureFlag(acc, true)
      const r = await open(addMessage(await signed('alice', INNER), { kind: 'signed' }))
      expect(r.smime).toMatchObject({ sig: 'verified', canSaveCert: true })
      expect(contacts(u1)).toEqual([])
    })
    it('harvest belongs to opener only', async () => {
      await open(addMessage(await signed('alice', INNER), { kind: 'signed' }), other)
      expect(contacts(u2)).toEqual(['alice@example.test'])
      expect(contacts(u1)).toEqual([])
    })
    it('elle kaydetme parmak iziyle', async () => {
      const id = addMessage(await signed('self-signed', INNER, { chain: [] }), { kind: 'signed' })
      const r = await open(id)
      await expect(srv.handle('smimeSaveContactCert', { messageId: id, fingerprint: 'yanlis' })).rejects.toThrow()
      await srv.handle('smimeSaveContactCert', { messageId: id, fingerprint: r.smime!.signer!.fingerprint })
      expect(q.listContactCerts(u1)[0].source).toBe('manual')
    })
    it('elle kaydetmede sertifika adresi gönderenle eşleşmeli', async () => {
      const id = addMessage(await signed('self-signed', INNER, { chain: [] }), { kind: 'signed' })
      const r = await open(id)
      db.prepare(`UPDATE messages SET from_addr = 'baska@example.test' WHERE id = ?`).run(id)
      await expect(srv.handle('smimeSaveContactCert', { messageId: id, fingerprint: r.smime!.signer!.fingerprint })).rejects.toThrow(t('smime.sig.addressMismatch'))
      expect(q.listContactCerts(u1)).toEqual([])
    })
    it('adres eşleşmeyen imzada kaydetme düğmesi çıkmaz', async () => {
      const raw = await signed('self-signed', INNER, { chain: [], from: 'baska@example.test' })
      const id = addMessage(raw, { kind: 'signed' })
      db.prepare(`UPDATE messages SET from_addr = 'baska@example.test' WHERE id = ?`).run(id)
      const r = await open(id)
      expect(r.smime?.canSaveCert).toBe(false)
    })
    it('harvestContactCert yalnız From adresiyle eşleşen adresi yazar', () => {
      const msg = q.getMessage(addMessage(Buffer.from('x')))!
      harvestContactCert(q, u1, { ...msg, fromAddr: 'baska@example.test' }, { valid: true, hashAlg: 'sha256', sigAlg: 'rsa', signer: certDer('alice'), certs: [], capabilities: [], unsupported: false }, [])
      expect(contacts(u1)).toEqual([])
    })
    it('revocation_unknown clears after crl arrives', async () => {
      const id = addMessage(await signed('alice', INNER), { kind: 'signed' })
      expect((await open(id)).smime?.notes).toContain('revocation_unknown')
      await crl.drain()
      expect((await open(id)).smime?.notes).not.toContain('revocation_unknown')
    })
    it('güven deposu yoksa fail closed', async () => {
      const deps = { ...hub.deps, smimeTrust: undefined, smimeCrl: undefined }
      hub = new RpcHub(deps, 'server')
      const s = hub.openSession({ send() {}, onMessage() {}, onClose() {}, close() {} }, { user: user(u1) }) as unknown as Session
      const r = await open(addMessage(await signed('alice', INNER), { kind: 'signed' }), s)
      expect(r.smime?.sig).toBe('untrusted')
      expect(r.smime?.notes).toContain('revocation_unknown')
      expect(contacts(u1)).toEqual([])
    })
    it('makeEvaluator yapraksız sonucu unsupported yapar', async () => {
      const e = makeEvaluator({ store: hub.deps.smimeTrust!, crl })
      const r = await e({ valid: true, hashAlg: 'sha256', sigAlg: 'rsa', signer: null, certs: [], capabilities: [], unsupported: false }, { from: null, at: AT })
      expect(r.sig).toBe('unsupported')
    })
  })

  it('forward rule skips encrypted', async () => {
    const id = addMessage(enveloped(INNER), { kind: 'encrypted' })
    const ev = { emitOpFailed: vi.fn(), emitChanged: vi.fn(), emitAutomationLogged: vi.fn() }
    const opq = new OpQueue(q, hub.deps.scheduler, new Map(), join(dir, 'att'), ev)
    const opId = q.enqueueOp(acc, 'forward', { messageId: id, to: 'x@y.co' })
    await (opq as unknown as { runImapOp(c: unknown, o: unknown): Promise<void> }).runImapOp(client, q.getOp(opId))
    expect(q.getOp(opId)).toBeFalsy()
    expect(q.listOps(null).filter((o) => o.kind === 'smtp_send')).toEqual([])
    const log = q.getRuleLog(5)
    expect(log[0]).toMatchObject({ ok: 0, message_id: id })
    expect(ev.emitAutomationLogged).toHaveBeenCalled()
  })

  it('notify body null for encrypted', async () => {
    const id = addMessage(enveloped(INNER), { kind: 'encrypted' })
    const download = vi.fn(async () => {})
    expect(await fetchNotifyBodyText(q, id, download)).toBeNull()
    expect(download).not.toHaveBeenCalled()
  })
})
