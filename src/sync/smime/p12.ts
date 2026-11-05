// PKCS#12 okuma ve yazma. pkijs yalnız yapı içindir: decryptEncryptedContentInfo PBES2 dışını açmaz, oysa OpenSSL 3 öncesi,
// Windows ve macOS dışa aktarımları 3DES ve RC2-40 kullanır. Kabukların hepsi burada node:crypto ile açılır; yineleme sınırı
// da böylece tek yerde durur. Yazma yolunda yalnız PBES2 + AES-256-CBC vardır, RC2 ve 3DES yalnız okumadır.
import { createCipheriv, createDecipheriv, createHash, createHmac, type Hash, createPrivateKey, createPublicKey, pbkdf2, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'
import { Constructed, Integer, Null, ObjectIdentifier, OctetString, Primitive, Sequence, Set as AsnSet, type BaseBlock } from 'asn1js'
import { AlgorithmIdentifier, AuthenticatedSafe, CertBag, EncryptedData, PBES2Params, PBKDF2Params, PFX, PKCS8ShroudedKeyBag, PrivateKeyInfo, SafeContents, type SafeBag } from 'pkijs'
import { SMIME_P12_MAX_BYTES } from '../../shared/smime'
import { withKdfSlot } from '../kdfLimit'
import { ensurePkiEngine } from './engine'
import { SmimeFormatError, SmimeP12PasswordError } from './errors'
import { pkcs7Unpad, rc2CbcDecrypt } from './rc2'

const pbkdf2Async = promisify(pbkdf2)

const OID = {
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  keyBag: '1.2.840.113549.1.12.10.1.1',
  shroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  certBag: '1.2.840.113549.1.12.10.1.3',
  x509Cert: '1.2.840.113549.1.9.22.1',
  localKeyId: '1.2.840.113549.1.9.21',
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  hmacSha256: '1.2.840.113549.2.9',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  aes256Cbc: '2.16.840.1.101.3.4.1.42',
  pbe3des: '1.2.840.113549.1.12.1.3',
  pbeRc2128: '1.2.840.113549.1.12.1.5',
  pbeRc240: '1.2.840.113549.1.12.1.6'
}

const PBKDF2_PRF: Record<string, string> = {
  '1.2.840.113549.2.7': 'sha1',
  '1.2.840.113549.2.8': 'sha224',
  [OID.hmacSha256]: 'sha256',
  '1.2.840.113549.2.10': 'sha384',
  '1.2.840.113549.2.11': 'sha512'
}

const PBES2_CIPHERS: Record<string, { name: string; keyLen: number; ivLen: number }> = {
  '2.16.840.1.101.3.4.1.2': { name: 'aes-128-cbc', keyLen: 16, ivLen: 16 },
  '2.16.840.1.101.3.4.1.22': { name: 'aes-192-cbc', keyLen: 24, ivLen: 16 },
  [OID.aes256Cbc]: { name: 'aes-256-cbc', keyLen: 32, ivLen: 16 },
  '1.2.840.113549.3.7': { name: 'des-ede3-cbc', keyLen: 24, ivLen: 8 }
}

const KDF_HASH = { sha1: { u: 20, v: 64 }, sha256: { u: 32, v: 64 } } as const
const MAC_HASH: Record<string, keyof typeof KDF_HASH> = { [OID.sha1]: 'sha1', [OID.sha256]: 'sha256' }

/** Dosya kullanıcıdan gelir: sınırsız tur motoru kilitlerdi (pkcs12Kdf zaman uyumlu) */
const MAX_ITERATIONS = 2_000_000
const MAX_CERTS = 32
/** Sınırlar çözmeden önce: tur üst sınırı dosya başına değil kabuk başınaydı, kabuk sayısı sınırsızdı */
const MAX_SAFES = 8
const MAX_KEY_BAGS = 2
const MAX_BAGS = 64
const MAX_TOTAL_ITERATIONS = 8_000_000
export const MAX_P12_PASSWORD = 1024
const EXPORT_ITERATIONS = 600_000
const SALT_LEN = 16

export interface P12Contents {
  keyPkcs8: Buffer
  leaf: Uint8Array
  chain: Uint8Array[]
}

const view = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b) // pkijs ayrı ArrayBuffer ister

