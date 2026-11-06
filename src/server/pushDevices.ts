// Push cihazları ve dağıtım: abonelik doğrulama ile bildirim hattının sunucu tarafı alıcısı (PushSink). Web Push doğrudan
// servise, APNs/FCM cihazları sabit boylu şifreli kutuyla geckomail-relay üzerinden gider; TTL ve öncelik burada ayrılmaz.
// Oran sınırı kullanıcı başına, eşzamanlılık cihaz başına; kuyruk ve bekleyen denemeler yalnız bellekte
// (süreç yeniden başlarsa kaybolur). Her gönderimden önce cihaz satırı yeniden okunur: çıkış ya da iptal
// sonrası kuyrukta kalan bildirim gitmez. Cihaz oturumuyla ölür: oturumu bitmiş cihaza gönderilmez, satırı silinir.
import { createHash, ECDH } from 'crypto'
import { getLocale, isLocale, tFor } from '../shared/i18n'
import { encodeNative, type NativePayload } from '../shared/nativePush'
import type { NativeDeviceInput, PushActionId, PushItem, PushPayload, ServerNotify } from '../shared/pushTypes'
import { validDeviceToken, type RelayEnv, type RelayPlatform, type RelayResult } from '../shared/relayProtocol'
import type { PushDevice, Queries } from '../sync/db/queries'
import { isRelayDevice, pushTransport } from '../sync/db/q/pushDevices'
import type { EngineHost } from '../sync/host'
import type { NotifySink } from '../sync/notifyPipeline'
import type { RpcHub } from '../sync/rpcHub'
import { sessionUserFromRow } from '../sync/auth/sessionUser'
import { sessionPushLive } from './auth'
import { notifyActionsFor } from './notifyActions'
import { relayDeviceId, type RelayClient } from './relayClient'
import { encryptPayload, isAllowedPushHost, loadOrCreateVapid, sendPush, type VapidKeys } from './webPush'

const RATE_MAX = 30
const RATE_WINDOW_MS = 60_000
const RETRY_MS = 30_000
const TTL_NORMAL_S = 3600
const TTL_URGENT_S = 86400
/** Şifreli gövde push servislerinin 4 KB sınırının altında kalsın */
const MAX_PAYLOAD = 3 * 1024
/** Yanıtsız serviste cihaz kuyruğu büyümesin */
const MAX_QUEUE = 30
const MAX_ENDPOINT = 2048
const MAX_LABEL = 100

/** Etiket içerik taşıyabilir (hat `notice:hesap:başlık:gövde` üretir): cihaza sabit uzunlukta özeti gider */
export const pushTag = (tag: string): string => createHash('sha256').update(tag).digest('hex').slice(0, 16)

export const pushSubject = (publicOrigin: string): string => `mailto:postmaster@${new URL(publicOrigin).hostname}`

/** Anahtarlar ilk gerektiğinde yüklenir, sonra bellekten; başarısız yükleme önbelleğe alınmaz */
export function vapidLoader(q: Queries, host: Pick<EngineHost, 'encrypt' | 'decrypt'>): () => Promise<VapidKeys> {
  let p: Promise<VapidKeys> | null = null
  return () => (p ??= loadOrCreateVapid(q, host).catch((e) => {
    p = null
    throw e
  }))
}

function validP256dh(v: string): boolean {
  const raw = Buffer.from(v, 'base64url')
  if (raw.length !== 65 || raw[0] !== 4) return false
  try {
    ECDH.convertKey(raw, 'prime256v1') // eğri üzerinde değilse fırlatır
    return true
  } catch {
    return false
  }
}

