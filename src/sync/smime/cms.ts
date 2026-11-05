// CMS imza, şifre ve çözme. pkijs yalnız ASN.1 şeması, imza ve imza doğrulama içindir: WebCrypto RSAES-PKCS1-v1_5
// desteklemez, AuthEnvelopedData sınıfı yoktur; RecipientInfo ve içerik çözümü node:crypto ile yapılır (K2).
// Tüm hatalar sabit iletili Smime* türlerine çevrilir: pkijs/OpenSSL metni dışarı çıkmaz.
import { constants, createCipheriv, createDecipheriv, createHash, privateDecrypt, publicEncrypt, randomBytes, webcrypto, X509Certificate, type KeyObject } from 'node:crypto'
import { Constructed, fromBER, Integer, Null, ObjectIdentifier, OctetString, Sequence, UTCTime, type BaseBlock } from 'asn1js'
import {
  AlgorithmIdentifier, Attribute, Certificate, ContentInfo, EncapsulatedContentInfo, EncryptedContentInfo, EnvelopedData, IssuerAndSerialNumber,
  KeyTransRecipientInfo, RecipientInfo, RSAESOAEPParams, RSASSAPSSParams, SignedAndUnsignedAttributes, SignedData, SignerInfo
} from 'pkijs'
import { ensurePkiEngine } from './engine'
import { SmimeFormatError, SmimeNoKeyError, SmimeUnsupportedError } from './errors'
import { CMS_BER_LIMITS } from './limits'
import { pkcs7Unpad, rc2CbcDecrypt } from './rc2'

const MAX_CERTS = 32
const MAX_SIGNERS = 4
// RecipientInfo sınırı: pkijs şeması alıcı başına pahalıdır, sel ayrıştırmadan durdurulur
const MAX_RECIPIENTS = 2000
const GCM_NONCE_LEN = 12

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  envelopedData: '1.2.840.113549.1.7.3',
  authEnvelopedData: '1.2.840.113549.1.9.16.1.23',
  attrContentType: '1.2.840.113549.1.9.3',
  attrMessageDigest: '1.2.840.113549.1.9.4',
  attrSigningTime: '1.2.840.113549.1.9.5',
  attrCapabilities: '1.2.840.113549.1.9.15',
  attrEncKeyPreference: '1.2.840.113549.1.9.16.2.11',
  rsaEncryption: '1.2.840.113549.1.1.1',
  rsaOaep: '1.2.840.113549.1.1.7',
  mgf1: '1.2.840.113549.1.1.8',
  aes128Cbc: '2.16.840.1.101.3.4.1.2',
  aes192Cbc: '2.16.840.1.101.3.4.1.22',
  aes256Cbc: '2.16.840.1.101.3.4.1.42',
  aes128Gcm: '2.16.840.1.101.3.4.1.6',
  aes192Gcm: '2.16.840.1.101.3.4.1.26',
  aes256Gcm: '2.16.840.1.101.3.4.1.46',
  desEde3Cbc: '1.2.840.113549.3.7',
  rc2Cbc: '1.2.840.113549.3.2',
  sha256: '2.16.840.1.101.3.4.2.1'
}

const HASHES: Record<string, string> = {
  '1.2.840.113549.2.5': 'md5',
  '1.3.14.3.2.26': 'sha1',
  [OID.sha256]: 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512'
}

/** İmza OID'si özeti de belirtir: digestAlgorithm SHA-256 derken imza SHA-1 üzerinde olabilir */
const SIG_ALGS: Record<string, { name: string; hash?: string }> = {
  [OID.rsaEncryption]: { name: 'rsa' },
  '1.2.840.113549.1.1.4': { name: 'rsa', hash: 'md5' },
  '1.2.840.113549.1.1.5': { name: 'rsa', hash: 'sha1' },
  '1.2.840.113549.1.1.10': { name: 'rsa-pss' },
  '1.2.840.113549.1.1.11': { name: 'rsa', hash: 'sha256' },
  '1.2.840.113549.1.1.12': { name: 'rsa', hash: 'sha384' },
  '1.2.840.113549.1.1.13': { name: 'rsa', hash: 'sha512' },
  '1.2.840.10045.4.1': { name: 'ecdsa', hash: 'sha1' },
  '1.2.840.10045.4.3.2': { name: 'ecdsa', hash: 'sha256' },
  '1.2.840.10045.4.3.3': { name: 'ecdsa', hash: 'sha384' },
  '1.2.840.10045.4.3.4': { name: 'ecdsa', hash: 'sha512' }
}

