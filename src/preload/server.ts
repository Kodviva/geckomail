// Sunucu modu köprüsü: burada çalışan sayfa sunucudan gelir. `window.geckoDesktop` bu dört alandan ibarettir; ipcRenderer,
// dosya, sır ya da çerez hiçbir biçimde sayfaya verilmez. Kök denetimi yine main'dedir (serverWindow.ts).
import { contextBridge, ipcRenderer } from 'electron'

// preload'lar ortak modül paylaşmaz: sandbox preload'u yerel parça yükleyemez, Rollup ortak kodu parçaya ayırırdı
ipcRenderer.on('gecko:wallboard-data', (_e, data) => {
  window.postMessage({ type: 'gecko-wallboard-data', data }, '*')
})

contextBridge.exposeInMainWorld('geckoDesktop', {
  wallboard: {
    open: (): Promise<void> => ipcRenderer.invoke('gecko-desktop:wallboard-open'),
    push: (snapshot: unknown): void => ipcRenderer.send('gecko-desktop:wallboard-push', snapshot)
  },
  openSystemBrowser: (path: string): Promise<void> => ipcRenderer.invoke('gecko-desktop:open-system-browser', path),
  onLocalEvent: (cb: (e: { event: string; data: unknown }) => void): void => {
    ipcRenderer.on('gecko-desktop:local-event', (_e, m: { event: string; data: unknown }) => cb(m))
  },
  rendererReady: (ready?: boolean): void => ipcRenderer.send('gecko-desktop:renderer-ready', ready)
})

// Yalnız paketteki "sunucuya ulaşılamadı" sayfası: sunucudan gelen sayfada bu yüzey hiç oluşmaz
const dev = process.argv.find((a) => a.startsWith('--gecko-dev-renderer='))?.slice('--gecko-dev-renderer='.length)
if (location.protocol === 'file:' || (!!dev && location.href.startsWith(dev))) {
  contextBridge.exposeInMainWorld('geckoDesktopConnect', {
    retry: (): Promise<void> => ipcRenderer.invoke('gecko-desktop:connect-retry'),
    local: (): Promise<void> => ipcRenderer.invoke('gecko-desktop:connect-local')
  })
}
