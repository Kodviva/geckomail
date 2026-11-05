// Güven kararı: zincir kuruluşu pkijs'te, politika burada. Güven deposu tek kaynaktır: Mozilla e-posta listesi +
// yöneticinin eklediği kurum kökleri. tls.rootCertificates ve sistem deposu bilinçli olarak kullanılmaz.
import { X509Certificate } from 'node:crypto'
import { CertificateChainValidationEngine, type Certificate } from 'pkijs'
import type { Queries } from '../db/queries'
import { EKU_EMAIL, nameAllowed, parseCert, type ParsedCert } from './certInfo'
import { ensurePkiEngine } from './engine'
import type { CrlCache } from './revocation'
import rootsPem from './roots/mozilla-email-roots.pem?raw'
import rootsMeta from './roots/roots-meta.json?raw'

const MAX_PATH = 8
const MIN_RSA_BITS = 2048
// iletiden gelen sertifika: dev modül yol kurucuda binlerce doğrulamayı pahalılaştırırdı
const MAX_RSA_BITS = 8192
const oversized = (c: ParsedCert): boolean => c.rsaBits !== null && c.rsaBits > MAX_RSA_BITS
const WEAK_HASHES = new Set(['md5', 'sha1'])
// zincir kurucu düğüm denetlemez: birbirini imzalayan iki sertifika sonsuza dek dönerdi
const MAX_ISSUER_LOOKUPS = 64

export interface TrustBundle {
  count: number
  fetchedAt: string
  sha256: string
}

export interface TrustStore {
  anchors(): ParsedCert[]
  bundle(): TrustBundle
}

