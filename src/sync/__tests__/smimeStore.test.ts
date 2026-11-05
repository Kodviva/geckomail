import { randomBytes } from 'crypto'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { setVaultKey } from '../vault/state'
import type { SmimeInfo } from '../../shared/smime'

const INFO: SmimeInfo = { sig: 'verified', enc: 'none', notes: [], signer: null, canSaveCert: false }

describe('S/MIME deposu', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let q: ReturnType<typeof makeQueries>
  let acc: number
  let u1: number
  let u2: number

  const account = (email: string): number =>
    q.insertAccount({ email, displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
  const message = (accountId: number, uid: number): number => {
    const folderId = q.upsertFolder(accountId, 'INBOX', 'inbox')
    return q.upsertHeader({
      folderId, accountId, folderKind: 'inbox', uid, messageId: `<${uid}@t.co>`, inReplyTo: null, subject: 's', fromName: null, fromAddr: 'a@t.co',
      toJson: null, date: 1, size: 1, seen: false, flagged: false, answered: false, hasAttachments: false, listUnsubscribe: null, listUnsubscribePost: null
    }).id
  }
  const identity = (userId: number, fingerprint = 'aa'): number =>
    q.insertIdentity({
      userId, email: 'a@t.co', fingerprint, certDer: Buffer.from('c'), chainDer: '[]', keyEnc: 'k', notBefore: 1, notAfter: 2, canSign: true, canEncrypt: true
    })
  const contact = (userId: number, fingerprint = 'bb'): void =>
    q.upsertContactCert({ userId, email: 'b@t.co', fingerprint, certDer: Buffer.from('c'), chainDer: '[]', notAfter: 2, capabilities: null, source: 'auto' })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-smime-'))
    db = openDb(dir)
    q = makeQueries(db)
    acc = account('a@t.co')
    u1 = q.insertUser({ username: 'u1', passwordHash: 'h', role: 'member' })
    u2 = q.insertUser({ username: 'u2', passwordHash: 'h', role: 'member' })
  })
  afterEach(() => {
    setVaultKey(null)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('başka kullanıcının kimliği dönmez ve silinemez', () => {
    const id = identity(u1)
    expect(q.getIdentity(u2, id)).toBeUndefined()
    expect(q.getIdentity(u1, id)?.email).toBe('a@t.co')
    expect(q.listIdentities(u2)).toEqual([])
    expect(q.identitiesForEmail(u2, 'a@t.co')).toEqual([])
    expect(q.deleteIdentity(u2, id)).toBe(false)
    expect(q.listIdentities(u1)).toHaveLength(1)
    expect(q.deleteIdentity(u1, id)).toBe(true)
  })

  it('başka kullanıcının alıcı sertifikası görünmez ve silinemez', () => {
    contact(u1)
    const id = q.listContactCerts(u1)[0].id
    expect(q.listContactCerts(u2)).toEqual([])
    expect(q.contactCerts(u2, 'b@t.co')).toEqual([])
    expect(q.deleteContactCert(u2, id)).toBe(false)
    expect(q.contactCerts(u1, 'b@t.co')).toHaveLength(1)
  })

  it('aynı alıcı sertifikası güncellenir, last_seen ilerler, ilk görülme korunur', () => {
    contact(u1)
    const first = q.contactCerts(u1, 'b@t.co')[0]
    q.upsertContactCert({ userId: u1, email: 'b@t.co', fingerprint: 'bb', certDer: Buffer.from('c'), chainDer: '[]', notAfter: 9, capabilities: '["x"]', source: 'manual' })
    const rows = q.contactCerts(u1, 'b@t.co')
    expect(rows).toHaveLength(1)
    expect(rows[0].first_seen_at).toBe(first.first_seen_at)
    expect(rows[0].last_seen_at).toBeGreaterThanOrEqual(first.last_seen_at)
    expect(rows[0].not_after).toBe(9)
  })

  it('kullanıcı silinince kimlik ve sertifikalar gider', () => {
    identity(u1)
    contact(u1)
    db.prepare('DELETE FROM users WHERE id = ?').run(u1)
    expect(q.listIdentities(u1)).toEqual([])
    expect(q.listContactCerts(u1)).toEqual([])
  })

  it('hesap silinince kimlik kalır', () => {
    identity(u1)
    q.deleteAccount(acc)
    expect(q.listIdentities(u1)).toHaveLength(1)
  })

  it('kasa hesabında message_smime.info düz JSON değildir, açıkken okunur, kilitliyken null döner', () => {
    setVaultKey(randomBytes(32))
    q.setAccountSecureFlag(acc, true)
    const id = message(acc, 1)
    q.setMessageSmime(id, INFO)
    const raw = (db.prepare('SELECT info FROM message_smime WHERE message_id = ?').get(id) as { info: string }).info
    expect(() => JSON.parse(raw)).toThrow()
    expect(raw).not.toContain('verified')
    expect(q.getMessageSmime(id)).toEqual(INFO)
    setVaultKey(null)
    expect(q.getMessageSmime(id)).toBeNull()
  })

  it('kasa dışı hesapta bilgi okunur, ileti silinince gider, yoksa null', () => {
    const id = message(acc, 1)
    expect(q.getMessageSmime(id)).toBeNull()
    q.setMessageSmime(id, INFO)
    q.setMessageSmime(id, { ...INFO, sig: 'invalid' })
    expect(q.getMessageSmime(id)?.sig).toBe('invalid')
    q.setSmimeKind(id, 'signed')
    expect(q.getMessage(id)?.smimeKind).toBe('signed')
    db.prepare('DELETE FROM messages WHERE id = ?').run(id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM message_smime').get()).toEqual({ n: 0 })
  })

  it('hesap kasaya alınınca message_smime mühürlenir; canlıya dönünce düz okunur', () => {
    const id = message(acc, 1)
    q.setMessageSmime(id, INFO)
    setVaultKey(randomBytes(32))
    q.convertAccountToSecure(acc)
    q.setAccountSecureFlag(acc, true)
    const sealed = (db.prepare('SELECT info FROM message_smime WHERE message_id = ?').get(id) as { info: string }).info
    expect(sealed).not.toContain('verified')
    expect(q.getMessageSmime(id)).toEqual(INFO)
    q.convertAccountToLive(acc)
    q.setAccountSecureFlag(acc, false)
    expect((db.prepare('SELECT info FROM message_smime WHERE message_id = ?').get(id) as { info: string }).info).toContain('verified')
    expect(q.getMessageSmime(id)).toEqual(INFO)
  })

  it('smime_kind başlıkla yazılır ve mesaj satırına düz çıkar', () => {
    setVaultKey(randomBytes(32))
    q.setAccountSecureFlag(acc, true)
    const folderId = q.upsertFolder(acc, 'INBOX', 'inbox')
    const { id } = q.upsertHeader({
      folderId, accountId: acc, folderKind: 'inbox', uid: 7, messageId: '<7@t.co>', inReplyTo: null, subject: 's', fromName: null, fromAddr: 'a@t.co', toJson: null,
      date: 1, size: 1, seen: false, flagged: false, answered: false, hasAttachments: false, listUnsubscribe: null, listUnsubscribePost: null, smimeKind: 'encrypted'
    })
    expect((db.prepare('SELECT smime_kind FROM messages WHERE id = ?').get(id) as { smime_kind: string }).smime_kind).toBe('encrypted')
    expect(q.getMessage(id)?.smimeKind).toBe('encrypted')
  })

  it('kurum kökleri ve CRL kaydı', () => {
    q.addAnchor({ fingerprint: 'ff', certDer: Buffer.from('c'), label: 'Kurum', addedBy: u1 })
    expect(q.listAnchors().map((a) => a.label)).toEqual(['Kurum'])
    db.prepare('DELETE FROM users WHERE id = ?').run(u1)
    expect(q.listAnchors()[0].added_by).toBeNull() // güven kurulum genelidir, ekleyen silinince kalır
    expect(q.removeAnchor('ff')).toBe(true)
    expect(q.listAnchors()).toEqual([])
    expect(q.getCrl('http://x')).toBeUndefined()
    q.putCrl({ url: 'http://x', der: Buffer.from('d'), thisUpdate: 1, nextUpdate: 2, fetchedAt: 3, lastErrorAt: null })
    q.putCrl({ url: 'http://x', der: Buffer.from('e'), thisUpdate: 4, nextUpdate: 5, fetchedAt: 6, lastErrorAt: null })
    expect(q.getCrl('http://x')).toMatchObject({ this_update: 4, next_update: 5, fetched_at: 6 })
  })

  it('cihaz senkron şeması S/MIME içermez', () => {
    for (const f of ['../deviceSync.ts', '../db/q/sync.ts']) {
      expect(readFileSync(new URL(f, import.meta.url), 'utf-8')).not.toMatch(/smime/i)
    }
  })
})
