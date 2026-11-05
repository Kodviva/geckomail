import { createPrivateKey } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PostalMime from 'postal-mime'
import { describe, expect, it } from 'vitest'
import type { DraftOut } from '../../../shared/rpc'
import type { AccountRow } from '../../db/queries'
import { composeEntity, type SendMeta } from '../../smtpSend'
import { addressesOf, wrapEnveloped, wrapSigned } from '../build'
import { signDetached, verifySignedData } from '../cms'
import { classifyRaw, headerValue, pkcs7Der, splitMultipartSigned } from '../mime'
import { certDer, fxBytes } from './fx'

const account = { email: 'alice@example.test', display_name: 'Alice' } as AccountRow
const META: SendMeta = { messageId: '<m@example.test>', date: Date.UTC(2030, 0, 1) }
const draft = (o: Partial<DraftOut> = {}): DraftOut => ({ accountId: 1, to: 'bob@example.test', subject: 'Konu', text: 'merhaba', ...o })

const partEncodings = (entity: Buffer): string[] =>
  [...entity.toString('latin1').matchAll(/^Content-Transfer-Encoding: *(\S+)/gim)].map((m) => m[1].toLowerCase())

describe('wrapSigned', () => {
  it('splitMultipartSigned ile aynı baytı verir ve imza doğrulanır', async () => {
    const { entity } = await composeEntity(account, draft({ text: 'satır  \r\n\r\nson' }), [], META)
    const { der, micalg } = await signDetached(entity, { key: createPrivateKey(fxBytes('alice.key')), cert: certDer('alice'), chain: [] })
    const wrapped = wrapSigned(entity, der, micalg)
    expect(classifyRaw(wrapped)).toBe('multipart_signed')
    const split = splitMultipartSigned(wrapped)!
    expect(split.signed.equals(entity)).toBe(true)
    expect((await verifySignedData(pkcs7Der(split.signature), split.signed)).results[0].valid).toBe(true)
  })
  it('sınır gövdede geçmez', async () => {
    const { entity } = await composeEntity(account, draft(), [], META)
    const b = /boundary="([^"]+)"/.exec(wrapSigned(entity, Buffer.from([1]), 'sha-256').toString('latin1'))![1]
    expect(entity.includes(b)).toBe(false)
  })
  it('wrapEnveloped köke pkcs7-mime yazar', () => {
    const w = wrapEnveloped(fxBytes('env-aes-cbc.der'))
    expect(classifyRaw(w)).toBe('enveloped')
    expect(pkcs7Der(w).equals(fxBytes('env-aes-cbc.der'))).toBe(true)
  })
})

describe('composeEntity', () => {
  it('all body parts are qp or base64', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gecko-build-'))
    try {
      const path = join(dir, 'a.txt')
      writeFileSync(path, 'düz metin ek\n')
      const { entity } = await composeEntity(account, draft({ text: 'plain ascii', html: '<p>x</p>' }), [{ path, filename: 'a.txt', mime: 'text/plain' }], META)
      const list = partEncodings(entity)
      expect(list.length).toBe(3)
      expect(list.every((e) => e === 'quoted-printable' || e === 'base64')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('iTIP REPLY keeps its calendar part in the signed entity', async () => {
    const content = 'BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nBEGIN:VEVENT\r\nUID:u1\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:alice@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
    const { entity } = await composeEntity(account, draft(), [], { ...META, ical: { method: 'REPLY', content } })
    expect(entity.toString('latin1')).toMatch(/text\/calendar;[^\r]*method=REPLY/i)
    const list = partEncodings(entity)
    expect(list.length).toBe(3)
    expect(list.every((e) => e === 'quoted-printable' || e === 'base64')).toBe(true)
    const parsed = await PostalMime.parse(Buffer.concat([Buffer.from('From: a@b.co\r\n'), entity]))
    const ics = parsed.attachments.find((a) => a.filename === 'invite.ics')
    expect(new TextDecoder().decode(ics?.content as Uint8Array)).toContain('PARTSTAT=ACCEPTED')
  })
  it('long lines and trailing spaces survive', async () => {
    const text = `${'uzun '.repeat(60)}\r\nsondaki boşluk   \r\nçift\t\r\n`
    const { entity } = await composeEntity(account, draft({ text }), [], META)
    for (const line of entity.toString('latin1').split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(78)
      expect(line).not.toMatch(/[ \t]$/)
    }
    expect((await PostalMime.parse(entity)).text?.replace(/\r\n/g, '\n')).toBe(text.replace(/\r\n/g, '\n'))
  })
  it('from-space line survives', async () => {
    const text = 'ilk\r\nFrom the desk\r\nson'
    const { entity } = await composeEntity(account, draft({ text }), [], META)
    expect(entity.toString('latin1')).not.toMatch(/^From /m)
    expect((await PostalMime.parse(entity)).text?.replace(/\r\n/g, '\n').trim()).toBe(text.replace(/\r\n/g, '\n'))
  })
  it('subject crlf cannot inject outer header', async () => {
    const { outer } = await composeEntity(account, draft({ subject: 'x\r\nBcc: gizli@kotu.test\r\n\r\nGOVDE' }), [], META)
    expect(outer).not.toMatch(/^Bcc:/im)
    expect(outer).not.toMatch(/^GOVDE/m)
    expect(outer.includes('\r\n\r\n')).toBe(false)
  })
  it('filename crlf cannot inject', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gecko-build-'))
    try {
      const path = join(dir, 'a.bin')
      writeFileSync(path, 'x')
      const { entity, outer } = await composeEntity(account, draft(), [{ path, filename: 'a\r\nX-Kotu: 1.txt', mime: 'application/octet-stream' }], META)
      expect(`${entity.toString('latin1')}${outer}`).not.toMatch(/^X-Kotu:/im)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('content-type only in entity, not outer', async () => {
    const { outer, entity } = await composeEntity(account, draft(), [], META)
    expect(outer).not.toMatch(/^content-/im)
    expect(headerValue(entity, 'content-type')).toMatch(/^text\/plain/)
    expect(outer).toMatch(/^MIME-Version: 1\.0/im)
    expect(outer).toMatch(/^Subject: Konu/im)
    expect(outer).toMatch(/^Message-ID: <m@example\.test>/im)
    expect(headerValue(entity, 'subject')).toBeNull()
  })
  it('no bcc header in any part', async () => {
    const { outer, entity } = await composeEntity(account, draft({ bcc: 'gizli@example.test' }), [], META)
    expect(`${outer}${entity.toString('latin1')}`).not.toContain('gizli@example.test')
  })
  it('adresler görünen adsız, küçük harfli, tekil', () => {
    expect(addressesOf('Ali <A@x.test>, b@x.test; a@x.test')).toEqual(['a@x.test', 'b@x.test'])
    expect(addressesOf(undefined)).toEqual([])
  })
})
