// Main sürecin sunucuyla kendi WebSocket'i: pencere kapalıyken bildirim, eylem ve taşıma bunu kullanır. Oturum çerezi yalnız
// bu istek başlığında ve bellekte durur: günlüğe, olaya, hataya yazılmaz. Sunucudan gelen her çerçeve düşman sayılır: burası
// sınırdır, içeri yalnız doğrulanmış bildirim ve izinli olay girer.
import { getCACertificates } from 'tls'
import WebSocket from 'ws'
import type { PushActionId, ServerNotify } from '../shared/pushTypes'

export type LinkState = 'online' | 'offline' | 'signedOut'

/** wsPort.ts WS_CLOSE_REVOKED */
const CLOSE_REVOKED = 4401
const HANDSHAKE_MS = 5000
const SILENCE_MS = 75_000
const CALL_TIMEOUT_MS = 30_000
/** Uyanışta açık görünen soket bu süre içinde yanıt vermezse ölüdür */
const NUDGE_PROBE_MS = 5000
const BACKOFF_MS = [1000, 2000, 5000, 15_000, 30_000, 60_000]
/** Kopuştan sonra fazlası tek özet olur */
const MAX_INDIVIDUAL = 5
/** Masaüstü ajanına giden en büyük meşru çerçeve bildirim ve kısa olaylardır; `ws` varsayılanı 100 MiB */
const MAX_FRAME = 1024 * 1024
const SERVER_EVENTS = new Set(['server:notify', 'counts:changed', 'messages:changed', 'sync:hello'])
const NOTIFY_ACTIONS: readonly PushActionId[] = ['read', 'archive', 'reply']
const MAX_TITLE = 512
const MAX_BODY = 4096
const MAX_TAG = 256
/** Sunucunun kuyruğu 50 ögedir */
const MAX_BACKLOG = 100
const NOTIFY_BURST = 10
const NOTIFY_REFILL_MS = 6000
const FLOOD_SUMMARY_MS = 30_000

const safeId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

/** Kimlikler toast argümanına ve eyleme gider, metinler işletim sistemine: türü ve boyu burada kesinleşir */
export function parseServerNotify(v: unknown): ServerNotify | null {
  if (typeof v !== 'object' || v === null) return null
  const n = v as Record<string, unknown>
  const idOk = (x: unknown): boolean => x === null || safeId(x)
  if (typeof n.title !== 'string' || typeof n.body !== 'string' || typeof n.tag !== 'string' || !idOk(n.messageId) || !idOk(n.accountId) || !safeId(n.seq)) return null
  if (n.level !== 'silent' && n.level !== 'normal' && n.level !== 'urgent') return null
  const actions = Array.isArray(n.actions) ? NOTIFY_ACTIONS.filter((a) => (n.actions as unknown[]).includes(a)) : []
  return {
    title: n.title.slice(0, MAX_TITLE), body: n.body.slice(0, MAX_BODY), tag: n.tag.slice(0, MAX_TAG), accountId: n.accountId as number | null,
    messageId: n.messageId as number | null, level: n.level, count: safeId(n.count) ? n.count : 1, actions, seq: n.seq as number
  }
}

/** Bozuk yanıtta null: imleç geri gitmez ya da bozulmaz */
function parseBacklog(v: unknown): Backlog | null {
  const r = v as Partial<Backlog> | null
  if (typeof r !== 'object' || r === null || !Array.isArray(r.items)) return null
  const items = r.items.slice(0, MAX_BACKLOG).map(parseServerNotify).filter((i): i is ServerNotify => !!i)
  return { items, lastSeq: safeId(r.lastSeq) ? r.lastSeq : 0, truncated: r.truncated === true }
}

interface Backlog { items: ServerNotify[]; lastSeq: number; truncated: boolean }
interface Pending { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }

export interface ServerLinkOptions {
  origin: string
  /** gm_session değeri; yoksa null */
  cookie(): Promise<string | null>
  userAgent: string
  WebSocketImpl?: typeof WebSocket
  now?: () => number
  backoffMs?: number[]
  silenceMs?: number
  onState(s: LinkState): void
  /** Sunucu olayları, ayrıca 'agent:ready' (kayıt ve kaçan bildirim sorgusu bitti) ve 'agent:summary' ({ count, truncated }) */
  onEvent(event: string, data: unknown): void
  deviceId: string
  label: string
  /** false: cihaz satırı açılmaz, oturum uzatılmaz (taşıma bağlantısı: kullanıcı bu sunucuya hiç geçmeyebilir) */
  registerAgent?: boolean
  notifyBurst?: number
  notifyRefillMs?: number
  floodSummaryMs?: number
}

