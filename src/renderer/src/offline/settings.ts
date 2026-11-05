// Çevrimdışı okuma tercihi: cihaz başına ve kapalı başlar; sır içermez. Açan kullanıcıya bağlıdır (userId): aynı
// tarayıcıda başka biri girerse tercih onun için geçerli olmaz, kopya silinir.

export const OFFLINE_KEY = 'gecko-offline'
export const LOGOUT_KEY = 'gecko-offline-logout'
export const OFFLINE_DAYS = [7, 30, 90] as const
export type OfflineDays = (typeof OFFLINE_DAYS)[number]

export interface OfflineSettings {
  on: boolean
  days: OfflineDays
  userId: number | null
}

const OFF: OfflineSettings = { on: false, days: 30, userId: null }

export function loadOfflineSettings(): OfflineSettings {
  try {
    const v = JSON.parse(localStorage.getItem(OFFLINE_KEY) ?? 'null') as Partial<OfflineSettings> | null
    if (!v) return OFF
    return {
      on: v.on === true,
      days: OFFLINE_DAYS.includes(v.days as OfflineDays) ? (v.days as OfflineDays) : OFF.days,
      userId: typeof v.userId === 'number' ? v.userId : null
    }
  } catch {
    return OFF
  }
}

export function saveOfflineSettings(s: OfflineSettings): void {
  try {
    localStorage.setItem(OFFLINE_KEY, JSON.stringify(s))
  } catch {
    /* yalnız bu oturum */
  }
}

/** Güvensiz köken (düz HTTP) ve eski tarayıcıda yok: ayar kapalı kalır */
export const offlineSupported = (): boolean =>
  typeof indexedDB !== 'undefined' && !!globalThis.crypto?.subtle && typeof caches !== 'undefined' && 'serviceWorker' in navigator

/** Sunucuya ulaşılamazken çıkıldı: çerez hâlâ geçerli, bağlantı gelince sunucuda da kapatılır */
export function markPendingLogout(): void {
  try {
    localStorage.setItem(LOGOUT_KEY, '1')
  } catch {
    /* yalnız bu oturum */
  }
}

export function clearPendingLogout(): void {
  try {
    localStorage.removeItem(LOGOUT_KEY)
  } catch {
    /* depo kapalı */
  }
}

export function pendingLogout(): boolean {
  try {
    return localStorage.getItem(LOGOUT_KEY) === '1'
  } catch {
    return false
  }
}
