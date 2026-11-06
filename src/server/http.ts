// Sunucu modu HTTP katmanı: giriş/çıkış API'si (çerezli oturum) ve kimliği doğrulanmış WebSocket RPC.
// Durum değiştiren her istek ve WS yükseltmesi aynı köken denetiminden geçer; belirteç yalnız Set-Cookie ile
// gider, yanıt gövdelerinde ve günlüklerde yer almaz. /api ve /rpc dışındaki GET/HEAD istekleri web istemcisinin
// statik dosyalarıdır (static.ts, sayfa CSP'siyle); /oauth/callback web OAuth dönüşü, POST /oauth/complete
// tamamlamasıdır (oauthWeb.ts). /api/backup, /api/restore/*, /api/restart yalnız yöneticiye (backupRoutes.ts).
// /api/passkey/* ve /api/passkeys passkey kaydı, girişi ve listesidir (passkeys.ts). /api/push/* Web Push
// abonelikleridir (pushDevices.ts). POST /api/notify/action bildirimden okundu/arşivle eylemidir (notifyActions.ts).
// GET /api/server-info masaüstü uygulamasının oturumsuz yoklamasıdır (desktopRoutes.ts).
// /api/mobile/* ve Bearer yolu mobil uygulamanındır (mobileAuth.ts): Bearer ya da izinli mobil kökenli istekte çerez hiç
// okunmaz, izinli yollar dışında 401 döner. Çerezli yol sameOrigin() ile eskisi gibi çalışır.
import http, { STATUS_CODES, type IncomingMessage, type ServerResponse } from 'http'
import type { Duplex } from 'stream'
import type WebSocket from 'ws'
import { WebSocketServer } from 'ws'
import { clientIp } from '../shared/clientIp'
import { WS_CLOSE_RENEW } from '../shared/mobileProtocol'
import type { SessionUser } from '../shared/rpc'
import type { RpcHub } from '../sync/rpcHub'
import type { RpcSession } from '../sync/rpcSession'
import { createAttachmentRoutes, type ReceiveLimits } from './attachments'
import { createBackupRoutes } from './backupRoutes'
import { serverInfo } from './desktopRoutes'
import { SESSION_TTL_MS, tokenHash, type LoginResult, type ResolvedSession, type WebAuth } from './auth'
import type { ServerConfig } from './config'
import { cookieValue, createWebOAuth, OAUTH_CALLBACK_PATH, OAUTH_COMPLETE_PATH } from './oauthWeb'
import { isRelayDevice } from '../sync/db/q/pushDevices'
import type { OAuthProviderDef, OAuthProviderId } from '../sync/oauth'
import {
  bearerToken, corsHeaders, hasBearer, isBearerPath, MOBILE_HELLO_PATH, MOBILE_ORIGINS, MobileTokens, nativeOnly, preflightHeaders, WS_SUBPROTOCOL, wsTicket
} from './mobileAuth'
import { applyNotifyAction, parseNotifyAction } from './notifyActions'
import { createPasskeys, PASSKEY_CHALLENGE_TTL_MS } from './passkeys'
import { parseNativeDevice, parseSubscription, vapidLoader } from './pushDevices'
import { relayDeviceId, relayEndpoint, type RelayClient } from './relayClient'
import { securityHeaders } from './securityHeaders'
import { serveStatic } from './static'
import { fromWebSocket } from './wsPort'

const COOKIE = 'gm_session'
/** Passkey girişi akış kimliği (kullanıcı adı yok, oturum yok): yalnız /api/passkey altında, tek akışlık */
const PASSKEY_COOKIE = 'gm_pk'
const BODY_MAX = 16 * 1024
/** Küçük JSON gövdesinin tamamı bu sürede gelmeli */
const JSON_BODY_MS = 30_000
/** Yanıtlanmış ama gövdesi okunmamış istek: bağlantı bu süre sonra kesilir (genel requestTimeout yok) */
const UNREAD_BODY_GRACE_MS = 5_000
const WS_MAX_PAYLOAD = 64 * 1024 * 1024
const REVALIDATE_MS = 60_000
const HEARTBEAT_MS = 30_000
/** Süresi dolan oturum ve push cihazı süpürmesi */
const SESSION_SWEEP_MS = 3600_000

const LOGIN_STATUS: Record<Exclude<LoginResult, { ok: true }>['reason'], number> = {
  bad: 401, totpBad: 401, locked: 423, totpRequired: 428, totpSetupRequired: 428
}

function sessionToken(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0 || part.slice(0, i).trim() !== COOKIE) continue
    const v = part.slice(i + 1).trim()
    return /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : null
  }
  return null
}

type Body = { ok: true; value: Record<string, unknown> } | { ok: false; status: 400 | 408 | 413 }

const bodyReason = (status: 400 | 408 | 413): string => ({ 400: 'invalid', 408: 'timeout', 413: 'tooLarge' })[status]

