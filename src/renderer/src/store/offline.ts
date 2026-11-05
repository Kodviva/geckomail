// Mağaza — Çevrimdışı okuma: eşitlemenin tetiklenmesi, kopyaya geçiş ve dönüş. Yalnız web (session.ts çağırır).
import type { SessionUser } from '../../../shared/rpc'
import { rpc } from '../rpcClient'
import { enableShellCache } from '../pwa'
import { loadOfflineSettings, offlineSupported, saveOfflineSettings, type OfflineDays } from '../offline/settings'
import { currentEpoch, wipeOffline } from '../offline/store'
import { readOfflineSnapshot, syncOffline, type OfflineSnapshot } from '../offline/sync'
import { runtime } from './runtime'
import type { GetState, SetState } from './types'
import { readSavedSearches } from './savedSearches'

/** Turlar arası en az süre: yeni posta olayında 10 dk, kopup bağlanan hatta 1 dk */
const SYNC_GAP_MS = 10 * 60_000
const RECONNECT_GAP_MS = 60_000
/** Paket düşüren ağda açılış kopyayı bundan fazla beklemez */
const OFFLINE_WAIT_MS = 5000

const activeFor = (userId: number): boolean => {
  const s = loadOfflineSettings()
  return s.on && s.userId === userId && offlineSupported()
}

/** Tur bittiğinde dinleyen ayar ekranı yenilenir */
const listeners = new Set<() => void>()
export function onOfflineSynced(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** gapMs 0: kapsam değişti, sürmekte olan tur kesilir */
export async function runOfflineSync(get: GetState, gapMs = SYNC_GAP_MS): Promise<void> {
  const user = get().currentUser
  if (!user || get().offlineMode || !activeFor(user.id)) return
  if (Date.now() - runtime.offlineLastSync < gapMs) return
  runtime.offlineLastSync = Date.now()
  const at = currentEpoch()
  const accounts = await rpc.call('getAccounts', {}).catch(() => null)
  // beklerken ayar kapatılmış, kullanıcı çıkmış ya da kopya silinmiş olabilir: silinen veri geri gelmesin
  if (!accounts || at !== currentEpoch() || get().currentUser?.id !== user.id || !activeFor(user.id)) return
  await syncOffline({ days: loadOfflineSettings().days, accountIds: accounts.filter((a) => !a.secure).map((a) => a.id), user, restart: gapMs === 0 })
  for (const cb of listeners) cb()
}

/** Sunucu kullanıcıyı doğruladı: kopya ona ait değilse (ya da mod kapalıysa kalıntı varsa) silinir, değilse eşitlenir */
export function offlineOnHello(user: SessionUser, get: GetState): void {
  const s = loadOfflineSettings()
  if (s.userId !== user.id && s.on) saveOfflineSettings({ on: false, days: s.days, userId: null })
  if (!activeFor(user.id)) {
    void wipeOffline()
    return
  }
  void enableShellCache().catch(() => {})
  void runOfflineSync(get, RECONNECT_GAP_MS)
}

/** Çevrimiçi hesap listesi değişti: görünür küme daraldıysa (kasaya alındı, yetki kalktı) kopya hemen temizlenir */
export function offlineAccountsChanged(get: GetState): void {
  const visible = new Set(get().accounts.filter((a) => !a.secure).map((a) => a.id))
  const prev = runtime.offlineVisible
  runtime.offlineVisible = visible
  if (prev && [...prev].some((id) => !visible.has(id))) void runOfflineSync(get, 0)
}

/** Kaynak olayı her eşitlemede de gelir (durum satırı): tur yalnız görünen kişi ve takvim kümesi değiştiyse yeniden başlar, kopya temizlenir */
export async function offlinePimSourcesChanged(get: GetState): Promise<void> {
  const { addressbook, calendar } = get().pimCollections
  const scope = [...addressbook, ...calendar].filter((c) => !c.hidden).map((c) => c.id).sort((a, b) => a - b).join(',')
  const prev = runtime.offlinePimScope
  runtime.offlinePimScope = scope
  if (prev !== scope) await runOfflineSync(get, 0)
}

function showCopy(set: SetState, get: GetState, extra: Record<string, unknown> = {}): void {
  rpc.setFailFast(true)
  set({ offlineMode: true, ...extra })
  void get().refreshList(false)
}

async function usableSnapshot(): Promise<OfflineSnapshot | null> {
  const { userId } = loadOfflineSettings()
  if (userId == null || !activeFor(userId)) return null
  // IndexedDB open'ı engellenmiş bir silmenin arkasında takılabilir: açılış ve kopuş sonsuza dek beklemesin
  const snap = await boundedWait(readOfflineSnapshot(), true).catch(() => null)
  return snap?.user?.id === userId ? snap : null
}

/** Mod bu cihazda açık mı (kopuşta sunucuyu ne kadar bekleyeceği için; kopyanın varlığını denetlemez) */
export const offlineEnabled = (): boolean => {
  const { userId } = loadOfflineSettings()
  return userId != null && activeFor(userId)
}

export const hasOfflineCopy = async (): Promise<boolean> => (await usableSnapshot()) !== null

/** Kopyaya düşecekse sunucu sınırsız beklenmez; süre dolunca çağıran "ulaşılamadı" yoluna girer */
export function boundedWait<T>(p: Promise<T>, bounded: boolean): Promise<T> {
  if (!bounded) return p
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('sunucu yanıtlamadı')), OFFLINE_WAIT_MS)
    p.then(res, rej).finally(() => clearTimeout(timer))
  })
}

/** Açılışta sunucuya ulaşılamadı: kopya varsa onunla açılır (kimlik sorulmaz; veri cihaz anahtarıyla mühürlü) */
export async function bootFromCopy(set: SetState, get: GetState): Promise<boolean> {
  const snap = await usableSnapshot()
  if (!snap?.user) return false
  showCopy(set, get, {
    currentUser: snap.user, accounts: snap.accounts, accountCount: snap.accounts.length, savedSearches: readSavedSearches(snap.user.id)
  })
  return true
}

/** Oturum açıkken sunucu gitti */
export async function enterOffline(set: SetState, get: GetState): Promise<void> {
  const user = get().currentUser
  if (!user || get().offlineMode || get().serverRestarting || rpc.isOpen) return
  const snap = await usableSnapshot()
  if (snap?.user?.id !== user.id || rpc.isOpen || get().currentUser?.id !== user.id) return
  showCopy(set, get)
}

/** Taşıma yeniden açıldı */
export function leaveOffline(set: SetState, get: GetState): void {
  rpc.setFailFast(false)
  if (!get().offlineMode) return
  set({ offlineMode: false })
  void get().refreshBody()
}

/** Ayarlar: açma, gün değişimi, kapatma */
export async function setOfflineMode(get: GetState, on: boolean, days: OfflineDays): Promise<void> {
  const userId = get().currentUser?.id ?? null
  saveOfflineSettings({ on, days, userId: on ? userId : null })
  if (!on) return wipeOffline()
  void enableShellCache().catch(() => {}) // SW kaydı olmayabilir (ready hiç dönmez): eşitleme beklemez
  await runOfflineSync(get, 0)
}
