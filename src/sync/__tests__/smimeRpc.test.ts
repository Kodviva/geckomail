import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '../../shared/rpc'
import type { RecipientStatus, SmimeIdentityInfo } from '../../shared/smime'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import type { OpQueue } from '../opQueue'
import { RpcHub } from '../rpcHub'
import type { Scheduler } from '../scheduler'
import { certDer, fxBytes, AT } from '../smime/__tests__/fx'
import { encodeChain, loadDecryptKeys, loadSignKey, resolveRecipients } from '../smime/identity'
import { parseP12 } from '../smime/p12'
import { CrlCache } from '../smime/revocation'
import { createTrustStore } from '../smime/trust'
import { createVault } from '../vault/manager'
import { setVaultKey } from '../vault/state'
import { signDetached } from '../smime/cms'
import { SmimeLockedError, SmimeNoIdentityError } from '../smime/errors'

type Session = { handle(method: string, params: unknown): Promise<unknown>; currentUser: SessionUser | null }

const PASS = fxBytes('p12-password.txt').toString().trim()
const VAULT = 'kasa-parolasi'
const p12b64 = (name = 'alice-modern.p12'): string => fxBytes(name).toString('base64')

describe('S/MIME RPC', { timeout: 30_000 }, () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let srv: Session
  let acc: number
  let group: number
  let u1: number
  let u2: number

  const user = (id: number, role: 'admin' | 'member' = 'member', o: Partial<SessionUser> = {}): SessionUser => ({
    id, username: `u${id}`, role, permittedGroupIds: [group], manageableGroupIds: [group], ...o
  })
  const importAlice = (over: object = {}): Promise<SmimeIdentityInfo> =>
    srv.handle('smimeImportIdentity', { accountId: acc, p12Base64: p12b64(), password: PASS, ...over }) as Promise<SmimeIdentityInfo>
  const contact = (name: string, email: string, capabilities: string | null = null): void => {
    const der = certDer(name)
    q.upsertContactCert({
      userId: u1, email, fingerprint: name, certDer: der, chainDer: encodeChain([certDer('int'), certDer('root')]),
      notAfter: new X509Certificate(der).validToDate.getTime(), capabilities, source: 'manual'
    })
  }
  const check = (addresses: string[]) => srv.handle('smimeCheckRecipients', { accountId: acc, addresses }) as Promise<{
    canSign: boolean; canEncrypt: boolean; blocked: string | null; recipients: { address: string; status: RecipientStatus }[]
  }>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-smimerpc-'))
    db = openDb(dir)
    q = makeQueries(db)
    acc = q.insertAccount({ email: 'alice@example.test', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    group = q.insertGroup('G', '#111111')
    q.setAccountGroup(acc, group)
    u1 = q.insertUser({ username: 'u1', passwordHash: 'h', role: 'member' })
    u2 = q.insertUser({ username: 'u2', passwordHash: 'h', role: 'admin' })
    q.addAnchor({ fingerprint: 'root', certDer: certDer('root'), label: 'test', addedBy: null })
    const stub = new Proxy({}, { get: () => () => undefined })
    const smimeCrl = new CrlCache({ q, mode: () => 'crl', fetchUrl: async () => Buffer.alloc(0), now: () => AT })
    hub = new RpcHub({
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: async (v) => v.map((s) => new TextEncoder().encode(s)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)),
      userData: dir, dbSchemaVersion: () => 0, smimeTrust: createTrustStore(q), smimeCrl
    }, 'desktop')
    hub.now = () => AT
    srv = hub.openSession({ send() {}, onMessage() {}, onClose() {}, close() {} }) as unknown as Session
    srv.currentUser = user(u1)
    createVault(q, VAULT)
  })
  afterEach(() => {
    setVaultKey(null)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('import stores key sealed', async () => {
    const info = await importAlice()
    expect(info).toMatchObject({ email: 'alice@example.test', canSign: true, canEncrypt: true, chainState: 'verified' })
    const row = q.listIdentities(u1)[0]
    const { keyPkcs8 } = await parseP12(fxBytes('alice-modern.p12'), PASS)
    expect(Buffer.from(row.key_enc, 'base64').includes(keyPkcs8.subarray(400, 440))).toBe(false)
    db.pragma('wal_checkpoint(TRUNCATE)')
    expect(readFileSync(join(dir, 'geckomail.db')).includes(keyPkcs8.subarray(400, 440))).toBe(false)
    expect(JSON.parse(row.chain_der)).toHaveLength(2)
  })

  it('imported key signs and decrypts through identity helpers', async () => {
    await importAlice()
    const k = loadSignKey(q, u1, 'Alice@example.test', AT)
    expect((await signDetached(Buffer.from('x'), k)).micalg).toBe('sha-256')
    expect(loadDecryptKeys(q, u1)).toHaveLength(1)
    expect(() => loadSignKey(q, u2, 'alice@example.test', AT)).toThrow(SmimeNoIdentityError)
    expect(() => loadSignKey(q, u1, 'alice@example.test', Date.UTC(2101, 0, 1))).toThrow(SmimeNoIdentityError)
    expect(loadDecryptKeys(q, u1)).toHaveLength(1)
    setVaultKey(null)
    expect(() => loadSignKey(q, u1, 'alice@example.test', AT)).toThrow(SmimeLockedError)
    expect(loadDecryptKeys(q, u1)).toBe('locked')
  })

  it('second import of same certificate is idempotent', async () => {
    const a = await importAlice()
    const b = await importAlice()
    expect(b.id).toBe(a.id)
    expect(q.listIdentities(u1)).toHaveLength(1)
  })

  it('import fails when vault locked', async () => {
    setVaultKey(null)
    await expect(importAlice()).rejects.toThrow('Kasayı açın')
  })

  it('import fails when address differs', async () => {
    const other = q.insertAccount({ email: 'baska@example.test', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    q.setAccountGroup(other, group)
    await expect(importAlice({ accountId: other })).rejects.toThrow('eşleşmiyor')
    expect(q.listIdentities(u1)).toHaveLength(0)
  })

  it('view-only member cannot import', async () => {
    srv.currentUser = user(u1, 'member', { manageableGroupIds: [] })
    await expect(importAlice()).rejects.toThrow('yetkiniz yok')
  })

  it('other user cannot export', async () => {
    const { id } = await importAlice()
    srv.currentUser = user(u2, 'member')
    await expect(srv.handle('smimeExportIdentity', { id, vaultPassphrase: VAULT, exportPassword: 'yeni-parola-12' })).rejects.toThrow('bulunamadı')
  })

  it('admin cannot export member key', async () => {
    const { id } = await importAlice()
    srv.currentUser = user(u2, 'admin')
    await expect(srv.handle('smimeExportIdentity', { id, vaultPassphrase: VAULT, exportPassword: 'yeni-parola-12' })).rejects.toThrow('bulunamadı')
    await expect(srv.handle('smimeRemoveIdentity', { id, confirmEmail: 'alice@example.test' })).rejects.toThrow('bulunamadı')
    expect(await srv.handle('smimeListIdentities', {})).toEqual([])
  })

  it('export needs vault passphrase', async () => {
    const { id } = await importAlice()
    await expect(srv.handle('smimeExportIdentity', { id, vaultPassphrase: 'yanlis', exportPassword: 'yeni-parola-12' })).rejects.toThrow('Kasa parolası hatalı')
    await expect(srv.handle('smimeExportIdentity', { id, vaultPassphrase: VAULT, exportPassword: 'kisa' })).rejects.toThrow('en az 12')
    const out = (await srv.handle('smimeExportIdentity', { id, vaultPassphrase: VAULT, exportPassword: 'yeni-parola-12' })) as { filename: string; base64: string }
    expect(out.filename).toBe('alice@example.test.p12')
    const c = await parseP12(Buffer.from(out.base64, 'base64'), 'yeni-parola-12')
    expect(Buffer.from(c.leaf).equals(certDer('alice'))).toBe(true)
    setVaultKey(null)
    await expect(srv.handle('smimeExportIdentity', { id, vaultPassphrase: VAULT, exportPassword: 'yeni-parola-12' })).rejects.toThrow('Kasayı açın')
  })

  it('export passphrase tries are rate limited per user', async () => {
    const { id } = await importAlice()
    const good = { id, vaultPassphrase: VAULT, exportPassword: 'yeni-parola-12' }
    const bad = { ...good, vaultPassphrase: 'yanlis' }
    let now = AT
    hub.now = () => now
    // başarı sayacı sıfırlar: dağınık yazım hataları kilitlemez
    for (let i = 0; i < 4; i++) await expect(srv.handle('smimeExportIdentity', bad)).rejects.toThrow('Kasa parolası hatalı')
    await srv.handle('smimeExportIdentity', good)
    for (let i = 0; i < 5; i++) await expect(srv.handle('smimeExportIdentity', bad)).rejects.toThrow('Kasa parolası hatalı')
    // kilitliyken doğru parola da denenmez: dışarıdan doğru tahmin ayırt edilemez
    await expect(srv.handle('smimeExportIdentity', good)).rejects.toThrow('Çok fazla hatalı deneme')
    await expect(srv.handle('smimeExportIdentity', bad)).rejects.toThrow('Çok fazla hatalı deneme')

    srv.currentUser = user(u2, 'member')
    const other = await importAlice()
    await expect(srv.handle('smimeExportIdentity', { ...bad, id: other.id })).rejects.toThrow('Kasa parolası hatalı')

    srv.currentUser = user(u1, 'member')
    now += 15 * 60_000
    await srv.handle('smimeExportIdentity', good)
  })

  it('short export password does not spend a passphrase try', async () => {
    const { id } = await importAlice()
    for (let i = 0; i < 8; i++) await expect(srv.handle('smimeExportIdentity', { id, vaultPassphrase: 'yanlis', exportPassword: 'kisa' })).rejects.toThrow('en az 12')
    await srv.handle('smimeExportIdentity', { id, vaultPassphrase: VAULT, exportPassword: 'yeni-parola-12' })
  })

  it('içe aktarma eski çözüm önbelleğini temizler', async () => {
    hub.smimeCache.set(u1, 5, { textPlain: 'x', html: null, attachments: [], signers: [], info: { sig: 'none', enc: 'failed', notes: [], signer: null, canSaveCert: false } })
    await importAlice()
    expect(hub.smimeCache.get(u1, 5)).toBeNull()
  })

  it('yönetici parola sıfırlayınca üye uyarılır, kendi sıfırlaması uyarı üretmez', async () => {
    const notified: { userId: number; title: string }[] = []
    hub.securityAlert = (userId, title) => void notified.push({ userId, title })
    srv.currentUser = user(u2, 'admin')
    await srv.handle('resetUserPassword', { userId: u2, newPassword: 'yeni-parola-1' })
    expect(notified).toEqual([])
    await srv.handle('resetUserPassword', { userId: u1, newPassword: 'yeni-parola-1' })
    expect(notified.map((n) => n.userId)).toEqual([u1])
    srv.currentUser = user(u1)
    expect(await srv.handle('getSecurityNotice', {})).toEqual({ passwordResetAt: AT, mustChangePassword: true })
  })

  it('sıfırlanan parolayla giren uyarıyı kapatamaz; bayrak yalnız üyenin kendi parola değişimiyle kalkar', async () => {
    srv.currentUser = user(u2, 'admin')
    await srv.handle('resetUserPassword', { userId: u1, newPassword: 'sifirlanan-1' })
    srv.currentUser = user(u1)
    await expect(srv.handle('ackSecurityNotice', {})).rejects.toThrow('parolanızı değiştirin')
    await expect(srv.handle('changeOwnPassword', { currentPassword: 'yanlis-parola', newPassword: 'kendi-parolam-1' })).rejects.toThrow('hatalı')
    await expect(srv.handle('changeOwnPassword', { currentPassword: 'sifirlanan-1', newPassword: 'kisa' })).rejects.toThrow()
    expect(await srv.handle('getSecurityNotice', {})).toMatchObject({ mustChangePassword: true })
    await srv.handle('changeOwnPassword', { currentPassword: 'sifirlanan-1', newPassword: 'kendi-parolam-1' })
    expect(await srv.handle('getSecurityNotice', {})).toEqual({ passwordResetAt: AT, mustChangePassword: false })
    await srv.handle('ackSecurityNotice', {})
    expect(await srv.handle('getSecurityNotice', {})).toEqual({ passwordResetAt: null, mustChangePassword: false })
    srv.currentUser = user(u2, 'admin')
    await srv.handle('resetUserPassword', { userId: u1, newPassword: 'yeniden-sifir-1' })
    expect(q.userPrefGet(u1, 'password_set_by_admin')).toBe('1')
  })

  it('adı tutan ama sertifikayı imzalamamış yayımcı iptali gizleyemez', async () => {
    q.putCrl({ url: 'http://crl.example.test/int.crl', der: fxBytes('int-revoked.crl.der'), thisUpdate: 1, nextUpdate: AT * 2, fetchedAt: AT, lastErrorAt: null })
    q.upsertContactCert({ userId: u1, email: 'x@example.test', fingerprint: 'r', certDer: certDer('revoked'), chainDer: encodeChain([certDer('same-name-int'), certDer('int')]), notAfter: AT * 2, capabilities: null, source: 'manual' })
    expect(resolveRecipients(q, { userId: u1, addresses: ['x@example.test'], now: AT }).get('x@example.test')?.status).toBe('revoked')
    const spy = vi.spyOn(q, 'crlSetState')
    q.upsertContactCert({ userId: u1, email: 'y@example.test', fingerprint: 'r2', certDer: certDer('revoked'), chainDer: encodeChain([certDer('same-name-int')]), notAfter: AT * 2, capabilities: null, source: 'manual' })
    spy.mockClear()
    resolveRecipients(q, { userId: u1, addresses: ['y@example.test'], now: AT })
    expect(spy).not.toHaveBeenCalled() // sahte yayımcı için liste hiç sorulmaz
  })

  it('zincirde olmayan yayımcı ve ara sertifika iptali de görülür', async () => {
    q.putCrl({ url: 'http://crl.example.test/int.crl', der: fxBytes('int-revoked.crl.der'), thisUpdate: 1, nextUpdate: AT * 2, fetchedAt: AT, lastErrorAt: null })
    q.addAnchor({ fingerprint: 'int', certDer: certDer('int'), label: 'ara', addedBy: null })
    q.upsertContactCert({ userId: u1, email: 'x@example.test', fingerprint: 'r', certDer: certDer('revoked'), chainDer: '[]', notAfter: AT * 2, capabilities: null, source: 'manual' })
    expect(resolveRecipients(q, { userId: u1, addresses: ['x@example.test'], now: AT }).get('x@example.test')?.status).toBe('revoked')
  })

  it('remove needs matching email', async () => {
    const { id } = await importAlice()
    await expect(srv.handle('smimeRemoveIdentity', { id, confirmEmail: 'x@example.test' })).rejects.toThrow('eşleşmiyor')
    expect(q.listIdentities(u1)).toHaveLength(1)
    await srv.handle('smimeRemoveIdentity', { id, confirmEmail: 'ALICE@example.test' })
    expect(q.listIdentities(u1)).toHaveLength(0)
  })

  it('self-signed import returns chainState untrusted', async () => {
    const { buildP12 } = await import('../smime/p12')
    const { createPrivateKey } = await import('node:crypto')
    const self = await buildP12({ keyPkcs8: createPrivateKey(fxBytes('self-signed.key')).export({ type: 'pkcs8', format: 'der' }), leaf: certDer('self-signed'), chain: [] }, PASS)
    const info = (await srv.handle('smimeImportIdentity', { accountId: acc, p12Base64: self.toString('base64'), password: PASS })) as SmimeIdentityInfo
    expect(info.chainState).toBe('untrusted')
  })

  it('listIdentities never returns key_enc', async () => {
    await importAlice()
    const list = await srv.handle('smimeListIdentities', {})
    expect(JSON.stringify(list)).not.toContain(q.listIdentities(u1)[0].key_enc)
    expect(Object.keys((list as object[])[0])).not.toContain('key_enc')
    expect(Object.keys((list as object[])[0])).not.toContain('keyEnc')
  })

  it('password not in thrown error', async () => {
    const secret = 'gizli-p12-parolasi-987'
    const e = (await importAlice({ password: secret }).catch((x: Error) => x)) as Error
    expect(e.message).toContain('hatalı')
    expect(`${e.message}${e.stack}`).not.toContain(secret)
    const garbage = (await importAlice({ p12Base64: Buffer.from('bozuk').toString('base64'), password: secret }).catch((x: Error) => x)) as Error
    expect(`${garbage.message}${garbage.stack}`).not.toContain(secret)
  })

  it('member cannot add anchor', async () => {
    await expect(srv.handle('smimeAddAnchor', { pemOrDerBase64: certDer('int').toString('base64'), label: 'x' })).rejects.toThrow('yönetici yetkisi')
    await expect(srv.handle('smimeRemoveAnchor', { fingerprint: 'root' })).rejects.toThrow('yönetici yetkisi')
  })

  it('admin adds and removes anchors; leaf is refused', async () => {
    srv.currentUser = user(u2, 'admin')
    await srv.handle('smimeAddAnchor', { pemOrDerBase64: fxBytes('int.crt').toString(), label: 'Kurum' })
    const info = (await srv.handle('smimeTrustInfo', {})) as { count: number; anchors: { label: string; fingerprint: string }[] }
    expect(info.count).toBeGreaterThanOrEqual(50)
    const added = info.anchors.find((a) => a.label === 'Kurum')!
    await expect(srv.handle('smimeAddAnchor', { pemOrDerBase64: certDer('alice').toString('base64'), label: 'yaprak' })).rejects.toThrow('Geçersiz kök')
    await srv.handle('smimeRemoveAnchor', { fingerprint: added.fingerprint })
    expect(((await srv.handle('smimeTrustInfo', {})) as typeof info).anchors.some((a) => a.label === 'Kurum')).toBe(false)
  })

  it('check recipients reports missing/expired/revoked/weak/unsupported_key', async () => {
    await importAlice()
    contact('bob', 'bob@example.test')
    contact('expired', 'old@example.test')
    contact('revoked', 'gone@example.test')
    contact('rsa1024', 'weak@example.test')
    contact('sha1', 'sha1@example.test')
    contact('ec-p256', 'ec@example.test')
    contact('sign-only', 'sign@example.test')
    contact('bob', 'noaes@example.test', JSON.stringify(['1.2.840.113549.3.7']))
    q.putCrl({ url: 'http://crl.example.test/int.crl', der: fxBytes('int-revoked.crl.der'), thisUpdate: 1, nextUpdate: AT + 1000, fetchedAt: AT, lastErrorAt: null })
    const r = await check(['bob@example.test', 'none@example.test', 'old@example.test', 'gone@example.test', 'weak@example.test', 'sha1@example.test', 'ec@example.test', 'sign@example.test', 'noaes@example.test'])
    expect(Object.fromEntries(r.recipients.map((x) => [x.address.split('@')[0], x.status]))).toEqual({
      bob: 'ok', none: 'missing', old: 'expired', gone: 'revoked', weak: 'weak', sha1: 'weak', ec: 'unsupported_key', sign: 'unsupported_key', noaes: 'weak'
    })
    expect(r.canSign).toBe(true)
    expect(r.canEncrypt).toBe(false)
    expect((await check(['bob@example.test'])).canEncrypt).toBe(true)
  })

  it('crl with bad signature does not revoke; off mode skips crl', async () => {
    contact('revoked', 'gone@example.test')
    await importAlice()
    q.putCrl({ url: 'http://crl.example.test/int.crl', der: fxBytes('int-badsig.crl.der'), thisUpdate: 1, nextUpdate: AT + 1000, fetchedAt: AT, lastErrorAt: null })
    expect((await check(['gone@example.test'])).recipients[0].status).toBe('ok')
    q.putCrl({ url: 'http://crl.example.test/int.crl', der: fxBytes('int-revoked.crl.der'), thisUpdate: 1, nextUpdate: AT + 1000, fetchedAt: AT + 1, lastErrorAt: null })
    expect((await check(['gone@example.test'])).recipients[0].status).toBe('revoked')
    q.prefSet('smimeRevocation', 'off')
    expect((await check(['gone@example.test'])).recipients[0].status).toBe('ok')
  })

  it('own cert missing blocks encrypt', async () => {
    expect((await check([])).blocked).toBe('no_identity')
    setVaultKey(null)
    expect((await check([])).blocked).toBe('vault_locked')
  })

  it('vault none is reported', async () => {
    db.prepare(`DELETE FROM prefs WHERE key LIKE 'vault_%'`).run()
    setVaultKey(null)
    expect((await check([])).blocked).toBe('vault_none')
    await expect(importAlice()).rejects.toThrow('yönetici')
  })

  it('sign-only own cert blocks encrypt', async () => {
    const der = certDer('sign-only')
    q.insertIdentity({
      userId: u1, email: 'alice@example.test', fingerprint: 'so', certDer: der, chainDer: '[]', keyEnc: 'x', notBefore: 0, notAfter: AT * 2, canSign: true, canEncrypt: false
    })
    const r = await check([])
    expect(r).toMatchObject({ canSign: true, canEncrypt: false, blocked: 'own_cert_missing' })
  })

  it('contact certs belong to their user', async () => {
    contact('bob', 'bob@example.test')
    const list = (await srv.handle('smimeListContactCerts', {})) as { id: number; subject: string }[]
    expect(list).toHaveLength(1)
    expect(list[0].subject).toContain('CN=Bob')
    srv.currentUser = user(u2, 'admin')
    expect(await srv.handle('smimeListContactCerts', {})).toEqual([])
    await srv.handle('smimeRemoveContactCert', { id: list[0].id })
    srv.currentUser = user(u1)
    expect(await srv.handle('smimeListContactCerts', {})).toHaveLength(1)
    await srv.handle('smimeRemoveContactCert', { id: list[0].id })
    expect(await srv.handle('smimeListContactCerts', {})).toEqual([])
  })
})
