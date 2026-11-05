// Motorun dış dünyayla (Electron main / sunucu süreci) konuştuğu yüzey.
// Motor bu arayüzün arkasını bilmez: masaüstünde parentPort, sunucuda yerel uygulamalar.
import type { SealRequest } from '../shared/importTypes'
import type { NotifyLevel } from '../shared/notifyRules'
import type { PushActionId } from '../shared/pushTypes'

export interface HostNotification {
  title: string
  body: string
  accountId?: number
  messageId?: number
  actions?: PushActionId[]
  level?: NotifyLevel
  tag?: string
}

/** Ana makineden motora giden tek yönlü sinyaller */
export type HostSignal =
  | { type: 'vault-lock' }
  | { type: 'network'; online: boolean }
  | { type: 'locale'; locale: string }
  | { type: 'resume' }
  /** Bildirim düğmesi: sonuç `notifyActionResult` ile döner */
  | { type: 'notify-action'; id: number; action: 'read' | 'archive'; messageId: number }
  /** Taşıma planı ve mühürleme: yalnız ana süreçten, RPC'de karşılığı yok. Sonuç `importResult` ile döner */
  | { type: 'import-plan'; id: number }
  | ({ type: 'import-seal'; id: number } & SealRequest)

export interface EngineHost {
  encrypt(values: string[]): Promise<Uint8Array[]>
  decrypt(blobs: Uint8Array[]): Promise<Uint8Array[]>
  notify(n: HostNotification): void
  badge(count: number): void
  /** yalnız masaüstü */
  notifyActionResult?(id: number, ok: boolean): void
  /** yalnız masaüstü. Hata metni gönderilmez: motordan ana sürece parola parçası taşınmasın */
  importResult?(id: number, r: { ok: true; value: unknown } | { ok: false }): void
  fatal(message: string): void
}
