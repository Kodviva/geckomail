// Mobil uygulama: arayüz sunucu modundadır (platform.kind 'web'), fark platform.native ile. API başka köktedir: çerez yok,
// Bearer erişim belirteci var. Erişim belirteci yalnız bu dosyadaki kapanış değişkeninde durur, hiçbir depoya yazılmaz; uzun
// ömürlü mobil oturum belirteci JS'e hiç girmez.
import { setApiClient, type ApiClient } from '../apiFetch'
import { isLocked, lockApp, whenUnlocked } from '../appLock'
import { rpc } from '../rpcClient'
import { isDangerousAttachment } from '../../../shared/attachmentSafety'
import { t } from '../../../shared/i18n'
import { WS_SUBPROTOCOL, WS_TICKET_PREFIX } from '../../../shared/mobileProtocol'
import type { GeckoNativePlugin, NativeHost } from './nativeBridge'
import type { Platform } from '.'
import { attachmentError, discardUpload, uploadFile } from './web'

const UNAUTHENTICATED = '{"reason":"unauthenticated"}'

export interface NativeApiOptions {
  plugin: GeckoNativePlugin
  origin: string | null
  /** Sunucu oturumu bitirdi; açık bir oturum varken bir kez çağrılır */
  onRevoked: () => void
  /** Uygulama kilidi: kilitliyken belirteç istenmez, istek kilit açılınca sürer (T14) */
  lock?: { isLocked(): boolean; whenUnlocked(): Promise<void>; lock(): void }
}

type Access = { status: 'ok'; token: string } | { status: 'gone' } | { status: 'network' } | { status: 'locked' }