/** pkijs varsayılan pSource değeri: boş dizenin SHA-1 özeti */
const EMPTY_LABEL_SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709'

const OAEP_HASHES: Record<string, string> = {
  '1.3.14.3.2.26': 'sha1',
  [OID.sha256]: 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512'
}

export interface SigResult {
  valid: boolean
  hashAlg: string
  sigAlg: string
  signer: Uint8Array | null
  certs: Uint8Array[]
  /** imzayı denetleme imkânı yok: algoritma bilinmiyor veya imzacı sertifikası iletide yok */
  unsupported: boolean
  /** imzacının SMIMECapabilities OID'leri */
  capabilities: string[]
}

export interface SignKey {
  key: KeyObject
  cert: Uint8Array
  chain: Uint8Array[]
}

export interface RecipientCert {
  cert: Uint8Array
  oaep: boolean
}

export interface DecryptKey {
  key: KeyObject
  cert: Uint8Array
}

export interface DecryptResult {
  content: Buffer
  cipher: 'aes-cbc' | 'aes-gcm' | '3des' | 'rc2'
  aead: boolean
}

const view = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b) // pkijs ayrı ArrayBuffer ister: Buffer havuzunu paylaşmasın

function buffer(b: ArrayBuffer | Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(b.byteLength)
  new Uint8Array(out).set(b instanceof ArrayBuffer ? new Uint8Array(b) : b)
  return out
}

function parseContentInfo(der: Buffer): ContentInfo {
  ensurePkiEngine()
  try {
    if (!der.length) throw new SmimeFormatError()
    const r = fromBER(view(der), CMS_BER_LIMITS)
    if (r.offset === -1) throw new SmimeFormatError()
    return new ContentInfo({ schema: r.result })
  } catch {
    throw new SmimeFormatError() // bozuk giriş, derin yığın (RangeError) dahil
  }
}

const certDer = (c: Certificate): Uint8Array => new Uint8Array(c.toSchema(false).toBER(false)) // TBS özgün baytlarıyla: parmak izi değişmez

function capabilitiesOf(si: SignerInfo): string[] {
  const attr = si.signedAttrs?.attributes.find((a) => a.type === OID.attrCapabilities)
  const list = attr?.values[0] as Sequence | undefined
  if (!(list instanceof Sequence)) return []
  return list.valueBlock.value.flatMap((item) => {
    const oid = item instanceof Sequence ? item.valueBlock.value[0] : null
    return oid instanceof ObjectIdentifier ? [oid.valueBlock.toString()] : []
  })
}

function pssHash(si: SignerInfo): string | undefined {
  try {
    const p = si.signatureAlgorithm.algorithmParams
    return HASHES[(p instanceof Sequence ? new RSASSAPSSParams({ schema: p }) : new RSASSAPSSParams()).hashAlgorithm.algorithmId]
  } catch {
    return undefined
  }
}

/** digestAlgorithm SHA-256 derken imza SHA-1 üzerinde olabilir: en zayıf olan söz sahibidir. Bilinmeyen varsa undefined. */
function effectiveHash(si: SignerInfo, sig: { name: string; hash?: string } | undefined): string | undefined {
  const digest = HASHES[si.digestAlgorithm.algorithmId]
  const signed = sig?.name === 'rsa-pss' ? pssHash(si) : sig?.hash
  if (!sig || !digest || (sig.name === 'rsa-pss' && !signed)) return undefined
  return [signed, digest].find((h) => h === 'md5') ?? [signed, digest].find((h) => h === 'sha1') ?? digest
}

/** İmza içerik türüne bağlı olmalı: signedAttrs olmadan öznitelik baytları gövde gibi yeniden imzalı görünürdü (RFC 5652 §5.3) */
function boundToData(sd: SignedData, si: SignerInfo): boolean {
  const types = si.signedAttrs?.attributes.filter((a) => a.type === OID.attrContentType) ?? []
  const value = types.length === 1 && types[0].values.length === 1 ? types[0].values[0] : null
  return sd.encapContentInfo.eContentType === OID.data && value instanceof ObjectIdentifier && value.valueBlock.toString() === OID.data
}

