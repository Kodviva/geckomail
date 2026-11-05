// Kayıtlı aramalar localStorage'da. Masaüstü: tek anahtar (bugünkü). Web: aynı tarayıcıyı başka kullanıcı da açabilir,
// anahtar kullanıcıya bağlı; kullanıcı girişle belli olur (sync:hello, yerel kopya açılışı).
import { platform } from '../platform'

export type SavedSearch = { name: string; query: string }

const KEY = 'gecko-saved-searches'
const webKey = (userId: number): string => `${KEY}:${userId}`

function parse(raw: string | null): SavedSearch[] {
  try {
    const v: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(v) ? (v as SavedSearch[]) : []
  } catch {
    return []
  }
}

/** Mağaza başlangıcı: web'de kullanıcı henüz belli değil */
export function initialSavedSearches(): SavedSearch[] {
  return platform.kind === 'web' ? [] : JSON.parse(localStorage.getItem(KEY) || '[]')
}

export function readSavedSearches(userId: number): SavedSearch[] {
  try {
    return parse(localStorage.getItem(webKey(userId)))
  } catch {
    return []
  }
}

export function writeSavedSearches(list: SavedSearch[], userId: number | undefined): void {
  if (platform.kind !== 'web') return localStorage.setItem(KEY, JSON.stringify(list))
  if (userId == null) return
  try {
    localStorage.setItem(webKey(userId), JSON.stringify(list))
  } catch {
    /* depo kapalı: liste yalnız bu oturumda kalır */
  }
}

/** Web: eski kapsamsız değer kimin olduğu bilinmediği için taşınmaz, silinir */
export function dropUnscopedSavedSearches(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* depo kapalı */
  }
}
