// Alıcı alanı için saf string yardımcıları (store/DOM bağımsız — test edilebilir).
import { norm } from '../../shared/notifyRules'
import type { Contact } from '../../shared/rpc'

// caret'ten önceki son virgülden sonrası = düzenlenmekte olan token (küçük harf)
export function currentToken(value: string, caret: number): string {
  const before = value.slice(0, caret)
  return before.slice(before.lastIndexOf(',') + 1).trim().toLowerCase()
}

const addressesOf = (value: string): string[] => value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

/** Öneriler: yazılmış adres yinelenmez, Türkçe i/İ/ı duyarsız. `value` alanın tümü, `token` düzenlenen parça */
export function matchContacts<T extends Contact>(contacts: readonly T[], token: string, value: string, limit = 8): T[] {
  const want = norm(token.trim())
  if (!want) return []
  const used = new Set(addressesOf(value))
  return contacts.filter((c) => (c.groupId != null || !used.has(c.addr.toLowerCase())) && (norm(c.addr).includes(want) || norm(c.name ?? '').includes(want))).slice(0, limit)
}

/** Öneri seçilince: grup üyeleri virgülle, zaten yazılmış adres atlanır */
export function insertContact(value: string, caret: number, c: Contact): string {
  if (c.groupId == null) return insertAddress(value, caret, c.addr)
  const start = value.slice(0, caret).lastIndexOf(',') + 1
  const used = new Set(addressesOf(value.slice(0, start)))
  return insertAddress(value, caret, [...new Set(c.members ?? [])].filter((a) => !used.has(a.toLowerCase())).join(', '))
}

// token'ı seçilen adresle değiştir, "adres, " olarak kapat
export function insertAddress(value: string, caret: number, addr: string): string {
  const start = value.slice(0, caret).lastIndexOf(',') + 1
  const prefix = value.slice(0, start)
  const rest = value.slice(caret).replace(/^\s*,?\s*/, '')
  const sep = prefix && !prefix.endsWith(' ') ? ' ' : ''
  return `${prefix}${sep}${addr}, ${rest}`
}
