// İstemci IP'si: sunucu ve röle aynı kuralı kullanır.
import type { IncomingMessage } from 'http'

/** İstemci IP'si. depth 0: soket adresi; n: X-Forwarded-For'un sağdan n'inci girdisi (güvenilen n vekil
 *  ekledi); girdi eksik ya da boşsa soket adresi. depth > 0 iken port yalnız vekil üzerinden erişilebilir
 *  olmalı: doğrudan erişen istemci X-Forwarded-For'u uydurup giriş kilidini başka IP'ye yükleyebilir. */
export function clientIp(req: IncomingMessage, depth: number): string {
  const sock = (req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '')
  if (depth <= 0) return sock
  const raw = req.headers['x-forwarded-for']
  const parts = (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).split(',').map((s) => s.trim())
  const e = parts.length >= depth ? parts[parts.length - depth] : ''
  return e ? e.replace(/^::ffff:/, '') : sock
}