/** pkijs SKI kimliğini anahtarın SHA-1'iyle eşler; sertifikanın SKI uzantısı başka olabilir */
function pinSkiSigner(sd: SignedData, si: SignerInfo): void {
  if (si.sid instanceof IssuerAndSerialNumber) return
  const want = Buffer.from((si.sid as OctetString).valueBlock.valueHexView)
  for (const c of sd.certificates ?? []) {
    if (!(c instanceof Certificate)) continue
    const ski = c.extensions?.find((e) => e.extnID === '2.5.29.14')?.parsedValue
    if (ski instanceof OctetString && want.equals(Buffer.from(ski.valueBlock.valueHexView))) si.sid = issuerAndSerial(c)
  }
}

async function verifyOne(sd: SignedData, index: number, detached: Buffer | null, eContent: Buffer | null, certs: Uint8Array[]): Promise<SigResult> {
  const si = sd.signerInfos[index]
  const sig = SIG_ALGS[si.signatureAlgorithm.algorithmId]
  const hash = effectiveHash(si, sig)
  const base = { hashAlg: hash ?? 'unknown', sigAlg: sig?.name ?? si.signatureAlgorithm.algorithmId, signer: null, certs, capabilities: capabilitiesOf(si) }
  if (!hash || hash === 'md5') return { ...base, valid: false, unsupported: true }
  // ayrık doğrulamada pkijs gömülü içeriği yeğler; gösterilen gövde imzalı olmadan "geçerli" çıkardı
  if ((detached && eContent) || (!detached && !eContent) || !boundToData(sd, si)) return { ...base, valid: false, unsupported: false }
  try {
    pinSkiSigner(sd, si)
    const r = await sd.verify({ signer: index, data: detached ? buffer(detached) : undefined, extendedMode: true })
    return { ...base, signer: r.signerCertificate ? certDer(r.signerCertificate) : null, valid: r.signatureVerified === true, unsupported: false }
  } catch (e) {
    const err = e as { code?: number; signerCertificate?: Certificate | null }
    return { ...base, signer: err.signerCertificate ? certDer(err.signerCertificate) : null, valid: false, unsupported: err.code === 2 || err.code === 3 }
  }
}

export async function verifySignedData(der: Buffer, detached: Buffer | null): Promise<{ results: SigResult[]; content: Buffer | null }> {
  const ci = parseContentInfo(der)
  if (ci.contentType !== OID.signedData) throw new SmimeFormatError()
  try {
    // sınır şemadan önce: pkijs sertifika başına pahalıdır, düğüm sınırı da geniştir
    const items = (ci.content as Sequence).valueBlock.value
    const certSet = items.find((b) => b.idBlock.tagClass === 3 && b.idBlock.tagNumber === 0) as Constructed | undefined
    const signers = items[items.length - 1] as Sequence
    if ((certSet?.valueBlock.value.length ?? 0) > MAX_CERTS || signers.valueBlock.value.length > MAX_SIGNERS) throw new SmimeFormatError()
    const sd = new SignedData({ schema: ci.content })
    const certs = (sd.certificates ?? []).filter((c): c is Certificate => c instanceof Certificate).map(certDer)
    const value = sd.encapContentInfo.eContent?.getValue()
    const eContent = value ? Buffer.from(value) : null
    const results: SigResult[] = []
    for (let i = 0; i < sd.signerInfos.length; i++) results.push(await verifyOne(sd, i, detached, eContent, certs))
    return { results, content: detached ? null : eContent }
  } catch {
    throw new SmimeFormatError()
  }
}

const seqOid = (oid: string): Sequence => new Sequence({ value: [new ObjectIdentifier({ value: oid })] })

function issuerAndSerial(c: Certificate): IssuerAndSerialNumber {
  return new IssuerAndSerialNumber({ issuer: c.issuer, serialNumber: c.serialNumber })
}

