import { execFileSync } from 'node:child_process'
import { constants, createCipheriv, createPrivateKey, publicEncrypt, randomBytes, sign, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromBER, OctetString, Sequence } from 'asn1js'
import { AlgorithmIdentifier, ContentInfo, EnvelopedData, SignedData, type SignerInfo } from 'pkijs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseCert } from '../certInfo'
import { decryptEnveloped, encryptEnveloped, rc2EffectiveBits, signDetached, verifySignedData, type DecryptKey, type SignKey } from '../cms'
import { SmimeNoKeyError, SmimeFormatError, SmimeUnsupportedError } from '../errors'
import { ensurePkiEngine } from '../engine'
import { certDer, fxBytes, fxPath } from './fx'

const keyOf = (name: string) => createPrivateKey(fxBytes(`${name}.key`))
const signer = (name: string): SignKey => ({ key: keyOf(name), cert: certDer(name), chain: [certDer('int')] })
const decKey = (name: string): DecryptKey => ({ key: keyOf(name), cert: certDer(name) })
const CONTENT = Buffer.from('Content-Type: text/plain\r\n\r\nimzalı gövde  \r\n')
const CMS_DATA = fxBytes('msg.eml')

const hasOpensslCms = (() => {
  try {
    return execFileSync('openssl', ['cms', '-help'], { stdio: 'pipe' }).length >= 0
  } catch {
    return false
  }
})()

/** İmzalı öznitelik baytını kurcala: SignerInfo'nun signedAttrs bloğundaki messageDigest değeri */
function flipSignedAttr(der: Buffer): Buffer {
  ensurePkiEngine()
  const ci = ContentInfo.fromBER(new Uint8Array(der))
  const sd = new SignedData({ schema: ci.content })
  const attrs = sd.signerInfos[0].signedAttrs!
  const enc = new Uint8Array(attrs.encodedValue)
  const out = Buffer.from(der)
  const at = out.indexOf(Buffer.from(enc.subarray(enc.length - 8)))
  out[at + 7] ^= 1
  return out
}

describe('imza', () => {
  it.each(['alice', 'ec-p256'])('imza-doğrulama turu %s', async (name) => {
    const { der, micalg } = await signDetached(CONTENT, signer(name))
    expect(micalg).toBe('sha-256')
    const { results, content } = await verifySignedData(der, CONTENT)
    expect(content).toBeNull()
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ valid: true, hashAlg: 'sha256', unsupported: false })
    expect(parseCert(results[0].signer!).fingerprint).toBe(parseCert(certDer(name)).fingerprint)
    expect(results[0].certs).toHaveLength(2)
  })

  it('SMIMECapabilities bildirir: AES ve OAEP', async () => {
    const { der } = await signDetached(CONTENT, signer('alice'))
    const { results } = await verifySignedData(der, CONTENT)
    expect(results[0].capabilities).toEqual(expect.arrayContaining(['2.16.840.1.101.3.4.1.42', '2.16.840.1.101.3.4.1.2', '2.16.840.1.101.3.4.2.1', '1.2.840.113549.1.1.7']))
  })

  it('tampered content → valid false', async () => {
    const { der } = await signDetached(CONTENT, signer('alice'))
    const { results } = await verifySignedData(der, Buffer.from(CONTENT.toString().replace('imzalı', 'sahte')))
    expect(results[0].valid).toBe(false)
  })

  it('tampered signedAttrs → valid false', async () => {
    const { der } = await signDetached(CONTENT, signer('alice'))
    const { results } = await verifySignedData(flipSignedAttr(der), CONTENT)
    expect(results[0].valid).toBe(false)
  })

  it('opak imzayı ayrık içerikle doğrulatma denemesi reddedilir', async () => {
    const { results } = await verifySignedData(fxBytes('sig-sha256.der'), Buffer.from('saldırganın gövdesi'))
    expect(results[0].valid).toBe(false)
  })

  it('opak imza içeriği döner', async () => {
    const { results, content } = await verifySignedData(fxBytes('sig-sha256.der'), null)
    expect(results[0]).toMatchObject({ valid: true, hashAlg: 'sha256' })
    expect(content).toEqual(CMS_DATA)
  })

  it('sha1 signature reports hashAlg', async () => {
    const { results } = await verifySignedData(fxBytes('sig-sha1.der'), null)
    expect(results[0]).toMatchObject({ valid: true, hashAlg: 'sha1', unsupported: false })
  })

  it('md5 → unsupported', async () => {
    const { results } = await verifySignedData(fxBytes('sig-md5.der'), null)
    expect(results[0]).toMatchObject({ valid: false, hashAlg: 'md5', unsupported: true })
  })

  it('P-384 anahtarla SHA-384', async () => {
    const k = signer('ec-p384')
    const { der, micalg } = await signDetached(CONTENT, k)
    expect(micalg).toBe('sha-384')
    expect((await verifySignedData(der, CONTENT)).results[0]).toMatchObject({ valid: true, hashAlg: 'sha384' })
  })
})

