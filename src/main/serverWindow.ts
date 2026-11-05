// Sunucu modu penceresi: sunucunun kendi web istemcisi ayrı kalıcı oturumda yüklenir (K1). Sunucudan gelen kod Electron içinde
// çalıştığı için: sandbox, kökene kilitli gezinme, varsayılan reddedilen izinler, dar köprü. `certificate-error` işleyicisi
// bilerek yok: Chromium reddeder, yükleme başarısız olur.
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { execFile } from 'child_process'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { isDangerousAttachment } from '../shared/attachmentSafety'
import { LOCAL_EVENTS, type ProbeResult } from '../shared/desktopMode'
import { t } from '../shared/i18n'
import { normalizeServerUrl, probeServer, readMode, updateMode } from './desktopMode'
import { openExternalHandler } from './externalLinks'
import { markUntrusted, safeSaveName } from './fileSafety'
import { devRendererUrl, windowChrome, type Os } from './os'

export const SERVER_PARTITION = 'persist:gecko-server'

/** macOS Touch ID passkey için keychain erişim grubu. Boş: kapalı. Developer ID sağlama profili gelmeden doldurulmaz,
 *  yetkisiz grup uygulamanın açılışta kapanmasına yol açabilir (sahibinin işleri). O zamana dek mac'te parola + TOTP */
export const KEYCHAIN_GROUP = ''

const os = process.platform as Os
const devRenderer = (): string | undefined => devRendererUrl({ packaged: app.isPackaged, url: process.env.ELECTRON_RENDERER_URL })
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])
/** ERR_ABORTED: yeni gezinme eskisini kesti, hata değil */
const ERR_ABORTED = -3
/** Chromium sertifika hataları -200…-299 */
const isCertError = (code: number): boolean => code <= -200 && code > -300

export function navigationAllowed(url: string, origin: string): boolean {
  try {
    const u = new URL(url)
    // blob: adresinde `URL.origin` kapsayan kökeni verir, şema ayrıca denetlenir
    return u.protocol === new URL(origin).protocol && u.origin === origin && !u.username && !u.password
  } catch {
    return false
  }
}

const sameOriginBlob = (url: string, origin: string): boolean => {
  try {
    const u = new URL(url)
    return u.protocol === 'blob:' && u.origin === origin
  } catch {
    return false
  }
}

/** Posta iframe'i `srcdoc` ile yazılır; alt çerçeve köke kilitli kalır. Preload almaz ama oltalama sayfası da açamaz */
export function subframeAllowed(url: string, origin: string): boolean {
  return url === 'about:srcdoc' || url === 'about:blank' || navigationAllowed(url, origin) || sameOriginBlob(url, origin)
}

/** Yönlendirme zincirinin hepsi: indirme kökten başlayıp başka yerden gelemez */
export function downloadAllowed(chain: string[], origin: string): boolean {
  return chain.length > 0 && chain.every((url) => navigationAllowed(url, origin) || sameOriginBlob(url, origin))
}

/** Bu sürede ikinci uyarı sorulmaz, indirme durur: düşman sayfa pencereyi modal döngüye sokamaz */
const WARN_GAP_MS = 5000

export interface DownloadDeps {
  origin: string
  os: Os
  /** Tehlikeli tür onayı: indirme kararı zaman uyumlu verilir */
  warn(name: string): boolean
  mark(path: string): Promise<void>
  now(): number
}

/** Yerel moddaki ek kapısının karşılığı: tehlikeli tür onayı, kaynak denetimi, karantina ya da Zone.Identifier */
export function handleDownload(e: { preventDefault(): void }, item: Electron.DownloadItem, d: DownloadDeps, gate: { lastWarn: number }): void {
  if (!downloadAllowed(item.getURLChain(), d.origin)) return e.preventDefault()
  const name = item.getFilename()
  if (isDangerousAttachment(name)) {
    if (d.now() - gate.lastWarn < WARN_GAP_MS) return e.preventDefault()
    gate.lastWarn = d.now()
    if (!d.warn(name)) return e.preventDefault()
  }
  item.setSaveDialogOptions({ defaultPath: safeSaveName(name, d.os) })
  item.once('done', (_e, state) => {
    if (state === 'completed') void d.mark(item.getSavePath())
  })
}

