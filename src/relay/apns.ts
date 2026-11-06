// APNs iletimi: HTTP/2, ES256 JWT (30 dakikada bir yenilenir). Seviye, boyut ve gruplama röleden gizli olduğu için öncelik,
// süre ve gövde kalıbı her bildirimde aynıdır; apns-collapse-id yok. NSE içeriği cihazda çözer.
import { sign, type KeyObject } from 'crypto'
import http2 from 'http2'
import { validDeviceToken, type RelayEnv, type RelayResult } from '../shared/relayProtocol'
import { logDeliveryFailure } from './providerLog'
import type { RelayDevice } from './store'

export const APNS_BASES: Record<RelayEnv, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com'
}
const JWT_TTL_MS = 30 * 60_000
const EXPIRATION_S = 86_400
const REQUEST_MS = 15_000
const GONE_REASONS = new Set(['BadDeviceToken', 'Unregistered'])
const AUTH_REASONS = new Set(['ExpiredProviderToken', 'InvalidProviderToken'])

export interface ApnsOptions {
  key: KeyObject
  keyId: string
  teamId: string
  topic: string
  now?: () => number
  /** yalnız testler: yerel h2c sahte sunucu */
  bases?: Record<RelayEnv, string>
  /** yalnız testler: yanıt bekleme süresi */
  requestMs?: number
}

export interface ApnsSender {
  (d: RelayDevice, c: string): Promise<RelayResult>
  close(): void
}

export const apnsBody = (c: string): string =>
  JSON.stringify({ aps: { alert: { 'loc-key': 'PUSH_FALLBACK' }, 'mutable-content': 1, sound: 'default' }, c })

export function createApns(o: ApnsOptions): ApnsSender {
  const now = o.now ?? Date.now
  const bases = o.bases ?? APNS_BASES
  const sessions = new Map<RelayEnv, http2.ClientHttp2Session>()
  let jwt: { value: string; at: number } | null = null

  const token = (): string => {
    const t = now()
    if (jwt && t - jwt.at < JWT_TTL_MS) return jwt.value
    const enc = (v: object): string => Buffer.from(JSON.stringify(v)).toString('base64url')
    const data = `${enc({ alg: 'ES256', kid: o.keyId })}.${enc({ iss: o.teamId, iat: Math.floor(t / 1000) })}`
    const sig = sign('sha256', Buffer.from(data), { key: o.key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    jwt = { value: `${data}.${sig}`, at: t }
    return jwt.value
  }

  const session = (env: RelayEnv): http2.ClientHttp2Session => {
    const cur = sessions.get(env)
    if (cur && !cur.closed && !cur.destroyed) return cur
    const s = http2.connect(bases[env])
    s.on('error', () => s.destroy()) // akış hatası sonucu 'retry' yapar; süreç düşmesin
    s.on('close', () => {
      if (sessions.get(env) === s) sessions.delete(env)
    })
    s.unref()
    sessions.set(env, s)
    return s
  }

  const send = ((d, c) =>
    new Promise<RelayResult>((resolve) => {
      if (!validDeviceToken('ios', d.token)) return resolve('gone')
      let status = 0
      let body = ''
      let failure = ''
      let req: http2.ClientHttp2Stream
      let current: http2.ClientHttp2Session
      try {
        current = session(d.env)
        req = current.request({
          ':method': 'POST', ':path': `/3/device/${d.token}`, authorization: `bearer ${token()}`,
          'apns-topic': o.topic, 'apns-push-type': 'alert', 'apns-priority': '10',
          'apns-expiration': String(Math.floor(now() / 1000) + EXPIRATION_S), 'content-type': 'application/json'
        })
      } catch (e) {
        logDeliveryFailure('apns', 0, (e as NodeJS.ErrnoException).code ?? 'request')
        return resolve('retry')
      }
      // yanıtsız oturum kuyruktakileri de bekletir: kapatılır, sıradaki gönderim yeni bağlantı açar
      req.setTimeout(o.requestMs ?? REQUEST_MS, () => {
        failure = 'timeout'
        current.destroy()
      })
      req.on('response', (h) => {
        status = Number(h[':status'])
      })
      req.setEncoding('utf8')
      req.on('data', (c: string) => {
        if (body.length < 1024) body += c
      })
      req.on('error', (e: NodeJS.ErrnoException) => {
        failure ||= e.code ?? 'stream'
        resolve('retry')
      })
      req.on('close', () => {
        if (status === 200) return resolve('ok')
        let reason = ''
        try {
          reason = String((JSON.parse(body) as { reason?: unknown }).reason ?? '')
        } catch {
          /* gövdesiz yanıt */
        }
        logDeliveryFailure('apns', status, reason || failure)
        if (status === 410 || GONE_REASONS.has(reason)) return resolve('gone')
        if (AUTH_REASONS.has(reason)) jwt = null
        resolve('retry')
      })
      req.end(apnsBody(c))
    })) as ApnsSender

  send.close = () => {
    for (const s of sessions.values()) s.destroy()
    sessions.clear()
  }
  return send
}
