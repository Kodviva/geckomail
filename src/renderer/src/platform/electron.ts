// Masaüstü: preload köprüsüne (window.gecko) ince sarmalayıcı. Köprü tipini kullanan tek yer burası.
import { rpc } from '../rpcClient'
import type { AttachmentRef, Platform } from '.'

export function electronBridge(): GeckoBridge | undefined {
  return typeof window !== 'undefined' ? window.gecko : undefined
}

export function createElectronPlatform(g: GeckoBridge): Platform {
  // ek sync tarafından diske indirilir (önbellekteyse hemen); dönen yol sistemde açılır/gösterilir
  const diskPath = async (a: AttachmentRef): Promise<string> =>
    (await rpc.call('getAttachment', { messageId: a.messageId, attachmentId: a.attachmentId })).diskPath

  return {
    kind: 'electron',
    native: null,
    serverOrigin: null,
    savedLocale: () => g.savedLocale ?? null,
    setLocale: (l) => g.setLocale?.(l),
    biometricAvailable: () => g.touchIdAvailable(),
    promptBiometric: (reason) => g.promptTouchId(reason),
    async openAttachment(a) {
      await g.openPath(await diskPath(a), a.name || undefined)
    },
    async revealAttachment(a) {
      await g.reveal(await diskPath(a))
    },
    saveBytes: (name, data) => g.saveFileAs(name, data),
    async saveSmimeAttachment(a) {
      const { base64 } = await rpc.call('getSmimeAttachment', { messageId: a.messageId, index: a.index })
      await g.saveFileAs(a.name, Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)))
    },
    chooseBackupSave: (name, encrypted) => g.chooseBackupSave(name, encrypted),
    chooseBackupOpen: () => g.chooseBackupOpen(),
    relaunch: () => g.relaunch(),
    filePath(f) {
      try {
        return g.getFilePath(f) || null
      } catch {
        return null
      }
    },
    trashFile: (path) => g.trashFile(path),
    openOAuthUrl: (url) => g.openOAuthUrl(url),
    oauthWindow: null,
    oauthComplete: null,
    uploadFile: null,
    discardUpload: null,
    serverBackup: null,
    wallboard: {
      open: () => g.openWallboard(),
      push: (snapshot) => g.wallboardPush(snapshot)
    },
    nativeNotifications: true,
    oauthExternal: null,
    wrapTransport: null,
    serverMode: g.serverMode ?? null,
    migration: g.migration ?? null,
    rendererReady: (ready) => g.rendererReady?.(ready),
    loginItem: g.loginItem ?? null
  }
}
