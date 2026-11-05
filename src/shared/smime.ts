// S/MIME durum türleri ve rozet eşlemesi. Saf modül: node:crypto ve pkijs içe aktarmaz, renderer da kullanır.
// Tüm kripto src/sync/smime altında motordadır; arayüz yalnız SmimeInfo görür.
export type SmimeKind = 'signed' | 'encrypted'
export type SmimeSigState = 'none' | 'verified' | 'untrusted' | 'expired' | 'address_mismatch' | 'weak_algorithm' | 'revoked' | 'invalid' | 'unsupported'
export type SmimeEncState = 'none' | 'decrypted' | 'locked' | 'no_key' | 'failed' | 'unsupported'
export type SmimeNote = 'self_signed' | 'cert_expired_since' | 'revocation_unknown' | 'weak_cipher' | 'unauthenticated' | 'header_mismatch' | 'too_large'

export interface SmimeSigner {
  email: string | null
  subject: string
  issuer: string
  fingerprint: string
  notBefore: number
  notAfter: number
}

export interface SmimeInfo {
  sig: SmimeSigState
  enc: SmimeEncState
  notes: SmimeNote[]
  signer: SmimeSigner | null
  canSaveCert: boolean
}

export type SmimeTone = 'ok' | 'warn' | 'bad' | 'muted'

export interface SmimeBadge {
  tone: SmimeTone
  labelKey: string
  detailKey: string
}

export type RecipientStatus = 'ok' | 'crl_pending' | 'missing' | 'expired' | 'revoked' | 'weak' | 'unsupported_key'

export interface SmimeIdentityInfo {
  id: number
  email: string
  subject: string
  issuer: string
  fingerprint: string
  notBefore: number
  notAfter: number
  canSign: boolean
  canEncrypt: boolean
  chainState: SmimeSigState
}

export interface SmimeContactCertInfo {
  id: number
  email: string
  subject: string
  fingerprint: string
  notAfter: number
  source: 'auto' | 'manual'
}

export const SMIME_MAX_BCC = 20
export const SMIME_P12_MAX_BYTES = 262_144

const SIG_ORDER: SmimeSigState[] = ['invalid', 'unsupported', 'revoked', 'untrusted', 'expired', 'address_mismatch', 'weak_algorithm', 'verified', 'none']

/** Birden çok imzacıda en kötü durum: bir imzanın geçerli olması diğerinin kusurunu örtmez. */
export function worstSig(states: SmimeSigState[]): SmimeSigState {
  return SIG_ORDER.find((s) => states.includes(s)) ?? 'none'
}

const badge = (tone: SmimeTone, labelKey: string): SmimeBadge => ({ tone, labelKey, detailKey: `${labelKey}.detail` })

function encBadge(i: SmimeInfo): SmimeBadge | null {
  switch (i.enc) {
    case 'decrypted':
      if (i.notes.includes('unauthenticated')) return badge('warn', 'smime.enc.unauthenticated')
      if (i.notes.includes('weak_cipher')) return badge('warn', 'smime.enc.weakCipher')
      return badge('ok', 'smime.enc.decrypted')
    case 'locked':
      return badge('muted', 'smime.enc.locked')
    case 'no_key':
      return badge('muted', 'smime.enc.noKey')
    case 'failed':
      return badge('bad', 'smime.enc.failed')
    case 'unsupported':
      return badge('muted', 'smime.enc.unsupported')
    default:
      return null
  }
}

function sigBadge(i: SmimeInfo): SmimeBadge | null {
  // kendinden imzalı sertifika hangi durumla gelirse gelsin yeşil rozet alamaz
  if (i.notes.includes('self_signed') && (i.sig === 'verified' || i.sig === 'untrusted')) return badge('warn', 'smime.sig.selfSigned')
  switch (i.sig) {
    case 'verified':
      return badge('ok', 'smime.sig.verified')
    case 'untrusted':
      return badge('warn', 'smime.sig.untrusted')
    case 'expired':
      return badge('warn', 'smime.sig.expired')
    case 'address_mismatch':
      return badge('bad', 'smime.sig.addressMismatch')
    case 'weak_algorithm':
      return badge('warn', 'smime.sig.weakAlgorithm')
    case 'revoked':
      return badge('bad', 'smime.sig.revoked')
    case 'invalid':
      return badge('bad', 'smime.sig.invalid')
    case 'unsupported':
      return badge('muted', 'smime.sig.unsupported')
    default:
      return null
  }
}

/** 0–2 rozet: önce şifre, sonra imza. */
export function smimeBadges(i: SmimeInfo): SmimeBadge[] {
  return [encBadge(i), sigBadge(i)].filter((b): b is SmimeBadge => b !== null)
}
