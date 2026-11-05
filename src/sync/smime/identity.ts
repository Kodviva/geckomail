// Kasadaki S/MIME kimlikleri ve alıcı sertifikası seçimi. Özel anahtar yalnız bu süreçte KeyObject olarak yaşar.
// Çağrılar zaman uyumludur: sendMail işleyicisi await içermez, gönderim denetimi araya başka çağrı almadan biter.
import { createPrivateKey, type KeyObject } from 'node:crypto'
import type { Queries } from '../db/queries'
import type { SmimeContactCertRow, SmimeIdentityRow } from '../db/q/types'
import { X509Certificate } from 'node:crypto'
import type { RecipientStatus } from '../../shared/smime'
import { decrypt } from '../vault/crypto'
import { getVaultKey } from '../vault/state'
import { parseCert, type ParsedCert } from './certInfo'
import type { DecryptKey, RecipientCert, SignKey } from './cms'
import { SmimeLockedError, SmimeNoIdentityError } from './errors'
import { storedRevocation, type StoredVerdict } from './revocation'

const MIN_RSA_BITS = 2048
const WEAK_HASHES = new Set(['md5', 'sha1'])
const OID_OAEP = '1.2.840.113549.1.1.7'
const AES_CAPS = new Set(['2.16.840.1.101.3.4.1.2', '2.16.840.1.101.3.4.1.22', '2.16.840.1.101.3.4.1.42'])
const STATUS_RANK: RecipientStatus[] = ['ok', 'crl_pending', 'revoked', 'expired', 'weak', 'unsupported_key', 'missing']

export const encodeChain = (chain: Uint8Array[]): string => JSON.stringify(chain.map((c) => Buffer.from(c).toString('base64')))

export function decodeChain(json: string): Uint8Array[] {
  try {
    const list = JSON.parse(json) as unknown
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string').map((s) => new Uint8Array(Buffer.from(s, 'base64'))) : []
  } catch {
    return []
  }
}

function openKey(vaultKey: Buffer, row: SmimeIdentityRow): KeyObject {
  const pkcs8 = decrypt(vaultKey, Buffer.from(row.key_enc, 'base64'))
  try {
    return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
  } finally {
    pkcs8.fill(0)
  }
}

const within = (row: { not_before?: number; not_after: number }, now: number): boolean => now >= (row.not_before ?? 0) && now <= row.not_after

/** İmzalama anahtarı: süresi dolmuş kimlik imzalayamaz. Satırlar en geç bitişe göre sıralıdır. */
export function loadSignKey(q: Queries, userId: number, email: string, now: number): SignKey {
  const vaultKey = getVaultKey()
  if (!vaultKey) throw new SmimeLockedError()
  const row = q.identitiesForEmail(userId, email).find((r) => r.can_sign && within(r, now))
  if (!row) throw new SmimeNoIdentityError()
  return { key: openKey(vaultKey, row), cert: new Uint8Array(row.cert_der), chain: decodeChain(row.chain_der) }
}

/** Şifre çözme anahtarları: süresi dolmuş olanlar da gerekir, eski posta açılmalı. Çözülemeyen satır diğerlerini düşürmez. */
export function loadDecryptKeys(q: Queries, userId: number): DecryptKey[] | 'locked' {
  const vaultKey = getVaultKey()
  if (!vaultKey) return 'locked'
  return q.listIdentities(userId).flatMap((row) => {
    try {
      return [{ key: openKey(vaultKey, row), cert: new Uint8Array(row.cert_der) }]
    } catch {
      return []
    }
  })
}

const MAX_REVOCATION_DEPTH = 8

/** Ad tutması yetmez: zincire eklenen sahte yayımcı kendi listesiyle iptali gizleyemesin */
function signedBy(child: ParsedCert, issuer: ParsedCert): boolean {
  try {
    return new X509Certificate(child.der).verify(new X509Certificate(issuer.der).publicKey)
  } catch {
    return false
  }
}

