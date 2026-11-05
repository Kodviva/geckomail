import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { setVaultKey } from '../vault/state'

// R21: kasa hesabının op payload'u op_queue'da düz metin kalmaz; kasa kilitliyken op listelenmez
describe('kasa op mühürleme', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let q: ReturnType<typeof makeQueries>
  let acc: number
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-seal-'))
    db = openDb(dir)
    q = makeQueries(db)
    acc = q.insertAccount({ email: 'gizli@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    q.setAccountSecureFlag(acc, true)
    setVaultKey(randomBytes(32))
  })
  afterEach(() => {
    setVaultKey(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('içerik diskte düz yazılmaz, açıkken okunur, kilitliyken bekler', () => {
    q.enqueueOp(acc, 'smtp_send', { draft: { subject: 'GİZLİ KONU', text: 'gövde' } })
    const raw = (db.prepare('SELECT payload_json FROM op_queue').get() as { payload_json: string }).payload_json
    expect(raw.startsWith('vault:')).toBe(true)
    expect(raw).not.toContain('GİZLİ')
    expect(JSON.parse(q.dueOps(Date.now() + 1, 10)[0].payload_json).draft.subject).toBe('GİZLİ KONU')
    setVaultKey(null)
    expect(q.dueOps(Date.now() + 1, 10)).toHaveLength(0)
  })

  it('kilitliyken mühürlü satırlar sınırı doldurup düz işleri durdurmaz', () => {
    const other = q.insertAccount({ email: 'acik@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    for (let i = 0; i < 30; i++) q.enqueueOp(acc, 'smtp_send', { draft: { subject: `gizli ${i}` } })
    const plain = q.enqueueOp(other, 'smtp_send', { draft: { subject: 'normal' } })
    expect(q.dueOps(Date.now() + 1, 30)).toHaveLength(30) // açıkken sıra korunur
    setVaultKey(null)
    expect(q.dueOps(Date.now() + 1, 30).map((o) => o.id)).toEqual([plain])
    expect(q.claimDueOps(Date.now() + 1, 30).map((o) => o.id)).toEqual([plain])
  })

  it('kilitliyken webhook şeridi de mühürlü satırlara takılmaz', () => {
    const other = q.insertAccount({ email: 'acik@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    for (let i = 0; i < 30; i++) q.enqueueOp(acc, 'call_webhook', { body: `gizli ${i}` })
    const plain = q.enqueueOp(other, 'call_webhook', { body: 'normal' })
    setVaultKey(null)
    expect(q.dueWebhookOps(Date.now() + 1, 30).map((o) => o.id)).toEqual([plain])
  })

  it('kasa dışı hesap etkilenmez', () => {
    const other = q.insertAccount({ email: 'acik@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    q.enqueueOp(other, 'smtp_send', { draft: { subject: 'normal' } })
    const raw = (db.prepare('SELECT payload_json FROM op_queue').get() as { payload_json: string }).payload_json
    expect(raw).toContain('normal')
  })

  describe('S/MIME: seal seçeneği', () => {
    let other: number
    const rawOf = (id: number) => (db.prepare('SELECT payload_json FROM op_queue WHERE id = ?').get(id) as { payload_json: string }).payload_json
    beforeEach(() => {
      other = q.insertAccount({ email: 'acik@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    })

    it('kasa dışı hesapta mühürlü yazar, kilitliyken dueOps döndürmez', () => {
      const id = q.enqueueOp(other, 'smtp_send', { draft: { subject: 'GİZLİ' } }, { seal: true })
      expect(rawOf(id).startsWith('vault:')).toBe(true)
      expect(rawOf(id)).not.toContain('GİZLİ')
      expect(q.dueOps(Date.now() + 1, 10)).toHaveLength(1)
      setVaultKey(null)
      expect(q.dueOps(Date.now() + 1, 10)).toHaveLength(0)
    })

    it('enqueueOpDelayed da mühürler', () => {
      const id = q.enqueueOpDelayed(other, 'smtp_send', { draft: { subject: 'GİZLİ' } }, Date.now() + 1000, { seal: true })
      expect(rawOf(id).startsWith('vault:')).toBe(true)
    })

    it('opSetPayload mührü korur', () => {
      const id = q.enqueueOp(other, 'smtp_send', { draft: { subject: 'GİZLİ' } }, { seal: true })
      q.opSetPayload(id, { draft: { subject: 'YİNE GİZLİ' }, smimeSent: ['main'] })
      expect(rawOf(id).startsWith('vault:')).toBe(true)
      expect(rawOf(id)).not.toContain('GİZLİ')
      expect(JSON.parse(q.dueOps(Date.now() + 1, 10)[0].payload_json).smimeSent).toEqual(['main'])
    })

    it('mühürsüz kasa dışı op düz kalır', () => {
      const id = q.enqueueOp(other, 'smtp_send', { draft: { subject: 'normal' } })
      q.opSetPayload(id, { draft: { subject: 'hâlâ normal' } })
      expect(rawOf(id)).toContain('hâlâ normal')
    })

    it('anahtar yokken seal/force atar, düz yazmaz', () => {
      setVaultKey(null)
      expect(() => q.enqueueOp(other, 'smtp_send', { draft: { subject: 'GİZLİ' } }, { seal: true })).toThrow()
      expect(() => q.enqueueOpDelayed(other, 'smtp_send', { draft: { subject: 'GİZLİ' } }, 1, { seal: true })).toThrow()
      expect(db.prepare('SELECT COUNT(*) AS n FROM op_queue').get()).toEqual({ n: 0 })
    })

    it('kilitliyken mühürlü op üstüne düz yazılmaz', () => {
      const id = q.enqueueOp(other, 'smtp_send', { draft: { subject: 'GİZLİ' } }, { seal: true })
      setVaultKey(null)
      expect(() => q.opSetPayload(id, { draft: { subject: 'GİZLİ' } })).toThrow()
      expect(rawOf(id).startsWith('vault:')).toBe(true)
    })
  })
})
