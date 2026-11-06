// geckomail-relay HTTP katmanı. Tüm uçlar imzalıdır; imzasız yalnız /healthz. Metrik ve durum sayfası yok. Günlüğe başarılı istek,
// IP, belirteç, cihaz kimliği yazılmaz; yalnız sağlayıcı reddi (providerLog). İstekten yalnız doğrulanmış belirteç ve opak kutu alınır, adres hiçbir zaman.
import { createPublicKey, verify } from 'crypto'
import http, { type IncomingMessage, type ServerResponse } from 'http'
import { clientIp } from '../shared/clientIp'
import {
  engineId, HEADER_ENGINE, HEADER_NONCE, HEADER_SIGNATURE, HEADER_TIME, RELAY_MAX_CIPHERTEXT, RELAY_SKEW_MS, signingString, validDeviceToken,
  type RelayEnv, type RelayPlatform, type RelayResult
} from '../shared/relayProtocol'
import type { RelayConfig } from './config'
import { Limits, MAX_DEVICES } from './limits'
import { dayOf, type RelayDevice, type RelayStore } from './store'

const BODY_MAX = 8 * 1024
const BODY_MS = 10_000
/** Saat farkı iki yönlü: bu süreden eski nonce zaten reddedilir */
const NONCE_TTL_MS = 2 * RELAY_SKEW_MS
const SWEEP_MS = 24 * 3600_000
/** Ed25519 açık anahtarının SPKI öneki */
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
const PLATFORMS: ReadonlySet<string> = new Set(['ios', 'android'])
const ENVS: ReadonlySet<string> = new Set(['production', 'sandbox'])
const OPAQUE = /^[A-Za-z0-9_-]+$/
const NONCE = /^[A-Za-z0-9_-]{16,64}$/
const DEVICE_PATH = /^\/v1\/devices\/([A-Za-z0-9_-]{1,64})$/

export type RelaySender = (d: RelayDevice, c: string) => Promise<RelayResult>

const send = (res: ServerResponse, status: number, body?: unknown, extra: Record<string, string> = {}): void => {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text)) })
  })
  res.end(text)
}

const tooMany = (res: ServerResponse, retryAfter: number): void => send(res, 429, { reason: 'rateLimited' }, { 'Retry-After': String(retryAfter) })

function readBody(req: IncomingMessage): Promise<Buffer | 408 | 413 | 400> {
  return new Promise((resolve) => {
    if (Number(req.headers['content-length'] ?? 0) > BODY_MAX) {
      req.resume()
      return resolve(413)
    }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (v: Buffer | 408 | 413 | 400): void => {
      if (done) return
      done = true
      clearTimeout(deadline)
      resolve(v)
    }
    const deadline = setTimeout(() => finish(408), BODY_MS).unref()
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > BODY_MAX) return finish(413)
      if (!done) chunks.push(c)
    })
    req.on('error', () => finish(400))
    req.on('close', () => finish(400))
    req.on('end', () => finish(Buffer.concat(chunks)))
  })
}

