// RPC taşıma soyutlaması: Electron MessagePortMain (masaüstü) ya da WebSocket (sunucu) aynı dar yüzle.
import type { MessagePortMain } from 'electron'

/** Tek bağlantının taşıması: istek/yanıt ve olaylar düz nesne olarak gider */
export interface RpcPort {
  send(msg: unknown): void
  onMessage(cb: (msg: unknown) => void): void
  onClose(cb: () => void): void
  close(): void
}

export function fromMessagePortMain(p: MessagePortMain): RpcPort {
  return {
    send: (msg) => p.postMessage(msg),
    onMessage(cb) {
      p.on('message', (e) => cb(e.data))
      p.start() // dinleyici bağlandıktan sonra kuyruktaki iletiler akmaya başlar
    },
    onClose: (cb) => void p.on('close', cb),
    close: () => p.close()
  }
}
