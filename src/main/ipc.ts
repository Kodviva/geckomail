// Renderer'dan gelen IPC: dosya açma/kaydetme, yedek yolu seçimi, Touch ID, dil.
import { app, dialog, ipcMain, shell, systemPreferences } from 'electron'
import { execFile } from 'child_process'
import { writeFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import path, { basename, join } from 'path'
import { isDangerousAttachment } from '../shared/attachmentSafety'
import { isLocale, setLocale, t } from '../shared/i18n'
import { attachmentPathIn, markUntrusted, safeSaveName } from './fileSafety'
import { helloAvailable } from './helloGate'
import { helloGate, helloProbe } from './helloWindow'
import { saveLocale } from './locale'
import { applyLoginItem, loginItemQuery, loginItemSupport } from './loginItem'
import type { Os } from './os'
import { syncPost } from './syncProcess'
import { createWallboardWindow, mainWindow, pushWallboardSnapshot } from './windows'

const os = process.platform as Os
const loginSupport = () => loginItemSupport({ os, windowsStore: !!process.windowsStore, packaged: app.isPackaged })

/** Yalnız kullanıcı anahtarı değiştirince yazılır */
export function setLoginItem(enabled: boolean): boolean {
  return applyLoginItem((s) => app.setLoginItemSettings(s), loginSupport(), enabled, os)
}

export function loginItemState(): { support: ReturnType<typeof loginSupport>; enabled: boolean } {
  const support = loginSupport()
  return { support, enabled: support === 'native' && app.getLoginItemSettings(loginItemQuery(os)).openAtLogin }
}

const ATTACH_PREFIX = () => join(app.getPath('userData'), 'attachments')

// IPC yalnız ana pencereden: duvar penceresi (ya da ileride eklenecek başka bir webContents) dosya
// açma/kaydetme/Touch ID gibi yetenekleri çağıramasın
const fromMain = (e: Electron.IpcMainInvokeEvent): boolean => e.sender === mainWindow()?.webContents

const attachmentPath = (p: unknown): string | null => attachmentPathIn(p, ATTACH_PREFIX(), os, path)
const quarantine = (full: string): Promise<void> => markUntrusted(full, os, { execFile, writeFile })

export function registerIpc(o: { rebuildMenu(): void; rendererReady(ready: boolean): void }): void {
  ipcMain.on('gecko:renderer-ready', (e, ready: unknown) => {
    if (e.sender === mainWindow()?.webContents && typeof ready === 'boolean') o.rendererReady(ready)
  })
  ipcMain.handle('gecko:reveal', async (e, path: string) => {
    if (!fromMain(e)) return
    const full = attachmentPath(path)
    if (!full) return
    await quarantine(full) // dosya yöneticisinden çift tıklansa da işletim sistemi denetlesin
    shell.showItemInFolder(full)
  })
  // OAuth: yalnız bilinen sağlayıcıların giriş sayfası sistem tarayıcısında açılır (renderer rastgele URL açtıramaz)
  const OAUTH_HOSTS = new Set(['accounts.google.com', 'login.microsoftonline.com'])
  ipcMain.handle('gecko:open-oauth', async (e, url: string) => {
    if (!fromMain(e)) return false
    try {
      const u = new URL(String(url))
      if (u.protocol !== 'https:' || !OAUTH_HOSTS.has(u.hostname)) return false
      await shell.openExternal(u.toString())
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle('gecko:open', async (e, path: string, displayName?: string) => {
    if (!fromMain(e)) return
    const full = attachmentPath(path)
    if (!full) return
    await quarantine(full)
    // diskteki ad içerik özetidir; tür için mailde görünen adı esas al (fatura.pdf.command gibi)
    const shown = typeof displayName === 'string' && displayName ? displayName : basename(full)
    if (isDangerousAttachment(shown) || isDangerousAttachment(full)) {
      const opts: Electron.MessageBoxOptions = {
        type: 'warning',
        buttons: [t(os === 'win32' ? 'main.attach.showInExplorer' : 'main.attach.showInFinder'), t('main.common.cancel'), t('main.common.openAnyway')],
        defaultId: 1,
        cancelId: 1,
        message: t('main.attach.dangerousTitle', { name: shown }),
        detail: t('main.attach.dangerousDetail')
      }
      const win = mainWindow()
      const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (response === 0) return shell.showItemInFolder(full)
      if (response !== 2) return
    }
    await shell.openPath(full)
  })
  ipcMain.handle('gecko:save-file-as', async (e, suggestedName: string, data: Uint8Array) => {
    if (!fromMain(e)) return false
    const win = mainWindow()
    if (typeof suggestedName !== 'string' || !(data instanceof Uint8Array) || !win) return false
    // filtre dosya türüne göre (önceden DB yedeği de .eml filtresiyle kaydediliyordu); tür beyaz listede
    const ext = suggestedName.split('.').pop()?.toLowerCase() ?? ''
    const FILTERS: Record<string, string> = { eml: t('main.filter.eml'), sqlite: t('main.filter.sqlite'), json: t('main.filter.diagnostics') }
    if (!FILTERS[ext]) return false
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: safeSaveName(suggestedName, os),
      filters: [{ name: FILTERS[ext], extensions: [ext] }]
    })
    if (canceled || !filePath) return false
    writeFileSync(filePath, Buffer.from(data))
    return true
  })
  // yedek/geri yükleme (R18): yolu main seçer, sync doğrudan dosyaya yazar/okur
  ipcMain.handle('gecko:choose-backup-save', async (e, suggestedName: string, encrypted: boolean) => {
    const win = mainWindow()
    if (!fromMain(e) || !win || typeof suggestedName !== 'string') return null
    const ext = encrypted ? 'geckobak' : 'sqlite'
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: suggestedName.replace(/\.(sqlite|geckobak)$/i, '') + '.' + ext,
      filters: [{ name: encrypted ? t('main.filter.backupEncrypted') : t('main.filter.backup'), extensions: [ext] }]
    })
    return canceled || !filePath ? null : filePath
  })
  ipcMain.handle('gecko:choose-backup-open', async (e) => {
    const win = mainWindow()
    if (!fromMain(e) || !win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: t('main.filter.backup'), extensions: ['sqlite', 'geckobak'] }]
    })
    return canceled || !filePaths[0] ? null : filePaths[0]
  })
  ipcMain.handle('gecko:relaunch', (e) => {
    if (!fromMain(e)) return
    app.relaunch()
    app.quit()
  })
  ipcMain.handle('gecko:touch-id-available', (e) => {
    if (!fromMain(e)) return false
    if (os === 'win32') return helloAvailable(os, helloProbe)
    try {
      return systemPreferences.canPromptTouchID()
    } catch {
      return false
    }
  })
  ipcMain.handle('gecko:prompt-touch-id', async (e, reason: string) => {
    if (!fromMain(e)) return false
    if (os === 'win32') return helloGate().prompt(typeof reason === 'string' ? reason : t('main.touchId.unlockVault'))
    try {
      await systemPreferences.promptTouchID(typeof reason === 'string' ? reason : t('main.touchId.unlockVault'))
      return true
    } catch {
      return false // iptal / başarısız
    }
  })
  ipcMain.handle('gecko:login-item-get', (e) => (fromMain(e) ? loginItemState() : null))
  ipcMain.handle('gecko:login-item-set', (e, enabled: unknown) => fromMain(e) && typeof enabled === 'boolean' && setLoginItem(enabled))
  ipcMain.handle('gecko:open-wallboard', (e) => (fromMain(e) ? createWallboardWindow() : undefined))
  ipcMain.on('gecko:set-locale', (e, locale: unknown) => {
    if (!fromMain(e) || !isLocale(locale)) return
    setLocale(locale)
    saveLocale(locale)
    o.rebuildMenu()
    syncPost({ type: 'locale', locale })
  })
  ipcMain.on('gecko:wallboard-push', (e, snapshot) => {
    // sadece ana pencereden kabul edilir — duvar penceresinin kendisi asla veri basmaz
    if (e.sender !== mainWindow()?.webContents) return
    pushWallboardSnapshot(snapshot)
  })
  ipcMain.handle('gecko:trash-file', async (e, path: string) => {
    if (!fromMain(e)) return false
    // yalnızca içe aktarma kaynak dosyaları: düz metin şifre içeren dosyayı çöpe taşı (geri alınabilir)
    if (typeof path !== 'string' || !/\.(mobileconfig|csv)$/i.test(path)) return false
    try {
      await shell.trashItem(path)
      return true
    } catch {
      return false
    }
  })
}
