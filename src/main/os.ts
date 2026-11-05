// Platforma göre dallanan saf kararlar. electron içe aktarılmaz: Windows dalları bu Mac'te birim testiyle kanıtlanır,
// process.platform yalnız bağlama noktasında (index.ts, syncProcess.ts, windows.ts) okunur.
export type Os = 'darwin' | 'win32' | 'linux'

/** Toast etkinleştiricisi: `app.setToastActivatorCLSID` ve paket bildirimleri aynı değeri kullanır, değiştirilmez */
export const TOAST_CLSID = 'ff1728f5-d1ec-4a05-b772-8ba5be532f92'

/** styles.css `--h-titlebar` ile aynı */
const TITLEBAR_HEIGHT = 38

/** Sunucu modunda web arayüzü yüklenir: orada `.dragbar` yok, yerel çerçeve gerekir */
export function windowChrome(os: Os, mode: 'local' | 'server'): {
  titleBarStyle?: 'hiddenInset' | 'hidden'
  titleBarOverlay?: { color: string; symbolColor: string; height: number }
  autoHideMenuBar?: boolean
} {
  if (os === 'darwin') return mode === 'local' ? { titleBarStyle: 'hiddenInset' } : {}
  if (os !== 'win32') return {}
  if (mode === 'server') return { autoHideMenuBar: true }
  // saydam katman: düğmeler açık ve koyu temada zemin rengini alır; simge rengi ikisinde de okunur
  return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#8a9385', height: TITLEBAR_HEIGHT }, autoHideMenuBar: true }
}

/** Store paketinde kimliği paket verir, elle atanırsa bildirimler pakete bağlanmaz */
export function appUserModelId(o: { os: Os; windowsStore: boolean; appId: string }): string | null {
  return o.os === 'win32' && !o.windowsStore ? o.appId : null
}

/** Store güncellemeyi kendisi yapar */
export function autoUpdateAllowed(o: { os: Os; packaged: boolean; windowsStore: boolean }): boolean {
  return o.packaged && !(o.os === 'win32' && o.windowsStore)
}

/** Windows'ta DPAPI yoksa parola düz yazılmaz: `crypto:err` döner */
export function encryptionPolicy(os: Os, available: boolean): 'encrypt' | 'plain' | 'refuse' {
  if (available) return 'encrypt'
  return os === 'win32' ? 'refuse' : 'plain'
}

/** Paketli uygulama ortam değişkeniyle başka sayfa yüklemez */
export function devRendererUrl(o: { packaged: boolean; url: string | undefined }): string | undefined {
  return o.packaged ? undefined : o.url
}
