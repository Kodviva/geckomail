// Electron utilityProcess köprüsü: EngineHost'u main sürecine parentPort üstünden bağlar.
import type { MessagePortMain } from 'electron'
import { t } from '../../shared/i18n'
import type { EngineHost, HostSignal } from '../host'

/** parentPort'un kullandığımız dar yüzü (testte sahte port verilir) */
export interface ParentPortLike {
  postMessage(msg: unknown): void
  on(event: 'message', cb: (e: { data: unknown; ports?: MessagePortMain[] }) => void): unknown
}

export function createParentPortHost(port: ParentPortLike): {
  host: EngineHost
  onSignal(cb: (s: HostSignal) => void): void
  onRpcPort(cb: (p: MessagePortMain) => void): void
} {
  let signalCb: ((s: HostSignal) => void) | null = null
  let portCb: ((p: MessagePortMain) => void) | null = null

  // ---- main süreciyle şifreleme köprüsü (safeStorage yalnızca main'de) ----
  let cryptoSeq = 0
  const cryptoPending = new Map<number, { resolve: (v: Uint8Array[]) => void; reject: (e: Error) => void }>()

  function cryptoRequest(type: 'encrypt' | 'decrypt', values: (string | Uint8Array)[]): Promise<Uint8Array[]> {
    return new Promise((resolve, reject) => {
      const id = ++cryptoSeq
      cryptoPending.set(id, { resolve, reject })
      port.postMessage({ type, id, values })
      setTimeout(() => {
        if (cryptoPending.delete(id)) reject(new Error(t('sync.crypto.timeout')))
      }, 15_000)
    })
  }

  port.on('message', (e) => {
    const msg = e.data as { type?: string; id?: number; values?: Uint8Array[]; online?: boolean; locale?: string; action?: unknown; messageId?: unknown; importId?: unknown; serverKey?: unknown; keys?: unknown }
    if (msg?.type === 'port' && e.ports?.[0]) {
      portCb?.(e.ports[0])
      return
    }
    if (msg?.type === 'vault-lock') return void signalCb?.({ type: 'vault-lock' }) // main: uyku/ekran kilidi sinyali
    // main: işletim sisteminin ağ durumu ve uykudan uyanış (kesintiyi sunucu reddi sanmamak için)
    if (msg?.type === 'network') return void signalCb?.({ type: 'network', online: !!msg.online })
    if (msg?.type === 'locale') return void signalCb?.({ type: 'locale', locale: String(msg.locale) })
    if (msg?.type === 'resume') return void signalCb?.({ type: 'resume' })
    if (msg?.type === 'notify-action') {
      const { id, action, messageId } = msg
      if (typeof id === 'number' && (action === 'read' || action === 'archive') && Number.isSafeInteger(messageId))
        signalCb?.({ type: 'notify-action', id, action, messageId: messageId as number })
      return
    }
    if (msg?.type === 'import-plan') {
      if (typeof msg.id === 'number') signalCb?.({ type: 'import-plan', id: msg.id })
      return
    }
    if (msg?.type === 'import-seal') {
      const { id, importId, serverKey, keys } = msg
      if (typeof id === 'number' && typeof importId === 'string' && typeof serverKey === 'string' && Array.isArray(keys) && keys.every((k) => typeof k === 'string'))
        signalCb?.({ type: 'import-seal', id, importId, serverKey, keys: keys as string[] })
      return
    }
    if ((msg?.type === 'encrypt:res' || msg?.type === 'decrypt:res') && msg.id) {
      const pending = cryptoPending.get(msg.id)
      if (pending) {
        cryptoPending.delete(msg.id)
        pending.resolve(msg.values ?? [])
      }
      return
    }
    if (msg?.type === 'crypto:err' && msg.id) {
      const pending = cryptoPending.get(msg.id)
      if (pending) {
        cryptoPending.delete(msg.id)
        pending.reject(new Error(t('sync.crypto.failed')))
      }
    }
  })

  const host: EngineHost = {
    encrypt: (values) => cryptoRequest('encrypt', values),
    decrypt: (blobs) => cryptoRequest('decrypt', blobs),
    notify: (n) => port.postMessage({ type: 'notify', ...n }),
    badge: (count) => port.postMessage({ type: 'badge', count }),
    notifyActionResult: (id, ok) => port.postMessage({ type: 'notify-action:res', id, ok }),
    importResult: (id, r) => port.postMessage({ type: 'import:res', id, ...r }),
    fatal: (message) => port.postMessage({ type: 'fatal', message })
  }
  return {
    host,
    onSignal: (cb) => { signalCb = cb },
    onRpcPort: (cb) => { portCb = cb }
  }
}
