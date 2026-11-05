// Service worker'ın push kararları: yan etkisiz, sw.ts dışında test edilebilir. Yalnız sw.js paketine girer,
// sayfa kodu buraya bağlanmaz (SW klasik betik, sayfayla ortak parça yükleyemez). Bu yüzden sameEvent, b64urlToBytes ve
// deviceLabel'in sayfadaki kardeşleri ayrı dosyalarda (webNotify, webPushClient); ortak modül derlemeyi kırar.
import type { NotifyLevel } from '../../shared/notifyRules'
import type { PushActionId, PushPayload, PushSubscriptionInput } from '../../shared/pushTypes'

const ICON = '/icons/icon-192.png'
const ACTION_IDS: readonly string[] = ['read', 'archive', 'reply'] satisfies PushActionId[]
const LEVELS: readonly string[] = ['silent', 'normal', 'urgent'] satisfies NotifyLevel[]

export interface PushNotificationOptions extends NotificationOptions {
  renotify: boolean
  actions: PushPayload['actions']
}

export interface NotificationData { messageId: number | null; accountId: number | null }

/** Görünen bildirim aynı olayı mı taşıyor (sekme ve push aynı olayı ayrı ayrı getirir). İleti etiketi iletiye özeldir;
 *  toplu etiketler (`new:<hesap>`, özet) yeniden kullanılır, onlarda içerik değiştiyse yeni olaydır */
export function sameEvent(shown: readonly { title: string; body: string }[], n: { title: string; body: string; messageId?: number | null }): boolean {
  return shown.some((s) => n.messageId != null || (s.title === n.title && s.body === n.body))
}

/** Sekme ve push aynı etiketi aynı anda gösterebilir: sorgu ile gösterim arasına öteki girerse aynı olay çift duyulur,
 *  Chromium'da gösterim sürerken yapılan sorgu yeni bildirimi listeden de düşürür. Kilit sayfayla SW arasında ortaktır.
 *  Kilit yoksa ya da bekleme dolarsa kilitsiz sürer: bildirim kaybolmaz, Apple'da sessiz push aboneliği düşürür */
export async function withShowLock<T>(locks: LockManager | undefined, tag: string, fn: () => Promise<T>): Promise<T> {
  if (!locks) return fn()
  let ran = false
  try {
    return await locks.request(`gecko-notify:${tag}`, { signal: AbortSignal.timeout(3000) }, () => {
      ran = true
      return fn()
    })
  } catch (e) {
    if (ran) throw e
    return fn()
  }
}

const b64urlToBytes = (v: string): Uint8Array<ArrayBuffer> => {
  const s = atob(v.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(v.length / 4) * 4, '='))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

/** Cihaz listesinde görünen ad; uç nokta ya da kişisel veri içermez. Sayfadaki kardeşiyle (webPushClient) aynı kaynak:
 *  swPushDrift testi eşitliği denetler */
