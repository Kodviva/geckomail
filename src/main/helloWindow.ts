// HelloGate'in Electron yüzü: görünür küçük pencere, tek kullanımlık yerel sunucu, `userData/hello.json`.
// Köken `http://localhost:<port>`: WebAuthn IP adresini RP ID kabul etmez. Yalnız win32'de çağrılır.
import { app, BrowserWindow } from 'electron'
import { randomBytes } from 'crypto'
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { join } from 'path'
import { dirOf, t } from '../shared/i18n'
import { HelloGate, type HelloCredential, type PageResult } from './helloGate'
import { mainWindow } from './windows'

const PARTITION = 'gecko-hello' // kalıcı değil; ana pencerenin izin işleyicisi ve çerezleriyle kesişmez

async function listenOnce(page: Buffer): Promise<{ url: string; close(): void }> {
  const path = `/${randomBytes(18).toString('base64url')}`
  let port = 0
  let served = false
  const server = createServer((req, res) => {
    // ilk GET dışında her şey 404: yerel başka süreç ya da yönlendirme ikinci kez alamaz
    if (served || req.method !== 'GET' || req.url !== path || req.headers.host !== `localhost:${port}`) {
      res.writeHead(404).end()
      return
    }
    served = true
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(page)
  })
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => done())
  })
  port = (server.address() as AddressInfo).port
  return {
    url: `http://localhost:${port}${path}`,
    close() {
      server.close()
      server.closeAllConnections()
    }
  }
}

function newWindow(show: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 240,
    show,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: 'GeckoMail',
    parent: (show && mainWindow()) || undefined,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: !app.isPackaged }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  return win
}

// gizli pencerede Hello diyaloğu öne gelmez: pencere görünür ve odaklıdır
function showPage(url: string): Promise<PageResult> {
  const win = newWindow(true)
  const closed = new Promise<PageResult>((done) => win.once('closed', () => done({ kind: 'cancel' })))
  const run = async (): Promise<PageResult> => {
    await win.loadURL(url)
    win.focus()
    return (await win.webContents.executeJavaScript('window.__hello')) as PageResult
  }
  return Promise.race([run().catch((): PageResult => ({ kind: 'cancel' })), closed]).finally(() => {
    if (!win.isDestroyed()) win.destroy()
  })
}

const PROBE_PAGE = Buffer.from('<!doctype html><meta charset="utf-8"><title>GeckoMail</title>')

/** Sınıf bilgisi yalnız güvenli kökende okunur; Hello kapalıysa düğme hiç görünmez */
async function probe(): Promise<boolean> {
  const server = await listenOnce(PROBE_PAGE)
  const win = newWindow(false)
  try {
    await win.loadURL(server.url)
    return (await win.webContents.executeJavaScript('PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()')) === true
  } finally {
    win.destroy()
    server.close()
  }
}

let probed: Promise<boolean> | null = null
export const helloProbe = (): Promise<boolean> => (probed ??= probe())

let gate: HelloGate | null = null
export function helloGate(): HelloGate {
  const file = (): string => join(app.getPath('userData'), 'hello.json')
  return (gate ??= new HelloGate({
    store: {
      read() {
        try {
          return JSON.parse(readFileSync(file(), 'utf8')) as HelloCredential
        } catch {
          return null
        }
      },
      write(c) {
        if (c) writeFileSync(file(), JSON.stringify(c))
        else rmSync(file(), { force: true })
      }
    },
    showPage,
    listen: listenOnce,
    text: () => ({ note: t('main.hello.enrollNote'), failed: t('main.hello.failed'), reenroll: t('main.hello.reenroll'), cancel: t('main.common.cancel') }),
    dir: () => dirOf()
  }))
}