export function createTrustStore(q: Queries): TrustStore {
  const bundle = JSON.parse(rootsMeta) as TrustBundle
  let mozilla: ParsedCert[] | null = null
  const institution = new Map<string, ParsedCert>()
  const mozillaRoots = (): ParsedCert[] => {
    mozilla ??= (rootsPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((p) => parseCert(new X509Certificate(p).raw))
    return mozilla
  }
  const instRoot = (fingerprint: string, der: Buffer): ParsedCert[] => {
    let c = institution.get(fingerprint)
    if (!c) {
      try {
        c = parseCert(der)
      } catch {
        return [] // bozuk kayıt güveni düşürmez, yalnız kendisi sayılmaz
      }
      institution.set(fingerprint, c)
    }
    return [c]
  }
  return {
    anchors: () => [...mozillaRoots(), ...q.listAnchors().flatMap((a) => instRoot(a.fingerprint, a.cert_der))],
    bundle: () => bundle
  }
}

export interface ChainInput {
  leaf: Uint8Array
  extra: Uint8Array[]
  /** doğrulama anı: IMAP INTERNALDATE; Date: ve signingTime gönderenin elindedir */
  at: number
  purpose: 'sign' | 'encrypt'
}

export interface ChainVerdict {
  state: 'ok' | 'untrusted' | 'expired' | 'weak' | 'revoked'
  selfSigned: boolean
  expiredSince: boolean
  revocation: 'good' | 'unknown'
  /** yapraktan köke parmak izleri */
  chain: string[]
}

const verdict = (state: ChainVerdict['state'], o: Partial<ChainVerdict> = {}): ChainVerdict => ({
  state, selfSigned: false, expiredSince: false, revocation: 'unknown', chain: [], ...o
})

const tbsKey = (c: Certificate): string => Buffer.from(c.tbsView).toString('base64')

async function buildPath(leaf: ParsedCert, extra: ParsedCert[], anchors: ParsedCert[], at: number): Promise<ParsedCert[] | null> {
  let lookups = 0
  const engine = new CertificateChainValidationEngine({
    trustedCerts: anchors.map((a) => a.cert),
    certs: [...extra.map((e) => e.cert), leaf.cert], // yaprak son sırada olmalı
    checkDate: new Date(at),
    findIssuer: (cert, eng, crypto) => {
      if (++lookups > MAX_ISSUER_LOOKUPS) return Promise.reject(new Error('issuer_limit'))
      return eng.defaultFindIssuer(cert, eng, crypto)
    }
  })
  try {
    const r = await engine.verify()
    if (!r.result || !r.certificatePath) return null
    const byTbs = new Map([leaf, ...extra, ...anchors].map((c) => [tbsKey(c.cert), c]))
    const path = r.certificatePath.map((c) => byTbs.get(tbsKey(c)))
    // zincir kurucu kopyaları kendi ayıklar; sonuç başka bir sertifikanın yolu olamaz
    if (path.some((c) => !c) || path[0]?.fingerprint !== leaf.fingerprint) return null
    return path as ParsedCert[]
  } catch {
    return null
  }
}

/** Her CA, altındaki her sertifikanın bütün e-postalarını sınırlar; CA başına ayrı denetim kısıtların kesişimidir.
 *  pkijs alt ağaçları birleştirir, tek izinli adı yeterli sayar ve konu e-postasını atlar: güvenilmez. */
function namesOk(path: ParsedCert[]): boolean {
  for (let i = 1; i < path.length; i++) {
    const limits = path[i].nameLimits
    if (!limits) continue
    if (limits.bad) return false
    if (!path.slice(0, i).every((c) => c.rfc822Names.every((a) => nameAllowed(a, limits)))) return false
  }
  return true
}

/** pkijs'in denetlemediği kurallar: amaç, EKU, CA bayrağı, yol uzunluğu, kritik uzantı, ad kısıtı */
function policyOk(path: ParsedCert[], purpose: ChainInput['purpose']): boolean {
  if (path.length > MAX_PATH || path.some((c) => c.malformedExt) || !namesOk(path)) return false
  const [leaf] = path
  if (!leaf.emailEku || !(purpose === 'sign' ? leaf.canSign : leaf.canEncrypt)) return false
  const last = path.length - 1
  for (let i = 0; i < path.length; i++) {
    const c = path[i]
    if (i < last && c.unknownCritical) return false
    if (i === 0) continue
    if (!c.ca) return false
    if (c.pathLen !== null && i - 1 > c.pathLen) return false
    if (i < last && c.ekus.length > 0 && !c.ekus.includes(EKU_EMAIL)) return false
  }
  return true
}

function isWeak(path: ParsedCert[]): boolean {
  const smallKey = (c: ParsedCert): boolean => c.rsaBits !== null && c.rsaBits < MIN_RSA_BITS
  // kökün kendi imzası önemsizdir, anahtarı değil
  return path.some(smallKey) || path.slice(0, -1).some((c) => WEAK_HASHES.has(c.sigHash))
}

async function revocationOf(path: ParsedCert[], crl: CrlCache): Promise<'revoked' | 'good' | 'unknown'> {
  let known = true
  for (let i = 0; i < path.length - 1; i++) {
    const c = path[i]
    if (i > 0 && !c.hasCdp) continue // CDP'siz ara sertifika için denetlenecek bir şey yok
    const { fresh, stale } = await crl.forCert(c, path[i + 1])
    if ([...fresh, ...stale].some((l) => l.isRevoked(c))) return 'revoked' // iptal kalıcıdır, bayat liste de sayılır
    if (fresh.length === 0) known = false
  }
  return known ? 'good' : 'unknown'
}

export async function evaluateChain(i: ChainInput, store: TrustStore, crl: CrlCache, now: () => number = Date.now): Promise<ChainVerdict> {
  ensurePkiEngine()
  const leaf = parseCert(i.leaf)
  if (leaf.selfSigned) return verdict('untrusted', { selfSigned: true })
  if (oversized(leaf)) return verdict('untrusted')

  const extra = new Map<string, ParsedCert>()
  for (const der of i.extra) {
    try {
      const c = parseCert(der)
      if (c.fingerprint !== leaf.fingerprint && !oversized(c)) extra.set(c.fingerprint, c) // yaprağın kopyası son sıradaki yaprağı siler
    } catch {
      /* bozuk ek sertifika yalnız zincire katılmaz */
    }
  }
  // CA olmayan kök kabul edilmez: yayımcı olamaz
  const anchors = store.anchors().filter((a) => a.ca && a.fingerprint !== leaf.fingerprint)

  let path = await buildPath(leaf, [...extra.values()], anchors, i.at)
  let expired = false
  if (!path) {
    path = await buildPath(leaf, [...extra.values()], anchors, leaf.notAfter - 1000)
    expired = path !== null
  }
  if (!path || !policyOk(path, i.purpose)) return verdict('untrusted')

  const chain = path.map((c) => c.fingerprint)
  // CRL yalnız zincir tamamlandıktan sonra istenir; iptal tarihten bağımsızdır
  const revocation = await revocationOf(path, crl)
  if (revocation === 'revoked') return verdict('revoked', { chain, revocation: 'good' })
  if (expired) return verdict('expired', { chain, revocation })
  if (isWeak(path)) return verdict('weak', { chain, revocation })
  return verdict('ok', { chain, revocation, expiredSince: now() > leaf.notAfter })
}
