// Web Push ortak türleri: PushItem bildirim hattının çıktısı, PushPayload tarayıcıya şifreli giden yük.
import type { NotifyLevel } from './notifyRules'
import type { RelayEnv, RelayPlatform } from './relayProtocol'

export interface PushItem {
  title: string
  body: string
  accountId: number | null
  messageId: number | null
  level: NotifyLevel
  tag: string
  count: number
}

export type PushActionId = 'read' | 'archive' | 'reply'

/** Açık oturuma ve masaüstü ajanına giden bildirim. `seq` kullanıcı başına artar: ajan kopuştan sonra kaçırdığını
 *  bununla ister. `actions` kullanıcının yetkisine göre seçilmiştir; özet ve kasa bildiriminde boştur. */
export interface ServerNotify extends PushItem {
  actions: PushActionId[]
  seq: number
}

/** Eylem düğmesi metinleri kullanıcının dilinde yükle gelir; özet bildirimde eylem yoktur */
export interface PushPayload extends PushItem {
  actions: { action: PushActionId; title: string }[]
}

/** POST /api/push/subscribe gövdesi: tarayıcı aboneliğinin toJSON çıktısı ve cihaz listesinde görünen ad */
export interface PushSubscriptionInput {
  endpoint: string
  keys: { p256dh: string; auth: string }
  label: string
}

/** POST /api/mobile/device gövdesi: jeton yalnız röleye iletilir, anahtarlar cihazda üretilir */
export interface NativeDeviceInput {
  platform: RelayPlatform
  env: RelayEnv
  token: string
  p256dh: string
  auth: string
  label: string | null
}
