import { createPrivateKey } from 'node:crypto'
import { OctetString } from 'asn1js'
import { ContentInfo, EnvelopedData, SignedData } from 'pkijs'
import { describe, expect, it } from 'vitest'
import { decryptEnveloped, encryptEnveloped, signDetached, verifySignedData, type DecryptKey } from '../cms'
import { SmimeFormatError } from '../errors'
import { ensurePkiEngine } from '../engine'
import { openSmime } from '../open'
import { AT, certDer, fxBytes } from './fx'

const pem = fxBytes('alice.key').toString()
const alice: DecryptKey = { key: createPrivateKey(pem), cert: certDer('alice') }
const CONTENT = Buffer.from('Content-Type: text/plain\r\n\r\nx\r\n')
const sign = (chain: Uint8Array[]) => signDetached(CONTENT, { key: alice.key, cert: alice.cert, chain })

const reencode = (ci: ContentInfo, content: { toSchema(enc?: boolean): unknown }): Buffer =>
  Buffer.from(new ContentInfo({ contentType: ci.contentType, content: content.toSchema(true) as never }).toSchema().toBER(false))

describe('kötü niyetli girdi', () => {
  const nested = Buffer.concat([Buffer.alloc(400_000, Buffer.from('3080', 'hex'))])

  it('deeply nested ber does not crash', async () => {
    await expect(verifySignedData(nested, null)).rejects.toBeInstanceOf(SmimeFormatError)
    expect(() => decryptEnveloped(nested, [alice])).toThrow(SmimeFormatError)
    const raw = Buffer.from(`Content-Type: application/pkcs7-mime; smime-type=enveloped-data\r\nContent-Transfer-Encoding: base64\r\n\r\n${nested.toString('base64')}`)
    expect((await openSmime(raw, { keys: () => [alice], evaluate: async () => ({ sig: 'verified', notes: [], signer: null, canSaveCert: false }), at: AT })).info.enc).toBe('failed')
  })

  it('33 certs rejected', async () => {
    const { der } = await sign(Array(32).fill(certDer('int')))
    await expect(verifySignedData(der, CONTENT)).rejects.toBeInstanceOf(SmimeFormatError)
    const ok = await sign(Array(31).fill(certDer('int')))
    expect((await verifySignedData(ok.der, CONTENT)).results[0].valid).toBe(true)
  })

  it('5 signers rejected', async () => {
    ensurePkiEngine()
    const { der } = await sign([])
    const ci = ContentInfo.fromBER(new Uint8Array(der))
    const sd = new SignedData({ schema: ci.content })
    sd.signerInfos.push(sd.signerInfos[0], sd.signerInfos[0], sd.signerInfos[0])
    expect((await verifySignedData(reencode(ci, sd), CONTENT)).results).toHaveLength(4)
    sd.signerInfos.push(sd.signerInfos[0])
    await expect(verifySignedData(reencode(ci, sd), CONTENT)).rejects.toBeInstanceOf(SmimeFormatError)
  })

  it('truncated der → SmimeFormatError', async () => {
    const { der } = await sign([])
    await expect(verifySignedData(der.subarray(0, 40), CONTENT)).rejects.toBeInstanceOf(SmimeFormatError)
    await expect(verifySignedData(Buffer.alloc(0), CONTENT)).rejects.toBeInstanceOf(SmimeFormatError)
    const env = encryptEnveloped(CONTENT, [{ cert: alice.cert, oaep: false }])
    expect(() => decryptEnveloped(env.subarray(0, 60), [alice])).toThrow(SmimeFormatError)
    expect(() => decryptEnveloped(Buffer.alloc(0), [alice])).toThrow(SmimeFormatError)
    expect(() => decryptEnveloped(der, [alice])).toThrow(SmimeFormatError) // SignedData zarf değildir
    await expect(verifySignedData(env, null)).rejects.toBeInstanceOf(SmimeFormatError)
  })

  it('zero-length encrypted content', () => {
    ensurePkiEngine()
    const ci = ContentInfo.fromBER(new Uint8Array(fxBytes('env-aes-cbc.der')))
    const env = new EnvelopedData({ schema: ci.content })
    env.encryptedContentInfo.encryptedContent = new OctetString({ valueHex: new ArrayBuffer(0) })
    expect(() => decryptEnveloped(reencode(ci, env), [alice])).toThrow(SmimeFormatError)
  })

  it('imzacısız SignedData doğrulanmış sayılmaz', async () => {
    ensurePkiEngine()
    const { der } = await sign([])
    const ci = ContentInfo.fromBER(new Uint8Array(der))
    const sd = new SignedData({ schema: ci.content })
    sd.signerInfos = []
    expect((await verifySignedData(reencode(ci, sd), CONTENT)).results).toEqual([])
    const raw = Buffer.concat([
      Buffer.from('Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary=b\r\n\r\n--b\r\n'),
      CONTENT,
      Buffer.from(`\r\n--b\r\nContent-Transfer-Encoding: base64\r\n\r\n${reencode(ci, sd).toString('base64')}\r\n--b--\r\n`)
    ])
    const r = await openSmime(raw, { keys: () => [alice], evaluate: async () => ({ sig: 'verified', notes: [], signer: null, canSaveCert: false }), at: AT })
    expect(r.info.sig).toBe('unsupported')
  })

  it('error message has no key or password material', async () => {
    const messages: string[] = []
    const grab = (fn: () => unknown): void => {
      try {
        fn()
      } catch (e) {
        messages.push(`${(e as Error).message} ${String((e as Error).stack)}`)
      }
    }
    grab(() => decryptEnveloped(Buffer.from('bozuk'), [alice]))
    grab(() => decryptEnveloped(encryptEnveloped(CONTENT, [{ cert: alice.cert, oaep: false }]), [{ key: createPrivateKey(fxBytes('bob.key')), cert: alice.cert }]))
    await verifySignedData(Buffer.from('bozuk'), null).catch((e: Error) => messages.push(`${e.message} ${e.stack}`))
    expect(messages).toHaveLength(3)
    const keyBody = pem.split('\n').slice(1, 3).join('')
    for (const m of messages) {
      expect(m).toMatch(/^smime_/)
      expect(m).not.toContain(keyBody)
      expect(m).not.toMatch(/pkijs|asn1|openssl|padding/i)
    }
  })
})
