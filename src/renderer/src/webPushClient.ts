// Web: tarayıcı push aboneliği. Cihaz kaydı oturumla ölür (sunucu): tercih kullanıcı başına bu tarayıcıda tutulur,
// aynı kişi yeniden girince resyncPush aboneliği kurar; aynı tarayıcıda başka kullanıcıya geçmez. Çıkışta abonelik
// iptal edilir, tercih kalır (suspendPush). Yalnız kullanıcı kimliği numarası saklanır, sır yok: anahtarlar tarayıcıda.
// İşlemler sıralı: oturum değişimiyle yarışan abonelik çıkışın ardında kalmasın.
import type { PushSubscriptionInput } from '../../shared/pushTypes'
import { apiFetch } from './apiFetch'
import { nativeBridge } from './platform/nativeBridge'

export type PushSupport = 'ok' | 'needsInstall' | 'unsupported'
export type EnablePushResult = 'on' | 'denied' | 'unsupported' | 'failed'

/** Bildirim tıklaması ya da derin bağlantı. messageId null: yalnız hesap açılır */
export interface NotificationLink { messageId: number | null; accountId: number | null; reply: boolean }

const WANT_PREFIX = 'gecko-push-wanted:'
const OWNER_KEY = 'gecko-push-owner'
/** Asılı push servisi çıkışı (sayfa yenilemesini) bekletmesin; kalan abonelik sonraki açılışta, oturum olmasa da temizlenir */
const SIGN_OUT_WAIT_MS = 2000
const READY_WAIT_MS = 10_000
/** Asılı işlem (push servisi yanıtsız) kuyruğu ve anahtarı kilitlemesin */
const JOB_WAIT_MS = 15_000

let userId: number | null = null
let chain: Promise<unknown> = Promise.resolve()

const listeners = new Set<() => void>()
const changed = (): void => listeners.forEach((cb) => cb())

/** Bu tarayıcıda push açıldı ya da kapandı: ayarlardaki anahtar ve cihaz listesi yeniden okur */
/** Mobil ayar ekranı: cihaz listesi yenilensin */
export const notifyPushChange = changed

export function onPushChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

/** expired: iş süresini aştı, bekleyen sonuç artık kimseye gitmiyor */
function serial<T>(fn: (expired: () => boolean) => Promise<T>): Promise<T> {
  const job = (): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let over = false
      const timer = setTimeout(() => {
        over = true
        reject(new Error('push işlemi zaman aşımına uğradı'))
      }, JOB_WAIT_MS)
      fn(() => over).then(resolve, reject).finally(() => clearTimeout(timer))
    })
  const run = chain.then(job, job)
  chain = run.catch(() => {})
  return run
}

const wantKey = (id: number): string => `${WANT_PREFIX}${id}`

function wanted(): boolean {
  if (userId == null) return false
  try {
    return localStorage.getItem(wantKey(userId)) === '1'
  } catch {
    return false
  }
}

function setWanted(on: boolean): void {
  if (userId == null) return
  try {
    if (on) localStorage.setItem(wantKey(userId), '1')
    else localStorage.removeItem(wantKey(userId))
  } catch {
    /* yalnız yeniden girişte kendiliğinden kurulmaz */
  }
}

/** Oturumdaki kullanıcı: tercih ona bağlı */
export function setPushUser(id: number | null): void {
  userId = id
}

