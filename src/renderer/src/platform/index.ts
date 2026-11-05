// Platform adaptörü: masaüstünde (Electron) preload köprüsü, tarayıcıda (sunucu modu web istemcisi) web
// karşılıkları, mobil uygulamada yerel eklenti. Arayüz kodu window.gecko'ya doğrudan dokunmaz; köprü yoksa (web) açılış çökmez.
import type { ProbeResult } from '../../../shared/desktopMode'
import type { MigrationEvent } from '../../../shared/importTypes'
import type { RpcTransport } from '../transport'
import { createDesktopServerPlatform, desktopServerBridge } from './desktopServer'
import { createElectronPlatform, electronBridge } from './electron'
import { createNativePlatform } from './native'
import { nativeBridge, type NativeOS } from './nativeBridge'
import { createWebPlatform } from './web'

/** Mobil uygulama da 'web': kind sunucu modu anlamındadır, fark native alanındadır */
export type PlatformKind = 'electron' | 'web'
export type { NativeOS }

/** Yükleme başarısız: HTTP durumu (413 = çok büyük). Burada (web.ts'te değil): store web'e özgü modülü
 *  doğrudan içe aktarmasın */
export class UploadError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

/** Sunucu yedek/geri yükleme uçlarının yanıtı: başarısızsa sunucunun reason'ı (yoksa HTTP durumu) */
export type BackupResult<T = object> = ({ ok: true } & T) | { ok: false; reason: string; status: number }

/** Web (sunucu modu) yedekleme ve geri yükleme: HTTP üzerinden, yalnız yönetici (backupRoutes.ts) */
export interface ServerBackup {
  /** POST /api/backup → .geckobak indirme; restorable false: dosya arayüzden geri yüklenemeyecek kadar büyük */
  download(passphrase: string): Promise<BackupResult<{ restorable: boolean }>>
  /** POST /api/restore/upload → uploadId */
  upload(f: File): Promise<BackupResult<{ uploadId: string }>>
  /** POST /api/restore/stage → doğrulanıp bekleyen geri yükleme olarak yazılır */
  stage(uploadId: string, passphrase: string): Promise<BackupResult<{ accounts: number }>>
  /** GET /api/restore/status → bekleyen (doğrulanmış) geri yükleme var mı; rejectedAt: son geri yükleme reddedildi */
  status(): Promise<BackupResult<{ staged: boolean; stagedAt?: number; rejectedAt?: number }>>
  /** POST /api/restore/cancel → bekleyen geri yükleme silinir */
  cancel(): Promise<BackupResult>
  /** POST /api/restart → sunucu düzgün kapanır, Docker yeniden başlatır */
  restart(): Promise<BackupResult>
}

export interface AttachmentRef {
  messageId: number
  attachmentId: number
  name: string
}

export interface OAuthWindow {
  go(url: string): void
  close(): void
}

/** Yerel moddan sunucuya geçiş */
export interface ServerModeApi {
  probe(url: string): Promise<ProbeResult>
  connect(origin: string): Promise<void>
}

/** Yerelden sunucuya taşıma: renderer yalnız ilerleme görür, sır ve zarf gelmez */
export interface MigrationApi {
  start(url: string): Promise<ProbeResult>
  state(): Promise<{ importedTo: { origin: string; at: number } | null }>
  /** dönen işlev dinleyiciyi kaldırır */
  onEvent(cb: (e: MigrationEvent) => void): () => void
}

/** Oturum açılışında başlatma; 'storeSettings': Windows Başlangıç ayarından, 'none': yok */
export interface LoginItemApi {
  get(): Promise<{ support: 'native' | 'storeSettings' | 'none'; enabled: boolean } | null>
  set(enabled: boolean): Promise<boolean>
}

