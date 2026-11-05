// Ana pencere ve Duvar Modu penceresi. Pencere durumu bu modülde tutulur, diğer modüller `mainWindow()` ile okur.
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { t } from '../shared/i18n'
import { openExternalHandler } from './externalLinks'
import { localeArgs } from './locale'
import { devRendererUrl, windowChrome, type Os } from './os'
import { deepLinkPath, OpenQueue, trackNavigation, type OpenLink } from './openQueue'
import { createServerWindow, lockNavigation, onServerRendererReady, sendServerLocalEvent, serverWebPreferences, serverWindow } from './serverWindow'

const os = process.platform as Os
const devRenderer = (): string | undefined => devRendererUrl({ packaged: app.isPackaged, url: process.env.ELECTRON_RENDERER_URL })

let win: BrowserWindow | null = null
let wallboardWin: BrowserWindow | null = null
let lastWallboardSnapshot: unknown = null
let mainLoaded: () => void = () => {}
let serverOrigin: string | null = null
let windowClosed: () => void = () => {}
const links = new OpenQueue()

/** Ana pencere kapandı: motor sürer, renderer belleği bırakılır */
export function onMainWindowClosed(cb: () => void): void {
  windowClosed = cb
}

/** Yerel mod penceresi. Sunucu penceresi bilerek burada değil: `fromMain` yerel IPC yetkilerini ona vermez */
export const mainWindow = (): BrowserWindow | null => win

/** Moddan bağımsız görünen pencere */
export const activeWindow = (): BrowserWindow | null => win ?? serverWindow()

/** Sunucu modu: bundan sonra pencere sunucunun web istemcisini açar */
export function useServerOrigin(origin: string): void {
  serverOrigin = origin
}

/** Ana pencere her yüklendiğinde (index.ts sync kanalını buraya bağlar) */
export function onMainWindowLoaded(cb: () => void): void {
  mainLoaded = cb
}

/** Sayfa yeniden yüklenirse hazır bilgisi geçersizdir; pencere kapanınca bekleyen de düşer */
function trackLinks(w: BrowserWindow): void {
  trackNavigation(w.webContents, links)
  w.on('closed', () => links.reset())
}

function sendLink({ messageId, accountId, reply }: OpenLink): void {
  if (serverOrigin) {
    const event = reply ? 'local:open-reply' : messageId != null ? 'local:open-message' : 'local:open-account'
    return sendServerLocalEvent(event, { messageId, accountId })
  }
  if (reply) win?.webContents.send('gecko-open-reply', messageId, accountId)
  else if (messageId != null) win?.webContents.send('gecko-open-message', messageId, accountId ?? undefined)
  else if (accountId != null) win?.webContents.send('open-account', accountId)
}

/** Renderer'da kullanıcı oturumu açıldı (true) ya da kapandı (false) */
export function markRendererReady(ready: boolean): void {
  if (ready) links.ready(sendLink)
  else links.reset()
}

/** Bildirim tıklaması: pencere öne gelir, ileti giriş tamamlanınca açılır */
export function openLink(l: OpenLink): void {
  const empty = l.messageId == null && l.accountId == null
  if (serverOrigin && !serverWindow()) {
    // sunucu sayfası doğrudan iletiyle açılır: bağlantı girişten sonra da geçerli kalır (web derin bağlantısı)
    const path = deepLinkPath(l)
    if (path) return createWindow(path)
  }
  showMainWindow()
  if (!empty) links.push(l)
}

export function createWindow(path?: string): void {
  if (serverOrigin) {
    const w = createServerWindow({ origin: serverOrigin, path })
    trackLinks(w)
    onServerRendererReady(markRendererReady)
    w.on('closed', () => windowClosed())
    return
  }
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 600,
    title: 'GeckoMail',
    ...windowChrome(os, 'local'),
    backgroundColor: '#10140f', // açılış/kapanışta OS beyaz flash'ını engeller (koyu tema zemini)
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged, // production'da geliştirici araçları kapalı
      additionalArguments: localeArgs()
    }
  })
  trackLinks(win)
  win.once('ready-to-show', () => win?.show())

  // Mail içindeki linkler
  win.webContents.setWindowOpenHandler(openExternalHandler(() => win))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

  win.webContents.on('did-finish-load', () => mainLoaded())
  win.on('closed', () => {
    win = null
    windowClosed()
  })

  const dev = devRenderer()
  if (dev) {
    void win.loadURL(dev)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Pencereyi öne getirir, yoksa oluşturur */
export function showMainWindow(): void {
  const w = activeWindow()
  if (!w) return createWindow()
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

export function sendMenu(action: 'settings' | 'accounts'): void {
  showMainWindow()
  win?.webContents.send('gecko:menu', action)
  sendServerLocalEvent('local:menu', { action })
}

// Duvar Modu: kendi RPC/oturum kanalı yok — sadece ana pencerenin zaten çektiği veriyi
// (gecko:wallboard-push ile) yansıtır. Session mimarisine (tek aktif port) dokunmaz.
export function createWallboardWindow(): void {
  if (wallboardWin) {
    wallboardWin.show()
    wallboardWin.focus()
    return
  }
  wallboardWin = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 700,
    minHeight: 480,
    title: t('main.wallboard.title'),
    ...windowChrome(os, serverOrigin ? 'server' : 'local'),
    backgroundColor: '#10140f', // duvar penceresi kapanırken beyaz flash olmasın
    show: false,
    webPreferences: serverOrigin ? serverWebPreferences() : {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
      additionalArguments: localeArgs()
    }
  })
  wallboardWin.once('ready-to-show', () => wallboardWin?.show())
  wallboardWin.webContents.on('did-finish-load', () => {
    if (lastWallboardSnapshot) wallboardWin?.webContents.send('gecko:wallboard-data', lastWallboardSnapshot)
  })
  wallboardWin.on('closed', () => {
    wallboardWin = null
  })
  wallboardWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (serverOrigin) {
    // oturum ana pencereyle ortak: izinleri orada kuruludur
    lockNavigation(wallboardWin.webContents, serverOrigin)
    void wallboardWin.loadURL(`${serverOrigin}/?mode=wallboard`)
    return
  }
  wallboardWin.webContents.on('will-navigate', (e) => e.preventDefault())
  wallboardWin.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

  const dev = devRenderer()
  if (dev) {
    void wallboardWin.loadURL(`${dev}?mode=wallboard`)
  } else {
    void wallboardWin.loadFile(join(__dirname, '../renderer/index.html'), { query: { mode: 'wallboard' } })
  }
}

export function pushWallboardSnapshot(snapshot: unknown): void {
  lastWallboardSnapshot = snapshot
  wallboardWin?.webContents.send('gecko:wallboard-data', snapshot)
}
