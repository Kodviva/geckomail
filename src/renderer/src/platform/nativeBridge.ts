// Mobil uygulamanın yerel eklentisi (GeckoNative). Bu dosya @capacitor/* içermez: köprüyü mobil giriş noktası kurar ve
// globalThis.__geckoNative'e koyar. Uzun ömürlü mobil oturum belirteci bu arayüzden hiçbir zaman dönmez.
import type { SessionUser } from '../../../shared/rpc'

export type NativeOS = 'ios' | 'android'

export type NativeLoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: 'bad' | 'locked' | 'totpRequired' | 'totpBad' | 'totpSetupRequired' | 'network' }

export interface NativeOpen { messageId: number | null; accountId: number | null; reply: boolean }
/** uploadPath aynı kökenden okunur (/_capacitor_file_/…). skipped: sınır aşıldığı için atılan dosya sayısı */
export interface NativeShare { files: { name: string; uploadPath: string; mime?: string }[]; text: string | null; skipped?: number }

export interface LockConfig { enabled: boolean; timeoutMs: number }
/** locked ve uptimeMs yerel katmandandır: uptimeMs duvar saati değil, tekdüze saattir */
export interface LockState extends LockConfig { locked: boolean; uptimeMs: number }

export interface GeckoNativePlugin {
  getServer(): Promise<{ origin: string | null }>
  /** Değişince oturum ve push anahtarı silinir */
  setServer(o: { origin: string }): Promise<void>
  login(o: { username: string; password: string; totp?: string }): Promise<NativeLoginResult>
  accessToken(o: { force?: boolean }): Promise<{ status: 'ok'; token: string; expiresAt: number } | { status: 'gone' | 'network' | 'locked' }>
  /** Oturum, push anahtarı ve önbellek silinir. Kilitliyken çağrılırsa kilit de kapanır: açılamayan kilit yeni girişi tutmasın */
  logout(): Promise<void>
  registerPush(): Promise<{ status: 'on' | 'denied' | 'unavailable' | 'failed' }>
  unregisterPush(): Promise<void>
  pushStatus(): Promise<{ status: 'on' | 'off' | 'denied' | 'unavailable' }>
  biometricAvailable(): Promise<{ available: boolean }>
  promptBiometric(o: { reason: string }): Promise<{ ok: boolean }>
  getLock(): Promise<LockState>
  /** Kilidi zayıflatmak (kapatmak, süreyi uzatmak) yerel katmanda kimlik doğrulaması ister; başarısızsa reddedilir */
  setLock(o: LockConfig): Promise<void>
  openAttachment(o: { messageId: number; attachmentId: number; name: string }): Promise<void>
  saveBytes(o: { name: string; base64: string }): Promise<{ ok: boolean }>
  takePending(): Promise<{ opens: NativeOpen[]; shares: NativeShare[] }>
  /** takePending ile alınan paylaşım dosyaları okundu: yerel kopyalar silinir */
  sharesDone(): Promise<void>
  /** 'share': bekleyen paylaşım var, takePending ile alınır */
  addListener(e: 'open' | 'share', cb: (d: unknown) => void): Promise<{ remove(): Promise<void> }>
}

/** serverOrigin: giriş noktası ana paketten önce getServer ile okur (Platform eşzamanlı kurulur). dev: Debug derlemesi */
export interface NativeHost { plugin: GeckoNativePlugin; os: NativeOS; serverOrigin: string | null; dev: boolean }

export function nativeBridge(): NativeHost | null {
  const h = (globalThis as { __geckoNative?: Partial<NativeHost> }).__geckoNative
  if (!h?.plugin || (h.os !== 'ios' && h.os !== 'android')) return null
  return { plugin: h.plugin, os: h.os, serverOrigin: h.serverOrigin ?? null, dev: h.dev === true }
}