export interface Platform {
  kind: PlatformKind
  /** mobil uygulama işletim sistemi; web ve masaüstünde null */
  native: NativeOS | null
  /** mobil uygulamanın bağlandığı sunucu kökeni; seçilmemişse, web ve masaüstünde null */
  serverOrigin: string | null
  savedLocale(): string | null
  setLocale(locale: string): void
  biometricAvailable(): Promise<boolean>
  promptBiometric(reason: string): Promise<boolean>
  openAttachment(a: AttachmentRef): Promise<void>
  /** web: openAttachment ile aynı (indirme) */
  revealAttachment(a: AttachmentRef): Promise<void>
  saveBytes(name: string, data: Uint8Array): Promise<boolean>
  /** çözülmüş S/MIME eki: düz metin geçici dosya yazılmaz, yalnız kaydedilir */
  saveSmimeAttachment(ref: { messageId: number; index: number; name: string }): Promise<void>
  /** web: null (yedek HTTP akışıyla, Görev 6) */
  chooseBackupSave(name: string, encrypted: boolean): Promise<string | null>
  /** web: null */
  chooseBackupOpen(): Promise<string | null>
  /** web: location.reload() */
  relaunch(): Promise<void>
  /** web: null (tarayıcı dosya yolunu vermez) */
  filePath(f: File): string | null
  /** web: false */
  trashFile(path: string): Promise<boolean>
  openOAuthUrl(url: string): Promise<boolean>
  /** web: OAuth açılır penceresi kullanıcı tıklamasında senkron (about:blank) açılır, sağlayıcı adresi
   *  oauthStart dönünce verilir — açılır pencere engelleyicisine takılmaz. Engellenirse null. Electron: null
   *  (sistem tarayıcısı openOAuthUrl ile) */
  oauthWindow: (() => OAuthWindow | null) | null
  /** web: sağlayıcı dönüşünden ('oauth:returned') sonra akışı bu sayfadan tamamlar (POST /oauth/complete; oturum
   *  çerezi SameSite=Strict, açılır penceredeki dönüş onu taşımaz). Sonuç yine 'oauth:done' olayıyla. Electron: null */
  oauthComplete: ((state: string) => Promise<{ ok: boolean; reason?: string }>) | null
  /** web: eki gönderimden önce HTTP ile yükler (POST /api/upload) → uploadId; hata UploadError. Electron: null
   *  (ek verisi sendMail ile doğrudan sync sürecine gider) */
  uploadFile: ((f: File) => Promise<string>) | null
  /** web: gönderilmeyecek yüklemeyi sunucuda hemen siler (DELETE /api/upload/:id; hata yutulur). Electron: null */
  discardUpload: ((uploadId: string) => Promise<void>) | null
  /** web: sunucu yedeği HTTP ile (ayarlar › yedek); Electron: null (backupToFile/stageRestore RPC'si) */
  serverBackup: ServerBackup | null
  /** duvar modu yalnız masaüstünde; web: null */
  wallboard: { open(): Promise<void>; push(snapshot: unknown): void } | null
  /** true: server:notify ve push'a dokunulmaz, bildirimi ana süreç gösterir */
  nativeNotifications: boolean
  /** masaüstü sunucu modu: Google izin sayfası gömülü pencerede açılmaz, hesap sistem tarayıcısından eklenir */
  oauthExternal: (() => void) | null
  /** masaüstü sunucu modu: ana sürecin yerel olayları (menü, bildirim tıklaması) taşımanın olay akışına girer */
  wrapTransport: ((t: RpcTransport) => RpcTransport) | null
  /** yalnız yerel masaüstünde */
  serverMode: ServerModeApi | null
  /** yalnız yerel masaüstünde */
  migration: MigrationApi | null
  /** masaüstü: kullanıcı oturumu hazır (true) ya da kapandı (false); ana süreç bekleyen bildirim tıklamasını o zaman gönderir */
  rendererReady(ready: boolean): void
  /** yalnız yerel masaüstünde; sunucu modunda anahtar uygulama menüsündedir */
  loginItem: LoginItemApi | null
}

function pick(): Platform {
  const bridge = electronBridge()
  if (bridge) return createElectronPlatform(bridge)
  const native = nativeBridge()
  if (native) return createNativePlatform(native)
  const server = desktopServerBridge()
  return server ? createDesktopServerPlatform(createWebPlatform(), server) : createWebPlatform()
}

/** window.gecko varsa electron, yerel köprü varsa mobil, window.geckoDesktop varsa web tabanlı masaüstü; yoksa web */
export const platform: Platform = pick()
