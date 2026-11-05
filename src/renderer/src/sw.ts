// Service worker: kurulum, güncelleme ve (yalnız çevrimdışı okuma açıkken) uygulama kabuğu önbelleği. Durum, kabuk
// önbelleğinin varlığıdır: sayfa açınca önbellek kurulur, wipeOffline silince SW ağa geçer; SW'nin ayrı kalıcı durumu
// yok. Posta verisi burada hiç tutulmaz; /api, /rpc, /oauth hiç yakalanmaz (swRoutes). Push yükü yalnız bildirime
// gider, saklanmaz; kararlar swPush.ts'te.
// Çıktı /sw.js (vite.web.config.ts): önbellek adı ve dosya listesi derlemede buraya yazılır, her derleme yeni SW.
// Ana tsconfig DOM kütüphanesiyle derlendiğinden WebWorker tipleri yerine gereken yüzey burada.
import { shellKey, shellRoute, staleShells, type ShellRoute } from './offline/swRoutes'
import { deviceLabel, handlePush, renewSubscription, runClick, type NotificationData, type OpenPlan, type RenewEvent } from './swPush'

interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void
}
interface FetchEvent extends ExtendableEvent {
  request: Request
  respondWith(r: Promise<Response>): void
}
interface ExtendableMessageEvent extends ExtendableEvent {
  data: unknown
  ports: readonly MessagePort[]
}
interface PushEvent extends ExtendableEvent {
  data: { json(): unknown } | null
}
type PushSubscriptionChangeEvent = ExtendableEvent & RenewEvent
interface NotificationClickEvent extends ExtendableEvent {
  action: string
  notification: Notification
}
interface WindowClient {
  focused: boolean
  visibilityState: string
  focus(): Promise<unknown>
  postMessage(message: unknown): void
}
const sw = self as unknown as {
  addEventListener(type: 'install' | 'activate', cb: (e: ExtendableEvent) => void): void
  addEventListener(type: 'fetch', cb: (e: FetchEvent) => void): void
  addEventListener(type: 'message', cb: (e: ExtendableMessageEvent) => void): void
  addEventListener(type: 'push', cb: (e: PushEvent) => void): void
  addEventListener(type: 'pushsubscriptionchange', cb: (e: PushSubscriptionChangeEvent) => void): void
  addEventListener(type: 'notificationclick', cb: (e: NotificationClickEvent) => void): void
  skipWaiting(): Promise<void>
  clients: {
    claim(): Promise<void>
    matchAll(o: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClient[]>
    openWindow(url: string): Promise<unknown>
  }
  registration: ServiceWorkerRegistration
  location: Location
}

const SHELL = JSON.parse('__GECKO_SHELL__') as { build: string; files: string[] }
const PREFIX = 'gecko-shell-' // offline/store.ts SHELL_PREFIX ile aynı
const CACHE = `${PREFIX}${SHELL.build}`
const NETWORK_WAIT_MS = 5000

const shellCaches = async (): Promise<string[]> => (await caches.keys()).filter((n) => n.startsWith(PREFIX))

/** Bu sürümün kabuğu tam mı: addAll bütün ya da hiç yazar, çalışırken eklenenler de listedendir */
async function currentReady(): Promise<boolean> {
  if (!(await caches.has(CACHE))) return false
  return (await (await caches.open(CACHE)).keys()).length >= SHELL.files.length
}

async function dropStale(): Promise<void> {
  const stale = staleShells(await shellCaches(), CACHE, await currentReady())
  await Promise.all(stale.map((n) => caches.delete(n)))
}

/** Tamsa dokunulmaz (her bağlanışta ağa gitmez). Başarısızsa yarım önbellek bırakılmaz: eski kabuğun önüne geçmesin */
async function precache(): Promise<void> {
  if (!(await currentReady())) {
    try {
      await (await caches.open(CACHE)).addAll(SHELL.files)
    } catch (e) {
      await caches.delete(CACHE)
      throw e
    }
  }
  await dropStale()
}

/** Bu sürümün kabuğu; alınamadıysa önceki sürümünki (çevrimdışı açılış sürsün); hiçbiri yoksa mod kapalı */
async function liveShell(): Promise<{ cache: Cache; current: boolean } | null> {
  const names = await shellCaches()
  const name = names.includes(CACHE) ? CACHE : names[0]
  return name ? { cache: await caches.open(name), current: name === CACHE } : null
}

/** Yavaş ya da asılı ağda kabuk beklemesin */
function networkFirst(req: Request): Promise<Response> {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('ağ yanıtlamadı')), NETWORK_WAIT_MS)
    fetch(req).then(res, rej).finally(() => clearTimeout(timer))
  })
}

