// X.509 ayrıştırma: pkijs nesnesi + politika ve arayüzün ihtiyaç duyduğu düz alanlar. Bozuk giriş SmimeFormatError olur.
import { createHash, X509Certificate } from 'node:crypto'
import { domainToASCII } from 'node:url'
import { AltName, BasicConstraints, Certificate, CRLDistributionPoints, ExtKeyUsage, RSASSAPSSParams } from 'pkijs'
import { BitString, Constructed, fromBER, Sequence, type BaseBlock, type Primitive } from 'asn1js'
import { ensurePkiEngine } from './engine'
import { SmimeFormatError } from './errors'

export const EKU_EMAIL = '1.3.6.1.5.5.7.3.4'
const EKU_ANY = '2.5.29.37.0'
const EKU_MALFORMED = 'malformed'
const OID_EMAIL_ATTR = '1.2.840.113549.1.9.1'
const GENERAL_NAME_RFC822 = 1
const GENERAL_NAME_URI = 6

const KU_DIGITAL_SIGNATURE = 0x80
const KU_NON_REPUDIATION = 0x40
const KU_KEY_ENCIPHERMENT = 0x20

// Politikanın anladığı uzantılar; kritik işaretli başka bir uzantı sertifikayı geçersiz kılar (RFC 5280 §4.2)
const KNOWN_EXTENSIONS = new Set([
  '2.5.29.14', '2.5.29.15', '2.5.29.17', '2.5.29.18', '2.5.29.19', '2.5.29.30', '2.5.29.31', '2.5.29.32', '2.5.29.33', '2.5.29.35', '2.5.29.36', '2.5.29.37', '2.5.29.54'
])

export const SIG_HASH: Record<string, string> = {
  '1.2.840.113549.1.1.4': 'md5',
  '1.2.840.113549.1.1.5': 'sha1',
  '1.2.840.113549.1.1.11': 'sha256',
  '1.2.840.113549.1.1.12': 'sha384',
  '1.2.840.113549.1.1.13': 'sha512',
  '1.2.840.10045.4.1': 'sha1',
  '1.2.840.10045.4.3.2': 'sha256',
  '1.2.840.10045.4.3.3': 'sha384',
  '1.2.840.10045.4.3.4': 'sha512'
}

export const PSS_HASH: Record<string, string> = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512'
}

export interface ParsedCert {
  cert: Certificate
  der: Uint8Array
  /** sha256 hex */
  fingerprint: string
  subject: string
  issuer: string
  notBefore: number
  notAfter: number
  emails: string[]
  /** bütün SAN rfc822 adları ve bütün konu e-postaları: ad kısıtı denetimi içindir */
  rfc822Names: string[]
  /** ad kısıtı uzantısı varsa */
  nameLimits: NameLimits | null
  ca: boolean
  /** konu = yayımcı (bu sınıftaki yaprak asla güvenilmez, imzayı denemeye gerek yok) */
  selfSigned: boolean
  canSign: boolean
  canEncrypt: boolean
  /** EKU yok, emailProtection veya anyExtendedKeyUsage */
  emailEku: boolean
  ekus: string[]
  pathLen: number | null
  unknownCritical: boolean
  /** çözülemeyen uzantı var: boş okunan SAN veya ad kısıtı güven kararına giremez */
  malformedExt: boolean
  rsaBits: number | null
  curve: 'P-256' | 'P-384' | null
  sigHash: string
  /** yalnız http/https; ldap yok sayılır */
  crlUrls: string[]
  /** CRL dağıtım noktası uzantısı var (http dışı veya kullanılamaz olsa da) */
  hasCdp: boolean
}

export interface NameLimits {
  permitted: string[]
  excluded: string[]
  /** değerlendirilemeyen uzantı: sertifika güvenilmez sayılır */
  bad: boolean
}

function extension<T>(cert: Certificate, oid: string): T | null {
  return (cert.extensions?.find((e) => e.extnID === oid)?.parsedValue as T | undefined) ?? null
}

/** pkijs bozuk uzantıda hata atmaz: boş nesne döndürür, üstüne `parsingError` yazar. Boş nesne "kısıt yok" gibi okunurdu. */
export const parseFailed = (v: unknown): boolean => typeof v === 'object' && v !== null && 'parsingError' in v

function sanEmails(cert: Certificate): string[] {
  const san = extension<AltName>(cert, '2.5.29.17')
  return (san?.altNames ?? []).filter((n) => n.type === GENERAL_NAME_RFC822).map((n) => String(n.value).toLowerCase())
}