function parseObject(body: Buffer): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(body.toString('utf-8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function createRelayServer(o: {
  cfg: RelayConfig; store: RelayStore
  apns: RelaySender; fcm: RelaySender
  now?: () => number
}): http.Server {
  const { cfg, store } = o
  const now = o.now ?? Date.now
  const limits = new Limits(now)
  const nonces = new Map<string, number>()
  let lastNonceSweep = now()

  const sweepNonces = (): void => {
    const t = now()
    for (const [k, exp] of nonces) if (t >= exp) nonces.delete(k)
  }

  /** İmza geçerliyse motor kimliği; nonce imzadan sonra kaydedilir: imzasız istek önbelleği dolduramaz */
  const authenticate = (req: IncomingMessage, path: string, body: Buffer): { id: string; publicKey: Buffer } | null => {
    const engine = String(req.headers[HEADER_ENGINE] ?? '')
    const ts = Number(req.headers[HEADER_TIME])
    const nonce = String(req.headers[HEADER_NONCE] ?? '')
    const signature = String(req.headers[HEADER_SIGNATURE] ?? '')
    if (!OPAQUE.test(engine) || !NONCE.test(nonce) || !OPAQUE.test(signature)) return null
    if (!Number.isSafeInteger(ts) || Math.abs(now() - ts) > RELAY_SKEW_MS) return null
    const publicKey = Buffer.from(engine, 'base64url')
    if (publicKey.length !== 32) return null
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, publicKey]), format: 'der', type: 'spki' })
    const data = Buffer.from(signingString(req.method ?? '', cfg.publicHost, path, ts, nonce, body))
    if (!verify(null, data, key, Buffer.from(signature, 'base64url'))) return null
    const id = engineId(publicKey)
    const seen = `${id}:${nonce}`
    if (nonces.has(seen)) return null
    if (now() - lastNonceSweep >= 60_000) {
      lastNonceSweep = now()
      sweepNonces()
    }
    nonces.set(seen, now() + NONCE_TTL_MS)
    return { id, publicKey }
  }
  const registerDevice = (res: ServerResponse, engine: string, body: Buffer): void => {
    const b = parseObject(body)
    const { platform, env, token } = b ?? {}
    if (typeof platform !== 'string' || !PLATFORMS.has(platform) || typeof env !== 'string' || !ENVS.has(env) || typeof token !== 'string') {
      return send(res, 400, { reason: 'invalid' })
    }
    if (!validDeviceToken(platform as RelayPlatform, token)) return send(res, 400, { reason: 'invalid' })
    const wait = limits.register(engine)
    if (wait) return tooMany(res, wait)
    // yenileme sınıra takılmaz; yeni cihaz ancak yer varsa
    if (!store.hasDevice(engine, platform as RelayPlatform, token) && store.deviceCount(engine) >= MAX_DEVICES) return tooMany(res, 3600)
    const deviceId = store.upsertDevice({ engineId: engine, platform: platform as RelayPlatform, env: env as RelayEnv, token, day: dayOf(now()) })
    send(res, 200, { deviceId })
  }

  const push = async (res: ServerResponse, engine: string, body: Buffer): Promise<void> => {
    const { deviceId, c } = parseObject(body) ?? {}
    if (typeof deviceId !== 'string' || typeof c !== 'string' || !c || c.length > RELAY_MAX_CIPHERTEXT || !OPAQUE.test(c)) {
      return send(res, 400, { reason: 'invalid' })
    }
    const wait = limits.push(engine)
    if (wait) return tooMany(res, wait)
    const device = store.ownDevice(engine, deviceId)
    if (!device) return send(res, 404, { reason: 'notFound' })
    let status: RelayResult
    try {
      status = await (device.platform === 'ios' ? o.apns : o.fcm)(device, c)
    } catch {
      status = 'retry'
    }
    if (status === 'gone') store.deleteDevice(engine, device.id)
    else store.touchDevice(device.id, dayOf(now()))
    send(res, 200, { status })
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true })
    const ip = clientIp(req, cfg.trustedProxyDepth)
    const wait = limits.ip(ip)
    if (wait) return tooMany(res, wait)
    const device = req.method === 'DELETE' ? DEVICE_PATH.exec(path) : null
    const known = req.method === 'POST' && (path === '/v1/devices' || path === '/v1/push')
    if (!device && !known) return send(res, 404, { reason: 'notFound' })
    const body = await readBody(req)
    if (!Buffer.isBuffer(body)) return send(res, body, { reason: 'body' }, { Connection: 'close' })
    const engine = authenticate(req, path, body)
    if (!engine) return send(res, 401, { reason: 'signature' })
    if (!store.hasEngine(engine.id)) {
      const waitEngine = limits.newEngine(ip)
      if (waitEngine) return tooMany(res, waitEngine)
    }
    store.touchEngine(engine.id, engine.publicKey, dayOf(now()))
    if (device) return send(res, store.deleteDevice(engine.id, device[1]) ? 204 : 404, undefined)
    if (path === '/v1/devices') return registerDevice(res, engine.id, body)
    return push(res, engine.id, body)
  }

  // sık yeniden başlayan süreç 24 saate hiç ulaşmayabilir
  store.sweep(dayOf(now()))
  const sweep = setInterval(() => {
    store.sweep(dayOf(now()))
    sweepNonces()
  }, SWEEP_MS)
  sweep.unref()

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      // yalnız hata türü: istek ayrıntısı yazılmaz
      console.error('relay: istek işlenemedi')
      if (!res.headersSent) send(res, 500, { reason: 'internal' })
      else res.destroy()
    })
  })
  server.on('close', () => clearInterval(sweep))
  return server
}
