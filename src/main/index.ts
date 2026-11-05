import '../shared/i18n/locales/all' // main: tüm diller eşzamanlı (menü, iletişim kutuları)
import { setUiOs, t } from '../shared/i18n'
import { uiOsOf } from '../shared/platformText'
import { app, BrowserWindow, Menu, Notification, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { createLogger, mirrorConsole, type JsonlLogger } from '../shared/jsonlLog'
import { loginItemState, registerIpc, setLoginItem } from './ipc'
import { loadLocale } from './locale'
import { readMode, startForMode, type DesktopModeFile } from './desktopMode'
import { startedHidden } from './loginItem'
import { menuTemplate } from './menu'
import { registerMigrationIpc } from './migrationFlow'
import { appUserModelId, autoUpdateAllowed, TOAST_CLSID, type Os } from './os'
import { configureNotifications, startToastActivation } from './notifications'
import { execServerAction, resourcesDir, startServerAgent } from './serverAgent'
import { configureMacWebAuthn, registerServerIpc, serverMenuItems } from './serverWindow'
import { applyPendingRestore, bridgeSystemSignals, execLocalAction, isQuitting, markQuitting, plumbPorts, setBadgeOverlay, setSyncLog, spawnSync, stopSync } from './syncProcess'
import { closeHintDue, refreshTray, setAgentState, startTray, trayIconPath } from './tray'
import { activeWindow, createWallboardWindow, createWindow, mainWindow, markRendererReady, onMainWindowClosed, onMainWindowLoaded, pushWallboardSnapshot, sendMenu, showMainWindow, useServerOrigin } from './windows'

const APP_ID = 'com.kodviva.geckomail'
const os = process.platform as Os
let desktopMode: DesktopModeFile | null = null
setUiOs(uiOsOf(os))

// Keychain (safeStorage) servis adı ve userData yolu dev/paketli arasında aynı kalsın
app.setName('GeckoMail')

// production: ayrıntılı logları sustur (warn/error kalır — çökme teşhisi için)
if (app.isPackaged) {
  console.log = console.info = console.debug = () => {}
}

// Otomatik güncelleme (yalnız paketli): açılışta + 6 saatte bir denetle; indirilince yeniden-başlat sor.
// Güncelleme kaynağı package.json build.publish (GitHub releases deposu) — imzalı zip + latest-mac.yml.
function installUpdate(): void {
  markQuitting()
  autoUpdater.quitAndInstall()
}

function setupAutoUpdate(): void {
  if (!autoUpdateAllowed({ os, packaged: app.isPackaged, windowsStore: !!process.windowsStore })) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => {
    setAgentState({ updateReady: true }) // tepside yaşayan uygulama hiç kapanmayabilir: öğe pencere olmadan da görünür
    const target = activeWindow() ?? BrowserWindow.getAllWindows()[0]
    const choice = target
      ? dialog.showMessageBoxSync(target, {
          type: 'info',
          buttons: [t('main.update.restartNow'), t('main.update.later')],
          defaultId: 0,
          cancelId: 1,
          message: t('main.update.readyTitle'),
          detail: t('main.update.readyDetail', { version: info.version })
        })
      : 1
    if (choice === 0) installUpdate()
  })
  autoUpdater.on('error', (e) => console.error('auto-update:', (e as Error)?.message ?? e))
  void autoUpdater.checkForUpdates().catch(() => {})
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => {}), 6 * 3600_000)
}

// Dil değişince yeniden kurulur
function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate({
        os,
        packaged: app.isPackaged,
        appName: app.name,
        label: (key) => t(`main.menu.${key}`, { app: app.name }),
        on: { settings: () => sendMenu('settings'), accounts: () => sendMenu('accounts') },
        extra: desktopMode?.serverOrigin && desktopMode.mode === 'server' ? [...serverMenuItems(desktopMode.serverOrigin), ...loginMenuItem()] : []
      })
    )
  )
  refreshTray()
}

/** Sunucu arayüzünde ayar köprüsü yok: anahtar menüde */
function loginMenuItem(): Electron.MenuItemConstructorOptions[] {
  const { support, enabled } = loginItemState()
  if (support !== 'native') return []
  return [{ label: t('main.tray.loginItem'), type: 'checkbox', checked: enabled, click: (i) => void setLoginItem(i.checked) }]
}