describe('şifre', () => {
  it.each([false, true])('şifre turu oaep=%s', (oaep) => {
    const der = encryptEnveloped(CONTENT, [{ cert: certDer('alice'), oaep }, { cert: certDer('bob'), oaep: false }])
    for (const name of ['alice', 'bob']) {
      const r = decryptEnveloped(der, [decKey(name)])
      expect(r).toMatchObject({ cipher: 'aes-cbc', aead: false })
      expect(r.content).toEqual(CONTENT)
    }
  })

  it('anahtar kimlik sertifikasıyla eşleşir, sıra önemsiz', () => {
    const der = encryptEnveloped(CONTENT, [{ cert: certDer('alice'), oaep: false }])
    expect(decryptEnveloped(der, [decKey('bob'), decKey('alice')]).content).toEqual(CONTENT)
  })

  it('decrypts aes-cbc fixture', () => {
    expect(decryptEnveloped(fxBytes('env-aes-cbc.der'), [decKey('alice')])).toMatchObject({ content: CMS_DATA, cipher: 'aes-cbc', aead: false })
  })

  it('decrypts oaep fixture', () => {
    expect(decryptEnveloped(fxBytes('env-oaep.der'), [decKey('alice')]).content).toEqual(CMS_DATA)
  })

  it('decrypts aes-gcm auth-enveloped fixture', () => {
    expect(decryptEnveloped(fxBytes('env-aes-gcm.der'), [decKey('alice')])).toMatchObject({ content: CMS_DATA, cipher: 'aes-gcm', aead: true })
  })

  it('kurcalanmış GCM reddedilir', () => {
    const d = fxBytes('env-aes-gcm.der')
    const out = Buffer.from(d)
    out[out.length - 40] ^= 1
    expect(() => decryptEnveloped(out, [decKey('alice')])).toThrow(SmimeFormatError)
  })

  it('decrypts 3des fixture', () => {
    expect(decryptEnveloped(fxBytes('env-3des.der'), [decKey('alice')])).toMatchObject({ content: CMS_DATA, cipher: '3des', aead: false })
  })

  it('decrypts rc2-40 fixture', () => {
    expect(decryptEnveloped(fxBytes('env-rc2-40.der'), [decKey('alice')])).toMatchObject({ content: CMS_DATA, cipher: 'rc2', aead: false })
  })

  it('tek DES ve ECDH desteklenmez', () => {
    expect(() => decryptEnveloped(fxBytes('env-des.der'), [decKey('alice')])).toThrow(SmimeUnsupportedError)
    expect(() => decryptEnveloped(fxBytes('env-ecdh.der'), [decKey('ec-p256')])).toThrow(SmimeUnsupportedError)
  })

  it('no matching key → SmimeNoKeyError', () => {
    expect(() => decryptEnveloped(fxBytes('env-aes-cbc.der'), [decKey('bob')])).toThrow(SmimeNoKeyError)
    expect(() => decryptEnveloped(fxBytes('env-aes-cbc.der'), [])).toThrow(SmimeNoKeyError)
  })

  it('wrong key never returns garbage as success', () => {
    const der = encryptEnveloped(CONTENT, [{ cert: certDer('alice'), oaep: false }])
    for (let i = 0; i < 20; i++) {
      const wrong: DecryptKey = { key: keyOf('bob'), cert: certDer('alice') }
      expect(() => decryptEnveloped(der, [wrong])).toThrow(SmimeFormatError)
    }
    const oaep = encryptEnveloped(CONTENT, [{ cert: certDer('alice'), oaep: true }])
    expect(() => decryptEnveloped(oaep, [{ key: keyOf('bob'), cert: certDer('alice') }])).toThrow(SmimeFormatError)
  })

  it('encryptEnveloped never emits 3des or rc2', () => {
    ensurePkiEngine()
    const der = encryptEnveloped(CONTENT, [{ cert: certDer('alice'), oaep: false }])
    const env = new EnvelopedData({ schema: ContentInfo.fromBER(new Uint8Array(der)).content })
    expect(env.encryptedContentInfo.contentEncryptionAlgorithm.algorithmId).toBe('2.16.840.1.101.3.4.1.42')
    expect(readFileSync(new URL('../cms.ts', import.meta.url), 'utf-8').match(/createCipheriv\([^)]*\)/g)).toEqual(["createCipheriv('aes-256-cbc', cek, iv)"])
  })

  it('EC sertifikaya şifreleme reddedilir', () => {
    expect(() => encryptEnveloped(CONTENT, [{ cert: certDer('ec-p256'), oaep: false }])).toThrow(SmimeUnsupportedError)
  })
})