export function createNativeApiClient(o: NativeApiOptions): ApiClient {
  let token: string | null = null
  let expiresAt = 0
  /** Bu oturumda belirteç alındı mı: hiç açılmamış oturumda 'gone' iptal değil, giriş ekranıdır */
  let signedIn = false
  let pending: Promise<Access> | null = null
  /** reset her artırışta sürmekte olan yenilemeyi geçersiz kılar: kilitten sonra belirteç geri gelmez (T14) */
  let epoch = 0

  const ask = (force: boolean): Promise<Access> => {
    if (pending) return pending
    const mine = epoch
    const current: Promise<Access> = o.plugin.accessToken(force ? { force } : {}).then(
      (r): Access => {
        if (mine !== epoch) return { status: 'network' }
        if (r.status === 'ok') {
          token = r.token
          expiresAt = r.expiresAt
          signedIn = true
          return { status: 'ok', token: r.token }
        }
        if (r.status === 'gone') {
          token = null
          expiresAt = 0
          if (signedIn) {
            signedIn = false
            o.onRevoked()
          }
        }
        if (r.status === 'locked') o.lock?.lock()
        return { status: r.status }
      },
      (): Access => ({ status: 'network' })
    ).finally(() => {
      if (pending === current) pending = null
    })
    pending = current
    return current
  }

  /** stale: reddedilen belirteç; başka istek bu arada yenilemişse yenisi kullanılır */
  const access = (stale?: string): Promise<Access> => {
    if (token && token !== stale && Date.now() < expiresAt) return Promise.resolve({ status: 'ok', token })
    return ask(stale !== undefined)
  }

  const unauthenticated = (): Response => new Response(UNAUTHENTICATED, { status: 401, headers: { 'Content-Type': 'application/json' } })

  const request = async (path: string, init: RequestInit | undefined, bearer: string): Promise<Response> => {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${bearer}`)
    return fetch(`${o.origin}${path}`, { ...init, credentials: 'omit', headers })
  }

  const client: ApiClient = {
    async fetch(path, init) {
      // tam adres verilemez: belirteç yalnız seçilen sunucuya gider
      if (!o.origin || !path.startsWith('/') || path.startsWith('//')) throw new TypeError('gecko.api.path')
      if (o.lock?.isLocked()) await o.lock.whenUnlocked()
      const first = await access()
      if (first.status === 'locked') return client.fetch(path, init)
      if (first.status === 'gone') return unauthenticated()
      if (first.status === 'network') throw new TypeError('gecko.api.network')
      const res = await request(path, init, first.token)
      if (res.status !== 401) return res
      const second = await access(first.token)
      if (second.status === 'locked') return client.fetch(path, init)
      if (second.status === 'gone') return unauthenticated()
      if (second.status === 'network') throw new TypeError('gecko.api.network')
      return request(path, init, second.token)
    },
    async wsEndpoint() {
      const r = await client.fetch('/api/mobile/ws-ticket', { method: 'POST' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const { ticket } = (await r.json()) as { ticket: string }
      return { url: `${(o.origin as string).replace(/^http/, 'ws')}/rpc`, protocols: [WS_SUBPROTOCOL, WS_TICKET_PREFIX + ticket] }
    },
    reset() {
      epoch++
      pending = null
      token = null
      expiresAt = 0
      signedIn = false
    }
  }
  return client
}

const toBase64 = (data: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Eklenti reddi: "status:<http>", "noApp", "locked". Çalıştırılabilir ek masaüstündeki gibi sorulur */
async function openNative(plugin: GeckoNativePlugin, a: { messageId: number; attachmentId: number; name: string }): Promise<void> {
  if (isDangerousAttachment(a.name) && !window.confirm(t('mobile.attach.dangerous', { name: a.name }))) return
  try {
    await plugin.openAttachment(a)
  } catch (e) {
    const code = String((e as Error).message)
    if (code === 'noApp') throw new Error(t('mobile.attach.noApp'))
    if (code === 'locked') throw new Error(code)
    throw new Error(attachmentError(Number(code.replace('status:', '')) || 502))
  }
}

export function createNativePlatform(h: NativeHost): Platform {
  const { plugin, os, serverOrigin } = h
  setApiClient(createNativeApiClient({ plugin, origin: serverOrigin, onRevoked: () => rpc.revoke(), lock: { isLocked, whenUnlocked, lock: lockApp } }))
  return {
    kind: 'web',
    native: os,
    serverOrigin,
    savedLocale: () => null,
    setLocale: (locale) => {
      if (rpc.isOpen) rpc.call('setSessionLocale', { locale }).catch(() => {})
    },
    biometricAvailable: async () => (await plugin.biometricAvailable()).available,
    promptBiometric: async (reason) => (await plugin.promptBiometric({ reason })).ok,
    openAttachment: (a) => openNative(plugin, a),
    revealAttachment: (a) => openNative(plugin, a),
    // çözülmüş ek yalnız oturumun RAM önbelleğinde, yerel indirme yolu yok: tarayıcıdan indirilir (README, Mobil uygulama)
    saveSmimeAttachment: async () => {
      throw new Error(t('sync.perm.browserRequired'))
    },
    async saveBytes(name, data) {
      try {
        return (await plugin.saveBytes({ name, base64: toBase64(data) })).ok
      } catch {
        return false
      }
    },
    chooseBackupSave: async () => null,
    chooseBackupOpen: async () => null,
    async relaunch() {
      window.location.reload()
    },
    filePath: () => null,
    trashFile: async () => false,
    // Capacitor yeni pencere isteğini sistem tarayıcısına verir (iOS ve Android'de ölçüldü). iOS'ta Safari açılır ama window.open
    // null döner: dönüş değeri başarı göstermez. Dokunma olayı içinde çağrılmalı
    async openOAuthUrl(url) {
      if (!URL.canParse(url) || new URL(url).protocol !== 'https:') return false
      window.open(url, '_blank')
      return true
    },
    oauthWindow: null,
    oauthComplete: null,
    uploadFile,
    discardUpload,
    serverBackup: null,
    wallboard: null,
    nativeNotifications: false,
    oauthExternal: null,
    wrapTransport: null,
    serverMode: null,
    migration: null,
    rendererReady: () => {},
    loginItem: null
  }
}