function isIos(): boolean {
  const ua = navigator.userAgent
  // iPadOS kendini Mac gösterir
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

function installed(): boolean {
  return (navigator as { standalone?: boolean }).standalone === true || !!window.matchMedia?.('(display-mode: standalone)').matches
}

/** iOS'ta push yalnız ana ekrana eklenmiş uygulamada var; sekmede API de görünmez */
export function pushSupport(): PushSupport {
  // mobil uygulamada bildirim yereldir (APNs/FCM): service worker ve Web Push yolu hiç çalışmaz
  if (typeof navigator === 'undefined' || typeof window === 'undefined' || nativeBridge()) return 'unsupported'
  if (isIos() && !installed()) return 'needsInstall'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return 'unsupported'
  return 'ok'
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return true // tarayıcı anahtarı göstermiyor: karşılaştırılamaz
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

// aşağıdaki yardımcıların swPush'ta kardeşi var: SW paketi sayfayla modül paylaşamaz, swPushDrift testi eşitliği denetler
const b64urlToBytes = (v: string): Uint8Array<ArrayBuffer> => {
  const s = atob(v.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(v.length / 4) * 4, '='))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

/** Cihaz listesinde görünen ad; uç nokta ya da kişisel veri içermez */
function deviceLabel(ua: string, touchPoints = 0): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Web'
  // iPadOS kendini Mac gösterir, tek ayrım dokunmatiktir. Service worker'da maxTouchPoints yok: orada iPad Mac görünür,
  // sayfa açılınca yeniden kayıt etiketi düzeltir
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)
  const os = /Android/.test(ua) ? 'Android' : ios ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${browser} · ${os}` : browser
}

async function serverKey(): Promise<Uint8Array<ArrayBuffer>> {
  const res = await apiFetch('/api/push/key')
  if (!res.ok) throw new Error(`push anahtarı alınamadı (${res.status})`)
  return b64urlToBytes(((await res.json()) as { publicKey: string }).publicKey)
}

/** Abonelik kurulur (yoksa ya da anahtar değiştiyse) ve bu oturuma kaydedilir */
async function register(reg: ServiceWorkerRegistration, existing: PushSubscription | null, expired: () => boolean): Promise<void> {
  const key = await serverKey()
  let sub = existing
  if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  if (expired()) {
    if (sub !== existing) await sub.unsubscribe().catch(() => {}) // anahtar "başarısız" gösterdi: geç gelen abonelik kalmasın
    throw new Error('push işlemi zaman aşımına uğradı')
  }
  const body: PushSubscriptionInput = { ...(sub.toJSON() as Omit<PushSubscriptionInput, 'label'>), label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints) }
  const res = await apiFetch('/api/push/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  if (!res.ok) {
    // kayıtsız abonelik tarayıcıda kalmasın; geçici sunucu sorunu (5xx, 429) sağlam aboneliği öldürmez
    if (res.status < 500 && res.status !== 429) await sub.unsubscribe().catch(() => {})
    throw new Error(`push kaydı reddedildi (${res.status})`)
  }
}

const registration = (): Promise<ServiceWorkerRegistration | undefined> => navigator.serviceWorker.getRegistration('/')

/** İzinsiz abonelik olamaz: pushManager'a hiç gidilmez (push hizmeti olmayan WebKit derlemesinde getSubscription sayfayı kilitler) */
const mayHaveSubscription = (): boolean => pushSupport() === 'ok' && Notification.permission === 'granted'

function bounded<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    p.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/** Kullanıcı tıklamasından çağrılır: izin yalnız burada sorulur */
export async function enablePush(): Promise<EnablePushResult> {
  if (pushSupport() !== 'ok') return 'unsupported'
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'
  return serial<EnablePushResult>(async (expired) => {
    const reg = await bounded(navigator.serviceWorker.ready, READY_WAIT_MS, undefined)
    if (!reg || userId == null) return 'failed'
    await register(reg, await reg.pushManager.getSubscription(), expired)
    setWanted(true)
    changed()
    return 'on'
  }).catch(() => 'failed')
}

/** Kullanıcı kapattı: sunucudaki bu cihaz kaydı silinir, abonelik iptal edilir. Ağ yoksa iptal yine olur; sunucu
 *  sonraki gönderimde 410 alıp kaydı siler */
export function disablePush(): Promise<void> {
  setWanted(false)
  if (pushSupport() !== 'ok') return Promise.resolve()
  return serial(async () => {
    try {
      const res = await apiFetch('/api/push/devices')
      const { devices } = (await res.json()) as { devices: { id: number; current: boolean }[] }
      for (const d of devices.filter((x) => x.current))
        await apiFetch(`/api/push/devices/${d.id}`, { method: 'DELETE' })
    } catch {
      /* yukarıdaki not */
    }
    const reg = await registration()
    await (await reg?.pushManager.getSubscription())?.unsubscribe()
  }).catch(() => {}).finally(changed)
}

async function closeShown(reg: ServiceWorkerRegistration): Promise<void> {
  for (const n of await reg.getNotifications()) n.close()
}

/** Bu tarayıcıdaki son kullanıcıdan başkası mı geldi. Yalnız kimlik numarası, bkz. dosya başı */
function ownerChanged(id: number): boolean {
  try {
    const prev = localStorage.getItem(OWNER_KEY)
    localStorage.setItem(OWNER_KEY, String(id))
    return prev != null && prev !== String(id)
  } catch {
    return false
  }
}

/** Çıkış: cihaz kaydı sunucuda oturumla silindi; burada abonelik iptal edilir, görünen bildirimler kapanır (ortak
 *  makinede içerik ekranda kalmasın). Tercih durur: aynı kişi girince geri kurulur. Sayfa yenilenmeden beklenir */
export function suspendPush(): Promise<void> {
  userId = null
  if (!mayHaveSubscription()) return Promise.resolve()
  const done = serial(async () => {
    const reg = await registration()
    if (!reg) return
    await closeShown(reg)
    await (await reg.pushManager.getSubscription())?.unsubscribe()
  })
  return bounded(done, SIGN_OUT_WAIT_MS, undefined).catch(() => {})
}

/** Oturum başında ve oturumsuz açılışta: tercih varsa abonelik bu oturuma yeniden kaydedilir (uç nokta değişmiş olabilir);
 *  yoksa önceki kullanıcıdan kalan abonelik iptal edilir. Oturum yoksa ya da kullanıcı değiştiyse önceki kullanıcının
 *  görünen bildirimleri kapanır (ortak makinede içerik ekranda kalmasın) */
export function resyncPush(): Promise<void> {
  if (!mayHaveSubscription()) return Promise.resolve()
  return serial(async (expired) => {
    const reg = await registration()
    if (!reg) return
    if (userId == null || ownerChanged(userId)) await closeShown(reg)
    const sub = await reg.pushManager.getSubscription()
    if (!wanted()) {
      await sub?.unsubscribe()
      return
    }
    await register(reg, sub, expired)
  }).catch(() => {
    /* sekme içi bildirim sürer; sonraki açılışta yeniden denenir */
  })
}

/** Ayarlar anahtarı. Kayıt sunucuda düşmüş olabilir (410, cihaz sınırı, başka cihazdan silme); sorulamazsa yerel bilgi.
 *  Kuyruktan geçer: açılıştaki yeniden kayıt bitmeden "kayıt yok" denmesin */
export function pushEnabled(): Promise<boolean> {
  if (!mayHaveSubscription() || !wanted()) return Promise.resolve(false)
  return serial(async () => {
    const reg = await registration()
    if (!(await reg?.pushManager.getSubscription())) return false
    try {
      const res = await apiFetch('/api/push/devices')
      if (!res.ok) return true
      return ((await res.json()) as { devices: { current: boolean }[] }).devices.some((d) => d.current)
    } catch {
      return true
    }
  }).catch(() => false)
}

function idParam(v: string | null): number | null {
  if (!v || !/^\d+$/.test(v)) return null
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : null
}

/** Pencere yokken service worker'ın açtığı adres: /?m=<id>, /?reply=<id> */
export function parseDeepLink(search: string): NotificationLink | null {
  const q = new URLSearchParams(search)
  const reply = idParam(q.get('reply'))
  if (reply != null) return { messageId: reply, accountId: null, reply: true }
  const messageId = idParam(q.get('m'))
  return messageId == null ? null : { messageId, accountId: null, reply: false }
}

/** Açık pencereye service worker'dan gelen ileti (swPush OpenMessage) */
export function parseSwMessage(v: unknown): NotificationLink | null {
  if (!v || typeof v !== 'object') return null
  const { type, messageId, accountId } = v as Record<string, unknown>
  if (type !== 'open-message' && type !== 'open-reply') return null
  const id = typeof messageId === 'number' ? messageId : null
  const account = typeof accountId === 'number' ? accountId : null
  if (id == null && (messageId != null || account == null)) return null
  return { messageId: id, accountId: account, reply: type === 'open-reply' }
}
