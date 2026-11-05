import { createPrivateKey } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { encryptEnveloped, signDetached, type DecryptKey } from '../cms'
import { openSmime, type SigEvaluator } from '../open'
import { AT, certDer, fxBytes } from './fx'

const key = (name: string) => createPrivateKey(fxBytes(`${name}.key`))
const alice: DecryptKey = { key: key('alice'), cert: certDer('alice') }
const INNER = Buffer.from('From: alice@example.test\r\nSubject: konu\r\nContent-Type: text/plain\r\n\r\nmerhaba\r\n')
const HEAD = 'From: alice@example.test\r\nTo: bob@example.test\r\nSubject: konu\r\nMIME-Version: 1.0\r\n'

const ok: SigEvaluator = async () => ({ sig: 'verified', notes: [], signer: null, canSaveCert: false })
const open = (raw: Buffer, o: Partial<Parameters<typeof openSmime>[1]> = {}) => openSmime(raw, { keys: () => [alice], evaluate: ok, at: AT, ...o })

async function multipartSigned(body: Buffer, head = HEAD): Promise<Buffer> {
  const { der, micalg } = await signDetached(body, { key: key('alice'), cert: certDer('alice'), chain: [certDer('int')] })
  return Buffer.concat([
    Buffer.from(`${head}Content-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=${micalg}; boundary="sb"\r\n\r\n--sb\r\n`),
    body,
    Buffer.from(`\r\n--sb\r\nContent-Type: application/pkcs7-signature; name=smime.p7s\r\nContent-Transfer-Encoding: base64\r\n\r\n${der.toString('base64')}\r\n--sb--\r\n`)
  ])
}
const p7 = (der: Buffer, type = 'enveloped-data', head = HEAD): Buffer =>
  Buffer.from(`${head}Content-Type: application/pkcs7-mime; smime-type=${type}; name=smime.p7m\r\nContent-Transfer-Encoding: base64\r\n\r\n${der.toString('base64')}\r\n`)
const envelope = (b: Buffer, head = HEAD): Buffer => p7(encryptEnveloped(b, [{ cert: certDer('alice'), oaep: false }]), 'enveloped-data', head)