function octets(block: unknown): Buffer {
  if (!(block instanceof OctetString)) throw new SmimeFormatError()
  return Buffer.from(block.getValue())
}

function iterations(n: unknown): number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > MAX_ITERATIONS) throw new SmimeFormatError()
  return n
}

/** RFC 7292 Ek B.2 çekirdeği. Kapanış yok: işçiye metin olarak gider. Parola BMPString + NUL. Tur sayısını çağıran sınırlar. */
function kdfCore(hashOf: (name: string) => Hash, hash: string, u: number, v: number, password: string, salt: Buffer, iter: number, id: number, size: number): Buffer {
  const pw = Buffer.alloc((password.length + 1) * 2)
  for (let i = 0; i < password.length; i++) pw.writeUInt16BE(password.charCodeAt(i), i * 2)
  const repeat = (src: Buffer, len: number): Buffer => {
    const out = Buffer.alloc(len)
    for (let i = 0; i < len && src.length; i++) out[i] = src[i % src.length]
    return out
  }
  const blocks = (n: number): number => Math.ceil(n / v) * v
  const d = Buffer.alloc(v, id)
  const input = Buffer.concat([repeat(salt, blocks(salt.length)), repeat(pw, blocks(pw.length))])
  const out = Buffer.alloc(size)
  for (let done = 0; done < size; done += u) {
    let a = hashOf(hash).update(d).update(input).digest()
    for (let r = 1; r < iter; r++) a = hashOf(hash).update(a).digest()
    a.copy(out, done)
    const b = repeat(a, v)
    for (let at = 0; at < input.length; at += v) {
      let carry = 1
      for (let i = v - 1; i >= 0; i--) {
        const sum = input[at + i] + b[i] + carry
        input[at + i] = sum & 0xff
        carry = sum >> 8
      }
    }
  }
  pw.fill(0)
  input.fill(0)
  return out
}

export function pkcs12Kdf(hash: 'sha1' | 'sha256', password: string, salt: Buffer, iter: number, id: 1 | 2 | 3, size: number): Buffer {
  const { u, v } = KDF_HASH[hash]
  return kdfCore((h) => createHash(h), hash, u, v, password, salt, iter, id, size)
}

// __name: bazı derleyiciler işlev adını korumak için bu yardımcıyı ekler, işçide tanımlı olmalı
const WORKER_SOURCE = `const __name = (f) => f
const { parentPort, workerData: w } = require('node:worker_threads')
const { createHash } = require('node:crypto')
const core = ${kdfCore.toString()}
const out = core((h) => createHash(h), w.hash, w.u, w.v, w.password, Buffer.from(w.salt), w.iter, w.id, w.size)
parentPort.postMessage(new Uint8Array(out))`

/** pkcs12Kdf zaman uyumludur: 2M tur saniyeler sürer. Olay döngüsü tutulmasın diye işçide; işçi açılamazsa aynı hesap burada. */
export function pkcs12KdfInWorker(hash: 'sha1' | 'sha256', password: string, salt: Buffer, iter: number, id: 1 | 2 | 3, size: number): Promise<Buffer> {
  const { u, v } = KDF_HASH[hash]
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { hash, u, v, password, salt: new Uint8Array(salt), iter, id, size } })
    } catch {
      resolve(pkcs12Kdf(hash, password, salt, iter, id, size))
      return
    }
    worker.once('message', (m: Uint8Array) => {
      resolve(Buffer.from(m))
      void worker.terminate()
    })
    worker.once('error', () => {
      try {
        resolve(pkcs12Kdf(hash, password, salt, iter, id, size))
      } catch (e) {
        reject(e as Error)
      }
    })
  })
}

/** Dosya başına harcanan tur: kabuk başına sınır toplam işi bağlamaz */
class Work {
  keyBags = 0
  readonly keys: FoundKey[] = []
  readonly certs: FoundCert[] = []
  constructor(private left: number, readonly password: string) {}
  spend(n: number): void {
    this.left -= n
    if (this.left < 0) throw new SmimeFormatError()
  }
}