function signedAttributes(content: Buffer, hash: 'sha256' | 'sha384', cert: Certificate, canEncrypt: boolean): SignedAndUnsignedAttributes {
  const digest = createHash(hash).update(content).digest()
  const attributes = [
    new Attribute({ type: OID.attrContentType, values: [new ObjectIdentifier({ value: OID.data })] }),
    new Attribute({ type: OID.attrMessageDigest, values: [new OctetString({ valueHex: buffer(digest) })] }),
    new Attribute({ type: OID.attrSigningTime, values: [new UTCTime({ valueDate: new Date() })] }),
    new Attribute({
      type: OID.attrCapabilities,
      values: [new Sequence({ value: [seqOid(OID.aes256Cbc), seqOid(OID.aes128Cbc), seqOid(OID.sha256), seqOid(OID.rsaOaep)] })]
    })
  ]
  if (canEncrypt) {
    const ias = issuerAndSerial(cert).toSchema() as Sequence
    attributes.push(new Attribute({ type: OID.attrEncKeyPreference, values: [new Constructed({ idBlock: { tagClass: 3, tagNumber: 0 }, value: ias.valueBlock.value })] }))
  }
  // SET OF: DER sırası; alıcı yeniden kodlayarak doğrulasa da aynı bayt çıkmalı
  const sorted = attributes.map((a) => ({ a, der: Buffer.from(a.toSchema().toBER(false)) })).sort((x, y) => Buffer.compare(x.der, y.der))
  return new SignedAndUnsignedAttributes({ type: 0, attributes: sorted.map((x) => x.a) })
}

async function signingKey(k: KeyObject, curve: string | undefined, hash: string): Promise<CryptoKey> {
  const pkcs8 = k.export({ type: 'pkcs8', format: 'der' })
  try {
    const alg = k.asymmetricKeyType === 'rsa' ? { name: 'RSASSA-PKCS1-v1_5', hash } : { name: 'ECDSA', namedCurve: curve as string }
    return (await webcrypto.subtle.importKey('pkcs8', pkcs8, alg, false, ['sign'])) as unknown as CryptoKey
  } finally {
    pkcs8.fill(0)
  }
}

const WEB_CURVE: Record<string, string> = { prime256v1: 'P-256', secp384r1: 'P-384' }

/** Açık imza (multipart/signed). Özet SHA-256, P-384 anahtarla SHA-384. */
export async function signDetached(content: Buffer, k: SignKey): Promise<{ der: Buffer; micalg: 'sha-256' | 'sha-384' }> {
  ensurePkiEngine()
  const curve = WEB_CURVE[k.key.asymmetricKeyDetails?.namedCurve ?? '']
  if (k.key.asymmetricKeyType !== 'rsa' && !curve) throw new SmimeUnsupportedError()
  const hash = curve === 'P-384' ? 'sha384' : 'sha256'
  const cert = Certificate.fromBER(view(k.cert))
  const canEncrypt = new X509Certificate(k.cert).publicKey.asymmetricKeyType === 'rsa'
  const sd = new SignedData({
    version: 1,
    encapContentInfo: new EncapsulatedContentInfo({ eContentType: OID.data }),
    signerInfos: [new SignerInfo({ version: 1, sid: issuerAndSerial(cert), signedAttrs: signedAttributes(content, hash, cert, canEncrypt) })],
    certificates: [cert, ...k.chain.map((c) => Certificate.fromBER(view(c)))]
  })
  const webHash = hash === 'sha384' ? 'SHA-384' : 'SHA-256'
  await sd.sign(await signingKey(k.key, curve, webHash), 0, webHash, buffer(content))
  const der = new ContentInfo({ contentType: OID.signedData, content: sd.toSchema(true) }).toSchema().toBER(false)
  return { der: Buffer.from(der), micalg: hash === 'sha384' ? 'sha-384' : 'sha-256' }
}

function oaepAlgorithm(): AlgorithmIdentifier {
  const sha256 = (): AlgorithmIdentifier => new AlgorithmIdentifier({ algorithmId: OID.sha256, algorithmParams: new Null() })
  const params = new RSAESOAEPParams({
    hashAlgorithm: sha256(),
    maskGenAlgorithm: new AlgorithmIdentifier({ algorithmId: OID.mgf1, algorithmParams: sha256().toSchema() })
  })
  return new AlgorithmIdentifier({ algorithmId: OID.rsaOaep, algorithmParams: params.toSchema() })
}

