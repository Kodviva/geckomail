// Web: sekme içi bildirim (Notification, sekme açıkken) ve okunmamış rozeti. Bildirim izni yalnız ayarlardan
// istenir (enableWebNotify); içerik düz metin alanlarına gider, HTML olarak yorumlanmaz. Sekme kapalıyken
// bildirim push ile (webPushClient, sw.ts); 'unsupported' yalnız bu sekme içi yol içindir, push'u bağlamaz.
// Sekme açıkken bildirim service worker kaydından gösterilir: sayfa ve SW bildirimleri tarayıcıda ayrı tutulur, push'la
// aynı etiketin tek bildirime düşmesi ancak böyle olur. Push kaydı ölmüş olabilir: sekme push'a güvenip susmaz.
import type { RpcEvents } from '../../shared/rpc'
import { nativeBridge } from './platform/nativeBridge'

const OFF_KEY = 'gecko-web-notify-off'
const ICON = '/icons/icon-192.png'

export type WebNotifyState = 'unsupported' | 'denied' | 'default' | 'off' | 'on'

/** Bu sekmede görünen bildirimler: çıkışta kapatılır (ortak makinede içerik ekranda kalmasın) */
const live = new Set<Notification>()
/** Kurucu reddetti: API var ama sayfadan bildirim gösterilemiyor */
let constructorRejected = false

/** Android'de Chromium tabanlı tarayıcılar kurucuyu reddeder (yalnız service worker gösterebilir). Firefox değil */
const isAndroidChromium = (): boolean => typeof navigator !== 'undefined' && /Android/.test(navigator.userAgent) && /Chrome\//.test(navigator.userAgent)

function userTurnedOff(): boolean {
  try {
    return localStorage.getItem(OFF_KEY) === '1'
  } catch {
    return false
  }
}

function setUserTurnedOff(off: boolean): void {
  try {
    if (off) localStorage.setItem(OFF_KEY, '1')
    else localStorage.removeItem(OFF_KEY)
  } catch {
    /* yalnız bu oturum */
  }
}

export function webNotifyState(): WebNotifyState {
  // mobil uygulamada bildirim yereldir: new Notification ve service worker yolu çalışmaz
  if (nativeBridge() || typeof Notification === 'undefined' || constructorRejected || isAndroidChromium()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission !== 'granted') return 'default'
  return userTurnedOff() ? 'off' : 'on'
}

/** Kullanıcı ayarlardan açtı: izin gerekiyorsa burada sorulur (kullanıcı eylemi içinde çağrılmalı) */
export async function enableWebNotify(): Promise<WebNotifyState> {
  if (webNotifyState() === 'unsupported') return 'unsupported'
  setUserTurnedOff(false)
  if (Notification.permission === 'default') await Notification.requestPermission()
  return webNotifyState()
}

/** Tarayıcının verdiği izin sayfadan geri alınamaz: kapatma bu tarayıcıda hatırlanır */
export function disableWebNotify(): void {
  setUserTurnedOff(true)
}

type ServerNotification = RpcEvents['server:notify']
type OnOpen = (accountId: number, messageId: number | null) => void

/** Service worker kaydı olmayan yol. Tıklanınca pencereye odak + hesabı/iletiyi aç (onOpen) */
function showInTab(n: ServerNotification, onOpen?: OnOpen): void {
  try {
    const shown = new Notification(n.title, {
      body: n.body,
      icon: ICON,
      // aynı kullanıcının iki sekmesi aynı olayı alır: işletim sisteminde tek bildirim kalsın
      tag: n.tag
    })
    live.add(shown)
    shown.onclose = () => live.delete(shown)
    shown.onclick = () => {
      window.focus()
      shown.close()
      live.delete(shown)
      if (n.accountId != null) onOpen?.(n.accountId, n.messageId ?? null)
    }
  } catch (e) {
    // sezgi kaçırdıysa: anahtar bundan sonra "desteklenmiyor" gösterir
    if (e instanceof TypeError) constructorRejected = true
  }
}

/** swPush.sameEvent'in sayfadaki kardeşi: SW paketi sayfayla modül paylaşamaz, swPushDrift testi eşitliği denetler */
function sameEvent(shown: readonly { title: string; body: string }[], n: { title: string; body: string; messageId?: number | null }): boolean {
  return shown.some((s) => n.messageId != null || (s.title === n.title && s.body === n.body))
}

/** swPush.withShowLock'un sayfadaki kardeşi: sorgu ve gösterim push'la aynı kilitte, swPushDrift testi eşitliği denetler */
async function withShowLock<T>(locks: LockManager | undefined, tag: string, fn: () => Promise<T>): Promise<T> {
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

/** Aynı olay push'la görünüyorsa dokunulmaz (eylem düğmeleri kalır, ses tekrarlanmaz). Aynı etiketle yeni içerik yeni
 *  olaydır: yerine geçer ve duyulur. Tıklama service worker'dan geçer, veri ona */
async function showViaWorker(sw: ServiceWorkerContainer, n: ServerNotification, onOpen?: OnOpen): Promise<void> {
  try {
    const reg = await sw.getRegistration('/')
    if (reg) {
      await withShowLock(navigator.locks, n.tag, async () => {
        const shown = await reg.getNotifications({ tag: n.tag })
        if (sameEvent(shown, n)) return
        await reg.showNotification(n.title, {
          body: n.body, icon: ICON, badge: ICON, tag: n.tag, renotify: shown.length > 0, requireInteraction: n.level === 'urgent',
          data: { messageId: n.messageId ?? null, accountId: n.accountId ?? null }
        } as NotificationOptions)
      })
      return
    }
  } catch {
    /* sekmeden gösterilir */
  }
  showInTab(n, onOpen)
}

/** İzin varsa ve sekme odakta değilse bildirim */
export function showServerNotification(n: ServerNotification, opts: { focused: boolean; onOpen?: OnOpen }): void {
  if (opts.focused || webNotifyState() !== 'on') return
  const sw = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker
  if (sw) void showViaWorker(sw, n, opts.onOpen)
  else showInTab(n, opts.onOpen)
}

/** Çıkış: bu sekmenin ve service worker'ın görünen bildirimleri kapanır */
export function closeServerNotifications(): void {
  for (const n of live) n.close()
  live.clear()
  const sw = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker
  void sw?.getRegistration('/').then((reg) => reg?.getNotifications()).then((list) => list?.forEach((n) => n.close())).catch(() => {})
}

/** Sekme başlığı "(N) GeckoMail"; yüklü uygulamada setAppBadge varsa simge rozeti. 0 ikisini de temizler */
export function updateUnreadBadge(count: number): void {
  document.title = count > 0 ? `(${count}) GeckoMail` : 'GeckoMail'
  const badge = count > 0 ? navigator.setAppBadge?.(count) : navigator.clearAppBadge?.()
  // izin yok, yüklü değil…: rozet kritik değil
  badge?.catch(() => {})
}
