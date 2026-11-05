// Bildirimden gelen açma isteği yerel katmandan gelir: yalnız pozitif tamsayı kimlikler geçer, sunucu ya da adres taşımaz (T10).
import type { NativeOpen } from './platform/nativeBridge'
import type { NotificationLink } from './webPushClient'

const id = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null)

export function toNotificationLink(o: NativeOpen): NotificationLink | null {
  if (!o || typeof o !== 'object') return null
  const raw = o as unknown as { messageId?: unknown; accountId?: unknown; reply?: unknown }
  // kimlik bozuksa hesap filtresine düşülmez: bozuk bağlantı hiçbir şey açmaz
  if (raw.messageId != null && id(raw.messageId) === null) return null
  const messageId = id(raw.messageId)
  const accountId = id(raw.accountId)
  if (messageId === null && accountId === null) return null
  return { messageId, accountId, reply: raw.reply === true }
}