async function verifyMac(pfx: PFX, authSafe: Buffer, w: Work): Promise<void> {
  const m = pfx.macData
  if (!m) throw new SmimeFormatError()
  const hash = MAC_HASH[m.mac.digestAlgorithm.algorithmId]
  if (!hash) throw new SmimeFormatError()
  const iter = iterations(m.iterations ?? 1)
  w.spend(iter)
  const key = await pkcs12KdfInWorker(hash, w.password, octets(m.macSalt), iter, 3, KDF_HASH[hash].u)
  const got = createHmac(hash, key).update(authSafe).digest()
  key.fill(0)
  const want = octets(m.mac.digest)
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new SmimeP12PasswordError()
}

async function legacyDecrypt(oid: string, params: unknown, ct: Buffer, w: Work): Promise<Buffer> {
  if (!(params instanceof Sequence)) throw new SmimeFormatError()
  const [saltBlock, iterBlock] = params.valueBlock.value
  if (!(iterBlock instanceof Integer)) throw new SmimeFormatError()
  const salt = octets(saltBlock)
  const iter = iterations(iterBlock.valueBlock.valueDec)
  w.spend(iter * 3) // anahtar iki blok, IV bir
  const derive = (id: 1 | 2, size: number): Promise<Buffer> => pkcs12KdfInWorker('sha1', w.password, salt, iter, id, size)
  const des = oid === OID.pbe3des
  const bits = oid === OID.pbeRc240 ? 40 : 128
  const key = await derive(1, des ? 24 : bits / 8)
  const iv = await derive(2, 8)
  try {
    if (des) {
      const d = createDecipheriv('des-ede3-cbc', key, iv)
      return Buffer.concat([d.update(ct), d.final()])
    }
    return pkcs7Unpad(rc2CbcDecrypt(key, bits, iv, ct), 8)
  } finally {
    key.fill(0)
    iv.fill(0)
  }
}

async function pbes2Decrypt(params: unknown, ct: Buffer, w: Work): Promise<Buffer> {
  const p = new PBES2Params({ schema: params })
  if (p.keyDerivationFunc.algorithmId !== OID.pbkdf2) throw new SmimeFormatError()
  const kdf = new PBKDF2Params({ schema: p.keyDerivationFunc.algorithmParams })
  const prf = PBKDF2_PRF[kdf.prf?.algorithmId ?? '1.2.840.113549.2.7']
  const cipher = PBES2_CIPHERS[p.encryptionScheme.algorithmId]
  if (!prf || !cipher) throw new SmimeFormatError()
  const iter = iterations(kdf.iterationCount)
  w.spend(iter)
  const key = await pbkdf2Async(w.password, octets(kdf.salt), iter, cipher.keyLen, prf)
  try {
    const iv = octets(p.encryptionScheme.algorithmParams)
    if (iv.length !== cipher.ivLen) throw new SmimeFormatError()
    const d = createDecipheriv(cipher.name, key, iv)
    return Buffer.concat([d.update(ct), d.final()])
  } finally {
    key.fill(0)
  }
}

function decryptShell(alg: AlgorithmIdentifier, ct: Buffer, w: Work): Promise<Buffer> {
  const oid = alg.algorithmId
  if (oid === OID.pbes2) return pbes2Decrypt(alg.algorithmParams, ct, w)
  if (oid === OID.pbe3des || oid === OID.pbeRc240 || oid === OID.pbeRc2128) return legacyDecrypt(oid, alg.algorithmParams, ct, w)
  throw new SmimeFormatError()
}

function localKeyId(bag: SafeBag): string | null {
  const v = bag.bagAttributes?.find((a) => a.type === OID.localKeyId)?.values[0]
  return v instanceof OctetString ? Buffer.from(v.getValue()).toString('hex') : null
}

interface FoundKey {
  pkcs8: Buffer
  id: string | null
}

interface FoundCert {
  der: Uint8Array
  id: string | null
}

async function readBags(bytes: Buffer, w: Work): Promise<void> {
  const bags = SafeContents.fromBER(view(bytes)).safeBags
  if (bags.length > MAX_BAGS) throw new SmimeFormatError()
  w.keyBags += bags.filter((b) => b.bagId === OID.keyBag || b.bagId === OID.shroudedKeyBag).length
  if (w.keyBags > MAX_KEY_BAGS) throw new SmimeFormatError()
  for (const bag of bags) {
    const id = localKeyId(bag)
    if (bag.bagId === OID.keyBag) {
      w.keys.push({ pkcs8: Buffer.from((bag.bagValue as PrivateKeyInfo).toSchema().toBER(false)), id })
    } else if (bag.bagId === OID.shroudedKeyBag) {
      const v = bag.bagValue as PKCS8ShroudedKeyBag
      w.keys.push({ pkcs8: await decryptShell(v.encryptionAlgorithm, octets(v.encryptedData), w), id })
    } else if (bag.bagId === OID.certBag) {
      const v = bag.bagValue as CertBag
      if (v.certId === OID.x509Cert) w.certs.push({ der: new Uint8Array(octets(v.certValue)), id })
    }
  }
}

