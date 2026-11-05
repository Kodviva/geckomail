// Web: service worker kaydı ve uygulama içi yükleme önerisi. Electron'da çağrılmaz (main.tsx).
// Öneri tarayıcının beforeinstallprompt olayına bağlıdır; iOS Safari'de bu olay yok, öneri de çıkmaz.

/** Olayın tarayıcıya özgü alanları (lib.dom'da yok) */
interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/** Değer: 'never' ya da önerinin yeniden çıkabileceği an (ms). Sır değil, yalnız bu tarayıcının tercihi */
export const PROMPT_KEY = 'gecko-pwa-prompt'
const SNOOZE_MS = 7 * 86_400_000

let deferred: InstallPromptEvent | null = null
const subscribers = new Set<() => void>()

function setDeferred(e: InstallPromptEvent | null): void {
  deferred = e
  for (const cb of subscribers) cb()
}

export function isPromptAllowed(stored: string | null, now: number): boolean {
  if (stored === 'never') return false
  const until = Number(stored)
  return !(until > now)
}

function readPrompt(): string | null {
  try {
    return localStorage.getItem(PROMPT_KEY)
  } catch {
    return null
  }
}

function writePrompt(v: string): void {
  try {
    localStorage.setItem(PROMPT_KEY, v)
  } catch {
    /* yalnız bu oturum */
  }
}

/** Öneri gösterilebilir mi (useSyncExternalStore anlık değeri) */
export function installAvailable(): boolean {
  return deferred !== null
}

export function subscribeInstall(cb: () => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}

export function dismissInstall(how: 'later' | 'never'): void {
  writePrompt(how === 'never' ? 'never' : String(Date.now() + SNOOZE_MS))
  setDeferred(null)
}

/** Tarayıcının yükleme sorusu (olay tek kullanımlık). Reddedilirse "Şimdi değil" gibi bir hafta sorulmaz */
export async function acceptInstall(): Promise<void> {
  const e = deferred
  if (!e) return
  setDeferred(null)
  let outcome: string
  try {
    await e.prompt()
    outcome = (await e.userChoice).outcome
  } catch {
    outcome = 'dismissed' // tarayıcı soruyu açamadı (olay bayatladı): öneri yeniden çıkmasın diye ertelenir
  }
  if (outcome !== 'accepted') writePrompt(String(Date.now() + SNOOZE_MS))
}

/** Olay render'dan önce gelebilir: dinleyici uygulama açılışında kurulur. Dönen işlev dinlemeyi bırakır */
export function startInstallPrompt(): () => void {
  const onPrompt = (e: Event): void => {
    // tercih ne olursa olsun tarayıcının kendi önerisi de çıkmasın
    e.preventDefault()
    if (isPromptAllowed(readPrompt(), Date.now())) setDeferred(e as InstallPromptEvent)
  }
  const onInstalled = (): void => setDeferred(null)
  window.addEventListener('beforeinstallprompt', onPrompt)
  window.addEventListener('appinstalled', onInstalled)
  return () => {
    window.removeEventListener('beforeinstallprompt', onPrompt)
    window.removeEventListener('appinstalled', onInstalled)
    setDeferred(null)
  }
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return
  // güvensiz köken ya da gizli pencere: uygulama service worker'sız da çalışır
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {})
}

/** Çevrimdışı mod: SW uygulama kabuğunu önbelleğe alır (kapanışı wipeOffline önbelleği silerek yapar) */
export async function enableShellCache(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false
  const reg = await navigator.serviceWorker.ready
  const worker = reg.active
  if (!worker) return false
  return new Promise((res) => {
    const ch = new MessageChannel()
    ch.port1.onmessage = (e) => res(e.data === true)
    worker.postMessage('gecko-shell-on', [ch.port2])
  })
}

export function startPwa(): void {
  startInstallPrompt()
  if (document.readyState === 'complete') registerServiceWorker()
  else window.addEventListener('load', registerServiceWorker, { once: true })
}
