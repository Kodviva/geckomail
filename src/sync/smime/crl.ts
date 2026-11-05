// CRL okuma. pkijs 10 MB'lık listeyi on saniyede ayrıştırır ve bu iş olay döngüsünü kilitler; asn1js sınırı da 3 000 kayıtta
// düşer. Bu yüzden kayıtlar yapıdan çıkarılır, pkijs yalnız başlık alanlarını görür, seri arama ham baytta yapılır.
// İmza ham TBS üzerinde node:crypto ile doğrulanır.
import { constants, verify, X509Certificate } from 'node:crypto'
import { CertificateRevocationList, RSASSAPSSParams } from 'pkijs'
import { SIG_HASH, PSS_HASH, type ParsedCert } from './certInfo'
import { SmimeFormatError } from './errors'

const TAG_INTEGER = 0x02
const TAG_BIT_STRING = 0x03
const TAG_SEQUENCE = 0x30
const TAG_UTC_TIME = 0x17
const TAG_GENERALIZED_TIME = 0x18
const OID_RSA_PSS = '1.2.840.113549.1.1.10'

interface Tlv {
  tag: number
  start: number
  value: number
  end: number
}

/** Yalnız belirli uzunluklu DER: CRL'de BER yoktur, belirsiz uzunluk reddedilir */
function readTlv(b: Buffer, at: number, limit: number): Tlv {
  if (at + 2 > limit) throw new SmimeFormatError()
  const first = b[at + 1]
  let value = at + 2
  let len = first
  if (first >= 0x80) {
    const n = first & 0x7f
    if (n === 0 || n > 4 || value + n > limit) throw new SmimeFormatError()
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + b[value + i]
    value += n
  }
  const end = value + len
  if (end > limit) throw new SmimeFormatError()
  return { tag: b[at], start: at, value, end }
}

function header(tag: number, len: number): Buffer {
  if (len < 128) return Buffer.from([tag, len])
  const bytes: number[] = []
  for (let v = len; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256)
  return Buffer.from([tag, 0x80 | bytes.length, ...bytes])
}

function sequence(parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  return Buffer.concat([header(TAG_SEQUENCE, body.length), body])
}

export class StoredCrl {
  constructor(
    /** kayıtsız başlık: düzenleyen, süreler, uzantılar */
    readonly info: CertificateRevocationList,
    private readonly der: Buffer,
    private readonly tbs: Tlv,
    private readonly entries: Tlv | null,
    private readonly signature: Tlv
  ) {}

  isRevoked(c: ParsedCert): boolean {
    if (!this.entries) return false
    const serial = c.cert.serialNumber.valueBlock.valueHexView
    for (let at = this.entries.value; at < this.entries.end; ) {
      const entry = readTlv(this.der, at, this.entries.end)
      const s = readTlv(this.der, entry.value, entry.end)
      if (s.tag === TAG_INTEGER && this.der.compare(serial, 0, serial.length, s.value, s.end) === 0) return true
      at = entry.end
    }
    return false
  }

  /** Listedeki seri numaraları, ham baytlar: küme bunlardan yazılır */
  *serials(): Generator<Buffer> {
    if (!this.entries) return
    for (let at = this.entries.value; at < this.entries.end; ) {
      const entry = readTlv(this.der, at, this.entries.end)
      const s = readTlv(this.der, entry.value, entry.end)
      if (s.tag === TAG_INTEGER) yield Buffer.from(this.der.subarray(s.value, s.end))
      at = entry.end
    }
  }

  private verifyOptions(): { hash: string; padding?: number; saltLength?: number } | null {
    const alg = this.info.signatureAlgorithm
    if (alg.algorithmId !== OID_RSA_PSS) {
      const hash = SIG_HASH[alg.algorithmId]
      return hash && hash !== 'md5' ? { hash } : null
    }
    const p = new RSASSAPSSParams({ schema: alg.algorithmParams })
    const hash = PSS_HASH[p.hashAlgorithm.algorithmId]
    return hash ? { hash, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: p.saltLength } : null
  }

  signatureOk(issuer: ParsedCert): boolean {
    try {
      const o = this.verifyOptions()
      if (!o) return false
      const key = new X509Certificate(issuer.der).publicKey
      const sig = this.der.subarray(this.signature.value + 1, this.signature.end)
      const options = o.padding === undefined ? key : { key, padding: o.padding, saltLength: o.saltLength }
      return verify(o.hash, this.der.subarray(this.tbs.start, this.tbs.end), options, sig)
    } catch {
      return false
    }
  }
}

export function parseCrl(der: Buffer): StoredCrl {
  const outer = readTlv(der, 0, der.length)
  if (outer.tag !== TAG_SEQUENCE || outer.end !== der.length) throw new SmimeFormatError()
  const tbs = readTlv(der, outer.value, outer.end)
  const alg = readTlv(der, tbs.end, outer.end)
  const signature = readTlv(der, alg.end, outer.end)
  if (tbs.tag !== TAG_SEQUENCE || signature.tag !== TAG_BIT_STRING || signature.end !== outer.end) throw new SmimeFormatError()

  let p = readTlv(der, tbs.value, tbs.end)
  if (p.tag === TAG_INTEGER) p = readTlv(der, p.end, tbs.end) // version
  p = readTlv(der, readTlv(der, p.end, tbs.end).end, tbs.end) // signature alg, issuer → thisUpdate
  if (p.tag !== TAG_UTC_TIME && p.tag !== TAG_GENERALIZED_TIME) throw new SmimeFormatError()
  let at = p.end
  if (at < tbs.end) {
    const next = readTlv(der, at, tbs.end)
    if (next.tag === TAG_UTC_TIME || next.tag === TAG_GENERALIZED_TIME) at = next.end
  }
  const candidate = at < tbs.end ? readTlv(der, at, tbs.end) : null
  const entries = candidate?.tag === TAG_SEQUENCE ? candidate : null

  const stripped = sequence([
    sequence(entries ? [der.subarray(tbs.value, entries.start), der.subarray(entries.end, tbs.end)] : [der.subarray(tbs.value, tbs.end)]),
    der.subarray(alg.start, signature.end)
  ])
  return new StoredCrl(CertificateRevocationList.fromBER(new Uint8Array(stripped)), der, tbs, entries, signature)
}