function startAgent(mode: DesktopModeFile, log: JsonlLogger): void {
  const userData = app.getPath('userData')
  configureNotifications({
    os,
    exec: mode.mode === 'server' ? execServerAction : execLocalAction,
    onFailed: (error) => log.warn('bildirim gösterilemedi', { error })
  })
  if (os === 'win32') {
    app.setToastActivatorCLSID(TOAST_CLSID)
    startToastActivation()
  }
  setBadgeOverlay(trayIconPath('win32', resourcesDir()))
  startTray({
    os,
    resources: resourcesDir(),
    state: { mode: mode.mode, link: null, unread: 0, updateReady: false },
    label: (key, vars) => t(`main.tray.${key}`, vars),
    on: { open: showMainWindow, installUpdate, quit: () => { markQuitting(); app.quit() } }
  })
  onMainWindowClosed(() => {
    if (!isQuitting() && closeHintDue(os, userData)) new Notification({ title: t('main.tray.hintTitle'), body: t('main.tray.hintBody') }).show()
  })
}

function start(): void {
  // ikinci açılış: yeni süreç kapanır, var olan pencere öne gelir
  app.on('second-instance', () => {
    if (app.isReady()) showMainWindow()
  })

  app.whenReady().then(() => {
    loadLocale()
    const mainLog = createLogger(join(app.getPath('userData'), 'logs'), 'main')
    setSyncLog(mainLog)
    mirrorConsole(mainLog)
    mainLog.info('uygulama başladı', { version: app.getVersion(), electron: process.versions.electron, os: process.getSystemVersion(), packaged: app.isPackaged })
    app.on('render-process-gone', (_e, _wc, d) => mainLog.error('renderer süreci kayboldu', { reason: d.reason, exitCode: d.exitCode }))
    app.on('child-process-gone', (_e, d) => mainLog.error('alt süreç kayboldu', { type: d.type, reason: d.reason, exitCode: d.exitCode, name: d.name }))
    // dev'de de kendi ikonumuz görünsün (paketli sürüm icns'i otomatik kullanır)
    if (!app.isPackaged) {
      try {
        app.dock?.setIcon(join(__dirname, '../../build/icon_1024.png'))
      } catch {
        /* ikon yoksa varsayılan kalır */
      }
    }
    const aumid = appUserModelId({ os, windowsStore: !!process.windowsStore, appId: APP_ID })
    if (aumid) app.setAppUserModelId(aumid)
    configureMacWebAuthn()
    // kaynak kimliği kalıcı olmalı (ajan cihazı); sunucu modunda dosya zaten yazılmıştır, yerelde yazılmaz
    desktopMode = readMode(app.getPath('userData'))
    if (desktopMode.mode === 'server' && desktopMode.serverOrigin) useServerOrigin(desktopMode.serverOrigin)
    buildMenu()
    registerIpc({ rebuildMenu: buildMenu, rendererReady: markRendererReady })
    registerServerIpc({
      fromLocalMain: (e) => !!mainWindow() && e.sender === mainWindow()?.webContents,
      localWindow: mainWindow,
      openWallboard: createWallboardWindow,
      pushWallboard: pushWallboardSnapshot
    })
    registerMigrationIpc({ fromLocalMain: (e) => !!mainWindow() && e.sender === mainWindow()?.webContents, localWindow: mainWindow })
    onMainWindowLoaded(plumbPorts)

    startAgent(desktopMode, mainLog)
    const hidden = startedHidden({ os, argv: process.argv, wasOpenedAtLogin: os === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin })
    startForMode(desktopMode, { hidden }, {
      restore: applyPendingRestore, spawnSync, localWindow: createWindow, bridge: bridgeSystemSignals, serverWindow: createWindow,
      serverAgent: (origin) => startServerAgent({ origin, os, deviceId: desktopMode!.sourceId, resources: resourcesDir() })
    })

    setupAutoUpdate()

    app.on('activate', () => {
      if (!activeWindow()) createWindow()
    })
  })

  app.on('before-quit', () => stopSync())

  app.on('window-all-closed', () => {
    // pencere kapansa da senkron arka planda sürer; Cmd+Q gerçekten kapatır (before-quit)
  })
}

// aynı DB'ye iki sync motoru yazmasın (dev + kurulu uygulama çakışması)
if (app.requestSingleInstanceLock()) start()
else app.quit()
