// Sunucu filtreleri ekranının saf görünüm kararları: durum, neden ve eylem eşlemeleri.
import {
  SIEVE_MAX_STRING_BYTES, SIEVE_VACATION_CONFLICT, SIEVE_VACATION_TOO_LARGE, vacationBodyCrlf, type ClientReason, type RulePlacement, type RulePlacementInfo,
  type SieveAccountInfo, type SieveState
} from '../../shared/sieve'

export type SieveTone = 'ok' | 'wait' | 'warn' | 'bad' | 'off'

const STATE: Record<SieveState, { tone: SieveTone; hint: boolean }> = {
  unknown: { tone: 'off', hint: false },
  unsupported: { tone: 'off', hint: true },
  off: { tone: 'off', hint: false },
  pending: { tone: 'wait', hint: true },
  active: { tone: 'ok', hint: false },
  needs_consent: { tone: 'warn', hint: true },
  blocked_no_include: { tone: 'warn', hint: true },
  blocked_user_include: { tone: 'warn', hint: true },
  conflict: { tone: 'warn', hint: true },
  drift: { tone: 'warn', hint: true },
  displaced: { tone: 'warn', hint: true },
  invalid: { tone: 'bad', hint: true },
  auth_failed: { tone: 'bad', hint: true },
  error: { tone: 'bad', hint: true }
}

const REASON: Record<ClientReason, string> = {
  user_choice: 'set.sieve.reason.user_choice',
  sieve_off: 'set.sieve.reason.sieve_off',
  attachment: 'set.sieve.reason.attachment',
  ext_missing: 'set.sieve.reason.ext_missing',
  unsafe_string: 'set.sieve.reason.unsafe_string',
  non_ascii: 'set.sieve.reason.non_ascii',
  folder_unknown: 'set.sieve.reason.folder_unknown',
  watch_cap: 'set.sieve.reason.watch_cap',
  size_cap: 'set.sieve.reason.size_cap',
  spam_split: 'set.sieve.reason.spam_split',
  order: 'set.sieve.reason.order'
}

const UNSUPPORTED_DETAIL: Record<string, string> = {
  no_listener: 'set.sieve.detail.noListener',
  no_tls: 'set.sieve.detail.noTls',
  no_sasl: 'set.sieve.detail.noSasl',
  provider: 'set.sieve.detail.provider'
}

/** Sunucunun ya da engelin metni aynen gösterilir; diğer durumlarda detail bir betik adıdır */
const RAW_DETAIL = new Set<SieveState>(['pending', 'invalid', 'auth_failed', 'error'])

export const stateLabelKey = (s: SieveState): string => `set.sieve.state.${s}`
export const stateHintKey = (s: SieveState): string | null => (STATE[s].hint ? `set.sieve.hint.${s}` : null)
export const stateTone = (s: SieveState): SieveTone => STATE[s].tone
export const reasonKey = (r: ClientReason): string => REASON[r]

export function placementBadge(p: RulePlacementInfo): { kind: RulePlacement | 'mixed'; labelKey: string } {
  const used = (['server', 'split', 'client'] as const).filter((k) => p[k] > 0)
  const kind = used.length > 1 ? 'mixed' : (used[0] ?? 'client')
  return { kind, labelKey: `set.sieve.badge.${kind}` }
}

export function detailLine(i: SieveAccountInfo): { key: string | null; raw: string | null } {
  // durum active kalır: kurallar çalışıyor, yalnız tatil eksik. Görünmezse kullanıcı tatilin açık olduğunu sanır
  if (i.detail === SIEVE_VACATION_CONFLICT) return { key: 'set.sieve.detail.vacationConflict', raw: null }
  if (i.detail === SIEVE_VACATION_TOO_LARGE) return { key: 'set.sieve.detail.vacationTooLarge', raw: null }
  if (i.detail && i.state === 'unsupported') return { key: UNSUPPORTED_DETAIL[i.detail] ?? null, raw: null }
  return { key: null, raw: i.detail && RAW_DETAIL.has(i.state) ? i.detail : null }
}

/** K22: hiç dağıtılmamış hesap da active olur; "dağıtıldı" demek yanlış olurdu */
export function deployNote(i: SieveAccountInfo): { key: string; at?: number } | null {
  if (i.deployedAt !== null) return { key: 'set.sieve.deployedAt', at: i.deployedAt }
  return i.enabled && i.state === 'active' ? { key: 'set.sieve.nothingDeployed' } : null
}

export interface SieveActions {
  enable: boolean
  rollback: boolean
  redeploy: boolean
  /** onay istenecek betik adı */
  consent: string | null
  /** sarmalayıcı kaldırıldı, hiçbir betik etkin değil: onaylanacak ad yok, kurallar yeniden kurulabilir */
  reactivate: boolean
  editor: boolean
  vacation: boolean
  retry: boolean
}

export function sieveActions(i: SieveAccountInfo): SieveActions {
  return {
    enable: !i.enabled && i.state !== 'unsupported',
    // başarısız geri alma hesabı kapatır, betikler sunucuda kalır: yeniden denenebilmeli
    rollback: i.enabled || i.scriptHash !== null || i.wrapperOf !== null,
    // drift elle düzenlenmiş betiktir: üzerine yazdırır gibi görünen düğme yok (K6)
    redeploy: i.enabled && i.state !== 'drift' && i.state !== 'auth_failed',
    consent: i.consentNeededFor ?? (i.state === 'displaced' ? i.detail : null),
    reactivate: i.state === 'displaced' && !i.detail,
    editor: i.caps !== null && i.state !== 'auth_failed',
    vacation: i.enabled,
    retry: i.state === 'unsupported' || i.state === 'unknown'
  }
}

/** Sunucunun saydığıyla aynı ölçü: betikte satır sonu CRLF yazılır */
export function remainingBytes(body: string): number {
  return SIEVE_MAX_STRING_BYTES - new TextEncoder().encode(vacationBodyCrlf(body)).length
}
