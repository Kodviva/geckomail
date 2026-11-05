// Tarayıcı taşıması: /rpc WebSocket'i. Web'de aynı kökende, kimlik HttpOnly çerezle (tarayıcı kendisi ekler); mobilde adres ve
// tek kullanımlık bilet sağlayıcıdan gelir, her bağlanışta yeniden alınır (arka plandan dönüşte bilet ve erişim süresi geçmiş olur).
// Kopunca artan beklemeyle yeniden bağlanır; sunucu oturumu iptal edince 4401 ile kapatır → 'revoked',
// yeniden denenmez (giriş gerekir). Çerezi geçersiz yükseltmeyi sunucu 401'le reddeder; tarayıcı bunu yalnız
// 1006 olarak gösterir — bu yüzden açılamayan her denemeden sonra isSessionGone sorulur (true → 'revoked').
import { WS_CLOSE_RENEW } from '../../../shared/mobileProtocol'
import type { RpcTransport, TransportState } from '.'

const DEFAULT_BACKOFF_MS = [500, 1000, 2000, 5000, 10000]
const CLOSE_REVOKED = 4401
const OPEN = 1 // WebSocket.OPEN

export interface WebSocketTransportOptions {
  backoffMs?: number[]
  /** açılamayan denemeden sonra: oturum kesin yoksa true; ağ hatasında fırlatabilir (deneme sürer) */
  isSessionGone?: () => Promise<boolean>
}

export type WebSocketEndpoint = () => Promise<{ url: string; protocols?: string[] }>

export function webSocketTransport(endpoint: string | WebSocketEndpoint, opts: WebSocketTransportOptions = {}): RpcTransport {
  const backoff = opts.backoffMs?.length ? opts.backoffMs : DEFAULT_BACKOFF_MS
  let ws: WebSocket | null = null
  let attempt = 0
  let wasOpen = false
  let stopped = false
  /** Sürmekte olan adres isteğini tanır: kapatılıp yeniden başlayan taşımada eski yanıt soket açmaz */
  let round = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let onMsg: (m: unknown) => void = () => {}
  let onState: (s: TransportState) => void = () => {}

  const connect = (): void => {
    timer = null
    if (stopped) return
    if (typeof endpoint === 'string') return open(endpoint)
    const mine = ++round
    endpoint().then(
      (e) => {
        if (!stopped && mine === round) open(e.url, e.protocols)
      },
      () => {
        if (stopped || mine !== round) return
        lost()
        failed()
      }
    )
  }

  const open = (url: string, protocols?: string[]): void => {
    const sock = protocols ? new WebSocket(url, protocols) : new WebSocket(url)
    ws = sock
    sock.onmessage = (e) => {
      if (ws !== sock || typeof e.data !== 'string') return
      let m: unknown
      try {
        m = JSON.parse(e.data)
      } catch {
        return // bozuk çerçeve yok sayılır
      }
      onMsg(m)
    }
    let opened = false
    sock.onopen = () => {
      if (ws !== sock) return
      opened = true
      attempt = 0
      wasOpen = true
      onState('open')
    }
    sock.onclose = (e) => {
      if (ws !== sock || stopped) return
      ws = null
      if (e.code === CLOSE_REVOKED) return revoke()
      // biletli soketin süresi doldu: arayüze kopuş gibi yansımaz; yenileme de başarısızsa 'closed' o zaman gelir
      if (e.code === WS_CLOSE_RENEW && opened) {
        onState('renewing')
        return connect()
      }
      lost()
      if (opened) return schedule()
      failed()
    }
  }

  /** Ara denemelerin düşmesi 'closed'ı tekrarlamaz; yalnız açık bağlantının kopuşu bildirilir
   *  (o durumda oturumu çağıran local:disconnected ile sorar) */
  const lost = (): void => {
    if (!wasOpen) return
    wasOpen = false
    onState('closed')
  }

  /** Bağlantı kurulamadı: oturum soruluyorsa yanıta göre, yoksa yeniden dene */
  const failed = (): void => {
    if (!opts.isSessionGone) return schedule()
    const check = opts.isSessionGone
    void (async () => {
      let gone = false
      try {
        gone = await check()
      } catch {
        /* sunucuya ulaşılamıyor: denemeye devam */
      }
      if (stopped || ws) return // bu arada close() ya da yeni bağlantı
      if (gone) revoke()
      else schedule()
    })()
  }

  const schedule = (): void => {
    const ms = backoff[Math.min(attempt, backoff.length - 1)]
    attempt++
    timer = setTimeout(connect, ms)
  }

  const revoke = (): void => {
    stopped = true
    wasOpen = false
    onState('revoked')
  }

  return {
    start(onMessage, onStateCb) {
      onMsg = onMessage
      onState = onStateCb
      stopped = false
      round++
      connect()
    },
    send(m) {
      if (!ws || ws.readyState !== OPEN) return
      try {
        ws.send(JSON.stringify(m))
      } catch {
        /* soket bu arada koptu; close olayı yeniden bağlanmayı başlatır */
      }
    },
    close() {
      stopped = true
      round++
      if (timer) clearTimeout(timer)
      timer = null
      const sock = ws
      ws = null
      sock?.close()
    }
  }
}