/** Node `ws` sistem CA deposunu görmez: özel CA'lı sunucu için açıkça verilir. Doğrulama kapatılmaz */
function trustedCa(): string[] | undefined {
  try {
    return [...getCACertificates('default'), ...getCACertificates('system')]
  } catch {
    return undefined
  }
}

export class ServerLink {
  private ws: WebSocket | null = null
  private running = false
  private state: LinkState | null = null
  private attempt = 0
  private retry: ReturnType<typeof setTimeout> | null = null
  private watchdog: ReturnType<typeof setInterval> | null = null
  private lastFrame = 0
  private deadline = Infinity
  private seq = 0
  private pending = new Map<number, Pending>()
  /** Son işlenen sıra numarası. Yalnız bellekte; null: ilk bağlantı, geçmiş gösterilmez */
  private cursor: number | null = null
  /** Kaçan bildirim sorgusu sürerken canlı gelenler: iki kez gösterilmesin */
  private catchingUp: Set<number> | null = null
  /** Çerez beklenirken stop/start olursa eski deneme soket açmasın */
  private generation = 0
  private tokens: number
  private lastRefill = 0
  private suppressed = 0
  private floodTimer: ReturnType<typeof setTimeout> | null = null
  private readonly silenceMs: number
  private readonly now: () => number
  private readonly backoff: number[]

  constructor(private readonly o: ServerLinkOptions) {
    this.silenceMs = o.silenceMs ?? SILENCE_MS
    this.now = o.now ?? Date.now
    this.backoff = o.backoffMs ?? BACKOFF_MS
    this.tokens = o.notifyBurst ?? NOTIFY_BURST
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.state = null
    this.attempt = 0
    void this.connect()
  }

  stop(): void {
    this.running = false
    this.generation++
    this.cursor = null // sonraki oturum başka kullanıcının olabilir
    this.catchingUp = null
    this.suppressed = 0
    if (this.floodTimer) clearTimeout(this.floodTimer)
    this.floodTimer = null
    this.clearRetry()
    this.drop()
  }