function recipientInfo(cek: Buffer, r: RecipientCert): RecipientInfo {
  const x = new X509Certificate(r.cert)
  if (x.publicKey.asymmetricKeyType !== 'rsa') throw new SmimeUnsupportedError()
  const wrapped = publicEncrypt(
    r.oaep ? { key: x.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' } : { key: x.publicKey, padding: constants.RSA_PKCS1_PADDING },
    cek
  )
  return new RecipientInfo({
    variant: 1,
    value: new KeyTransRecipientInfo({
      version: 0,
      rid: issuerAndSerial(Certificate.fromBER(view(r.cert))),
      keyEncryptionAlgorithm: r.oaep ? oaepAlgorithm() : new AlgorithmIdentifier({ algorithmId: OID.rsaEncryption, algorithmParams: new Null() }),
      encryptedKey: new OctetString({ valueHex: buffer(wrapped) })
    })
  })
}

/** Yalnız AES-256-CBC: gönderimde zayıf algoritma kod yolunda yoktur */
export function encryptEnveloped(content: Buffer, to: RecipientCert[]): Buffer {
  ensurePkiEngine()
  if (!to.length) throw new SmimeFormatError()
  const cek = randomBytes(32)
  try {
    const iv = randomBytes(16)
    const cipher = createCipheriv('aes-256-cbc', cek, iv)
    const ct = Buffer.concat([cipher.update(content), cipher.final()])
    const env = new EnvelopedData({
      version: 0,
      recipientInfos: to.map((r) => recipientInfo(cek, r)),
      encryptedContentInfo: new EncryptedContentInfo({
        contentType: OID.data,
        contentEncryptionAlgorithm: new AlgorithmIdentifier({ algorithmId: OID.aes256Cbc, algorithmParams: new OctetString({ valueHex: buffer(iv) }) }),
        encryptedContent: new OctetString({ valueHex: buffer(ct) }),
        disableSplit: true // parçalı içerik düğüm sınırına takılırdı, Gönderilenler kopyası okunamazdı
      })
    })
    return Buffer.from(new ContentInfo({ contentType: OID.envelopedData, content: env.toSchema() }).toSchema().toBER(false))
  } finally {
    cek.fill(0)
  }
}

interface Envelope {
  recipients: RecipientInfo[]
  eci: EncryptedContentInfo
  /** AuthEnvelopedData: etiket ve doğrulanan öznitelikler */
  mac: Buffer | null
  aad: Buffer | null
}

/** RFC 5083 AuthEnvelopedData: pkijs'te sınıfı yok */
function parseAuthEnveloped(content: BaseBlock): Envelope {
  const items = (content as Sequence).valueBlock.value
  const isContext = (b: BaseBlock | undefined, n: number): boolean => b?.idBlock.tagClass === 3 && b.idBlock.tagNumber === n
  let i = 1 // version
  if (isContext(items[i], 0)) i++ // originatorInfo
  const recipientSet = (items[i++] as Sequence).valueBlock.value
  if (recipientSet.length > MAX_RECIPIENTS) throw new SmimeFormatError()
  const recipients = recipientSet.map((schema) => new RecipientInfo({ schema }))
  const eci = new EncryptedContentInfo({ schema: items[i++] })
  let aad: Buffer | null = null
  if (isContext(items[i], 1)) {
    aad = Buffer.from(items[i++].valueBeforeDecodeView)
    aad[0] = 0x31 // imza gibi: IMPLICIT [1] değil, SET OF üzerinden hesaplanır
  }
  const mac = items[i]
  if (!(mac instanceof OctetString)) throw new SmimeFormatError()
  return { recipients, eci, mac: Buffer.from(mac.valueBlock.valueHexView), aad }
}

function parseEnvelope(der: Buffer): Envelope {
  const ci = parseContentInfo(der)
  if (ci.contentType === OID.authEnvelopedData) return parseAuthEnveloped(ci.content)
  if (ci.contentType !== OID.envelopedData) throw new SmimeFormatError()
  const body = (ci.content as Sequence).valueBlock.value
  const set = body[body[1]?.idBlock.tagClass === 3 ? 2 : 1] as Sequence | undefined
  if (!set || set.valueBlock.value.length > MAX_RECIPIENTS) throw new SmimeFormatError()
  const env = new EnvelopedData({ schema: ci.content })
  return { recipients: env.recipientInfos, eci: env.encryptedContentInfo, mac: null, aad: null }
}

function matches(ri: KeyTransRecipientInfo, cert: Certificate): boolean {
  if (ri.rid instanceof IssuerAndSerialNumber) return cert.issuer.isEqual(ri.rid.issuer) && cert.serialNumber.isEqual(ri.rid.serialNumber)
  const ski = cert.extensions?.find((e) => e.extnID === '2.5.29.14')?.parsedValue as OctetString | undefined
  return !!ski && Buffer.compare(ski.valueBlock.valueHexView, (ri.rid as OctetString).valueBlock.valueHexView) === 0
}

function unwrapKey(ri: KeyTransRecipientInfo, key: KeyObject): Buffer {
  const encrypted = Buffer.from(ri.encryptedKey.valueBlock.valueHexView)
  const alg = ri.keyEncryptionAlgorithm
  if (alg.algorithmId === OID.rsaEncryption) return privateDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, encrypted)
  if (alg.algorithmId !== OID.rsaOaep) throw new SmimeUnsupportedError()
  const params = alg.algorithmParams instanceof Sequence ? new RSAESOAEPParams({ schema: alg.algorithmParams }) : new RSAESOAEPParams()
  const oaepHash = OAEP_HASHES[params.hashAlgorithm.algorithmId]
  const mgf = params.maskGenAlgorithm.algorithmParams
  const mgfHash = mgf ? OAEP_HASHES[new AlgorithmIdentifier({ schema: mgf }).algorithmId] : 'sha1'
  // node:crypto MGF1 özetini ayrı almaz; etiketli OAEP'yi de kimse üretmez: ikisi de çözülemez sayılır
  const label = Buffer.from((params.pSourceAlgorithm.algorithmParams as OctetString).valueBlock.valueHexView).toString('hex')
  if (!oaepHash || mgfHash !== oaepHash || (label !== '' && label !== EMPTY_LABEL_SHA1)) throw new SmimeUnsupportedError()
  return privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash }, encrypted)
}

