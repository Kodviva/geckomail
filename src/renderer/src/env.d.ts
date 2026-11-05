/// <reference types="vite/client" />

/** Electron preload köprüsü. Yalnız platform/electron.ts kullanır; geri kalan kod platform/'u çağırır. */
interface GeckoBridge {
  reveal(path: string): Promise<void>
  openPath(path: string, displayName?: string): Promise<void>
  /** Yalnız izinli OAuth sağlayıcı sayfalarını sistem tarayıcısında açar */
  openOAuthUrl(url: string): Promise<boolean>
  /** arayüz dili: main (menüler) ve sync (bildirimler, sunucu mesajları) aynı dili kullanır */
  setLocale(locale: string): void
  /** main'in kayıtlı dil seçimi (yoksa null) */
  savedLocale: string | null
  chooseBackupSave(suggestedName: string, encrypted: boolean): Promise<string | null>
  chooseBackupOpen(): Promise<string | null>
  relaunch(): Promise<void>
  getFilePath(file: File): string
  trashFile(path: string): Promise<boolean>
  saveFileAs(suggestedName: string, data: Uint8Array): Promise<boolean>
  openWallboard(): Promise<void>
  wallboardPush(snapshot: unknown): void
  touchIdAvailable(): Promise<boolean>
  promptTouchId(reason: string): Promise<boolean>
  /** yerel moddan sunucuya geçiş: bağlanma yalnız main'in onayıyla, yeniden başlatarak */
  serverMode: import('./platform').ServerModeApi
  loginItem: import('./platform').LoginItemApi
  /** bildirimden açılan ileti girişten sonra gelsin */
  rendererReady(ready: boolean): void
  migration?: import('./platform').MigrationApi
}

/** Sunucu modu köprüsü: sayfa sunucudan gelir, yüzey bundan ibarettir */
interface GeckoDesktopBridge {
  wallboard: { open(): Promise<void>; push(snapshot: unknown): void }
  openSystemBrowser(path: string): Promise<void>
  onLocalEvent(cb: (e: { event: string; data: unknown }) => void): void
  rendererReady(ready?: boolean): void
}

interface Window {
  /** web istemcisinde (tarayıcı) yok */
  gecko?: GeckoBridge
  /** yalnız masaüstü sunucu modunda */
  geckoDesktop?: GeckoDesktopBridge
  /** yalnız paketteki "sunucuya ulaşılamadı" sayfasında */
  geckoDesktopConnect?: { retry(): Promise<void>; local(): Promise<void> }
}
