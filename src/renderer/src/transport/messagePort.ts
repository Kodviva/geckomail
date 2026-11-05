// Masaüstü taşıması: preload'un postMessage ile verdiği MessagePort. Bugünkü akışın aynısı — sync süreci
// yeniden başlayınca yeni port gelir ('open' yeniden), eski port kapatılır. Preload'un yerel olayları
// (yeniden başlatma, hesap aç, menü) rpcClient'a olay çerçevesi olarak iletilir.
import type { RpcTransport } from '.'

export function messagePortTransport(): RpcTransport {
  let port: MessagePort | null = null
  let listener: ((e: MessageEvent) => void) | null = null
  return {
    start(onMessage, onState) {
      listener = (e) => {
        // yalnız kendi penceremizden (preload'un postMessage'ı) — mail iframe'i vb. köprüyü taklit edemez
        if (e.source !== window) return
        if (e.data?.type === 'gecko-sync-port' && e.ports[0]) {
          port?.close()
          port = e.ports[0]
          port.onmessage = (ev) => onMessage(ev.data)
          onState('open')
        }
        if (e.data?.type === 'gecko-sync-restarted') onMessage({ event: 'local:restarted', data: {} })
        if (e.data?.type === 'gecko-open-account') onMessage({ event: 'local:open-account', data: { accountId: e.data.accountId } })
        if (e.data?.type === 'gecko-open-message') onMessage({ event: 'local:open-message', data: { messageId: e.data.messageId, accountId: e.data.accountId ?? null } })
        if (e.data?.type === 'gecko-open-reply') onMessage({ event: 'local:open-reply', data: { messageId: e.data.messageId, accountId: e.data.accountId ?? null } })
        if (e.data?.type === 'gecko-menu' && typeof e.data.action === 'string') onMessage({ event: 'local:menu', data: { action: e.data.action } })
      }
      window.addEventListener('message', listener)
    },
    send(m) {
      port?.postMessage(m)
    },
    close() {
      if (listener) window.removeEventListener('message', listener)
      listener = null
      port?.close()
      port = null
    }
  }
}