function octets(block: unknown): Buffer {
  if (!(block instanceof OctetString)) throw new SmimeFormatError()
  return Buffer.from(block.valueBlock.valueHexView)
}

function aesCbc(cek: Buffer, ct: Buffer, params: unknown, bits: number): Buffer {
  const iv = octets(params)
  if (cek.length !== bits / 8 || iv.length !== 16) throw new SmimeFormatError()
  const d = createDecipheriv(`aes-${bits}-cbc`, cek, iv)
  return Buffer.concat([d.update(ct), d.final()])
}

function aesGcm(cek: Buffer, ct: Buffer, params: unknown, bits: number, mac: Buffer, aad: Buffer | null): Buffer {
  if (!(params instanceof Sequence) || cek.length !== bits / 8) throw new SmimeFormatError()
  const [nonce, icv] = params.valueBlock.value
  const tagLen = icv instanceof Integer ? icv.valueBlock.valueDec : 12
  const iv = octets(nonce)
  if (mac.length !== tagLen || mac.length < 12 || mac.length > 16 || iv.length !== GCM_NONCE_LEN) throw new SmimeFormatError()
  const d = createDecipheriv(`aes-${bits}-gcm` as 'aes-256-gcm', cek, iv, { authTagLength: mac.length })
  d.setAuthTag(mac)
  if (aad) d.setAAD(aad)
  return Buffer.concat([d.update(ct), d.final()])
}

/** Yalnız 40, 64, 128 etkin bit ve eşleşen CEK: başka algoritmanın anahtarı RC2 diye etiketlenemez, 1 bitlik "etkin" anahtar olmaz */
export function rc2EffectiveBits(version: number | null, cekLen: number): number {
  const bits = ({ 160: 40, 120: 64, 58: 128 } as Record<number, number>)[version ?? -1]
  if (!bits || bits !== cekLen * 8) throw new SmimeFormatError()
  return bits
}