/** POST /api/push/subscribe gövdesi; izinsiz ana makine ya da bozuk anahtar: null */
export function parseSubscription(b: Record<string, unknown>, extraHosts?: string[]): { endpoint: string; p256dh: string; auth: string; label: string | null } | null {
  const { endpoint, keys, label } = b
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT || !isAllowedPushHost(endpoint, extraHosts)) return null
  if (!keys || typeof keys !== 'object') return null
  const { p256dh, auth } = keys as Record<string, unknown>
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null
  if (!validP256dh(p256dh) || Buffer.from(auth, 'base64url').length !== 16) return null
  if (label != null && typeof label !== 'string') return null
  return { endpoint, p256dh, auth, label: label ? label.slice(0, MAX_LABEL) : null }
}

const PLATFORMS: readonly RelayPlatform[] = ['ios', 'android']
const ENVS: readonly RelayEnv[] = ['production', 'sandbox']

/** POST /api/mobile/device gövdesi; bozuk alan: null */
export function parseNativeDevice(b: Record<string, unknown>): NativeDeviceInput | null {
  const { platform, env, token, p256dh, auth, label } = b
  if (!PLATFORMS.includes(platform as RelayPlatform) || !ENVS.includes(env as RelayEnv)) return null
  if (typeof token !== 'string' || !validDeviceToken(platform as RelayPlatform, token)) return null
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null
  if (!validP256dh(p256dh) || Buffer.from(auth, 'base64url').length !== 16) return null
  if (label != null && typeof label !== 'string') return null
  return { platform: platform as RelayPlatform, env: env as RelayEnv, token, p256dh, auth, label: label ? label.slice(0, MAX_LABEL) : null }
}

function shorten(s: string): string {
  const chars = Array.from(s) // vekil çifti bölünmesin
  return chars.slice(0, Math.floor(chars.length * 0.75)).join('')
}

/** Yük MAX_PAYLOAD'a sığana dek uzun olan metin kısalır. Kalan alanlar sabit boyda (etiket özet, eylem metinleri i18n) */
function fitPayload(p: PushPayload): PushPayload {
  const limit = MAX_PAYLOAD - 16 // üç nokta için pay
  const size = (x: PushPayload): number => Buffer.byteLength(JSON.stringify(x))
  if (size(p) <= MAX_PAYLOAD) return p
  let { title, body } = p
  while (size({ ...p, title, body }) > limit && (title || body)) {
    if (body.length >= title.length) body = shorten(body)
    else title = shorten(title)
  }
  return { ...p, title: title === p.title ? title : `${title}…`, body: body ? `${body}…` : body }
}

interface Job { userId: number; deviceId: number; payload: PushPayload; retried: boolean }
interface RateWindow { sent: number; held: number; urgent: boolean }

export interface PushSinkOptions {
  q: Queries
  keys(): Promise<VapidKeys>
  subject: string
  /** bağlı oturumlara `server:notify` yayını */
  broadcast(userId: number, item: Omit<ServerNotify, 'seq'>): void
  fetch?: typeof fetch
  now?: () => number
  /** testler: yeniden deneme beklemesi ve oran penceresi */
  retryMs?: number
  windowMs?: number
  /** yalnız testler: createHttpServer'ın pushHosts seçeneğiyle aynı */
  extraHosts?: string[]
  /** null: röle kapalı (GECKO_RELAY_URL=off), yerel cihazlara gönderilmez ama satırları kalır */
  relay?: (Pick<RelayClient, 'push'> & Partial<Pick<RelayClient, 'unregister'>>) | null
}

/** Bildirim hattının sunucu alıcısı */
export class PushSink implements NotifySink {
  private readonly rate = new Map<number, RateWindow>()
  /** cihaz → bekleyen işler; kayıt varsa cihazın gönderimi sürüyor */
  private readonly queues = new Map<number, Job[]>()
  private readonly timers = new Set<NodeJS.Timeout>()
  private readonly abort = new AbortController()
  private closed = false

  constructor(private readonly o: PushSinkOptions) {}

  deliver(userId: number, items: PushItem[]): void {
    if (this.closed) return
    for (const raw of items) {
      // oturuma da özet etiket: sekme içi gösterim ile push aynı etiketle birleşir
      const item = { ...raw, tag: pushTag(raw.tag) }
      this.o.broadcast(userId, { ...item, actions: this.actions(userId, item) })
      this.admit(userId, item)
    }
  }

