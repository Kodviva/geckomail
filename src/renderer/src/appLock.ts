// Mobil uygulama kilidi. Kilit uygulama kapısıdır, anahtar ACL'i değildir: kilidi açık telefonu eline alan kişiye karşıdır.
// Kilitte erişim belirteci bellekten silinir ve WebSocket kapanır (T14); açılınca yeni bilet alınır.
import { resetApiClient } from './apiFetch'
import { nativeBridge, type GeckoNativePlugin, type LockConfig } from './platform/nativeBridge'
import { rpc } from './rpcClient'

export const LOCK_TIMEOUTS = [0, 60_000, 300_000, 900_000] as const

/** Zamanlar yerel katmanın tekdüze saatindendir: cihaz saatini geri almak süreyi uzatmaz. Saat yine de geri giderse kilitlenir */
export function shouldLock(s: { enabled: boolean; timeoutMs: number; backgroundedAt: number | null; now: number }): boolean {
  if (!s.enabled || s.backgroundedAt === null) return false
  return s.now < s.backgroundedAt || s.now - s.backgroundedAt >= s.timeoutMs
}

/** Ayar yerel depodan okunana dek mobilde kilitli: soğuk açılışta içerik görünmez */
let locked = nativeBridge() !== null
/** Açılınca bağlantı kurulacak mı: kilit açık bağlantıyı durdurdu ya da kilitliyken başlatma istendi. Girişsiz ekranda yanlış olmalı:
 *  oturumsuz bağlantı 'revoked' olur, çıkış akışı sayfayı yeniler */
let resumeWanted = false
const listeners = new Set<(v: boolean) => void>()
const emit = (): void => listeners.forEach((cb) => cb(locked))
/** Son bilinen ayar; null: henüz okunamadı */
let config: LockConfig | null = null
let backgroundedAt: number | null = null
/** Kimlik sorusu sürüyor: Face ID uygulamayı etkin olmayan duruma düşürür, bu geçiş arka plana gitmek sayılmaz */
let prompting = 0
let transitions: Promise<unknown> = Promise.resolve()
let waiters: (() => void)[] = []

export const isLocked = (): boolean => locked

export function onLockChange(cb: (locked: boolean) => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

/** Kilitliyken bağlantı başlatılmaz: kilit açılınca kurulur */
export function deferRpcStart(): void {
  resumeWanted = true
}

export const lockConfig = (): LockConfig | null => config

/** Ayar değiştiğinde çağrılır: bir sonraki geçiş eski değerle karar vermez */
export function rememberLockConfig(c: LockConfig): void {
  config = { enabled: c.enabled, timeoutMs: c.timeoutMs }
}

/** Kilit açıkken hemen çözülür; soğuk açılışta kilit çözülene dek belirteç ve soket istenmez */
export function whenUnlocked(): Promise<void> {
  return locked ? new Promise((r) => waiters.push(r)) : Promise.resolve()
}

export async function duringPrompt<T>(ask: () => Promise<T>): Promise<T> {
  prompting++
  try {
    return await ask()
  } finally {
    prompting--
  }
}

/** Soğuk açılış. Okunamazsa kilitli kalır ve kimlik istenir: 'prompt' */
export async function resolveColdLock(plugin: Pick<GeckoNativePlugin, 'getLock'>, resume: () => void): Promise<'open' | 'prompt'> {
  try {
    const c = await plugin.getLock()
    rememberLockConfig(c)
    if (!isLocked()) return 'open' // dil değişince bileşen yeniden bağlanır: yalnız açılıştaki kilit burada çözülür
    if (c.enabled || c.locked) {
      lockApp()
      return 'prompt'
    }
    unlockApp(resume)
    return 'open'
  } catch {
    if (!isLocked()) return 'open'
    return 'prompt'
  }
}

async function transition(active: boolean, plugin: Pick<GeckoNativePlugin, 'getLock'>): Promise<boolean> {
  let due: boolean
  try {
    const s = await plugin.getLock()
    rememberLockConfig(s)
    if (!active) backgroundedAt ??= s.uptimeMs
    due = s.locked || shouldLock({ ...s, backgroundedAt, now: s.uptimeMs })
  } catch {
    due = config?.enabled === true
  }
  if (active) backgroundedAt = null
  if (due && !locked) lockApp()
  return due && active
}

/** Her geçişte ayar yerel depodan yeniden okunur; dönüş: kimlik sorulmalı. Geçişler sıralıdır: dönüş, gidişin okumasını bekler */
export function appStateChanged(active: boolean, plugin: Pick<GeckoNativePlugin, 'getLock'>): Promise<boolean> {
  if (prompting > 0) return Promise.resolve(false)
  // okuma arka planda yarıda kalabilir: "hemen" ayarında içerik uygulama değiştiricide görünmesin
  if (!active && config?.enabled && config.timeoutMs === 0) lockApp()
  const run = transitions.then(() => transition(active, plugin))
  transitions = run.catch(() => {})
  return run
}

export function lockApp(): void {
  resetApiClient()
  resumeWanted ||= rpc.running
  rpc.stop()
  if (locked) return
  locked = true
  emit()
}

/** Kilit ekranından çıkış: yerel oturum silindi ve yerel katman kilidi kapattı. Oturum olmadığı için bağlantı yeniden kurulmaz */
export function releaseLockAfterSignOut(): void {
  resumeWanted = false
  backgroundedAt = null
  if (config) rememberLockConfig({ ...config, enabled: false })
  unlockApp(() => {})
}

export function unlockApp(resume: () => void): void {
  const restart = resumeWanted
  resumeWanted = false
  locked = false
  const waiting = waiters
  waiters = []
  waiting.forEach((r) => r())
  emit()
  if (restart) resume()
}
