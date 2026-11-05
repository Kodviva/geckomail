// Oturum açılışında başlatma. Varsayılan kapalıdır, yalnız kullanıcı anahtarı değiştirince yazılır. electron içe aktarılmaz.
import type { Os } from './os'

export type LoginItemSupport = 'native' | 'storeSettings' | 'none'

const HIDDEN_ARG = '--hidden'

/** Store paketi kendi başına kaydolamaz: Windows Başlangıç ayarına yönlendirilir. Paketsizde Electron ikilisi kaydolurdu */
export function loginItemSupport(o: { os: Os; windowsStore: boolean; packaged: boolean }): LoginItemSupport {
  if (!o.packaged || o.os === 'linux') return 'none'
  return o.os === 'win32' && o.windowsStore ? 'storeSettings' : 'native'
}

export function loginItemSettings(enabled: boolean, os: Os): Electron.Settings {
  return os === 'win32' ? { openAtLogin: enabled, args: [HIDDEN_ARG] } : { openAtLogin: enabled }
}

/** Windows kaydı argümanla eşleştirir: aynı argümanla sorulmazsa kapalı görünür */
export function loginItemQuery(os: Os): Electron.LoginItemSettingsOptions | undefined {
  return os === 'win32' ? { args: [HIDDEN_ARG] } : undefined
}

/** Yalnız `native`'de yazılır; true: yazıldı */
export function applyLoginItem(set: (s: Electron.Settings) => void, support: LoginItemSupport, enabled: boolean, os: Os): boolean {
  if (support !== 'native') return false
  set(loginItemSettings(enabled, os))
  return true
}

export function startedHidden(o: { os: Os; argv: string[]; wasOpenedAtLogin: boolean }): boolean {
  return o.os === 'win32' ? o.argv.includes(HIDDEN_ARG) : o.os === 'darwin' && o.wasOpenedAtLogin
}
