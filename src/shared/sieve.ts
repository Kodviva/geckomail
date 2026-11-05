// Sunucu tarafı filtreler: süreçler arası ortak türler ve doğrulama. Mantık src/sync/sieve altında.

export const SIEVE_RULES_SCRIPT = 'geckomail-rules'
export const SIEVE_WRAPPER_SCRIPT = 'geckomail-main'

/** Üretici dizgi sınırı (Stalwart varsayılanı): tatil gövdesi de buna tabi */
export const SIEVE_MAX_STRING_BYTES = 3900

/** state_detail değeri: kurallar dağıtıldı, tatil kullanıcı betiğiyle çatıştığı için üretilmedi (K19) */
export const SIEVE_VACATION_CONFLICT = 'vacation_conflict'
/** state_detail değeri: tatil, spam dışlamalarıyla betik sınırına sığmadı */
export const SIEVE_VACATION_TOO_LARGE = 'vacation_too_large'
/** Sabit kodlar: sunucu metni ya da betik adı taşımaz, görme izni olana gösterilir ve mühürlenmez */
/** Adres değişimi eski Sieve sunucusuna ulaşılamadığı için reddedildi: hata kodu, yönetici bırakmayı onaylayabilir */
export const SIEVE_UNREACHABLE = 'SIEVE_UNREACHABLE'

export const SIEVE_PUBLIC_DETAILS: ReadonlySet<string> = new Set([
  SIEVE_VACATION_CONFLICT, SIEVE_VACATION_TOO_LARGE, 'no_listener', 'no_tls', 'no_sasl', 'provider'
])

export type SieveState =
  | 'unknown' | 'unsupported' | 'off' | 'pending' | 'active' | 'needs_consent' | 'blocked_no_include'
  | 'blocked_user_include' | 'conflict' | 'drift' | 'displaced' | 'invalid' | 'auth_failed' | 'error'

export type RulePlacement = 'server' | 'split' | 'client'

export type ClientReason =
  | 'user_choice' | 'sieve_off' | 'attachment' | 'ext_missing' | 'unsafe_string' | 'non_ascii' | 'folder_unknown'
  | 'watch_cap' | 'size_cap' | 'spam_split' | 'order'

export interface SieveCapsInfo {
  implementation: string | null
  version: string | null
  sasl: string[]
  sieve: string[]
  maxRedirects: number | null
}

export interface SieveVacation {
  enabled: boolean
  subject: string
  body: string
  days: number
  startDate: string | null
  endDate: string | null
}

export interface SieveAccountInfo {
  accountId: number
  enabled: boolean
  state: SieveState
  detail: string | null
  caps: SieveCapsInfo | null
  capsAt: number | null
  host: string
  port: number
  /** yalnız elle verilmiş uç nokta; boşsa IMAP sunucusu izlenir */
  customHost: string | null
  deployedAt: number | null
  scriptHash: string | null
  consentNeededFor: string | null
  wrapperOf: string | null
}

export interface RulePlacementInfo {
  ruleId: number
  server: number
  split: number
  client: number
  reasons: ClientReason[]
}

/** Betikte satır sonu CRLF yazılır: tatil gövdesi hep bu biçimde ölçülür ve üretilir */
export function vacationBodyCrlf(body: string): string {
  return body.replace(/\r\n|\r|\n/g, '\r\n')
}

const utf8Length = (s: string): number => new TextEncoder().encode(s).length

/** Denetim karakteri var mı (allowed dışında). no-control-regex kuralına takılmamak için kod noktasıyla bakılır */
export function hasControlChars(s: string, allowed = ''): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0)!
    if ((code < 0x20 || code === 0x7f) && !allowed.includes(ch)) return true
  }
  return false
}

const isCalendarDate = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Geçerliyse düzgün değer, değilse çeviri anahtarı döner */
export function validateVacation(input: unknown): SieveVacation | string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'sync.sieve.vacationInvalid'
  const v = input as Record<string, unknown>
  const { subject, body, days } = v
  const startDate = v.startDate ?? null
  const endDate = v.endDate ?? null
  if (typeof v.enabled !== 'boolean' || typeof subject !== 'string' || typeof body !== 'string') return 'sync.sieve.vacationInvalid'
  // konu başlığa gider: satır sonu başlık enjeksiyonudur
  if (subject.length > 200 || hasControlChars(subject)) return 'sync.sieve.vacationSubject'
  if (hasControlChars(body, '\r\n\t') || utf8Length(vacationBodyCrlf(body)) > SIEVE_MAX_STRING_BYTES) return 'sync.sieve.vacationBody'
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 30) return 'sync.sieve.vacationDays'
  for (const d of [startDate, endDate]) {
    if (d !== null && (typeof d !== 'string' || !isCalendarDate(d))) return 'sync.sieve.vacationDate'
  }
  const start = startDate as string | null
  const end = endDate as string | null
  if (start && end && end < start) return 'sync.sieve.vacationDate'
  return { enabled: v.enabled, subject, body, days, startDate: start, endDate: end }
}