function rc2Cbc(cek: Buffer, ct: Buffer, params: unknown): Buffer {
  // RFC 8018: SEQUENCE { version, iv }. Sürümsüz biçim 32 bit demektir, kabul edilmez
  const seq = params instanceof Sequence ? params.valueBlock.value : null
  const version = seq?.[0] instanceof Integer ? seq[0].valueBlock.valueDec : null
  const iv = octets(seq ? seq[seq.length - 1] : params)
  return pkcs7Unpad(rc2CbcDecrypt(cek, rc2EffectiveBits(version, cek.length), iv, ct), 8)
}

function des3Cbc(cek: Buffer, ct: Buffer, params: unknown): Buffer {
  const iv = octets(params)
  if (cek.length !== 24 || iv.length !== 8) throw new SmimeFormatError()
  const d = createDecipheriv('des-ede3-cbc', cek, iv)
  return Buffer.concat([d.update(ct), d.final()])
}

function decryptContent(e: Envelope, cek: Buffer): DecryptResult {
  const alg = e.eci.contentEncryptionAlgorithm
  if (!e.eci.encryptedContent) throw new SmimeFormatError()
  const ct = Buffer.from(e.eci.getEncryptedContent())
  const p = alg.algorithmParams
  const gcm: Record<string, number> = { [OID.aes128Gcm]: 128, [OID.aes192Gcm]: 192, [OID.aes256Gcm]: 256 }
  const cbc: Record<string, number> = { [OID.aes128Cbc]: 128, [OID.aes192Cbc]: 192, [OID.aes256Cbc]: 256 }
  const id = alg.algorithmId
  // kimlik doğrulamalı kapta CBC, düz kapta GCM tanımsızdır: etiket denetimi atlanmasın
  if (e.mac) {
    if (!gcm[id]) throw new SmimeUnsupportedError()
    return { content: aesGcm(cek, ct, p, gcm[id], e.mac, e.aad), cipher: 'aes-gcm', aead: true }
  }
  if (cbc[id]) return { content: aesCbc(cek, ct, p, cbc[id]), cipher: 'aes-cbc', aead: false }
  if (id === OID.desEde3Cbc) return { content: des3Cbc(cek, ct, p), cipher: '3des', aead: false }
  if (id === OID.rc2Cbc) return { content: rc2Cbc(cek, ct, p), cipher: 'rc2', aead: false }
  throw new SmimeUnsupportedError()
}

function tryKey(e: Envelope, ri: KeyTransRecipientInfo, key: KeyObject): DecryptResult | null {
  let cek: Buffer | null = null
  try {
    // implicit rejection: kötü dolgu hata değil rastgele anahtar döndürür; karar içerik dolgusu/etiketinden çıkar
    cek = unwrapKey(ri, key)
    return decryptContent(e, cek)
  } catch (err) {
    if (err instanceof SmimeUnsupportedError) throw err
    return null
  } finally {
    cek?.fill(0)
  }
}

function open(e: Envelope, keys: DecryptKey[]): DecryptResult {
  const transports = e.recipients.filter((r) => r.variant === 1).map((r) => r.value as KeyTransRecipientInfo)
  const usable = keys.filter((k) => k.key.asymmetricKeyType === 'rsa').map((k) => ({ key: k.key, cert: Certificate.fromBER(view(k.cert)) }))
  let matched = false
  for (const ri of transports) {
    for (const k of usable) {
      if (!matches(ri, k.cert)) continue
      matched = true
      const r = tryKey(e, ri, k.key)
      if (r) return r
    }
  }
  if (matched) throw new SmimeFormatError()
  if (!transports.length && e.recipients.length) throw new SmimeUnsupportedError() // ECDH (KeyAgree)
  throw new SmimeNoKeyError()
}

export function decryptEnveloped(der: Buffer, keys: DecryptKey[]): DecryptResult {
  try {
    return open(parseEnvelope(der), keys)
  } catch (e) {
    if (e instanceof SmimeNoKeyError || e instanceof SmimeUnsupportedError) throw e
    throw new SmimeFormatError()
  }
}