async function respond(req: Request, route: Exclude<ShellRoute, 'pass'>): Promise<Response> {
  // önbellek sorunu sayfayı düşürmesin: mod kapalıymış gibi ağa gidilir
  const shell = await liveShell().catch(() => null)
  if (!shell) return fetch(req)
  const { cache: c, current } = shell
  if (route === 'cache') {
    const hit = await c.match(req)
    if (hit) return hit
    const res = await fetch(req)
    if (res.ok && current) await c.put(req, res.clone()).catch(() => {})
    return res
  }
  const path = new URL(req.url).pathname
  const fallback = req.mode === 'navigate' ? '/' : path
  try {
    const res = await networkFirst(req)
    const key = shellKey(req.mode, path, res.headers.get('content-type'))
    // eski sürümün kabuğuna yeni sayfa yazılmaz: yeni dosyaları onda yok
    if (res.ok && key && current) await c.put(key, res.clone()).catch(() => {})
    // ters vekil sunucu düşünce 502 verir: bu da çevrimdışı sayılır
    if (res.status < 500) return res
    return (await c.match(fallback)) ?? res
  } catch (e) {
    const hit = await c.match(fallback)
    if (hit) return hit
    throw e
  }
}

sw.addEventListener('install', (e) =>
  e.waitUntil(
    (async () => {
      // mod açıkken gelen yeni sürüm kabuğunu önceden alır; alamazsa sayfa açılışta yeniden ister
      if ((await shellCaches()).length) await precache().catch(() => {})
      await sw.skipWaiting()
    })()
  )
)

sw.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      await dropStale()
      await sw.clients.claim()
    })()
  )
)

sw.addEventListener('message', (e) => {
  if (e.data !== 'gecko-shell-on') return
  const reply = e.ports[0]
  e.waitUntil(precache().then(() => reply?.postMessage(true), () => reply?.postMessage(false)))
})

sw.addEventListener('fetch', (e) => {
  const req = e.request
  const route = shellRoute(req.method, req.mode, req.url, sw.location.origin)
  if (route !== 'pass') e.respondWith(respond(req, route))
})

const windows = (): Promise<WindowClient[]> => sw.clients.matchAll({ type: 'window', includeUncontrolled: true })

const pushDeps = {
  ua: navigator.userAgent,
  locks: navigator.locks,
  windows,
  shown: (tag: string) => sw.registration.getNotifications({ tag }),
  show: (title: string, options: NotificationOptions) => sw.registration.showNotification(title, options)
}

/** Açık pencere yeniden yüklenmez: öne alınır, iletiyi kendisi açar. Pencere yoksa derin bağlantı */
async function openApp(plan: OpenPlan): Promise<void> {
  const all = await windows()
  const win = all.find((c) => c.focused) ?? all.find((c) => c.visibilityState === 'visible') ?? all[0]
  if (!win) {
    await sw.clients.openWindow(plan.url)
    return
  }
  await win.focus().catch(() => {}) // tarayıcı öne almayı reddedebilir: ileti yine gider
  if (plan.message) win.postMessage(plan.message)
}

const postAction = (messageId: number, action: 'read' | 'archive'): Promise<Response> =>
  fetch('/api/notify/action', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId, action })
  })

sw.addEventListener('push', (e) => e.waitUntil(handlePush(e.data, pushDeps)))

sw.addEventListener('pushsubscriptionchange', (e) => {
  const { pushManager } = sw.registration
  e.waitUntil(renewSubscription(e, {
    label: deviceLabel(navigator.userAgent, (navigator as { maxTouchPoints?: number }).maxTouchPoints),
    subscribe: (o) => pushManager.subscribe(o),
    fetch: (...a) => fetch(...a)
  }))
})

sw.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil(runClick(e.action, e.notification.data as NotificationData | undefined, { post: postAction, open: openApp }))
})