/** Sürerken gelen çağrı beklemeden yedek değeri alır: sayfa iletişim kutusu ya da yoklama yığamaz */
export function singleFlight<A extends unknown[], R>(fn: (...a: A) => Promise<R>, busy: R): (...a: A) => Promise<R> {
  let running = false
  return async (...a) => {
    if (running) return busy
    running = true
    try {
      return await fn(...a)
    } finally {
      running = false
    }
  }
}

export function permissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission)
}

/** Sayfa ya da bildirimden gelen yol: `//kotu.example` ve ters bölü kök dışına taşır */
export function safeServerPath(path: unknown, origin: string): string | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return null
  const full = `${origin}${path}`
  return navigationAllowed(full, origin) ? new URL(full).toString() : null
}

/** Tek hesapta sorulmaz. Dinleyici şarttır: yoksa Electron isteği iptal eder */
export async function pickWebauthnAccount(accounts: { credentialId: string; name?: string }[], choose: (names: string[]) => Promise<number>): Promise<string | undefined> {
  if (accounts.length <= 1) return accounts[0]?.credentialId
  return accounts[await choose(accounts.map((a) => a.name || a.credentialId))]?.credentialId
}

export function macWebAuthnOptions(platform: Os, group: string): Electron.ConfigureWebAuthnOptions | null {
  return platform === 'darwin' && group ? { touchID: { keychainAccessGroup: group } } : null
}

/** Windows'ta ek ayar gerekmez: Chromium webauthn.dll üzerinden Hello'yu kullanır */
export function configureMacWebAuthn(): void {
  const options = macWebAuthnOptions(os, KEYCHAIN_GROUP)
  if (options) app.configureWebAuthn(options)
}

let current: BrowserWindow | null = null
let serverOrigin: string | null = null
let hardened = false
let rendererReadyCb: (ready: boolean) => void = () => {}

export const serverWindow = (): BrowserWindow | null => current

/** Pencere ve duvar modu aynı kurallarla */
export function serverWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/server.js'),
    partition: SERVER_PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    devTools: !app.isPackaged,
    additionalArguments: devRenderer() ? [`--gecko-dev-renderer=${devRenderer()}`] : []
  }
}

/** Oturum başına bir kez */
function hardenSession(): void {
  if (hardened) return
  hardened = true
  const ses = session.fromPartition(SERVER_PARTITION)
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permissionAllowed(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => permissionAllowed(permission))
  ses.on('select-webauthn-account', (e, details, cb) => {
    e.preventDefault()
    const accounts = details.accounts.map((a) => ({ credentialId: a.credentialId, name: a.displayName ?? a.name }))
    let picked: string | undefined
    void pickWebauthnAccount(accounts, async (names) => {
      const opts: Electron.MessageBoxOptions = { type: 'question', buttons: [...names, t('main.common.cancel')], cancelId: names.length, message: t('main.server.pickPasskey') }
      return (await (current ? dialog.showMessageBox(current, opts) : dialog.showMessageBox(opts))).response
    }).then((id) => { picked = id }).finally(() => cb(picked))
  })
  const gate = { lastWarn: -Infinity }
  ses.on('will-download', (e, item) => {
    if (!serverOrigin) return e.preventDefault()
    handleDownload(e, item, {
      origin: serverOrigin, os, warn: warnDangerous, now: Date.now,
      mark: (path) => markUntrusted(path, os, { execFile, writeFile })
    }, gate)
  })
}

/** `will-download` kararı olay içinde verilmeli: zaman uyumlu tek modal, sıklığı `handleDownload` sınırlar */
function warnDangerous(name: string): boolean {
  const opts: Electron.MessageBoxSyncOptions = {
    type: 'warning', buttons: [t('main.common.cancel'), t('main.attach.saveAnyway')], defaultId: 0, cancelId: 0,
    message: t('main.attach.dangerousTitle', { name }), detail: t('main.attach.dangerousDetail')
  }
  return (current ? dialog.showMessageBoxSync(current, opts) : dialog.showMessageBoxSync(opts)) === 1
}

/** Yönlendirmeler `will-navigate`'ten geçmez */
export function lockNavigation(wc: Electron.WebContents, origin: string): void {
  const guard = (e: { preventDefault(): void; url: string }): void => {
    if (!navigationAllowed(e.url, origin)) e.preventDefault()
  }
  wc.on('will-navigate', guard)
  wc.on('will-redirect', guard)
  wc.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame && !subframeAllowed(e.url, origin)) e.preventDefault()
  })
  wc.on('will-attach-webview', (e) => e.preventDefault())
}

