// RFC 8058 tek-tık abonelik iptali: List-Unsubscribe'de https: URL VE
// List-Unsubscribe-Post: List-Unsubscribe=One-Click ikisi birden olmalı.
// Sadece mailto: veya bu ikinci header eksikse tek-tık güvenli değildir.
export function extractUnsubscribeUrl(listUnsubscribe: string | null): string | null {
  if (!listUnsubscribe) return null
  const m = listUnsubscribe.match(/<(https?:[^>]+)>/i)
  return m ? m[1] : null
}

export function isOneClickUnsubscribe(listUnsubscribe: string | null, listUnsubscribePost: string | null): boolean {
  if (!extractUnsubscribeUrl(listUnsubscribe)) return false
  return /list-unsubscribe\s*=\s*one-click/i.test(listUnsubscribePost ?? '')
}