async function readSafe(ci: AuthenticatedSafe['safeContents'][number], w: Work): Promise<void> {
  if (ci.contentType === OID.data) return readBags(octets(ci.content), w)
  if (ci.contentType !== OID.encryptedData) throw new SmimeFormatError()
  const eci = new EncryptedData({ schema: ci.content }).encryptedContentInfo
  if (!eci.encryptedContent) throw new SmimeFormatError()
  const plain = await decryptShell(eci.contentEncryptionAlgorithm, Buffer.from(eci.getEncryptedContent()), w)
  try {
    return await readBags(plain, w)
  } finally {
    plain.fill(0)
  }
}

/** localKeyId eşleşmesi, yoksa açık anahtar eşleşmesi. Dosyadaki eşleşme de anahtarla doğrulanır. */
function pickLeaf(key: FoundKey, certs: FoundCert[]): P12Contents {
  const spki = createPublicKey(createPrivateKey({ key: key.pkcs8, format: 'der', type: 'pkcs8' }) as unknown as string).export({ type: 'spki', format: 'der' })
  const owns = (c: FoundCert): boolean => spki.equals(new X509Certificate(c.der).publicKey.export({ type: 'spki', format: 'der' }))
  const leaf = certs.find((c) => key.id !== null && c.id === key.id) ?? certs.find(owns)
  if (!leaf || !owns(leaf)) throw new SmimeFormatError()
  return { keyPkcs8: key.pkcs8, leaf: leaf.der, chain: certs.filter((c) => c !== leaf).map((c) => c.der) }
}

async function parse(data: Buffer, w: Work): Promise<P12Contents> {
  const pfx = PFX.fromBER(view(data))
  if (pfx.authSafe.contentType !== OID.data) throw new SmimeFormatError() // açık anahtarlı bütünlük kipi desteklenmez
  const authSafe = octets(pfx.authSafe.content)
  const safes = AuthenticatedSafe.fromBER(view(authSafe)).safeContents
  if (safes.length > MAX_SAFES) throw new SmimeFormatError()
  await verifyMac(pfx, authSafe, w)
  for (const ci of safes) await readSafe(ci, w)
  if (w.keys.length !== 1 || w.certs.length > MAX_CERTS) throw new SmimeFormatError()
  return pickLeaf(w.keys[0], w.certs)
}

/** Yanlış parola SmimeP12PasswordError, diğer her şey SmimeFormatError: pkijs metni ve parola dışarı çıkmaz */
export async function parseP12(data: Buffer, password: string, limits: { maxIterations?: number } = {}): Promise<P12Contents> {
  ensurePkiEngine()
  if (data.length > SMIME_P12_MAX_BYTES || password.length > MAX_P12_PASSWORD) throw new SmimeFormatError()
  const w = new Work(limits.maxIterations ?? MAX_TOTAL_ITERATIONS, password)
  let done: P12Contents | null = null
  try {
    done = await withKdfSlot(() => parse(data, w))
    return done
  } catch (e) {
    if (e instanceof SmimeP12PasswordError) throw e
    throw new SmimeFormatError()
  } finally {
    for (const k of w.keys) if (k.pkcs8 !== done?.keyPkcs8) k.pkcs8.fill(0)
  }
}

const der = (b: BaseBlock): Buffer => Buffer.from(b.toBER(false))
const oid = (value: string): ObjectIdentifier => new ObjectIdentifier({ value })
const octet = (b: Uint8Array): OctetString => new OctetString({ valueHex: view(b).buffer })
const explicit0 = (value: BaseBlock[]): Constructed => new Constructed({ idBlock: { tagClass: 3, tagNumber: 0 }, value })