  /** Uyanış ya da ağ geldi: bekleyen deneme öne alınır, açık soket sınanır. Oturum bitmişse çerez değişmeden denenmez */
  nudge(): void {
    if (!this.running || this.state === 'signedOut') return
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (this.now() - this.lastFrame >= this.silenceMs) return void this.ws.terminate()
      this.deadline = this.now() + NUDGE_PROBE_MS
      this.ws.ping()
      return
    }
    if (this.retry) {
      this.clearRetry()
      void this.connect()
    }
  }

  call<T>(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    return new Promise((resolve, reject) => {
      const ws = this.ws
      if (ws?.readyState !== WebSocket.OPEN) return reject(new Error('sunucu bağlantısı yok'))
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('sunucu yanıt vermedi'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  private setState(s: LinkState): void {
    if (s === this.state) return
    this.state = s
    this.o.onState(s)
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
  }

  private drop(): void {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    const ws = this.ws
    this.ws = null
    ws?.removeAllListeners()
    ws?.on('error', () => {}) // kapanış sırasındaki hata süreci düşürmesin
    ws?.terminate()
    this.failPending()
  }

  private failPending(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('sunucu bağlantısı koptu'))
    }
    this.pending.clear()
  }

  private async connect(): Promise<void> {
    this.retry = null
    const generation = ++this.generation
    let token: string | null = null
    try {
      token = await this.o.cookie()
    } catch {
      /* çerez deposu okunamadı: oturumsuz sayılır */
    }
    if (!this.running || generation !== this.generation) return
    if (!token) return this.setState('signedOut')
    const url = `${this.o.origin.replace(/^http/, 'ws')}/rpc`
    const Impl = this.o.WebSocketImpl ?? WebSocket
    const ws = new Impl(url, {
      headers: { Cookie: `gm_session=${token}`, Origin: this.o.origin, 'User-Agent': this.o.userAgent },
      handshakeTimeout: HANDSHAKE_MS,
      maxPayload: MAX_FRAME,
      ...(url.startsWith('wss:') ? { ca: trustedCa() } : {})
    })
    this.ws = ws
    let rejected = 0
    ws.on('unexpected-response', (_req, res) => {
      rejected = res.statusCode ?? 0
      ws.terminate()
    })
    ws.on('error', () => {}) // 'close' izler; ayrıntı başlık içerebilir, yazılmaz
    ws.on('open', () => {
      if (this.ws === ws) this.onOpen(ws)
    })
    ws.on('message', (raw) => {
      if (this.ws === ws) this.onFrame(raw.toString())
    })
    ws.on('ping', () => this.touch())
    ws.on('pong', () => this.touch())
    ws.on('close', (code) => {
      if (this.ws !== ws) return
      this.drop()
      if (!this.running) return
      if (code === CLOSE_REVOKED || rejected === 401) return this.setState('signedOut')
      this.setState('offline')
      const delay = this.backoff[Math.min(this.attempt++, this.backoff.length - 1)]
      this.retry = setTimeout(() => void this.connect(), delay)
    })
  }

  private touch(): void {
    this.lastFrame = this.now()
    this.deadline = Infinity
  }

  private onOpen(ws: WebSocket): void {
    this.attempt = 0
    this.touch()
    // uykuda zamanlayıcı durur: saat farkıyla da yakalanır
    this.watchdog = setInterval(() => {
      if (this.now() - this.lastFrame >= this.silenceMs || this.now() >= this.deadline) ws.terminate()
    }, Math.min(Math.ceil(this.silenceMs / 3), 5000))
    this.setState('online')
    void this.catchUp()
  }

  /** Kayıt her bağlantıda: satır oturum uzamasını taşır, silinmiş olabilir */
  private async catchUp(): Promise<void> {
    const ws = this.ws
    const seen = new Set<number>()
    this.catchingUp = seen
    try {
      if (this.o.registerAgent !== false) await this.call('registerDesktopAgent', { deviceId: this.o.deviceId, label: this.o.label })
      const first = this.cursor === null
      const r = parseBacklog(await this.call('notifyBacklog', { afterSeq: this.cursor ?? Number.MAX_SAFE_INTEGER }))
      if (this.ws !== ws) return
      if (!r) {
        this.catchingUp = null
        return this.o.onEvent('agent:ready', {})
      }
      if (!first) this.showMissed(r, seen)
      this.cursor = Math.max(r.lastSeq, ...seen)
      this.catchingUp = null
      this.o.onEvent('agent:ready', {})
    } catch {
      /* bağlantı koptu: sonraki bağlantıda aynı `cursor` ile sorulur */
    }
  }

  private showMissed(r: Backlog, seen: Set<number>): void {
    const missed = r.items.filter((i) => !seen.has(i.seq))
    if (missed.length > MAX_INDIVIDUAL) return this.o.onEvent('agent:summary', { count: missed.length, truncated: r.truncated })
    for (const item of missed) this.deliver(item)
    if (r.truncated) this.o.onEvent('agent:summary', { count: missed.length, truncated: true })
  }

  /** Sel: fazlası tek özet olur, işletim sistemi bildirim merkezi ve ana süreç boğulmaz */
  private deliver(item: ServerNotify): void {
    const burst = this.o.notifyBurst ?? NOTIFY_BURST
    const refill = this.o.notifyRefillMs ?? NOTIFY_REFILL_MS
    const now = this.now()
    this.tokens = Math.min(burst, this.tokens + (now - this.lastRefill) / refill)
    this.lastRefill = now
    if (this.tokens >= 1) {
      this.tokens--
      return this.o.onEvent('server:notify', item)
    }
    this.suppressed++
    this.floodTimer ??= setTimeout(() => {
      this.floodTimer = null
      const count = this.suppressed
      this.suppressed = 0
      if (count) this.o.onEvent('agent:summary', { count, truncated: false, flood: true })
    }, this.o.floodSummaryMs ?? FLOOD_SUMMARY_MS)
  }

  private onFrame(raw: string): void {
    this.touch()
    try {
      const m = JSON.parse(raw) as { id?: number; ok?: boolean; result?: unknown; error?: unknown; event?: unknown; data?: unknown } | null
      if (typeof m !== 'object' || m === null) return
      if (typeof m.event === 'string') return this.onServerEvent(m.event, m.data)
      const p = m.id === undefined ? undefined : this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id!)
      clearTimeout(p.timer)
      if (m.ok === false || m.error !== undefined) p.reject(new Error(String(m.error ?? 'hata')))
      else p.resolve(m.result)
    } catch {
      /* bozuk çerçeve ya da dinleyici hatası `ws` dinleyicisinden ana sürece taşmaz */
    }
  }

  /** İç `agent:*` olayları buradan girmez */
  private onServerEvent(event: string, data: unknown): void {
    if (!SERVER_EVENTS.has(event)) return
    if (event !== 'server:notify') return this.o.onEvent(event, data)
    const item = parseServerNotify(data)
    if (!item) return
    if (this.catchingUp) this.catchingUp.add(item.seq)
    else if (this.cursor !== null) this.cursor = Math.max(this.cursor, item.seq)
    this.deliver(item)
  }
}