/** Paketteki sayfa: tekrar dene ya da yerele dön. Sunucu kökeninde değildir */
function loadUnreachablePage(w: BrowserWindow, code: number): void {
  const query = { mode: 'connect', ...(isCertError(code) ? { cert: '1' } : {}) }
  const dev = devRenderer()
  if (dev) void w.loadURL(`${dev}?${new URLSearchParams(query)}`)
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { query })
}

export function createServerWindow(o: { origin: string; path?: string }): BrowserWindow {
  hardenSession()
  serverOrigin = o.origin
  const w = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 600,
    title: 'GeckoMail',
    ...windowChrome(os, 'server'),
    backgroundColor: '#10140f',
    show: false,
    webPreferences: serverWebPreferences()
  })
  current = w
  w.once('ready-to-show', () => w.show())
  w.on('closed', () => {
    if (current === w) current = null
  })
  w.webContents.setWindowOpenHandler(openExternalHandler(() => current))
  lockNavigation(w.webContents, o.origin)
  w.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (isMainFrame && code !== ERR_ABORTED && navigationAllowed(url, o.origin)) loadUnreachablePage(w, code)
  })
  void w.loadURL(safeServerPath(o.path ?? '/', o.origin) ?? `${o.origin}/`)
  return w
}

/** Açık sunucu sayfasına yerel olay. Pencere bu olayları yalnız ana çerçevede, kökeni doğrulanmışken alır */
export function sendServerLocalEvent(event: (typeof LOCAL_EVENTS)[number], data: unknown): void {
  if (current && serverOrigin && navigationAllowed(current.webContents.getURL(), serverOrigin)) {
    current.webContents.send('gecko-desktop:local-event', { event, data })
  }
}

export function onServerRendererReady(cb: (ready: boolean) => void): void {
  rendererReadyCb = cb
}

/** IPC yalnız sunucu sayfasının ana çerçevesinden (iframe, duvar penceresi ya da gezinmiş sayfa değil) */
function fromServerPage(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame
  return !!frame && !!serverOrigin && e.sender === current?.webContents && frame === e.sender.mainFrame && navigationAllowed(frame.url, serverOrigin)
}

/** Paketteki bağlanamadı sayfası: kökeni sunucu değil, dosya ya da geliştirme sunucusu */
function fromUnreachablePage(e: Electron.IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame
  if (!frame || e.sender !== current?.webContents || frame !== e.sender.mainFrame) return false
  const dev = devRenderer()
  return frame.url.startsWith('file:') || (!!dev && frame.url.startsWith(dev))
}

/** Modu değiştirip yeniden başlatır. `--hidden` taşınmaz: kullanıcı pencereyi bekliyor */
export function relaunchInMode(patch: Parameters<typeof updateMode>[1]): void {
  updateMode(app.getPath('userData'), patch)
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') })
  app.quit()
}

/** Taşıma yapılmışsa kullanıcıya otomasyonun yerelde durduğu söylenir; vazgeçerse sunucu modunda kalır */
async function backToLocal(): Promise<void> {
  if (readMode(app.getPath('userData')).importedTo) {
    const opts: Electron.MessageBoxOptions = {
      type: 'warning', buttons: [t('main.common.cancel'), t('main.server.backToLocal')], defaultId: 0, cancelId: 0,
      message: t('main.migration.backTitle'), detail: t('main.migration.backDetail')
    }
    if ((await (current ? dialog.showMessageBox(current, opts) : dialog.showMessageBox(opts))).response !== 1) return
  }
  relaunchInMode({ mode: 'local' })
}

const fetchViaServerSession: typeof fetch = (input, init) => session.fromPartition(SERVER_PARTITION).fetch(input as string, init)

export async function probe(url: unknown): Promise<ProbeResult> {
  if (typeof url !== 'string') return { ok: false, reason: 'invalid' }
  const n = normalizeServerUrl(url)
  if (!n.ok) return n
  const r = await probeServer(n.origin, fetchViaServerSession)
  return r.ok ? { ok: true, origin: n.origin } : r
}

