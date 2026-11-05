// Hesap durumunun tek yorumu: başlık rozeti, Sorunlar paneli, Ayarlar › Hesaplar ve bildirimler
// aynı tanımı kullanır. "Şifre reddedildi — HH:MM'de bir kez daha denenecek" (degraded) da dikkat
// gerektirir: sunucu banından önce düzeltmek için tek şans budur.
import type { AccountInfo } from '../../shared/rpc'
import { t } from '../../shared/i18n'
import { isAuthPausedDetail } from '../../shared/accountStatus'

export type Attention = 'auth' | 'server' | 'warn' | null

// scheduler'ın 1. şifre reddi mesajı (src/sync/scheduler.ts onAuthFailure)

export function attention(a: Pick<AccountInfo, 'enabled' | 'status' | 'statusDetail'>): Attention {
  if (!a.enabled) return null
  if (a.status === 'auth_failed') return 'auth'
  if (a.status === 'degraded' && isAuthPausedDetail(a.statusDetail)) return 'auth'
  if (a.status === 'unreachable') return 'server'
  if (a.status === 'degraded') return 'warn'
  return null
}

/** Kullanıcı eylemi gerektiren (rozette sayılan) durum mu? */
export function needsAction(a: Pick<AccountInfo, 'enabled' | 'status' | 'statusDetail'>): boolean {
  const k = attention(a)
  return k === 'auth' || k === 'server'
}

/** Satırdaki durum-duyarlı birincil eylemin etiketi */
export function primaryActionLabel(a: Pick<AccountInfo, 'enabled' | 'status' | 'statusDetail'>): string {
  const k = attention(a)
  return k === 'auth' ? t('acct.health.updatePassword') : k === 'server' ? t('acct.health.serverSettings') : t('action.edit')
}

// durum → çeviri anahtarı (metin çağrı anında çözülür: dil çalışırken değişebilir)
const STATUS_KEY: Record<string, string> = {
  ok: 'acct.status.ok',
  degraded: 'acct.status.degraded',
  auth_failed: 'acct.status.authFailed',
  unreachable: 'acct.status.unreachable',
  unknown: 'acct.status.unknown',
  disabled: 'acct.status.disabled'
}

const hasStatus = (s: string): boolean => Object.prototype.hasOwnProperty.call(STATUS_KEY, s)

/** Durumun kısa etiketi; bilinmeyen durum kodu olduğu gibi döner */
export function statusLabel(s: string): string {
  return hasStatus(s) ? t(STATUS_KEY[s]) : s
}

/** @deprecated statusLabel() kullanın. Eski `STATUS_LABEL[s] ?? s` çağrıları için: her okumada güncel dilde çözülür. */
export const STATUS_LABEL: Readonly<Record<string, string>> = new Proxy({} as Record<string, string>, {
  get: (_o, p) => (typeof p === 'string' && hasStatus(p) ? t(STATUS_KEY[p]) : undefined),
  has: (_o, p) => typeof p === 'string' && hasStatus(p),
  ownKeys: () => Object.keys(STATUS_KEY),
  getOwnPropertyDescriptor: (_o, p) =>
    typeof p === 'string' && hasStatus(p) ? { configurable: true, enumerable: true, value: t(STATUS_KEY[p]) } : undefined
})

export function fmtRelative(ts: number | null): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return t('acct.time.justNow')
  if (min < 60) return t('acct.time.minutesAgo', { count: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('acct.time.hoursAgo', { count: hr })
  return t('acct.time.daysAgo', { count: Math.floor(hr / 24) })
}