function subjectEmails(cert: Certificate): string[] {
  return cert.subject.typesAndValues.filter((t) => t.type === OID_EMAIL_ATTR).map((t) => String(t.value.valueBlock.value).toLowerCase())
}

const asContext = (b: BaseBlock | undefined, n: number): boolean => b?.idBlock.tagClass === 3 && b.idBlock.tagNumber === n

/** minimum yalnız 0 olabilir, maximum yasak (RFC 5280 §4.2.1.10): aksi halde kısıt değerlendirilemez */
function subtreeBase(sub: BaseBlock): string | null | 'bad' {
  if (!(sub instanceof Sequence)) return 'bad'
  const [base, ...rest] = sub.valueBlock.value
  for (const r of rest) {
    if (!asContext(r, 0) || (r as Primitive).valueBlock.valueHexView.some((x) => x !== 0)) return 'bad'
  }
  if (!base || base.idBlock.tagClass !== 3) return 'bad'
  if (base.idBlock.tagNumber !== GENERAL_NAME_RFC822) return null // kısıt tür başınadır
  const value = Buffer.from((base as Primitive).valueBlock.valueHexView).toString('latin1').trim().toLowerCase()
  return validRfc822Base(value) ? value : 'bad'
}

/** `@alan` ve sonda nokta hiçbir adresle eşleşmez: dışlama listesinde sessizce işlevsiz kalırdı */
export function validRfc822Base(v: string): boolean {
  return !!v && v !== '.' && !v.startsWith('@') && !v.endsWith('@') && !v.endsWith('.')
}

/** Aynı uzantı iki kez: ayrıştırıcılar farklı olanı okuyabilir */
export function duplicateNameExt(extensions: { extnID: string }[]): boolean {
  return ['2.5.29.17', '2.5.29.30'].some((id) => extensions.filter((e) => e.extnID === id).length > 1)
}

/** pkijs GeneralSubtree şeması minimum için açık etiket bekler, RFC ise örtük: yanlış okuduğu için ham bloklardan çözülür */
function nameLimits(cert: Certificate): NameLimits | null {
  const ext = cert.extensions?.find((e) => e.extnID === '2.5.29.30')
  if (!ext) return null
  const limits: NameLimits = { permitted: [], excluded: [], bad: true }
  const parsed = fromBER(ext.extnValue.valueBlock.valueHexView)
  if (parsed.offset === -1 || !(parsed.result instanceof Sequence)) return limits
  for (const group of parsed.result.valueBlock.value) {
    const target = asContext(group, 0) ? limits.permitted : asContext(group, 1) ? limits.excluded : null
    if (!target || !(group instanceof Constructed)) return limits
    for (const sub of group.valueBlock.value) {
      const base = subtreeBase(sub)
      if (base === 'bad') return limits
      if (base !== null) target.push(base)
    }
  }
  return { ...limits, bad: false }
}