/** Yerel pencerede posta XSS'i uygulamayı saldırgan sunucusuna çeviremesin: köken main'in kendi iletişim kutusunda onaylanır */
async function confirmConnect(parent: BrowserWindow | null, origin: string): Promise<boolean> {
  const opts: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: [t('main.common.cancel'), t('main.server.connect')],
    defaultId: 0,
    cancelId: 0,
    message: t('main.server.confirmTitle'),
    detail: t('main.server.confirmDetail', { origin })
  }
  return (await (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts))).response === 1
}

/** Yerel moddaki giriş penceresi de sunucu sayfasıdır: yerel duvar panosunu açamaz, ona sahte görüntü veremez */
export const wallboardAllowed = (mode: 'local' | 'server', fromPage: boolean): boolean => fromPage && mode === 'server'

export function registerServerIpc(o: { fromLocalMain(e: Electron.IpcMainInvokeEvent): boolean; openWallboard(): void; pushWallboard(s: unknown): void; localWindow(): BrowserWindow | null }): void {
  const probeOnce = singleFlight(probe, { ok: false, reason: 'unreachable' } as ProbeResult)
  const connectOnce = singleFlight(async (url: unknown) => {
    const r = await probe(url)
    if (!r.ok || !(await confirmConnect(o.localWindow(), r.origin))) return
    relaunchInMode({ mode: 'server', serverOrigin: r.origin })
  }, undefined)
  ipcMain.handle('gecko:server-probe', (e, url: unknown): Promise<ProbeResult> | ProbeResult =>
    o.fromLocalMain(e) ? probeOnce(url) : { ok: false, reason: 'invalid' })
  ipcMain.handle('gecko:server-connect', (e, url: unknown) => (o.fromLocalMain(e) ? connectOnce(url) : undefined))
  ipcMain.handle('gecko-desktop:wallboard-open', (e) => {
    if (wallboardAllowed(readMode(app.getPath('userData')).mode, fromServerPage(e))) o.openWallboard()
  })
  ipcMain.on('gecko-desktop:wallboard-push', (e, snapshot: unknown) => {
    if (wallboardAllowed(readMode(app.getPath('userData')).mode, fromServerPage(e))) o.pushWallboard(snapshot)
  })
  ipcMain.handle('gecko-desktop:open-system-browser', async (e, path: unknown) => {
    if (!fromServerPage(e) || !serverOrigin) return
    const url = safeServerPath(path, serverOrigin)
    if (url) await shell.openExternal(url)
  })
  // eski sunucu arayüzü argümansız çağırır: yalnız açık `false` "oturum bitti" demektir
  ipcMain.on('gecko-desktop:renderer-ready', (e, ready: unknown) => {
    if (fromServerPage(e)) rendererReadyCb(ready !== false)
  })
  ipcMain.handle('gecko-desktop:connect-retry', (e) => {
    if (fromUnreachablePage(e) && current && serverOrigin) void current.loadURL(`${serverOrigin}/`)
  })
  ipcMain.handle('gecko-desktop:connect-local', (e) => {
    if (fromUnreachablePage(e)) return backToLocal()
  })
}

/** Oturum sunucuda kapatılır (ulaşılamıyorsa süresi dolar), sonra bu cihazdaki çerez ve önbellek silinir. Çerez değeri okunmaz */
export async function forgetServer(origin: string): Promise<void> {
  const ses = session.fromPartition(SERVER_PARTITION)
  try {
    await ses.fetch(`${origin}/api/logout`, {
      method: 'POST', credentials: 'include', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000)
    })
  } catch {
    /* yerel temizlik yine yapılır */
  }
  await ses.clearStorageData()
  await ses.clearCache()
}

/** Menü öğeleri main'dedir, sunucu arayüzüne bağlı değildir */
export function serverMenuItems(origin: string): Electron.MenuItemConstructorOptions[] {
  return [
    { label: t('main.server.backToLocal'), click: () => void backToLocal() },
    {
      label: t('main.server.forget'),
      click: () => {
        void (async () => {
          const opts: Electron.MessageBoxOptions = {
            type: 'warning', buttons: [t('main.common.cancel'), t('main.server.forgetConfirm')], defaultId: 0, cancelId: 0,
            message: t('main.server.forgetTitle'), detail: t('main.server.forgetDetail', { origin })
          }
          if ((await (current ? dialog.showMessageBox(current, opts) : dialog.showMessageBox(opts))).response !== 1) return
          await forgetServer(origin)
          relaunchInMode({ mode: 'local', serverOrigin: null })
        })()
      }
    }
  ]
}