export function deviceLabel(ua: string, touchPoints = 0): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Web'
  // iPadOS kendini Mac gösterir, tek ayrım dokunmatiktir. Service worker'da maxTouchPoints yok: orada iPad Mac görünür,
  // sayfa açılınca yeniden kayıt etiketi düzeltir
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)
  const os = /Android/.test(ua) ? 'Android' : ios ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${browser} · ${os}` : browser
}

/** Sayfaya giden ileti. Açık pencere yeniden yüklenmez, derin bağlantı yalnız pencere yokken.
 *  messageId null: toplu bildirim, yalnız hesap açılır */
export interface OpenMessage { type: 'open-message' | 'open-reply'; messageId: number | null; accountId: number | null }

export type OpenPlan = { kind: 'open'; url: string; message: OpenMessage | null }

export type ClickPlan =
  | OpenPlan
  | { kind: 'action'; action: 'read' | 'archive'; messageId: number; accountId: number | null }

/** Apple tarafında her push görünür bildirim üretmeli: sessiz geçilen push aboneliği düşürür */
export function alwaysShows(ua: string): boolean {
  if (/iPhone|iPad|iPod/.test(ua)) return true
  return /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\/|Android/.test(ua)
}

/** Kullanıcı uygulamaya bakıyorsa bildirim gereksiz (yeni ileti listede görünür) */
export function shouldShow(clients: readonly { focused: boolean; visibilityState: string }[], ua: string): boolean {
  if (alwaysShows(ua)) return true
  return !clients.some((c) => c.focused && c.visibilityState === 'visible')
}

/** Özet bildirimde eylem yok; yükte tanınmayan eylem gösterilmez */
export function actionsFor(p: PushPayload): PushPayload['actions'] {
  if (p.messageId == null) return []
  return p.actions.filter((a) => ACTION_IDS.includes(a.action))
}

/** alreadyShown: aynı olayı sekme göstermiş, yerine geçer ama ikinci kez ses çıkarmaz */
export function notificationOptions(p: PushPayload, alreadyShown = false): PushNotificationOptions {
  const data: NotificationData = { messageId: p.messageId, accountId: p.accountId }
  return {
    body: p.body, icon: ICON, badge: ICON, tag: p.tag, renotify: !alreadyShown, requireInteraction: p.level === 'urgent',
    data, actions: actionsFor(p)
  }
}

const validId = (v: unknown): boolean => v == null || Number.isSafeInteger(v)

const validAction = (a: unknown): a is PushPayload['actions'][number] => {
  const { action, title } = (a ?? {}) as Record<string, unknown>
  return typeof action === 'string' && ACTION_IDS.includes(action) && typeof title === 'string'
}

/** Push servisinden geleni olduğu gibi güvenme: bozuk yükte bildirim API'si fırlatırdı, bozuk kimlik yanlış adres üretirdi */
export function parsePush(data: { json(): unknown } | null | undefined): PushPayload | null {
  let v: Partial<PushPayload> | null
  try {
    v = data ? (data.json() as Partial<PushPayload> | null) : null
  } catch {
    return null
  }
  if (!v || typeof v.title !== 'string' || typeof v.body !== 'string' || typeof v.tag !== 'string' || !v.tag) return null
  if (!validId(v.messageId) || !validId(v.accountId) || typeof v.level !== 'string' || !LEVELS.includes(v.level)) return null
  return { ...v, messageId: v.messageId ?? null, accountId: v.accountId ?? null, actions: Array.isArray(v.actions) ? v.actions.filter(validAction) : [] } as PushPayload
}

export interface PushDeps {
  ua: string
  locks?: LockManager
  windows(): Promise<readonly { focused: boolean; visibilityState: string }[]>
  shown(tag: string): Promise<readonly { title: string; body: string }[]>
  show(title: string, options: NotificationOptions): Promise<void>
}

/** Apple'da her push görünür bildirim üretmeli: yük bozuksa ya da gösterim başarısızsa genel bildirim */
export async function handlePush(data: { json(): unknown } | null | undefined, d: PushDeps): Promise<void> {
  const mustShow = alwaysShows(d.ua)
  try {
    const p = parsePush(data)
    if (p) {
      if (shouldShow(await d.windows(), d.ua)) await withShowLock(d.locks, p.tag, async () => d.show(p.title, notificationOptions(p, sameEvent(await d.shown(p.tag), p))))
      return
    }
  } catch (e) {
    if (!mustShow) throw e
  }
  if (mustShow) await d.show('GeckoMail', { tag: 'fallback', icon: ICON, badge: ICON })
}

/** Eylem sunucuda işlenmediyse (oturum bitti, yetki yok, sunucu sorunu, ağ yok) kaybolmasın: kullanıcı iletiyi görsün */
export async function runClick(
  action: string, data: Partial<NotificationData> | null | undefined,
  d: { post(messageId: number, action: 'read' | 'archive'): Promise<{ ok: boolean }>; open(plan: OpenPlan): Promise<void> }
): Promise<void> {
  const plan = clickPlan(action, data)
  if (plan.kind === 'open') return d.open(plan)
  const res = await d.post(plan.messageId, plan.action).catch(() => null)
  if (!res?.ok) await d.open(clickPlan('', data) as OpenPlan)
}

type RenewableSubscription = { toJSON(): unknown }

export interface RenewEvent {
  oldSubscription?: { options?: { applicationServerKey?: ArrayBuffer | null } } | null
  newSubscription?: RenewableSubscription | null
}

export interface RenewDeps {
  label: string
  subscribe(o: { userVisibleOnly: true; applicationServerKey: ArrayBuffer | Uint8Array<ArrayBuffer> }): Promise<RenewableSubscription>
  fetch: typeof fetch
}

async function serverKey(f: typeof fetch): Promise<Uint8Array<ArrayBuffer>> {
  const res = await f('/api/push/key', { credentials: 'same-origin' })
  if (!res.ok) throw new Error(String(res.status))
  return b64urlToBytes(((await res.json()) as { publicKey: string }).publicKey)
}

/** Tarayıcı aboneliği değiştirdi (Firefox'ta dönüşüm): eski uç nokta 410 alıp cihazı siler, yenisi oturum çereziyle
 *  kaydedilir. Başarısızlık güvenli: sayfa açılınca resyncPush onarır */
export async function renewSubscription(e: RenewEvent, d: RenewDeps): Promise<boolean> {
  try {
    const sub = e.newSubscription ?? await d.subscribe({
      userVisibleOnly: true, applicationServerKey: e.oldSubscription?.options?.applicationServerKey ?? await serverKey(d.fetch)
    })
    const body: PushSubscriptionInput = { ...(sub.toJSON() as Omit<PushSubscriptionInput, 'label'>), label: d.label }
    const res = await d.fetch('/api/push/subscribe', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    return res.ok
  } catch {
    return false
  }
}

export function clickPlan(action: string, data: Partial<NotificationData> | null | undefined): ClickPlan {
  const messageId = data?.messageId ?? null
  const accountId = data?.accountId ?? null
  if (messageId == null) return { kind: 'open', url: '/', message: accountId == null ? null : { type: 'open-message', messageId, accountId } }
  if (action === 'read' || action === 'archive') return { kind: 'action', action, messageId, accountId }
  if (action === 'reply') return { kind: 'open', url: `/?reply=${messageId}`, message: { type: 'open-reply', messageId, accountId } }
  return { kind: 'open', url: `/?m=${messageId}`, message: { type: 'open-message', messageId, accountId } }
}