function crlUrls(cert: Certificate): string[] {
  const cdp = extension<CRLDistributionPoints>(cert, '2.5.29.31')
  // nedenli veya başka yayımcılı nokta tam liste vermez: "iptal değil" kanıtı olamaz
  const full = (cdp?.distributionPoints ?? []).filter((p) => p.reasons === undefined && p.cRLIssuer === undefined)
  const urls = full.flatMap((p) => (Array.isArray(p.distributionPoint) ? p.distributionPoint : []))
  return urls.filter((n) => n.type === GENERAL_NAME_URI).map((n) => String(n.value)).filter((u) => /^https?:\/\//i.test(u))
}

function pathLen(bc: BasicConstraints | null): number | null {
  const v = bc?.pathLenConstraint
  if (v === undefined || v === null) return null
  return typeof v === 'number' ? v : v.valueBlock.valueDec
}

function sigHash(cert: Certificate): string {
  const oid = cert.signatureAlgorithm.algorithmId
  // RSA-PSS'te özet parametrededir; parametre yoksa RFC 4055 varsayılanı SHA-1
  if (oid === '1.2.840.113549.1.1.10') {
    return PSS_HASH[new RSASSAPSSParams({ schema: cert.signatureAlgorithm.algorithmParams }).hashAlgorithm.algorithmId] ?? 'unknown'
  }
  return SIG_HASH[oid] ?? 'unknown'
}

export function parseCert(der: Uint8Array): ParsedCert {
  ensurePkiEngine()
  try {
    const bytes = new Uint8Array(der)
    const cert = Certificate.fromBER(bytes)
    const x = new X509Certificate(bytes)
    // bozuk uzantı "yok" sayılmaz: yok demek kısıt yok demektir
    const kuExt = cert.extensions?.find((e) => e.extnID === '2.5.29.15')
    const ku = kuExt?.parsedValue as unknown
    const kuBits = !kuExt ? null : ku instanceof BitString ? (ku.valueBlock.valueHexView[0] ?? 0) : 0
    const ekuExt = cert.extensions?.find((e) => e.extnID === '2.5.29.37')
    const ekuValue = ekuExt?.parsedValue as unknown
    const eku = !ekuExt ? [] : ekuValue instanceof ExtKeyUsage && !parseFailed(ekuValue) ? ekuValue.keyPurposes : [EKU_MALFORMED]
    const bc = extension<BasicConstraints>(cert, '2.5.29.19')
    const details = x.publicKey.asymmetricKeyDetails
    const isRsa = x.publicKey.asymmetricKeyType === 'rsa'
    const named = details?.namedCurve
    const san = sanEmails(cert)
    const subject = subjectEmails(cert)
    return {
      cert,
      der: bytes,
      fingerprint: createHash('sha256').update(bytes).digest('hex'),
      subject: x.subject.split('\n').join(', '),
      issuer: x.issuer.split('\n').join(', '),
      notBefore: cert.notBefore.value.getTime(),
      notAfter: cert.notAfter.value.getTime(),
      emails: san.length ? san : subject,
      rfc822Names: [...new Set([...san, ...subject])],
      nameLimits: nameLimits(cert),
      ca: bc?.cA === true,
      selfSigned: cert.subject.isEqual(cert.issuer),
      canSign: kuBits === null || (kuBits & (KU_DIGITAL_SIGNATURE | KU_NON_REPUDIATION)) !== 0,
      canEncrypt: isRsa && (kuBits === null || (kuBits & KU_KEY_ENCIPHERMENT) !== 0),
      emailEku: eku.length === 0 || eku.includes(EKU_EMAIL) || eku.includes(EKU_ANY),
      ekus: eku,
      pathLen: pathLen(bc),
      unknownCritical: (cert.extensions ?? []).some((e) => e.critical && !KNOWN_EXTENSIONS.has(e.extnID)),
      malformedExt: (cert.extensions ?? []).some((e) => parseFailed(e.parsedValue)) || duplicateNameExt(cert.extensions ?? []),
      rsaBits: details?.modulusLength ?? null,
      curve: named === 'prime256v1' ? 'P-256' : named === 'secp384r1' ? 'P-384' : null,
      sigHash: sigHash(cert),
      crlUrls: crlUrls(cert),
      hasCdp: !!cert.extensions?.some((e) => e.extnID === '2.5.29.31')
    }
  } catch {
    throw new SmimeFormatError()
  }
}

const canonicalDomain = (d: string): string => domainToASCII(d) || d

function canonicalAddress(a: string): string {
  const s = a.trim().toLowerCase()
  const at = s.lastIndexOf('@')
  if (at < 0) return s
  return `${s.slice(0, at)}@${canonicalDomain(s.slice(at + 1))}`
}

/** Küçük harf + alan adında domainToASCII; +etiket soyulmaz */
export function sameAddress(a: string, b: string): boolean {
  return canonicalAddress(a) === canonicalAddress(b)
}

function matchesBase(address: string, base: string): boolean {
  if (base.includes('@')) return address === canonicalAddress(base)
  const domain = address.slice(address.lastIndexOf('@') + 1)
  if (base.startsWith('.')) return domain.endsWith(`.${canonicalDomain(base.slice(1))}`)
  return domain === canonicalDomain(base)
}

/** RFC 5280 §4.2.1.10 rfc822: `@` içeren taban tek posta kutusu, `.alan` alt alanlar, `alan` tam eşleşme. */
export function nameAllowed(address: string, limits: Pick<NameLimits, 'permitted' | 'excluded'>): boolean {
  if (!limits.permitted.length && !limits.excluded.length) return true
  const a = canonicalAddress(address)
  if (a.indexOf('@') <= 0) return false
  if (limits.excluded.some((b) => matchesBase(a, b))) return false
  return !limits.permitted.length || limits.permitted.some((b) => matchesBase(a, b))
}
