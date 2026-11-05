// Bildirimi ve rozeti gösterme kararları. Aynı `server:notify` hem pencereye hem ajana gider: yalnız ajan gösterir.
import { app, nativeImage, type BrowserWindow } from 'electron'
import type { NotifyLevel } from '../shared/notifyRules'
import type { Os } from './os'
import { setAgentState } from './tray'

/** Pencere odaktaysa kullanıcı zaten görüyor; acil yine gösterilir */
export function shouldShow(o: { focused: boolean; level: NotifyLevel }): boolean {
  return !o.focused || o.level === 'urgent'
}

/** Oturum bitince ajan susmaz ama giriş ekranı zaten görünüyorsa konuşmaz: kendi çıkışı ya da açılışta pencereyle gelen giriş */
export function shouldTellSignedOut(o: { focused: boolean; everOnline: boolean; hasWindow: boolean }): boolean {
  return !o.focused && (o.everOnline || !o.hasWindow)
}

/** mac Dock sayısı; Windows görev çubuğu işareti (yalnız pencere varken) ve tepsi ipucu. `overlay`: küçük simge dosyası */
export function presentBadge(o: { os: Os; count: number; window: BrowserWindow | null; overlay: string | null; label: string }): void {
  if (o.os === 'win32') {
    if (o.window && o.overlay) o.window.setOverlayIcon(o.count > 0 ? nativeImage.createFromPath(o.overlay) : null, o.count > 0 ? o.label : '')
  } else {
    app.setBadgeCount(o.count)
  }
  setAgentState({ unread: o.count })
}
