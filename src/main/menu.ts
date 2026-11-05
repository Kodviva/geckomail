// Uygulama menüsü. Paketli sürümde yeniden yükle / geliştirici araçları öğeleri yok (native uygulama gibi).
// Rol öğeleri kendi davranışını korur ama etiketleri uygulamanın dilinden gelir: macOS'un hazır başlıkları
// sistem dilini izler, arayüz başka dildeyken menü karışık görünmesin.
import type { MenuItemConstructorOptions } from 'electron'
import type { Os } from './os'

export interface MenuHandlers {
  settings(): void
  accounts(): void
}

/** `extra`: sunucu modunda uygulama menüsüne eklenen öğeler; yerel modda menü aynen kalır */
export function menuTemplate(o: { os: Os; packaged: boolean; appName: string; label: (key: string) => string; on: MenuHandlers; extra?: MenuItemConstructorOptions[] }): MenuItemConstructorOptions[] {
  const { label: L, on } = o
  const mac = o.os === 'darwin'
  const r = (role: MenuItemConstructorOptions['role'], key: string): MenuItemConstructorOptions => ({ role, label: L(key) })
  const sep: MenuItemConstructorOptions = { type: 'separator' }
  const macOnly = (...items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] => (mac ? items : [])
  return [
    {
      // standart appMenu + Ayarlar/Hesaplar (macOS'ta ayarların beklenen yeri ⌘,)
      label: o.appName,
      submenu: [
        r('about', 'about'),
        sep,
        { label: L('settings'), accelerator: 'CmdOrCtrl+,', click: () => on.settings() },
        { label: L('accounts'), accelerator: 'CmdOrCtrl+Shift+,', click: () => on.accounts() },
        sep,
        ...(o.extra?.length ? [...o.extra, sep] : []),
        ...macOnly(r('services', 'services'), sep, r('hide', 'hide'), r('hideOthers', 'hideOthers'), r('unhide', 'showAll'), sep),
        r('quit', 'quit')
      ]
    },
    {
      label: L('edit'),
      submenu: [
        r('undo', 'undo'),
        r('redo', 'redo'),
        sep,
        r('cut', 'cut'),
        r('copy', 'copy'),
        r('paste', 'paste'),
        r('pasteAndMatchStyle', 'pasteMatch'),
        r('delete', 'delete'),
        r('selectAll', 'selectAll')
      ]
    },
    {
      label: L('view'),
      submenu: [
        ...(o.packaged ? [] : [r('reload', 'reload'), r('forceReload', 'forceReload'), r('toggleDevTools', 'devTools'), sep]),
        r('resetZoom', 'actualSize'),
        r('zoomIn', 'zoomIn'),
        r('zoomOut', 'zoomOut'),
        sep,
        r('togglefullscreen', 'fullScreen')
      ]
    },
    // role 'window': macOS açık pencere listesini bu menüye kendisi ekler
    mac
      ? { label: L('window'), role: 'window', submenu: [r('minimize', 'minimize'), r('zoom', 'zoom'), sep, r('front', 'front')] }
      : { label: L('window'), submenu: [r('minimize', 'minimize')] }
  ]
}
