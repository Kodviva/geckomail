import type { RpcEventName, RpcEvents, RpcMethods, RpcWireDown } from '../../shared/rpc'
import { t } from '../../shared/i18n'
import { messagePortTransport, type RpcTransport, type TransportState } from './transport'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; sent: boolean }

const SLOW_METHODS = new Set(['getBody', 'getAttachment', 'importAccounts', 'importPreview', 'discoverMailServers', 'serverAdminAccountDiff', 'testWebhook', 'getInvite', 'respondInvite', 'getRawSource', 'syncPush', 'syncPull'])

type LocalEvent = 'local:connected' | 'local:disconnected' | 'local:revoked' | 'local:restarted' | 'local:open-account' | 'local:open-message' | 'local:open-reply' | 'local:menu'

export class RpcClient {
  private transport: RpcTransport | null = null
  private open = false
  private seq = 0
  private pending = new Map<number, Pending>()
  private handlers = new Map<string, Set<(data: unknown) => void>>()
  private sendQueue: Array<() => void> = []
  private initialized = false
  private failFast = false

  /** Taşıma açık mı (kapalıyken çağrılar kuyruğa girer) */
  get isOpen(): boolean {
    return this.open
  }

  /** Taşıma başlatılmış mı (açık ya da yeniden bağlanıyor) */
  get running(): boolean {
    return this.transport !== null
  }

  /** Masaüstü: preload'un MessagePort'u (bugünkü akış) */
  init(): void {
    if (this.initialized) return
    this.initialized = true
    this.start(messagePortTransport())
  }

  /** Taşımayı başlatır (web: giriş doğrulandıktan sonra WebSocket); varsa öncekini kapatır */
  start(transport: RpcTransport): void {
    if (this.transport) this.stop()
    // önceki oturumdan (taşıma revoked ile düşmüş olsa da) kalan kuyruk yeni oturumun bağlantısında gitmesin
    this.sendQueue = []
    this.transport = transport
    transport.start(
      (m) => {
        if (this.transport === transport) this.onMessage(m as RpcWireDown)
      },
      (st) => {
        if (this.transport === transport) this.onState(st)
      }
    )
  }

  /** Web çevrimdışı modu: taşıma kapalıyken çağrılar kuyruğa girmez, hemen reddedilir. Kopuştan bu yana kuyruğa
   *  girmişler de reddedilir: salt okunur moda geçmeden istenen yazma yeniden bağlanınca gitmesin. */
  setFailFast(on: boolean): void {
    this.failFast = on
    if (!on) return
    this.sendQueue = []
    this.rejectPending(true, t('common.offlineReadOnly'))
  }

  /** Taşımayı kapatır (web çıkışı): bekleyen ve kuyruktaki çağrılar reddedilir */
  stop(): void {
    const tr = this.transport
    this.transport = null
    this.open = false
    tr?.close()
    this.sendQueue = []
    this.rejectPending(true)
  }

  /** Oturum taşıma dışında bitti (mobil belirteç reddedildi): taşıma kapanır, 'local:revoked' tek yerden işlenir */
  revoke(): void {
    this.stop()
    this.emitLocal('local:revoked', {})
  }

  private onState(st: TransportState): void {
    if (st === 'open') {
      this.open = true
      const q = this.sendQueue
      this.sendQueue = []
      q.forEach((f) => f())
      this.emitLocal('local:connected', {})
      return
    }
    this.open = false
    if (st === 'renewing') {
      // yanıtı gelmeyecek çağrılar düşer, kuyruk yeni soketi bekler; arayüz kopuş görmez
      this.rejectPending(false)
      return
    }
    if (st === 'revoked') {
      // oturum iptal: taşıma yeniden bağlanmaz, kuyruk da gönderilmeyecek
      this.transport = null
      this.sendQueue = []
      this.rejectPending(true)
      this.emitLocal('local:revoked', {})
      return
    }
    // gönderilmiş çağrının yanıtı artık gelmez; kuyruktakiler yeniden bağlanınca gider
    this.rejectPending(false)
    this.emitLocal('local:disconnected', {})
  }

  private rejectPending(all: boolean, message = t('common.rpcDisconnected')): void {
    for (const [id, p] of this.pending) {
      if (!all && !p.sent) continue
      this.pending.delete(id)
      clearTimeout(p.timer)
      p.reject(new Error(message))
    }
  }

  private onMessage(msg: RpcWireDown): void {
    if ('event' in msg) {
      this.emitLocal(msg.event, msg.data)
      return
    }
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error))
  }

  private emitLocal(event: string, data: unknown): void {
    this.handlers.get(event)?.forEach((cb) => cb(data))
  }

  call<M extends keyof RpcMethods>(
    method: M,
    params: Parameters<RpcMethods[M]>[0]
  ): Promise<ReturnType<RpcMethods[M]>> {
    return new Promise((resolve, reject) => {
      if (this.failFast && !this.open) return reject(new Error(t('common.offlineReadOnly')))
      const id = ++this.seq
      // oauthFinish kullanıcının tarayıcıda izin vermesini bekler (akış 5 dk'da kendisi düşer)
      const timeoutMs = method === 'oauthFinish' ? 330_000 : SLOW_METHODS.has(method) ? 180_000 : 30_000
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(t('common.rpcTimeout', { method })))
      }, timeoutMs)
      const p: Pending = { resolve: resolve as (v: unknown) => void, reject, timer, sent: false }
      this.pending.set(id, p)
      const send = () => {
        // kuyrukta zaman aşımına uğradı: çağıran hata gördü (yeniden deneyebilir), geç çalışmasın
        if (!this.pending.has(id)) return
        p.sent = true
        this.transport?.send({ id, method, params })
      }
      if (this.open) send()
      else this.sendQueue.push(send)
    })
  }

  on<E extends RpcEventName | LocalEvent>(
    event: E,
    cb: (
      data: E extends RpcEventName
        ? RpcEvents[E]
        : E extends 'local:open-account'
          ? { accountId: number }
          : E extends 'local:open-message' | 'local:open-reply'
            ? { messageId: number; accountId: number | null }
            : E extends 'local:menu'
              ? { action: string }
              : Record<string, never>
    ) => void
  ): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(cb as (data: unknown) => void)
    return () => set!.delete(cb as (data: unknown) => void)
  }
}

export const rpc = new RpcClient()