function capabilities(row: SmimeContactCertRow | SmimeIdentityRow): string[] | null {
  if (!('capabilities' in row) || !row.capabilities) return null
  try {
    const list = JSON.parse(row.capabilities) as unknown
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : null
  } catch {
    return null
  }
}

/** Zincir yukarı yürünür: ara sertifika da iptal edilmiş olabilir. Kaydedilen zincirde olmayan yayımcı kurum köklerinde aranır.
 *  Mozilla kökü doğrudan yaprak imzalamaz, ara sertifika zincirde gelir; yayımcısı hiç bulunamayan sertifika burada denetlenemez. */
function revocationOf(q: Queries, c: ParsedCert, chain: Uint8Array[]): StoredVerdict {
  const pool = [...chain, ...q.listAnchors().map((a) => new Uint8Array(a.cert_der))].flatMap((der) => {
    try {
      return [parseCert(der)]
    } catch {
      return [] // bozuk zincir öğesi yalnız kendisi sayılmaz
    }
  })
  let cur = c
  let pending = false
  for (let depth = 0; depth < MAX_REVOCATION_DEPTH; depth++) {
    const child = cur
    const issuers = pool.filter((p) => p.fingerprint !== child.fingerprint && p.cert.subject.isEqual(child.cert.issuer) && signedBy(child, p))
    const verdicts = issuers.map((issuer) => storedRevocation(q, cur, issuer))
    if (verdicts.includes('revoked')) return 'revoked'
    pending ||= verdicts.includes('pending')
    if (!issuers.length) break
    cur = issuers[0]
  }
  return pending ? 'pending' : 'good'
}

function statusOf(q: Queries, row: SmimeContactCertRow | SmimeIdentityRow, c: ParsedCert, now: number): RecipientStatus {
  if (!c.canEncrypt || !c.emailEku) return 'unsupported_key'
  if ((c.rsaBits !== null && c.rsaBits < MIN_RSA_BITS) || WEAK_HASHES.has(c.sigHash)) return 'weak'
  if (now < c.notBefore || now > c.notAfter) return 'expired'
  const revocation = revocationOf(q, c, decodeChain(row.chain_der))
  if (revocation === 'revoked') return 'revoked'
  if (revocation === 'pending') return 'crl_pending'
  const caps = capabilities(row)
  if (caps?.length && !caps.some((o) => AES_CAPS.has(o))) return 'weak' // gönderim yalnız AES: yedek yoktur (K7)
  return 'ok'
}

function resolveOne(q: Queries, userId: number, address: string, now: number): { status: RecipientStatus; cert?: RecipientCert } {
  const rows = [...q.contactCerts(userId, address), ...q.identitiesForEmail(userId, address)]
  let best: RecipientStatus = 'missing'
  for (const row of rows) {
    let status: RecipientStatus
    let c: ParsedCert
    try {
      c = parseCert(new Uint8Array(row.cert_der))
      status = statusOf(q, row, c, now)
    } catch {
      continue
    }
    if (status === 'ok') return { status, cert: { cert: c.der, oaep: capabilities(row)?.includes(OID_OAEP) ?? false } }
    if (STATUS_RANK.indexOf(status) < STATUS_RANK.indexOf(best)) best = status
  }
  return { status: best }
}

/** Adres başına seçim: geçerli, en geç not_after. Yoksa en yakın neden döner, arayüz bunu gösterir. */
export function resolveRecipients(q: Queries, o: { userId: number; addresses: string[]; now: number }): Map<string, { status: RecipientStatus; cert?: RecipientCert }> {
  return new Map(o.addresses.map((a) => [a, resolveOne(q, o.userId, a, o.now)]))
}

/** Gönderenin şifreleme sertifikası: her zarfa girer, Gönderilenler kopyası böylece çözülür */
export function ownEncryptCert(q: Queries, userId: number, email: string, now: number): RecipientCert | null {
  const row = q.identitiesForEmail(userId, email).find((r) => r.can_encrypt && within(r, now))
  return row ? { cert: new Uint8Array(row.cert_der), oaep: false } : null
}