/** En çok BODY_MAX baytlık JSON nesnesi; aşımda ya da süre dolunca okuma bırakılır (yanıt bağlantıyı kapatır) */
export function readJson(req: IncomingMessage, allowEmpty = false, deadlineMs = JSON_BODY_MS): Promise<Body> {
  return new Promise((resolve) => {
    if (Number(req.headers['content-length'] ?? 0) > BODY_MAX) {
      req.resume()
      return resolve({ ok: false, status: 413 })
    }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const deadline = setTimeout(() => stop(408), deadlineMs).unref()
    const stop = (status: 400 | 408 | 413): void => {
      clearTimeout(deadline)
      if (!done) resolve({ ok: false, status })
      done = true
    }
    req.on('data', (c: Buffer) => {
      if (done) return
      size += c.length
      if (size > BODY_MAX) return stop(413)
      chunks.push(c)
    })
    req.on('error', () => stop(400))
    // istemci gövde bitmeden koptu: söz asılı kalmasın ('end'den sonraki normal 'close' etkisiz)
    req.on('close', () => stop(400))
    req.on('end', () => {
      clearTimeout(deadline)
      if (done) return
      done = true
      const text = Buffer.concat(chunks).toString('utf-8')
      if (allowEmpty && !text.trim()) return resolve({ ok: true, value: {} })
      try {
        const v: unknown = JSON.parse(text)
        if (v && typeof v === 'object' && !Array.isArray(v)) return resolve({ ok: true, value: v as Record<string, unknown> })
      } catch {
        /* aşağıda 400 */
      }
      resolve({ ok: false, status: 400 })
    })
  })
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Alanların hepsi dize mi (isteğe bağlılar yoksa da olur) */
function strings(v: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((k) => typeof v[k] === 'string') && optional.every((k) => v[k] == null || typeof v[k] === 'string')
}

/** close() önce açık WebSocket'leri sonlandırır: yükseltilmiş soketler http sunucusunun bağlantı izlemesinde
 *  değildir (closeAllConnections onları kapatmaz), açık soket varken 'close' olayı hiç gelmez — kapanış
 *  bu olaya bağlanırsa sunucu hiç kapanmaz. */
class GeckoHttpServer extends http.Server {
  constructor(private readonly beforeClose: () => void, listener: http.RequestListener) {
    super(listener)
  }

  override close(cb?: (err?: Error) => void): this {
    this.beforeClose()
    return super.close(cb)
  }
}

export function createHttpServer(o: {
  cfg: ServerConfig; hub: RpcHub; auth: WebAuth; revalidateMs?: number; heartbeatMs?: number
  /** testler: sahte saat ve kısa süpürme aralığı (yükleme süresi) */
  now?: () => number; uploadSweepMs?: number; uploadGlobalBytes?: number
  /** yalnız testler: OAuth sağlayıcı uç noktaları yerel sahte sunucuya */
  oauthProviders?: Partial<Record<OAuthProviderId, Partial<OAuthProviderDef>>>
  /** POST /api/restart: yanıt gittikten sonra (serve düzgün kapanır, çıkış 0); testler sahtesini verir */
  onRestart?: () => void
  /** yalnız testler: geri yükleme yüklemesindeki boş alan ölçümü */
  freeBytes?: (dir: string) => number
  /** yalnız testler: gövde okuma süreleri */
  bodyLimits?: { jsonMs?: number; attachment?: ReceiveLimits; restore?: ReceiveLimits; unreadGraceMs?: number }
  /** yalnız testler: geri yüklenebilir en büyük yedek */
  restoreLimit?: number
  /** yalnız testler: oturum süpürme aralığı */
  sessionSweepMs?: number
  /** yalnız testler: izinli servislere ek olarak kabul edilen push ana makineleri (yerel sahte servis) */
  pushHosts?: string[]
  /** yoksa röle kapalı (GECKO_RELAY_URL=off): hello push:false, cihaz kaydı 409 */
  relay?: Pick<RelayClient, 'register' | 'unregister'> | null
}): http.Server {
  const { cfg, hub, auth } = o
  const https = cfg.publicOrigin.startsWith('https:')
  const files = createAttachmentRoutes({ hub, dataDir: cfg.dataDir, https, now: o.now, sweepMs: o.uploadSweepMs, globalBytes: o.uploadGlobalBytes, receiveLimits: o.bodyLimits?.attachment })
  // web OAuth: dönüş bu sunucuya; sonuç yalnız akışı başlatan web oturumuna
  const oauth = createWebOAuth({
    publicOrigin: cfg.publicOrigin, https, now: o.now, providers: o.oauthProviders,
    session: (req) => {
      const token = sessionToken(req)
      return token ? auth.resolve(token) : null
    },
    returned: (owner, flowId) => hub.sendToWebSession(owner, 'oauth:returned', { flowId }),
    notify: (owner, data) => hub.sendToWebSession(owner, 'oauth:done', data)
  })
  hub.webOAuth = oauth
  const passkeys = createPasskeys({ q: hub.deps.q, auth, publicOrigin: cfg.publicOrigin, now: o.now })
  const pushKeys = vapidLoader(hub.deps.q, {
    encrypt: (v) => hub.deps.encrypt(v),
    decrypt: async (b) => (await hub.deps.decrypt(b)).map((s) => new Uint8Array(Buffer.from(s)))
  })
  const backups = createBackupRoutes({ hub, dataDir: cfg.dataDir, https, store: files.store, now: o.now, onRestart: o.onRestart, freeBytes: o.freeBytes, receiveLimits: o.bodyLimits?.restore, restoreLimit: o.restoreLimit })
  // WS oturumu → oturumu yeniden çözen kapanış (çerez belirteci ya da mobil oturum kimliği yalnız bellekte; periyodik doğrulama için)
  const tokens = new Map<RpcSession, () => ResolvedSession | null>()
  // bilet asla yankılanmaz: yalnız sabit alt protokol seçilir
  const wss = new WebSocketServer({
    noServer: true, maxPayload: WS_MAX_PAYLOAD, handleProtocols: (offered) => (offered.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false)
  })
  const mobileOn = cfg.mobileEnabled !== false
  const mobile = new MobileTokens(o.now)

  const closeWebSessions = (ids: Set<string>): void => {
    if (ids.size) hub.closeSessionsWhere((s) => s.webSessionId != null && ids.has(s.webSessionId))
  }
  // kullanıcı devre dışı/silindi, parolası/rolü değişti, 2FA'sı kaldırıldı: tüm web oturumları ve soketleri hemen
  hub.onUserRevoked = (userId, keep) => {
    hub.notifyBacklog.forget(userId)
    closeWebSessions(new Set(auth.revokeUser(userId, keep)))
  }

  hub.endWebSessions = (ids) => {
    const relayed = ids.flatMap((id) => hub.deps.q.listPushDevicesForSession(id).filter(isRelayDevice))
    for (const id of ids) auth.endSession(id)
    closeWebSessions(new Set(ids))
    for (const d of relayed) void o.relay?.unregister(relayDeviceId(d.endpoint)).catch(() => {})
  }

  // Periyodik yeniden doğrulama: süresi dolan, çıkışı başka yoldan yapılan ya da satırı silinen oturumların
  // soketleri kapanır; geçerli olanlarda rol ve grup izinleri DB'den yenilenir (gruptan çıkarılan üye
  // yeniden giriş gerekmeden en geç bir aralıkta erişimini kaybeder)
  const revalidate = (): void => {
    const dead = new Set<RpcSession>()
    for (const [s, check] of tokens) {
      const r = check()
      if (!r) dead.add(s)
      // handler oturumu bilerek girişsiz bıraktıysa (kendi rolünü değiştirdi) geri açılmaz
      else if (s.currentUser) s.currentUser = r.user
    }
    if (dead.size) hub.closeSessionsWhere((s) => dead.has(s))
  }
  const timer = setInterval(revalidate, o.revalidateMs ?? REVALIDATE_MS)
  timer.unref()

  // oturumu biten kullanıcının çözülmüş içeriği RAM'de kalmaz; başka oturumu varsa yeniden çözülür
  const sessionSweep = setInterval(() => {
    for (const userId of auth.sweepExpired()) hub.smimeCache.clearUser(userId)
    mobile.sweep()
  }, o.sessionSweepMs ?? SESSION_SWEEP_MS)
  sessionSweep.unref()

  // Kalp atışı: her aralıkta ping; önceki ping'e pong gelmemişse soket sonlandırılır (close olayı oturumu
  // düşürür). Sessizce kopan bağlantı (NAT zaman aşımı, uyuyan cihaz) oturumu açık tutmasın.
  const alive = new WeakMap<WebSocket, boolean>()
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate()
        continue
      }
      alive.set(ws, false)
      try {
        ws.ping()
      } catch {
        /* soket bu arada koptu */
      }
    }
  }, o.heartbeatMs ?? HEARTBEAT_MS)
  heartbeat.unref()

  const sameOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin
    if (origin !== undefined) return origin === cfg.publicOrigin
    return req.headers['sec-fetch-site'] === 'same-origin'
  }
  // sunucu kökeni izinli değerle aynıysa (https://localhost denemesi) istek web istemcisindendir: çerezli yol kalır
  const mobileOrigin = (origin: string | undefined): boolean =>
    mobileOn && origin !== undefined && MOBILE_ORIGINS.has(origin) && origin !== cfg.publicOrigin
  /** Bu istekte çerez okunmaz. Geçtiği kapı handle başındadır: yalnız izinli yol ve izinli köken buraya ulaşır */
  const bearerMode = (req: IncomingMessage): boolean => mobileOn && (hasBearer(req) || mobileOrigin(req.headers.origin))
  const accessSession = (req: IncomingMessage): ResolvedSession | null => {
    const t = bearerToken(req)
    const id = t ? mobile.resolveAccess(t) : null
    return id ? auth.resolveSession(id) : null
  }
  const cookieSession = (req: IncomingMessage): ResolvedSession | null => {
    const token = sessionToken(req)
    return token ? auth.resolve(token) : null
  }
  /** Hem çerez hem Bearer kabul eden yollar için oturum */
  const callerSession = (req: IncomingMessage): ResolvedSession | null => (bearerMode(req) ? accessSession(req) : cookieSession(req))
  /** Durum değiştiren istekte köken: Bearer yolunda köken kapıda denetlendi, belirteç tarayıcıdan kendiliğinden gitmez */
  const trustedRequest = (req: IncomingMessage): boolean => bearerMode(req) || sameOrigin(req)
  const isJson = (req: IncomingMessage): boolean =>
    (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'application/json'

  const send = (res: ServerResponse, status: number, body: unknown, api: boolean, extra: Record<string, string | string[]> = {}): void => {
    const h: Record<string, string | string[]> = { ...securityHeaders({ https, api }), ...extra }
    if (body === undefined) {
      res.writeHead(status, h).end()
      return
    }
    const text = JSON.stringify(body)
    res.writeHead(status, { ...h, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text)) })
    res.end(text)
  }
  // düz http yalnız geri döngüde mümkün (config.ts); Linux WebKit orada Secure çerezi saklamaz, üretim kökeni hep https
  const secure = https ? '; Secure' : ''
  const cookie = (token: string, maxAge: number): string =>
    `${COOKIE}=${token}; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=${maxAge}`

  const passkeyCookie = (v: string, maxAge: number): string =>
    `${PASSKEY_COOKIE}=${v}; HttpOnly${secure}; SameSite=Strict; Path=/api/passkey; Max-Age=${maxAge}`

  const loginResponse = (res: ServerResponse, r: LoginResult, extraCookie?: string): void => {
    const extra = extraCookie ? [extraCookie] : []
    if (!r.ok) return send(res, LOGIN_STATUS[r.reason], { reason: r.reason }, true, { 'Set-Cookie': extra })
    send(res, 200, { user: r.user }, true, { 'Set-Cookie': [cookie(r.token, SESSION_TTL_MS / 1000), ...extra] })
  }

  /** Oturumlu passkey ucu: oturum yoksa 401 yanıtlanır, null döner */
  const passkeySession = (req: IncomingMessage, res: ServerResponse): { user: SessionUser; sessionId: string } | null => {
    const token = sessionToken(req)
    const r = token ? auth.resolve(token) : null
    if (!r) send(res, 401, { reason: 'unauthenticated' }, true)
    return r
  }
  /** Çerez ya da Bearer ile oturumlu uç: oturum yoksa 401 yanıtlanır, null döner */
  const deviceSession = (req: IncomingMessage, res: ServerResponse): ResolvedSession | null => {
    const r = callerSession(req)
    if (!r) send(res, 401, { reason: 'unauthenticated' }, true)
    return r
  }
  const userAgent = (req: IncomingMessage): string => String(req.headers['user-agent'] ?? '').slice(0, 256)

  // Yerel uçlar: uzun ömürlü belirteç yalnız yerel katmanla konuşur, CORS yok, tarayıcı bağlamı reddedilir (nativeOnly)
  const nativeRoutes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
    async '/api/mobile/login'(req, res) {
      if (!isJson(req)) return send(res, 415, { reason: 'contentType' }, true)
      const b = await readJson(req, false, o.bodyLimits?.jsonMs)
      if (!b.ok) return send(res, b.status, { reason: bodyReason(b.status) }, true, { Connection: 'close' })
      if (!strings(b.value, ['username', 'password'], ['totp'])) return send(res, 400, { reason: 'invalid' }, true)
      const r = await auth.login({
        username: b.value.username as string, password: b.value.password as string, totp: (b.value.totp as string | undefined) || undefined,
        ip: clientIp(req, cfg.trustedProxyDepth), userAgent: userAgent(req)
      }, 'mobile')
      if (!r.ok) return send(res, LOGIN_STATUS[r.reason], { reason: r.reason }, true)
      send(res, 200, { token: r.token, user: r.user }, true)
    },
    async '/api/mobile/token'(req, res) {
      const token = bearerToken(req)
      const r = token ? auth.resolve(token, 'mobile') : null
      // idle: oturum push için duruyor, yerel katman push anahtarını silmez; gone: oturum yok, tam silme
      if (!r) return send(res, 401, { reason: token && auth.mobileIdle(token) ? 'idle' : 'gone' }, true)
      const { token: accessToken, expiresAt } = mobile.issueAccess(r.sessionId)
      send(res, 200, { accessToken, expiresAt, user: r.user }, true)
    },
    async '/api/mobile/logout'(req, res) {
      const token = bearerToken(req)
      if (!token) return send(res, 401, { reason: 'unauthenticated' }, true)
      const id = tokenHash(token)
      const devices = hub.deps.q.listPushDevicesForSession(id).filter(isRelayDevice)
      const owner = hub.deps.q.getWebSession(id)?.user_id
      // boşta kalmış oturumda da kapanır; bekleyen çıkış yinelenirse yine 204
      if (auth.logout(token, 'mobile')) {
        if (owner != null) hub.smimeCache.clearUser(owner)
        closeWebSessions(new Set([id]))
        // çıkış röleyi beklemez: düşmeyen kayıt rölede 90 günde süpürülür, motorda satır kalmadığından gönderim yok
        for (const d of devices) void o.relay?.unregister(relayDeviceId(d.endpoint)).catch(() => {})
      }
      send(res, 204, undefined, true)
    }
  }

  const posts: Record<string, (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => Promise<void>> = {
    async '/api/login'(req, res, b) {
      if (!strings(b, ['username', 'password'], ['totp'])) return send(res, 400, { reason: 'invalid' }, true)
      loginResponse(res, await auth.login({
        username: b.username as string, password: b.password as string, totp: (b.totp as string | undefined) || undefined,
        ip: clientIp(req, cfg.trustedProxyDepth), userAgent: userAgent(req)
      }))
    },
    async '/api/logout'(req, res) {
      const token = sessionToken(req)
      if (token) {
        const session = auth.resolve(token)
        if (auth.logout(token)) {
          if (session) hub.smimeCache.clearUser(session.user.id)
          closeWebSessions(new Set([tokenHash(token)]))
        }
      }
      send(res, 204, undefined, true, { 'Set-Cookie': cookie('', 0) })
    },
    async '/api/push/subscribe'(req, res, b) {
      const s = passkeySession(req, res)
      if (!s) return
      const sub = parseSubscription(b, o.pushHosts)
      if (!sub) return send(res, 400, { reason: 'invalid' }, true)
      const id = hub.deps.q.upsertPushDevice({ ...sub, userId: s.user.id, sessionId: s.sessionId, now: (o.now ?? Date.now)() })
      send(res, 200, { id }, true)
    },
    async '/api/mobile/device'(req, res, b) {
      if (!mobileOn) return send(res, 404, { reason: 'notFound' }, true)
      const s = bearerMode(req) ? accessSession(req) : null
      if (!s) return send(res, 401, { reason: 'unauthenticated' }, true)
      if (!o.relay) return send(res, 409, { reason: 'relayOff' }, true)
      const d = parseNativeDevice(b)
      if (!d) return send(res, 400, { reason: 'invalid' }, true)
      let deviceId: string
      try {
        deviceId = await o.relay.register({ platform: d.platform, env: d.env, token: d.token })
      } catch {
        return send(res, 502, { reason: 'relayUnavailable' }, true)
      }
      // beklerken çıkış yapıldıysa satır açılmaz: cihaz oturumuyla ölür
      if (!auth.resolveSession(s.sessionId)) return send(res, 401, { reason: 'unauthenticated' }, true)
      const endpoint = relayEndpoint(deviceId)
      const id = hub.deps.q.upsertPushDevice({
        userId: s.user.id, sessionId: s.sessionId, endpoint, p256dh: d.p256dh, auth: d.auth, label: d.label,
        now: (o.now ?? Date.now)(), kind: d.platform === 'ios' ? 'apns' : 'fcm'
      })
      hub.deps.q.deleteOtherRelayDevices(s.sessionId, endpoint)
      send(res, 200, { id }, true)
    },
    async '/api/notify/action'(req, res, b) {
      const s = deviceSession(req, res)
      if (!s) return
      const input = parseNotifyAction(b)
      if (!input) return send(res, 400, { reason: 'invalid' }, true)
      if (!applyNotifyAction(hub, s.user, input)) return send(res, 403, { reason: 'forbidden' }, true)
      send(res, 204, undefined, true)
    },
    async '/api/passkey/register/options'(req, res, b) {
      const s = passkeySession(req, res)
      if (!s) return
      // oturum yetmez: çalınan oturum kalıcı anahtar ekleyemesin. Challenge yalnız yeniden doğrulamadan sonra
      if (!strings(b, ['password'], ['totp'])) return send(res, 400, { reason: 'invalid' }, true)
      const r = await auth.reauthenticate({
        userId: s.user.id, password: b.password as string, totp: (b.totp as string | undefined) || undefined, ip: clientIp(req, cfg.trustedProxyDepth)
      })
      if (!r.ok) return send(res, LOGIN_STATUS[r.reason], { reason: r.reason }, true)
      send(res, 200, await passkeys.registerOptions(s.user, s.sessionId), true)
    },
    async '/api/passkey/register/verify'(req, res, b) {
      const s = passkeySession(req, res)
      if (!s) return
      if (!isObject(b.response) || typeof b.name !== 'string') return send(res, 400, { reason: 'invalid' }, true)
      const r = await passkeys.registerVerify({ user: s.user, sessionId: s.sessionId, response: b.response, name: b.name })
      if (r.ok) return send(res, 200, { passkey: r.passkey }, true)
      // await sırasında oturum iptal edildi ya da kullanıcı devre dışı kaldı: kayıt yapılmadı
      send(res, r.reason === 'revoked' ? 401 : r.reason === 'duplicate' ? 409 : 400, { reason: r.reason }, true)
    },
    async '/api/passkey/login/options'(req, res) {
      const r = await passkeys.loginOptions(clientIp(req, cfg.trustedProxyDepth))
      if (!r.ok) return send(res, LOGIN_STATUS[r.reason], { reason: r.reason }, true)
      send(res, 200, r.options, true, { 'Set-Cookie': passkeyCookie(r.flowId, PASSKEY_CHALLENGE_TTL_MS / 1000) })
    },
    async '/api/passkey/login/verify'(req, res, b) {
      // akış sonuç ne olursa olsun biter: challenge tüketilir, çerez her yanıtta temizlenir
      const clear = passkeyCookie('', 0)
      const flowId = cookieValue(req, PASSKEY_COOKIE) ?? ''
      if (!isObject(b.response)) {
        passkeys.abandonLogin(flowId)
        return send(res, 400, { reason: 'invalid' }, true, { 'Set-Cookie': clear })
      }
      loginResponse(res, await passkeys.loginVerify({
        flowId, response: b.response, ip: clientIp(req, cfg.trustedProxyDepth), userAgent: userAgent(req)
      }), clear)
    },
    async '/api/2fa/setup/begin'(req, res, b) {
      if (!strings(b, ['username', 'password'])) return send(res, 400, { reason: 'invalid' }, true)
      const r = await auth.setupBegin({ username: b.username as string, password: b.password as string, ip: clientIp(req, cfg.trustedProxyDepth) })
      if (!r.ok) return send(res, r.reason === 'notRequired' ? 409 : LOGIN_STATUS[r.reason], { reason: r.reason }, true)
      send(res, 200, { otpauthUri: r.otpauthUri, secretBase32: r.secretBase32 }, true)
    },
    // web OAuth'u uygulama sayfasından tamamlama (oauthWeb.ts): oturum + işaret çerezi; gm_oauth her yanıtta temizlenir
    async [OAUTH_COMPLETE_PATH](req, res, b) {
      const r = await oauth.complete(req, b)
      if (r.outcome === 'ok') return send(res, 204, undefined, true, { 'Set-Cookie': r.setCookie })
      send(res, 400, { reason: r.outcome }, true, { 'Set-Cookie': r.setCookie })
    },
    async '/api/2fa/setup/confirm'(req, res, b) {
      if (!strings(b, ['username', 'password', 'code'])) return send(res, 400, { reason: 'invalid' }, true)
      loginResponse(res, await auth.setupConfirm({
        username: b.username as string, password: b.password as string, code: b.code as string,
        ip: clientIp(req, cfg.trustedProxyDepth), userAgent: userAgent(req)
      }))
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '/').split('?')[0]
    const api = path === '/api' || path.startsWith('/api/')
    if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true }, false)
    if (req.method === 'GET' && path === '/api/server-info') return send(res, 200, serverInfo(cfg), true)
    if (mobileOn) {
      const origin = req.headers.origin
      const allowed = mobileOrigin(origin) ? origin : undefined
      if (req.method === 'OPTIONS') {
        const h = preflightHeaders(allowed, String(req.headers['access-control-request-method'] ?? ''), path)
        if (h) return send(res, 204, undefined, true, h)
        if (bearerMode(req)) return send(res, 404, { reason: 'notFound' }, api)
      }
      // writeHead önceden konan başlıklarla birleşir: ek yanıtları da CORS alır, 401 de okunabilir olur
      for (const [k, v] of Object.entries(corsHeaders(allowed, req.method ?? '', path))) res.setHeader(k, v)
      // sürüm dizesi yok
      if (req.method === 'GET' && path === MOBILE_HELLO_PATH) return send(res, 200, { product: 'geckomail', api: 1, push: !!o.relay }, true)
      const native = req.method === 'POST' && Object.hasOwn(nativeRoutes, path) ? nativeRoutes[path] : undefined
      if (native) {
        if (!nativeOnly(req)) return send(res, 403, { reason: 'origin' }, true)
        return native(req, res)
      }
      if (bearerMode(req)) {
        if (!isBearerPath(req.method ?? '', path)) return send(res, 401, { reason: 'unauthenticated' }, true)
        if (origin !== undefined && !allowed) return send(res, 403, { reason: 'origin' }, true)
      }
      if (req.method === 'POST' && path === '/api/mobile/ws-ticket') {
        const r = bearerMode(req) ? accessSession(req) : null
        const ticket = r ? mobile.issueTicket(bearerToken(req) as string) : null
        if (!ticket) return send(res, 401, { reason: 'unauthenticated' }, true)
        return send(res, 200, { ticket }, true)
      }
    }
    if (req.method === 'GET' && path === '/api/me') {
      if (bearerMode(req)) {
        const r = accessSession(req)
        return r ? send(res, 200, { user: r.user }, true) : send(res, 401, { reason: 'unauthenticated' }, true)
      }
      const token = sessionToken(req)
      const r = token ? auth.resolve(token) : null
      // çerez sunucudaki süreyi izler: uzatılan oturumda tarayıcı çerezi erken düşmesin
      if (r && token) return send(res, 200, { user: r.user }, true, { 'Set-Cookie': [cookie(token, Math.floor((r.expiresAt - Date.now()) / 1000))] })
      // hiç kullanıcı yoksa web istemcisi giriş yerine create-admin bilgisini gösterir
      return send(res, 401, { reason: 'unauthenticated', setupRequired: hub.deps.q.userCount() === 0 }, true)
    }
    if (path === '/api/upload' || path.startsWith('/api/upload/') || path.startsWith('/api/attachment/') || path.startsWith('/api/smime-attachment/')) {
      // ek uçları oturum ister; çerezli yükleme/silme durum değiştirir: aynı köken
      const r = callerSession(req)
      if (!r) return send(res, 401, { reason: 'unauthenticated' }, true)
      if (req.method !== 'GET' && req.method !== 'HEAD' && !trustedRequest(req)) return send(res, 403, { reason: 'origin' }, true)
      if (await files(req, res, r.user, r.sessionId)) return
      return send(res, 404, { reason: 'notFound' }, true)
    }
    if (path === '/api/backup' || path === '/api/restart' || path.startsWith('/api/restore/')) {
      // hepsi durum değiştirir ya da tüm veriyi verir: oturum ve yönetici rolü sunucuda, durum değiştirenlerde
      // aynı köken (GET /api/restore/status yalnız okur)
      const token = sessionToken(req)
      const r = token ? auth.resolve(token) : null
      if (!r) return send(res, 401, { reason: 'unauthenticated' }, true)
      if (r.user.role !== 'admin') return send(res, 403, { reason: 'forbidden' }, true)
      if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return send(res, 403, { reason: 'origin' }, true)
      const body = async (): Promise<Record<string, unknown> | null> => {
        if (!isJson(req)) {
          send(res, 415, { reason: 'contentType' }, true)
          return null
        }
        const b = await readJson(req, path === '/api/restart', o.bodyLimits?.jsonMs)
        if (b.ok) return b.value
        send(res, b.status, { reason: bodyReason(b.status) }, true, { Connection: 'close' })
        return null
      }
      if (await backups(req, res, r.sessionId, body)) return
      return send(res, 404, { reason: 'notFound' }, true)
    }
    if (path === '/api/passkeys' || path.startsWith('/api/passkeys/')) {
      const s = passkeySession(req, res)
      if (!s) return
      if (req.method === 'GET' && path === '/api/passkeys') return send(res, 200, { passkeys: passkeys.list(s.user.id) }, true)
      if (req.method === 'DELETE' && path !== '/api/passkeys') {
        if (!sameOrigin(req)) return send(res, 403, { reason: 'origin' }, true)
        if (passkeys.remove(s.user.id, path.slice('/api/passkeys/'.length))) return send(res, 204, undefined, true)
      }
      return send(res, 404, { reason: 'notFound' }, true)
    }
    if (path === '/api/push/key' || path === '/api/push/devices' || path.startsWith('/api/push/devices/')) {
      const s = deviceSession(req, res)
      if (!s) return
      if (!trustedRequest(req)) return send(res, 403, { reason: 'origin' }, true)
      if (req.method === 'GET' && path === '/api/push/key') return send(res, 200, { publicKey: (await pushKeys()).publicKey }, true)
      if (req.method === 'GET' && path === '/api/push/devices') {
        // uç nokta ve anahtarlar istemciye geri verilmez
        const devices = hub.deps.q.listPushDevices(s.user.id).map((d) => ({
          id: d.id, label: d.label, createdAt: d.created_at, lastOkAt: d.last_ok_at, current: d.web_session_id === s.sessionId
        }))
        return send(res, 200, { devices }, true)
      }
      if (req.method === 'DELETE' && path.startsWith('/api/push/devices/')) {
        const id = Number(path.slice('/api/push/devices/'.length))
        const device = Number.isSafeInteger(id) ? hub.deps.q.getPushDevice(id) : undefined
        if (device && hub.deps.q.deleteOwnPushDevice(s.user.id, id)) {
          // masaüstü ajanının ve kaybolan telefonun oturumu ancak böyle kapanır: satırı silmek bildirimleri kesmezdi, cihaz kendini yeniden kaydederdi.
          // Telefon kendini kaldırıyorsa yalnız bildirim kapanır, oturum sürer
          const remotePhone = isRelayDevice(device) && device.web_session_id !== s.sessionId
          if ((device.kind === 'desktop' || remotePhone) && device.web_session_id) {
            auth.endSession(device.web_session_id)
            closeWebSessions(new Set([device.web_session_id]))
          }
          // satır gittiyse röle kaydı da gider: kapatılan telefon jetonu rölede kalmaz
          if (isRelayDevice(device)) void o.relay?.unregister(relayDeviceId(device.endpoint)).catch(() => {})
          return send(res, 204, undefined, true)
        }
      }
      return send(res, 404, { reason: 'notFound' }, true)
    }
    if (path === OAUTH_CALLBACK_PATH) {
      if (req.method === 'GET') return oauth.handle(req, res)
      return send(res, 405, { reason: 'method' }, true, { Allow: 'GET' })
    }
    if (!api && path !== '/rpc' && path !== '/healthz') {
      // HSTS sayfada da; static.ts'in writeHead'i önceden konan başlıkla birleşir
      const hsts = securityHeaders({ https, api: false })['Strict-Transport-Security']
      if (hsts) res.setHeader('Strict-Transport-Security', hsts)
      if (serveStatic(req, res, cfg.webDir)) return
    }
    const route = req.method === 'POST' ? posts[path] : undefined
    if (!route) return send(res, 404, { reason: 'notFound' }, api)
    if (!trustedRequest(req)) return send(res, 403, { reason: 'origin' }, true)
    if (!isJson(req)) return send(res, 415, { reason: 'contentType' }, true)
    const body = await readJson(req, path === '/api/logout', o.bodyLimits?.jsonMs)
    // aşımda gövdenin kalanı okunmaz: bağlantı yanıttan sonra kapanır
    if (!body.ok) return send(res, body.status, { reason: bodyReason(body.status) }, true, { Connection: 'close' })
    await route(req, res, body.value)
  }

  const server = new GeckoHttpServer(() => {
    clearInterval(timer)
    clearInterval(heartbeat)
    clearInterval(sessionSweep)
    files.close()
    oauth.close()
    // 1001 (going away) ile nazikçe kapat; karşılık vermeyen soket 1 sn sonra sonlandırılır
    for (const ws of wss.clients) {
      ws.close(1001)
      setTimeout(() => ws.terminate(), 1000).unref()
    }
  }, (req, res) => {
    // gövdesini hiç okumayan yanıtlar (404, 403, 415…): gövdeyi göndermeyen istemci bağlantıyı sonsuza dek tutmasın
    res.once('finish', () => {
      if (req.complete) return
      setTimeout(() => {
        if (!req.complete) req.socket.destroy()
      }, o.bodyLimits?.unreadGraceMs ?? UNREAD_BODY_GRACE_MS).unref()
    })
    handle(req, res).catch(() => {
      // yığın izi ve hata metni yanıta/günlüğe gitmez
      console.error('gecko: HTTP isteği işlenemedi')
      if (!res.headersSent) send(res, 500, { reason: 'internal' }, true)
      else res.destroy()
    })
  })

  // Toplam istek süresi yok: 2 GB geri yükleme yavaş hatta 5 dk'yı (Node varsayılanı) çok aşar. Süreler yol başına:
  // JSON gövdesi, ek yüklemesi, geri yükleme durgunluğu (receive), okunmamış gövde; başlıklar headersTimeout'ta kalır
  server.requestTimeout = 0

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {})
    const reject = (status: number): void => {
      const lines = Object.entries(securityHeaders({ https, api: true })).map(([k, v]) => `${k}: ${v}\r\n`).join('')
      socket.once('finish', () => socket.destroy())
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n${lines}Connection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    if ((req.url ?? '').split('?')[0] !== '/rpc') return reject(404)
    const origin = req.headers.origin
    const ticket = mobileOn ? wsTicket(req) : null
    let check: () => ResolvedSession | null
    /** Biletli soket: erişim belirteciyle biter, revalidate bunu uzatmaz */
    let accessExpiresAt: number | null = null
    if (ticket !== null || bearerMode(req)) {
      // bilet yolu: çerez okunmaz. Köken önce denetlenir: reddedilen istek geçerli bileti yakmasın
      if (origin !== undefined && !mobileOrigin(origin)) return reject(403)
      const entry = ticket !== null ? mobile.consumeTicket(ticket) : null
      if (!entry) return reject(401)
      accessExpiresAt = entry.accessExpiresAt
      check = () => auth.resolveSession(entry.sessionId)
    } else {
      if (!sameOrigin(req)) return reject(403)
      const token = sessionToken(req)
      if (!token) return reject(401)
      check = () => auth.resolve(token)
    }
    const r = check()
    if (!r) return reject(401)
    const ip = clientIp(req, cfg.trustedProxyDepth)
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {}) // maxPayload aşımı vb.: ws soketi kapatır, süreç düşmesin
      alive.set(ws, true)
      ws.on('pong', () => alive.set(ws, true))
      const s = hub.openSession(fromWebSocket(ws), { user: r.user, webSessionId: r.sessionId, ip, ticket: accessExpiresAt !== null })
      tokens.set(s, check)
      ws.on('close', () => tokens.delete(s))
      if (accessExpiresAt !== null) {
        const renew = setTimeout(() => ws.close(WS_CLOSE_RENEW), Math.max(0, accessExpiresAt - (o.now ?? Date.now)()))
        renew.unref()
        ws.on('close', () => clearTimeout(renew))
      }
      // akış sürerken kopan bağlantı: 'oauth:returned' kaçmış olabilir, dönmüş akış yeni kanalda yeniden duyurulur
      oauth.resendReturned(r.sessionId)
    })
  })

  return server
}
