import { contextBridge, ipcRenderer, webUtils } from 'electron'

// Sync sürecinin MessagePort'unu sayfa dünyasına aktar
ipcRenderer.on('sync-port', (e) => {
  window.postMessage({ type: 'gecko-sync-port' }, '*', e.ports)
})

ipcRenderer.on('sync-restarted', () => {
  window.postMessage({ type: 'gecko-sync-restarted' }, '*')
})

ipcRenderer.on('open-account', (_e, accountId: number) => {
  window.postMessage({ type: 'gecko-open-account', accountId }, '*')
})

ipcRenderer.on('gecko-open-message', (_e, messageId: number, accountId?: number) => {
  window.postMessage({ type: 'gecko-open-message', messageId, accountId }, '*')
})

ipcRenderer.on('gecko-open-reply', (_e, messageId: number, accountId?: number) => {
  window.postMessage({ type: 'gecko-open-reply', messageId, accountId }, '*')
})

// uygulama menüsü (Ayarlar… ⌘, / Hesaplar…) → renderer
ipcRenderer.on('gecko:menu', (_e, action: string) => {
  window.postMessage({ type: 'gecko-menu', action }, '*')
})

ipcRenderer.on('gecko:wallboard-data', (_e, data) => {
  window.postMessage({ type: 'gecko-wallboard-data', data }, '*')
})

// main'in kayıtlı dil seçimi (varsa): renderer yerel deposu boşsa buna düşer
const savedLocale = process.argv.find((a) => a.startsWith('--gecko-locale='))?.slice('--gecko-locale='.length) ?? null

contextBridge.exposeInMainWorld('gecko', {
  savedLocale,
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('gecko:reveal', path),
  openPath: (path: string, displayName?: string): Promise<void> => ipcRenderer.invoke('gecko:open', path, displayName),
  openOAuthUrl: (url: string): Promise<boolean> => ipcRenderer.invoke('gecko:open-oauth', url),
  setLocale: (locale: string): void => ipcRenderer.send('gecko:set-locale', locale),
  getFilePath: (file: File): string => webUtils.getPathForFile(file),
  trashFile: (path: string): Promise<boolean> => ipcRenderer.invoke('gecko:trash-file', path),
  saveFileAs: (suggestedName: string, data: Uint8Array): Promise<boolean> =>
    ipcRenderer.invoke('gecko:save-file-as', suggestedName, data),
  openWallboard: (): Promise<void> => ipcRenderer.invoke('gecko:open-wallboard'),
  wallboardPush: (snapshot: unknown): void => ipcRenderer.send('gecko:wallboard-push', snapshot),
  touchIdAvailable: (): Promise<boolean> => ipcRenderer.invoke('gecko:touch-id-available'),
  promptTouchId: (reason: string): Promise<boolean> => ipcRenderer.invoke('gecko:prompt-touch-id', reason),
  chooseBackupSave: (suggestedName: string, encrypted: boolean): Promise<string | null> =>
    ipcRenderer.invoke('gecko:choose-backup-save', suggestedName, encrypted),
  chooseBackupOpen: (): Promise<string | null> => ipcRenderer.invoke('gecko:choose-backup-open'),
  relaunch: (): Promise<void> => ipcRenderer.invoke('gecko:relaunch'),
  rendererReady: (ready: boolean): void => ipcRenderer.send('gecko:renderer-ready', ready),
  loginItem: {
    get: () => ipcRenderer.invoke('gecko:login-item-get'),
    set: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('gecko:login-item-set', enabled)
  },
  migration: {
    start: (url: string) => ipcRenderer.invoke('gecko:migration-start', url),
    state: () => ipcRenderer.invoke('gecko:migration-state'),
    onEvent: (cb: (e: unknown) => void): (() => void) => {
      const listener = (_e: unknown, m: unknown): void => cb(m)
      ipcRenderer.on('gecko:migration-event', listener)
      return () => void ipcRenderer.removeListener('gecko:migration-event', listener)
    }
  },
  serverMode: {
    probe: (url: string) => ipcRenderer.invoke('gecko:server-probe', url),
    connect: (origin: string): Promise<void> => ipcRenderer.invoke('gecko:server-connect', origin)
  }
})