  close(): void {
    this.closed = true
    this.abort.abort()
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t)
      fn()
    }, ms)
    t.unref()
    this.timers.add(t)
  }

  /** Pencerede sınır dolduysa öge sayılır, pencere bitince tek özet gider */
  private admit(userId: number, item: PushItem): void {
    const devices = this.liveDevices(userId).filter((d) => this.o.relay || !isRelayDevice(d))
    if (!devices.length) return
    let w = this.rate.get(userId)
    if (!w) {
      const opened: RateWindow = { sent: 0, held: 0, urgent: false }
      w = opened
      this.rate.set(userId, opened)
      this.later(this.o.windowMs ?? RATE_WINDOW_MS, () => {
        this.rate.delete(userId)
        if (opened.held) this.admit(userId, this.summary(userId, opened))
      })
    }
    if (w.sent < RATE_MAX) {
      w.sent++
      const payload = this.payload(userId, item)
      for (const d of devices) this.enqueue({ userId, deviceId: d.id, payload, retried: false })
    } else {
      w.held += Math.max(1, item.count)
      w.urgent ||= item.level === 'urgent'
    }
  }

  /** Oturumu bitmiş cihaz (süpürme henüz geçmemiş olabilir) gönderim almaz, satırı silinir. Masaüstü ajanı push almaz,
   *  satırı oturum temizliğine bırakılır */
  private liveDevices(userId: number): PushDevice[] {
    const { q } = this.o
    const now = (this.o.now ?? Date.now)()
    return q.listPushDevices(userId).filter((d) => {
      if (pushTransport(d) === 'desktop') return false
      const s = d.web_session_id ? q.getWebSession(d.web_session_id) : undefined
      if (s && sessionPushLive(s, now)) return true
      q.deletePushDevice(d.id, d.endpoint)
      if (isRelayDevice(d)) void this.o.relay?.unregister?.(relayDeviceId(d.endpoint)).catch(() => {})
      return false
    })
  }

  private locale(userId: number): ReturnType<typeof getLocale> {
    const saved = this.o.q.userPrefGet(userId, 'locale')
    return isLocale(saved) ? saved : getLocale()
  }

  private summary(userId: number, w: RateWindow): PushItem {
    const loc = this.locale(userId)
    return {
      title: tFor(loc, 'sync.notify.newMailFallback'), body: tFor(loc, 'sync.notify.newMail', { count: w.held }),
      accountId: null, messageId: null, level: w.urgent ? 'urgent' : 'normal', tag: 'push-summary', count: w.held
    }
  }

  private payload(userId: number, item: PushItem): PushPayload {
    const loc = this.locale(userId)
    // kasa hesabı: gönderen, konu ve hesap adresi cihaza gitmez
    const hidden = item.accountId != null && this.o.q.isAccountSecure(item.accountId)
    return fitPayload({
      ...item,
      title: hidden ? tFor(loc, 'sync.notify.newMailFallback') : item.title,
      body: hidden ? '' : item.body,
      actions: this.actions(userId, item).map((action) => ({ action, title: tFor(loc, `sync.notify.action.${action}`) }))
    })
  }

  private actions(userId: number, item: PushItem): PushActionId[] {
    const { q } = this.o
    const row = q.getUserById(userId)
    return row ? notifyActionsFor(q, sessionUserFromRow(q, row), item) : []
  }

  private enqueue(job: Job): void {
    const queue = this.queues.get(job.deviceId)
    if (queue) {
      if (queue.length >= MAX_QUEUE) {
        // taşmada önce en eski normal öge düşer; acil öge hiç düşmez
        const i = queue.findIndex((j) => j.payload.level !== 'urgent')
        if (i >= 0) queue.splice(i, 1)
        else if (job.payload.level !== 'urgent') return
      }
      queue.push(job)
      return
    }
    this.queues.set(job.deviceId, [job])
    void this.drain(job.deviceId)
  }

  private async drain(deviceId: number): Promise<void> {
    const queue = this.queues.get(deviceId)!
    for (let job = queue.shift(); job; job = queue.shift()) {
      // yalnız hata adı: ileti uç noktayı içerebilir
      await this.run(job).catch((e: Error) => console.error(`gecko: push gönderilemedi (${e.name})`))
    }
    this.queues.delete(deviceId)
  }

  private async run(job: Job): Promise<void> {
    if (this.closed) return
    const { q } = this.o
    const first = q.getPushDevice(job.deviceId)
    // yerel cihaz VAPID istemez: anahtar sorunu mobil bildirimi durdurmasın
    const keys = first && !isRelayDevice(first) ? await this.o.keys() : null
    if (this.closed) return
    const d = q.getPushDevice(job.deviceId)
    // bu arada çıkış/iptal oldu ya da uç nokta başka kullanıcıya geçti
    if (!d || d.user_id !== job.userId) return
    const r = keys ? await this.sendWeb(d, job.payload, keys) : await this.sendRelay(d, job.payload)
    if (this.closed) return
    if (r === 'ok') {
      q.touchPushDevice(d.id, (this.o.now ?? Date.now)())
      console.log(`gecko: push gönderildi (kullanıcı ${d.user_id})`)
    } else if (r === 'gone') {
      q.deletePushDevice(d.id, d.endpoint)
      console.log(`gecko: push aboneliği bitmiş, cihaz silindi (kullanıcı ${d.user_id})`)
    } else if (!job.retried) this.later(this.o.retryMs ?? RETRY_MS, () => this.enqueue({ ...job, retried: true }))
    else console.log(`gecko: push iki denemede gitmedi, bırakıldı (kullanıcı ${d.user_id})`)
  }

  private sendWeb(d: PushDevice, payload: PushPayload, keys: VapidKeys): Promise<RelayResult> {
    const urgent = payload.level === 'urgent'
    return sendPush(d, payload, {
      keys, subject: this.o.subject, urgency: urgent ? 'high' : 'normal', ttl: urgent ? TTL_URGENT_S : TTL_NORMAL_S,
      fetch: this.o.fetch, extraHosts: this.o.extraHosts, signal: this.abort.signal
    })
  }

  /** Seviye yalnız şifreli kutunun içindedir; röle bütün yükleri aynı boyda ve aynı öncelikte görür */
  private async sendRelay(d: PushDevice, payload: PushPayload): Promise<RelayResult> {
    const { relay } = this.o
    if (!relay) return 'retry'
    const native: NativePayload = {
      v: 1, title: payload.title, body: payload.body, accountId: payload.accountId, messageId: payload.messageId,
      level: payload.level === 'urgent' ? 'urgent' : 'normal', tag: payload.tag, count: payload.count, ts: (this.o.now ?? Date.now)(),
      actions: payload.actions.map((a) => a.action)
    }
    return relay.push(relayDeviceId(d.endpoint), encryptPayload(encodeNative(native), d.p256dh, d.auth).toString('base64url'), this.abort.signal)
  }
}

/** cli'nin kullandığı bağlama: oturumlara yayın öge olduğu gibi (kasa dahil, yalnız kullanıcının kendi oturumları),
 *  push yükü `payload` içinde kasa için soyulur. extraHosts yalnız testler (createHttpServer pushHosts) */
export function serverPushSink(o: {
  q: Queries; host: Pick<EngineHost, 'encrypt' | 'decrypt'>; hub: Pick<RpcHub, 'notifyUser'>; publicOrigin: string; extraHosts?: string[]
  relay?: PushSinkOptions['relay']
}): PushSink {
  return new PushSink({
    q: o.q, keys: vapidLoader(o.q, o.host), subject: pushSubject(o.publicOrigin), extraHosts: o.extraHosts, relay: o.relay,
    broadcast: (userId, item) => o.hub.notifyUser(userId, item)
  })
}
