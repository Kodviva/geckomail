// Mobil kimlik katmanı. Uygulama kendi kökeninden (iOS capacitor://localhost, Android https://localhost) sunucuya başka
// kökenden bağlanır: SameSite=Strict çerez gitmez. Üç katman var: Keychain/Keystore'daki uzun ömürlü mobil oturum, JS
// belleğindeki 15 dakikalık erişim belirteci ve tek kullanımlık WebSocket bileti.
// Altın kural: köken izni kimlik vermez. İzinli kökenden gelen istekte çerez hiç okunmaz, yanıtta Allow-Credentials yoktur.
import { createHash, randomBytes } from 'crypto'
import type { IncomingMessage } from 'http'
import { WS_TICKET_PREFIX } from '../shared/mobileProtocol'

/** Kodda sabit, ortam değişkeniyle genişletilmez; http://localhost bilerek yok */
export const MOBILE_ORIGINS: ReadonlySet<string> = new Set(['capacitor://localhost', 'https://localhost'])
export const ACCESS_TTL_MS = 15 * 60_000
export const TICKET_TTL_MS = 30_000
export { WS_SUBPROTOCOL, WS_TICKET_PREFIX } from '../shared/mobileProtocol'
export const MOBILE_HELLO_PATH = '/api/mobile/hello'

const ACCESS_PREFIX = 'gma_'
const TICKET_PREFIX = 'gmt_'
/** Yoğun belirteç üretiminde tablo saatlik süpürmeyi beklemesin */
const SELF_SWEEP_MS = 60_000

const CORS_ALLOW_HEADERS = 'Authorization, Content-Type, X-Filename'
const CORS_MAX_AGE_S = '600'

const digest = (v: string): string => createHash('sha256').update(v).digest('hex')

interface Entry { sessionId: string; expiresAt: number }
interface TicketEntry extends Entry { accessExpiresAt: number }

/** Erişim belirteçleri ve WS biletleri yalnız bellekte ve özet olarak: süreç yeniden başlarsa 401, yeniden alınır */
export class MobileTokens {
  private readonly access = new Map<string, Entry>()
  private readonly tickets = new Map<string, TicketEntry>()
  private lastSweep = 0

  constructor(private readonly now: () => number = Date.now) {}

  issueAccess(sessionId: string): { token: string; expiresAt: number } {
    this.sweepIfDue()
    const token = ACCESS_PREFIX + randomBytes(32).toString('base64url')
    const expiresAt = this.now() + ACCESS_TTL_MS
    this.access.set(digest(token), { sessionId, expiresAt })
    return { token, expiresAt }
  }

  resolveAccess(token: string): string | null {
    if (!token.startsWith(ACCESS_PREFIX)) return null
    const e = this.access.get(digest(token))
    return e && this.now() < e.expiresAt ? e.sessionId : null
  }

  /** Bilet erişim belirtecinden alınır ve onun süresini taşır: soket belirteçten uzun yaşamaz. Geçersiz belirteçte null */
  issueTicket(accessToken: string): string | null {
    this.sweepIfDue()
    const a = accessToken.startsWith(ACCESS_PREFIX) ? this.access.get(digest(accessToken)) : undefined
    if (!a || this.now() >= a.expiresAt) return null
    const ticket = TICKET_PREFIX + randomBytes(32).toString('base64url')
    this.tickets.set(digest(ticket), {
      sessionId: a.sessionId, accessExpiresAt: a.expiresAt, expiresAt: Math.min(this.now() + TICKET_TTL_MS, a.expiresAt)
    })
    return ticket
  }

  /** İkinci çağrı null: bilet ilk denemede silinir */
  consumeTicket(ticket: string): { sessionId: string; accessExpiresAt: number } | null {
    if (!ticket.startsWith(TICKET_PREFIX)) return null
    const key = digest(ticket)
    const e = this.tickets.get(key)
    this.tickets.delete(key)
    return e && this.now() < e.expiresAt ? { sessionId: e.sessionId, accessExpiresAt: e.accessExpiresAt } : null
  }