interface Pbes2Output {
  alg: Sequence
  ct: Buffer
}

async function pbes2Encrypt(plain: Buffer, password: string): Promise<Pbes2Output> {
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(16)
  const key = await pbkdf2Async(password, salt, EXPORT_ITERATIONS, 32, 'sha256')
  const c = createCipheriv('aes-256-cbc', key, iv)
  const ct = Buffer.concat([c.update(plain), c.final()])
  key.fill(0)
  const prf = new Sequence({ value: [oid(OID.hmacSha256), new Null()] })
  const kdf = new Sequence({ value: [oid(OID.pbkdf2), new Sequence({ value: [octet(salt), new Integer({ value: EXPORT_ITERATIONS }), prf] })] })
  const scheme = new Sequence({ value: [oid(OID.aes256Cbc), octet(iv)] })
  return { alg: new Sequence({ value: [oid(OID.pbes2), new Sequence({ value: [kdf, scheme] })] }), ct }
}

function safeBag(id: string, value: BaseBlock, keyId: Buffer | null): Sequence {
  const items: BaseBlock[] = [oid(id), explicit0([value])]
  if (keyId) items.push(new AsnSet({ value: [new Sequence({ value: [oid(OID.localKeyId), new AsnSet({ value: [octet(keyId)] })] })] }))
  return new Sequence({ value: items })
}

const dataInfo = (bytes: Buffer): Sequence => new Sequence({ value: [oid(OID.data), explicit0([octet(bytes)])] })

/** Parça düzeyi yazıcı: dışa aktarma tek anahtarla çağırır, testler bozuk dosya üretir. İlk sertifika ilk anahtarındır. */
export async function buildP12Bags(keys: Buffer[], certs: Uint8Array[], password: string, test: { extraShells?: number } = {}): Promise<Buffer> {
  ensurePkiEngine()
  const keyId = certs.length ? createHash('sha256').update(certs[0]).digest() : null
  const certBags = certs.map((c, i) =>
    safeBag(OID.certBag, new Sequence({ value: [oid(OID.x509Cert), explicit0([octet(c)])] }), i === 0 ? keyId : null)
  )
  const sealedCerts = await pbes2Encrypt(der(new Sequence({ value: certBags })), password)
  const encryptedCerts = new Sequence({
    value: [
      oid(OID.encryptedData),
      explicit0([
        new Sequence({
          value: [
            new Integer({ value: 0 }),
            new Sequence({
              value: [oid(OID.data), sealedCerts.alg, new Primitive({ idBlock: { tagClass: 3, tagNumber: 0 }, valueHex: view(sealedCerts.ct).buffer })]
            })
          ]
        })
      ])
    ]
  })
  const keyBags: Sequence[] = []
  for (const [i, pkcs8] of keys.entries()) {
    const sealed = await pbes2Encrypt(pkcs8, password)
    keyBags.push(safeBag(OID.shroudedKeyBag, new Sequence({ value: [sealed.alg, octet(sealed.ct)] }), i === 0 ? keyId : null))
  }
  const shells = Array.from({ length: 1 + (test.extraShells ?? 0) }, () => encryptedCerts)
  const authSafe = der(new Sequence({ value: [...shells, dataInfo(der(new Sequence({ value: keyBags })))] }))

  const salt = randomBytes(SALT_LEN)
  const macKey = await pkcs12KdfInWorker('sha256', password, salt, EXPORT_ITERATIONS, 3, 32)
  const mac = createHmac('sha256', macKey).update(authSafe).digest()
  macKey.fill(0)
  const macData = new Sequence({
    value: [
      new Sequence({ value: [new Sequence({ value: [oid(OID.sha256), new Null()] }), octet(mac)] }),
      octet(salt),
      new Integer({ value: EXPORT_ITERATIONS })
    ]
  })
  return der(new Sequence({ value: [new Integer({ value: 3 }), dataInfo(authSafe), macData] }))
}

/** PBES2, AES-256-CBC, PBKDF2-SHA256, 600 000 tur; HMAC-SHA256. Yeni parolanın tahmin hızını MAC belirlemesin diye aynı tur. */
export function buildP12(c: P12Contents, password: string): Promise<Buffer> {
  return withKdfSlot(() => buildP12Bags([c.keyPkcs8], [c.leaf, ...c.chain], password))
}
