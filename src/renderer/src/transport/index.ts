// RPC taşıması: masaüstünde preload'un MessagePort'u, tarayıcıda (sunucu modu) çerezli WebSocket.
// rpcClient yalnız bu arayüzü görür; çerçeve biçimi ikisinde aynı ({id,method,params} / {id,ok,…} / {event,data}).

/** renewing: sunucu bileti yeniliyor, taşıma hemen döner; arayüzde kopuş sayılmaz */
export type TransportState = 'open' | 'closed' | 'revoked' | 'renewing'

export interface RpcTransport {
  /** onState: 'open' her (yeniden) bağlanışta; 'closed' açık bağlantı koptuğunda; 'revoked' oturum iptal (yeniden bağlanılmaz) */
  start(onMessage: (m: unknown) => void, onState: (s: TransportState) => void): void
  /** kapalıyken sessizce düşer (rpcClient kapalıyken kuyruğa alır) */
  send(m: unknown): void
  close(): void
}

export { messagePortTransport } from './messagePort'
export { webSocketTransport, type WebSocketEndpoint } from './webSocket'