describe.skipIf(!hasOpensslCms)('OpenSSL uyumu', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-cms-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const ossl = (args: string[]): Buffer => execFileSync('openssl', args, { stdio: 'pipe' })
  const file = (name: string, b: Buffer): string => {
    const p = join(dir, name)
    writeFileSync(p, b)
    return p
  }

  it('openssl cms -verify imzamızı kabul eder', async () => {
    const { der } = await signDetached(CONTENT, signer('alice'))
    const out = ossl(['cms', '-verify', '-inform', 'DER', '-in', file('s.der', der), '-content', file('c.txt', CONTENT), '-CAfile', fxPath('root.crt'), '-binary', '-purpose', 'smimesign'])
    expect(out).toEqual(CONTENT)
  })

  it('openssl cms -verify EC imzamızı kabul eder', async () => {
    const { der } = await signDetached(CONTENT, signer('ec-p256'))
    ossl(['cms', '-verify', '-inform', 'DER', '-in', file('e.der', der), '-content', file('c2.txt', CONTENT), '-CAfile', fxPath('root.crt'), '-binary', '-purpose', 'any'])
  })

  it.each([false, true])('openssl cms -decrypt zarfımızı açar oaep=%s', (oaep) => {
    const der = encryptEnveloped(CONTENT, [{ cert: certDer('alice'), oaep }])
    const out = ossl(['cms', '-decrypt', '-inform', 'DER', '-in', file('z.der', der), '-recip', fxPath('alice.crt'), '-inkey', fxPath('alice.key'), '-binary'])
    expect(out).toEqual(CONTENT)
  })

  it('OpenSSL taze zarflarını biz açarız', () => {
    const plain = file('p.txt', CONTENT)
    const pkcs1 = ossl(['cms', '-encrypt', '-binary', '-outform', 'DER', '-in', plain, '-aes-256-cbc', fxPath('alice.crt')])
    expect(decryptEnveloped(pkcs1, [decKey('alice')]).content).toEqual(CONTENT)
    const oaep = ossl(['cms', '-encrypt', '-binary', '-outform', 'DER', '-in', plain, '-aes-128-cbc', '-recip', fxPath('alice.crt'), '-keyopt', 'rsa_padding_mode:oaep', '-keyopt', 'rsa_oaep_md:sha256'])
    expect(decryptEnveloped(oaep, [decKey('alice')]).content).toEqual(CONTENT)
  })

  it('SKI ile adreslenmiş alıcı', () => {
    const der = ossl(['cms', '-encrypt', '-binary', '-outform', 'DER', '-in', file('q.txt', CONTENT), '-aes-256-cbc', '-keyid', '-recip', fxPath('alice.crt')])
    expect(decryptEnveloped(der, [decKey('alice')]).content).toEqual(CONTENT)
  })

  it('OpenSSL ayrık imzası doğrulanır', async () => {
    const der = ossl(['cms', '-sign', '-binary', '-outform', 'DER', '-in', file('d.txt', CONTENT), '-signer', fxPath('alice.crt'), '-inkey', fxPath('alice.key'), '-md', 'sha256'])
    expect((await verifySignedData(der, CONTENT)).results[0]).toMatchObject({ valid: true, hashAlg: 'sha256' })
  })

  it('OpenSSL akış biçimli (BER) opak imza doğrulanır', async () => {
    const der = ossl(['cms', '-sign', '-nodetach', '-stream', '-binary', '-outform', 'DER', '-in', file('t.txt', CONTENT), '-signer', fxPath('alice.crt'), '-inkey', fxPath('alice.key')])
    const r = await verifySignedData(der, null)
    expect(r.results[0].valid).toBe(true)
    expect(r.content).toEqual(CONTENT)
  })
})

