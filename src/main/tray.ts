// Arka plan ajanı: pencere kapanınca motor sürer, kullanıcı menü çubuğu ya da tepsiden ulaşır. Dock simgesi gizlenmez.
import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { readMode, updateMode } from './desktopMode'
import type { Os } from './os'

export interface AgentState { mode: 'local' | 'server'; link: 'online' | 'offline' | 'signedOut' | null; unread: number; updateReady: boolean }
export interface TrayHandlers { open(): void; installUpdate(): void; quit(): void }
type Label = (key: string, vars?: Record<string, string | number>) => string

function statusLine(s: AgentState, label: Label): string | null {
  if (s.mode === 'server') return s.link ? label(s.link) : null
  return s.unread > 0 ? label('unread', { count: s.unread }) : null
}

export function trayMenuTemplate(s: AgentState, label: Label, on: TrayHandlers): MenuItemConstructorOptions[] {
  const status = statusLine(s, label)
  return [
    ...(status ? [{ label: status, enabled: false }, { type: 'separator' as const }] : []),
    { label: label(s.link === 'signedOut' ? 'signIn' : 'open'), click: () => on.open() },
    ...(s.updateReady ? [{ label: label('update'), click: () => on.installUpdate() }] : []),
    { type: 'separator' },
    { label: label('quit'), click: () => on.quit() }
  ]
}

export function trayIconPath(os: Os, resources: string): string {
  return join(resources, os === 'darwin' ? 'trayTemplate.png' : 'tray.ico')
}

export function shouldHintOnClose(o: { os: Os; shown: boolean }): boolean {
  return o.os === 'win32' && !o.shown
}

let tray: Tray | null = null // modül düzeyinde: toplanırsa simge kaybolur
let state: AgentState = { mode: 'local', link: null, unread: 0, updateReady: false }
let render: () => void = () => {}

export function startTray(o: { os: Os; resources: string; state: AgentState; label: Label; on: TrayHandlers }): void {
  state = o.state
  const icon = nativeImage.createFromPath(trayIconPath(o.os, o.resources))
  if (o.os === 'darwin') icon.setTemplateImage(true) // açık ve koyu menü çubuğuna uyar
  tray = new Tray(icon)
  // macOS'ta menü tıklamada açılır; Windows'ta sol tık pencereyi açar
  if (o.os === 'win32') tray.on('click', () => o.on.open())
  render = () => {
    tray?.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(state, o.label, o.on)))
    const status = statusLine(state, o.label)
    tray?.setToolTip(status ? `GeckoMail · ${status}` : 'GeckoMail')
  }
  render()
}

export function setAgentState(patch: Partial<AgentState>): void {
  state = { ...state, ...patch }
  render()
}

/** Dil değişince */
export const refreshTray = (): void => render()

/** win32'de ilk kapatmada bir kez: uygulama kapanmadı, tepside sürüyor */
export function closeHintDue(os: Os, userData: string): boolean {
  if (!shouldHintOnClose({ os, shown: readMode(userData).closeHintShown })) return false
  updateMode(userData, { closeHintShown: true })
  return true
}
