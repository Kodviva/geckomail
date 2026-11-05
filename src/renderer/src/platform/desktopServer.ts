// Sunucu modu masaüstü penceresi: arayüz sunucunun web istemcisidir, yalnız köprünün verdiği birkaç yetenek eklenir.
import { LOCAL_EVENTS } from '../../../shared/desktopMode'
import type { RpcTransport } from '../transport'
import type { Platform } from '.'

export function desktopServerBridge(): GeckoDesktopBridge | undefined {
  return typeof window !== 'undefined' ? window.geckoDesktop : undefined
}

export function createDesktopServerPlatform(web: Platform, g: GeckoDesktopBridge): Platform {
  // köprü aboneliği sayfa ömrü boyunca tek: taşıma yenilense de olay iki kez girmez
  let deliver: ((m: unknown) => void) | null = null
  const allowed = new Set<string>(LOCAL_EVENTS)
  g.onLocalEvent((e) => {
    if (allowed.has(e.event)) deliver?.({ event: e.event, data: e.data })
  })
  return {
    ...web,
    nativeNotifications: true,
    oauthWindow: null,
    oauthExternal: () => void g.openSystemBrowser('/'),
    // oturum iptali her zaman sayfayı yenilemez (sunucuya ulaşılamıyorsa ekran yerinde kalır): ana süreç bekleyeni giriş sonrasına saklar
    rendererReady: (ready) => g.rendererReady(ready),
    wallboard: { open: () => g.wallboard.open(), push: (snapshot) => g.wallboard.push(snapshot) },
    wrapTransport: (t: RpcTransport): RpcTransport => ({
      start(onMessage, onState) {
        deliver = onMessage
        t.start(onMessage, onState)
      },
      send: (m) => t.send(m),
      close() {
        deliver = null
        t.close()
      }
    })
  }
}