describe('güvenlik düzeltmeleri', () => {
  function editSigned(der: Buffer, edit: (sd: SignedData, si: SignerInfo) => void): Buffer {
    ensurePkiEngine()
    const ci = ContentInfo.fromBER(new Uint8Array(der))
    const sd = new SignedData({ schema: ci.content })
    edit(sd, sd.signerInfos[0])
    return Buffer.from(new ContentInfo({ contentType: ci.contentType, content: sd.toSchema(false) }).toSchema().toBER(false))
  }
  const attrBytes = (si: SignerInfo): Buffer => {
    const b = Buffer.from(si.signedAttrs!.encodedValue)
    b[0] = 0x31
    return b
  }

  it('RSA-PSS SHA-1 digestAlgorithm SHA-256 arkasına saklanamaz', async () => {
    const { der } = await signDetached(CONTENT, signer('alice'))
    const forged = editSigned(der, (_sd, si) => {
      const signature = sign('sha1', attrBytes(si), { key: keyOf('alice'), padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 20 })
      si.signatureAlgorithm = new AlgorithmIdentifier({ algorithmId: '1.2.840.113549.1.1.10', algorithmParams: new Sequence() })
      si.signature = new OctetString({ valueHex: new Uint8Array(signature).buffer })
    })
    const [r] = (await verifySignedData(forged, CONTENT)).results
    expect(r.hashAlg).toBe('sha1')
  })

  it('signedAttrs olmadan imza geçerli sayılmaz', async () => {
    const forged = editSigned(fxBytes('sig-sha256.der'), (sd, si) => {
      const attrs = attrBytes(si)
      si.signedAttrs = undefined
      sd.encapContentInfo.eContent = new OctetString({ valueHex: new Uint8Array(attrs).buffer })
    })
    const { results } = await verifySignedData(forged, null)
    expect(results[0].valid).toBe(false)
  })

  it('eContentType id-data olmalı', async () => {
    const forged = editSigned(fxBytes('sig-sha256.der'), (sd) => {
      sd.encapContentInfo.eContentType = '1.2.840.113549.1.7.2'
    })
    expect((await verifySignedData(forged, null)).results[0].valid).toBe(false)
  })

  it('SKI ile tanıtılan imzacı SHA-1 olmayan SKI ile de bulunur', async () => {
    const { results, content } = await verifySignedData(fxBytes('sig-ski.der'), null)
    expect(results[0]).toMatchObject({ valid: true, unsupported: false })
    expect(content?.equals(CMS_DATA)).toBe(true)
  })

  it('sertifika baytları yeniden kodlanmaz', async () => {
    const { results } = await verifySignedData(fxBytes('sig-sha256.der'), null)
    expect(Buffer.from(results[0].signer!).equals(certDer('alice'))).toBe(true)
  })

  it('25 MB zarf kendi kendine çözülür', () => {
    const big = Buffer.concat([Buffer.from('Content-Type: text/plain\r\n\r\n'), Buffer.alloc(25_000_000, 0x61)])
    const der = encryptEnveloped(big, [{ cert: certDer('alice'), oaep: false }])
    expect(decryptEnveloped(der, [decKey('alice')]).content.equals(big)).toBe(true)
  })

  it.skipIf(!hasOpensslCms)('OpenSSL 17 MB zarfı açılır', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gecko-cms-'))
    try {
      const src = join(dir, 'in')
      writeFileSync(src, Buffer.alloc(17_000_000, 0x62))
      const out = join(dir, 'out.der')
      execFileSync('openssl', ['cms', '-encrypt', '-binary', '-outform', 'DER', '-aes-256-cbc', '-in', src, '-out', out, fxPath('alice.crt')])
      expect(decryptEnveloped(readFileSync(out), [decKey('alice')]).content.length).toBe(17_000_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('RC2 etkin bit yalnız 40, 64, 128 ve CEK uzunluğuyla eşleşir', () => {
    expect(rc2EffectiveBits(160, 5)).toBe(40)
    expect(rc2EffectiveBits(120, 8)).toBe(64)
    expect(rc2EffectiveBits(58, 16)).toBe(128)
    expect(() => rc2EffectiveBits(1, 32)).toThrow(SmimeFormatError)
    expect(() => rc2EffectiveBits(160, 32)).toThrow(SmimeFormatError)
    expect(() => rc2EffectiveBits(null, 5)).toThrow(SmimeFormatError)
  })

  it('GCM nonce 12 bayt olmalı', () => {
    const asn = fromBER(new Uint8Array(fxBytes('env-aes-gcm.der'))).result as Sequence
    const auth = (asn.valueBlock.value[1] as Sequence).valueBlock.value[0] as Sequence
    const items = auth.valueBlock.value
    const eci = items[2] as Sequence
    const alg = eci.valueBlock.value[1] as Sequence
    const params = alg.valueBlock.value[1] as Sequence
    const cek = randomBytes(32)
    const nonce = randomBytes(16)
    const c = createCipheriv('aes-256-gcm', cek, nonce, { authTagLength: 16 })
    const ct = Buffer.concat([c.update(CMS_DATA), c.final()])
    const ri = (items[1] as Sequence).valueBlock.value[0] as Sequence
    const ek = ri.valueBlock.value[3] as OctetString
    ek.valueBlock.valueHexView = new Uint8Array(publicEncrypt({ key: new X509Certificate(certDer('alice')).publicKey, padding: constants.RSA_PKCS1_PADDING }, cek))
    const nonceBlock = params.valueBlock.value[0] as OctetString
    nonceBlock.valueBlock.valueHexView = new Uint8Array(nonce)
    const ctBlock = eci.valueBlock.value[2] as unknown as { valueBlock: { valueHexView: Uint8Array } }
    ctBlock.valueBlock.valueHexView = new Uint8Array(ct)
    const macBlock = items[items.length - 1] as OctetString
    macBlock.valueBlock.valueHexView = new Uint8Array(c.getAuthTag())
    const der = Buffer.from(asn.toBER(false))
    expect(() => decryptEnveloped(der, [decKey('alice')])).toThrow(SmimeFormatError)
  })

  it('boş alıcı listesi reddedilir', () => {
    expect(() => encryptEnveloped(CONTENT, [])).toThrow(SmimeFormatError)
  })

  it.skipIf(!hasOpensslCms)('SHA-224 özetli imza unsupported', () => {
    const der = execFileSync('openssl', ['cms', '-sign', '-binary', '-nodetach', '-outform', 'DER', '-md', 'sha224', '-in', fxPath('msg.eml'), '-signer', fxPath('alice.crt'), '-inkey', fxPath('alice.key')])
    return verifySignedData(der, null).then(({ results }) => expect(results[0].unsupported).toBe(true))
  })

  it('sınırdaki 2000 alıcılı zarf makul sürede açılır', () => {
    const list = Array.from({ length: 2000 }, () => ({ cert: certDer('alice'), oaep: false }))
    const der = encryptEnveloped(CMS_DATA, list)
    const t0 = performance.now()
    expect(decryptEnveloped(der, [decKey('alice')]).content.equals(CMS_DATA)).toBe(true)
    expect(performance.now() - t0).toBeLessThan(3000)
  }, 60_000)

  it('çok alıcılı zarf ayrıştırmadan reddedilir', () => {
    const list = Array.from({ length: 2100 }, () => ({ cert: certDer('alice'), oaep: false }))
    const der = encryptEnveloped(CONTENT, list)
    const t0 = performance.now()
    expect(() => decryptEnveloped(der, [decKey('alice')])).toThrow(SmimeFormatError)
    expect(performance.now() - t0).toBeLessThan(1000)
  }, 60_000)
})