  sweep(): void {
    const now = this.now()
    this.lastSweep = now
    for (const m of [this.access, this.tickets]) {
      for (const [k, e] of m) if (now >= e.expiresAt) m.delete(k)
    }
  }

  /** Bellekte tutulan belirteç ve bilet sayısı */
  size(): number {
    return this.access.size + this.tickets.size
  }

  private sweepIfDue(): void {
    if (this.now() - this.lastSweep >= SELF_SWEEP_MS) this.sweep()
  }
}

/** Bearer kabul eden tek HTTP yolları. Yedek, passkey, 2FA ve OAuth uçları bilerek yok. Erişim belirteci yine de bilet alır: bilet
 *  posta RPC'sini açar ama yönetici, 2FA ve parola yöntemleri o sokette kapalıdır (rpcHub.invoke) ve soket belirteçle biter */
export function isBearerPath(method: string, path: string): boolean {
  if (path === '/api/me') return method === 'GET'
  if (path === '/api/upload') return method === 'POST'
  if (path.startsWith('/api/upload/')) return method === 'DELETE'
  if (path.startsWith('/api/attachment/')) return method === 'GET' || method === 'HEAD'
  if (path === '/api/push/devices') return method === 'GET'
  if (path.startsWith('/api/push/devices/')) return method === 'DELETE'
  return method === 'POST' && (path === '/api/notify/action' || path === '/api/mobile/ws-ticket' || path === '/api/mobile/device')
}

/** Allow-Credentials hiç yok: tarayıcı bu yanıtlara çerez bağlamıyla erişemez. Yerel uçlar (login, token, logout) CORS almaz. */
export function corsHeaders(origin: string | undefined, method: string, path: string): Record<string, string> {
  if (origin === undefined || !MOBILE_ORIGINS.has(origin)) return {}
  if (path !== MOBILE_HELLO_PATH && !isBearerPath(method, path)) return {}
  if (path === MOBILE_HELLO_PATH && method !== 'GET') return {}
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Expose-Headers': 'Content-Disposition' }
}

/** OPTIONS yanıtı; method Access-Control-Request-Method değeri. İzin yoksa null */
export function preflightHeaders(origin: string | undefined, method: string, path: string): Record<string, string> | null {
  const cors = corsHeaders(origin, method, path)
  if (!cors['Access-Control-Allow-Origin']) return null
  return { ...cors, 'Access-Control-Allow-Methods': method, 'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS, 'Access-Control-Max-Age': CORS_MAX_AGE_S }
}

/** Origin ve Sec-Fetch-* yoksa true: hiçbir tarayıcı bağlamı uzun ömürlü belirteci okuyamaz, gönderemez */
export function nativeOnly(req: IncomingMessage): boolean {
  return req.headers.origin === undefined && !Object.keys(req.headers).some((h) => h.startsWith('sec-fetch-'))
}

/** İstek Bearer şemasıyla geldi mi. Vekilin Basic başlığı bu yolu tetiklemez: temel kimlik doğrulamalı web kurulumu bozulmasın */
export const hasBearer = (req: IncomingMessage): boolean => /^bearer(\s|$)/i.test(req.headers.authorization ?? '')

export function bearerToken(req: IncomingMessage): string | null {
  const m = /^bearer +([\x21-\x7e]{1,512})$/i.exec(req.headers.authorization ?? '')
  return m ? m[1] : null
}

/** Bilet adreste değil Sec-WebSocket-Protocol'dedir: vekil günlüğüne düşmez */
export function wsTicket(req: IncomingMessage): string | null {
  for (const part of String(req.headers['sec-websocket-protocol'] ?? '').split(',')) {
    const p = part.trim()
    if (p.startsWith(WS_TICKET_PREFIX) && p.length > WS_TICKET_PREFIX.length) return p.slice(WS_TICKET_PREFIX.length)
  }
  return null
}