describe('openSmime', () => {
  it('S/MIME olmayan ileti dokunulmadan döner', async () => {
    const raw = Buffer.from('Content-Type: text/plain\r\n\r\nx')
    const r = await open(raw)
    expect(r.entity).toEqual(raw)
    expect(r.info).toEqual({ sig: 'none', enc: 'none', notes: [], signer: null, canSaveCert: false })
    expect(r.harvest).toBeNull()
  })

  it('imzalı ileti: entity yalnız imzalı baytlardır', async () => {
    const r = await open(await multipartSigned(INNER))
    expect(r.entity).toEqual(INNER)
    expect(r.info).toMatchObject({ sig: 'verified', enc: 'none', notes: [] })
    expect(r.harvest?.valid).toBe(true)
  })

  it('kurcalanmış imzalı içerik invalid, değerlendiriciye gitmez', async () => {
    const raw = Buffer.from((await multipartSigned(INNER)).toString('latin1').replace('merhaba', 'MERHABA'), 'latin1')
    const evaluate = vi.fn(ok)
    const r = await open(raw, { evaluate })
    expect(r.info.sig).toBe('invalid')
    expect(evaluate).not.toHaveBeenCalled()
    expect(r.harvest).toBeNull()
  })

  it('yalnız LF ile saklanmış ileti CRLF kanonikleştirilerek doğrulanır', async () => {
    const raw = Buffer.from((await multipartSigned(INNER)).toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
    expect((await open(raw)).info.sig).toBe('verified')
  })

  it('opak imzalı ileti', async () => {
    const r = await open(p7(fxBytes('sig-sha256.der'), 'signed-data'))
    expect(r.info.sig).toBe('verified')
    expect(r.entity).toEqual(fxBytes('msg.eml'))
  })

  it('sha1 imza değerlendirici verified dese de doğrulanmış sayılmaz', async () => {
    const r = await open(p7(fxBytes('sig-sha1.der'), 'signed-data'))
    expect(r.info.sig).toBe('weak_algorithm')
    expect(r.harvest).toBeNull()
  })

  it('md5 imza unsupported', async () => {
    expect((await open(p7(fxBytes('sig-md5.der'), 'signed-data'))).info.sig).toBe('unsupported')
  })

  it('signed then encrypted returns both states', async () => {
    const r = await open(envelope(await multipartSigned(INNER, '')))
    expect(r.info).toMatchObject({ sig: 'verified', enc: 'decrypted', notes: [] })
    expect(r.entity).toEqual(INNER)
  })

  it('enveloped without signature marks unauthenticated', async () => {
    const r = await open(envelope(INNER))
    expect(r.info).toMatchObject({ sig: 'none', enc: 'decrypted' })
    expect(r.info.notes).toContain('unauthenticated')
  })

  it('invalid signature inside encrypted keeps unauthenticated', async () => {
    const signed = Buffer.from((await multipartSigned(INNER, '')).toString('latin1').replace('merhaba', 'MERHABA'), 'latin1')
    const r = await open(envelope(signed))
    expect(r.info).toMatchObject({ sig: 'invalid', enc: 'decrypted' })
    expect(r.info.notes).toContain('unauthenticated')
  })

  it('güvenilmeyen ama matematiksel geçerli imza bütünlük kanıtıdır', async () => {
    const r = await open(envelope(await multipartSigned(INNER, '')), { evaluate: async () => ({ sig: 'untrusted', notes: [], signer: null, canSaveCert: true }) })
    expect(r.info.sig).toBe('untrusted')
    expect(r.info.canSaveCert).toBe(true)
    expect(r.info.notes).not.toContain('unauthenticated')
  })

  it('dış imza şifreli içeriğin bütünlüğünü kanıtlamaz', async () => {
    const html = Buffer.from('From: alice@example.test\r\nContent-Type: text/html\r\n\r\n<b>x</b>\r\n')
    const evaluate: SigEvaluator = async () => ({ sig: 'untrusted', notes: [], signer: null, canSaveCert: false })
    const r = await open(await multipartSigned(envelope(html)), { evaluate })
    expect(r.info.enc).toBe('decrypted')
    expect(r.info.notes).toContain('unauthenticated')
  })

  it('dış AEAD içteki CBC zarfının bütünlüğünü kanıtlamaz', async () => {
    const r = await open(p7(fxBytes('env-gcm-over-cbc.der'), 'authEnveloped-data'))
    expect(r.info.enc).toBe('decrypted')
    expect(r.info.notes).toContain('unauthenticated')
  })

  it('son çözümden sonraki geçerli imza bütünlük sağlar, geçersizi sağlamaz', async () => {
    const ok2 = await open(envelope(await multipartSigned(INNER)))
    expect(ok2.info.notes).not.toContain('unauthenticated')
    const signed = await multipartSigned(INNER)
    const bad = await open(envelope(Buffer.from(signed.toString('latin1').replace('merhaba', 'MERHABA'), 'latin1')))
    expect(bad.info.notes).toContain('unauthenticated')
  })

  it('başka katman kötüyse sertifika toplanmaz', async () => {
    const inner = Buffer.from((await multipartSigned(INNER)).toString('latin1').replace('merhaba', 'MERHABA').replaceAll('sb', 'ib'), 'latin1')
    const r = await open(await multipartSigned(inner))
    expect(r.info.sig).toBe('invalid')
    expect(r.harvest).toBeNull()
  })

  it('aes-gcm without signature is authenticated', async () => {
    const r = await open(p7(fxBytes('env-aes-gcm.der'), 'authEnveloped-data'))
    expect(r.info.enc).toBe('decrypted')
    expect(r.info.notes).not.toContain('unauthenticated')
  })

  it('3DES ve RC2 weak_cipher notu alır', async () => {
    for (const f of ['env-3des.der', 'env-rc2-40.der']) expect((await open(p7(fxBytes(f)))).info.notes).toEqual(expect.arrayContaining(['weak_cipher', 'unauthenticated']))
  })

  it('locked returns enc locked without touching content', async () => {
    const raw = p7(Buffer.from('bu DER bile değil'))
    const r = await open(raw, { keys: () => 'locked' })
    expect(r.info).toMatchObject({ enc: 'locked', sig: 'none' })
    expect(r.entity).toHaveLength(0)
  })

  it('anahtar yoksa no_key, gövde yok', async () => {
    const r = await open(envelope(INNER), { keys: () => [{ key: key('bob'), cert: certDer('bob') }] })
    expect(r.info.enc).toBe('no_key')
    expect(r.entity).toHaveLength(0)
  })

  it('bozuk zarf failed, ECDH unsupported', async () => {
    expect((await open(p7(Buffer.from('bozuk')))).info.enc).toBe('failed')
    expect((await open(p7(fxBytes('env-ecdh.der')))).info.enc).toBe('unsupported')
  })

  it('MIME olmayan çözüm başarı sayılmaz', async () => {
    expect((await open(envelope(Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80])))).info.enc).toBe('failed')
  })

  it('inner from differs → header_mismatch', async () => {
    const inner = Buffer.from('From: mallory@example.test\r\nContent-Type: text/plain\r\n\r\nx\r\n')
    expect((await open(envelope(inner))).info.notes).toContain('header_mismatch')
  })

  it('sarmalı message/rfc822 konusu farklıysa header_mismatch, entity iç iletidir', async () => {
    const msg = 'From: alice@example.test\r\nTo: bob@example.test\r\nSubject: =?utf-8?B?a29udQ==?= degil\r\nContent-Type: text/plain\r\n\r\nx\r\n'
    const wrapped = Buffer.from(`Content-Type: message/rfc822\r\n\r\n${msg}`)
    const r = await open(envelope(wrapped))
    expect(r.info.notes).toContain('header_mismatch')
    expect(r.entity.toString()).toBe(msg)
  })

  it('kodlanmış ama aynı konu fark sayılmaz', async () => {
    const wrapped = Buffer.from('Content-Type: message/rfc822\r\n\r\nFrom: Alice <ALICE@example.test>\r\nTo: bob@example.test\r\nSubject: =?utf-8?B?a29udQ==?=\r\n\r\nx')
    expect((await open(envelope(wrapped))).info.notes).not.toContain('header_mismatch')
  })

  it('imza değerlendiriciye yalnız en dış From ve INTERNALDATE gider', async () => {
    const evaluate = vi.fn(ok)
    await open(envelope(await multipartSigned(Buffer.from('From: mallory@example.test\r\n\r\nx'), '')), { evaluate })
    expect(evaluate.mock.calls[0][1]).toEqual({ from: 'alice@example.test', at: AT })
  })

  it('çoklu From değerlendiriciye null gider', async () => {
    const evaluate = vi.fn(ok)
    await open(await multipartSigned(INNER, 'From: a@x.test, b@x.test\r\n'), { evaluate })
    expect(evaluate.mock.calls[0][1].from).toBeNull()
  })

  it('üç katman açılır', async () => {
    const r = await open(envelope(await multipartSigned(envelope(INNER, ''), '')))
    expect(r.info).toMatchObject({ sig: 'verified', enc: 'decrypted' })
    expect(r.entity).toEqual(INNER)
  })

  it('depth 4 → unsupported', async () => {
    const r = await open(envelope(envelope(envelope(envelope(INNER, ''), ''), '')))
    expect(r.info.enc).toBe('unsupported')
    expect(r.entity).toHaveLength(0)
  })

  it('compressed → unsupported', async () => {
    const r = await open(p7(Buffer.from('x'), 'compressed-data'))
    expect(r.info.sig).toBe('unsupported')
    expect(r.entity).toHaveLength(0)
  })

  it('belirsiz yapı unsupported, gövde açılmaz', async () => {
    const raw = Buffer.from('Content-Type: text/html\r\nContent-Type: application/pkcs7-mime; smime-type=enveloped-data\r\n\r\n<img src=x>')
    expect((await open(raw)).info.sig).toBe('unsupported')
  })

  it('üç parçalı multipart/signed unsupported', async () => {
    const raw = Buffer.from('Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary=b\r\n\r\n--b\r\n\r\na\r\n--b\r\n\r\nb\r\n--b\r\n\r\nc\r\n--b--\r\n')
    expect((await open(raw)).info.sig).toBe('unsupported')
  })

  it('kök dışında gömülü şifreli parça çözülmez', async () => {
    const keys = vi.fn((): DecryptKey[] => [alice])
    const p = p7(fxBytes('env-aes-cbc.der'), 'enveloped-data', '').toString()
    const raw = Buffer.from(`Content-Type: multipart/mixed; boundary=m\r\n\r\n--m\r\nContent-Type: text/html\r\n\r\n<img src="x\r\n--m\r\n${p}\r\n--m--\r\n`)
    const r = await open(raw, { keys })
    expect(keys).not.toHaveBeenCalled()
    expect(r.info).toMatchObject({ enc: 'none', sig: 'none' })
    expect(r.entity).toEqual(raw)
  })
})
