// WebSocket → RpcPort: JSON metin çerçeveleri. Sunucu tarafı kapatma yalnız oturum iptalinde
// (çıkış, süre dolması, kullanıcı devre dışı) olur: istemci 4401'i "yeniden giriş gerekli" diye okur.
import WebSocket from 'ws'
import type { RpcPort } from '../sync/rpc/transport'

export const WS_CLOSE_REVOKED = 4401

export function fromWebSocket(ws: WebSocket): RpcPort {
  return {
    send(msg) {
      // kapanmış/kapanan sokete yazma sessizce atlanır
      if (ws.readyState !== WebSocket.OPEN) return
      try {
        ws.send(JSON.stringify(msg))
      } catch {
        /* soket bu arada koptu; close olayı oturumu düşürür */
      }
    },
    onMessage(cb) {
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        let msg: unknown
        try {
          msg = JSON.parse(data.toString())
        } catch {
          return // bozuk çerçeve yok sayılır
        }
        cb(msg)
      })
    },
    onClose: (cb) => void ws.on('close', () => cb()),
    close: () => ws.close(WS_CLOSE_REVOKED)
  }
}
