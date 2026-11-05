// Kasa parolası deneme sınırı. Parola kurulum genelidir: unlockVault, enableVaultBiometric ve smimeExportIdentity aynı sırrı
// sınar, bu yüzden aynı sayaçları paylaşırlar.
// - Kullanıcı sayacı: 15 dk'da 5 yanlıştan sonra o kullanıcı kilitlenir; başkası etkilenmez.
// - Rol sayacı: üyeler ve yöneticiler ayrı sayılır. Eşik aşılınca aynı roldeki herkes artan bekleme görür; sert kilit değildir,
//   çok hesaplı tahmini yavaşlatır. Üyenin yanlışı yöneticiye dokunmaz, yönetici kasayı her zaman açabilir.
// Bekleme üst sınıra varsa da kova başına pencerede sert tavan vardır; yönetici yalnız üye kovasından muaftır.
// 24 saatlik bütçe de rol başınadır: üyelerin yanlışları yalnız üye bütçesine, yöneticilerinki yalnız yönetici bütçesine yazılır,
// temizleme ikisini de sıfırlamaz. Üyeler yöneticiyi dışarıda bırakamaz; her rolün tahmin sayısına yine kesin üst sınır vardır.
// Sunucuda kurtarma: `reset-vault-throttle` komutu tüm kovaları siler.
// Sayaç prefs'te durur: süreci yeniden başlatmak (ya da düşürmek) sayacı sıfırlamaz. Deneme türetmeden önce yanlış olarak yazılır,
// doğruysa geri alınır: eşzamanlı istekler sınırı aşamaz, ortada düşen süreç deneme kazanmaz. Touch ID ile açma buradan geçmez.
import type { SessionUser } from '../../shared/rpc'
import { t } from '../../shared/i18n'
import type { Queries } from '../db/queries'
import { withKdfSlot } from '../kdfLimit'
import { syncLog } from '../log'
import { tProcess } from '../sessionLocale'

export const VAULT_USER_MAX_FAILS = 5
export const VAULT_HUB_MAX_FAILS = 20
export const VAULT_WINDOW_MS = 15 * 60_000
export const VAULT_HARD_MAX_FAILS = 3 * VAULT_HUB_MAX_FAILS
export const VAULT_DAY_MAX_FAILS = 200
export const VAULT_DAY_MS = 24 * 3_600_000
export const VAULT_CLEAR_COOLDOWN_MS = 5 * 60_000
export const VAULT_HUB_BASE_DELAY_MS = 1000
export const VAULT_HUB_MAX_DELAY_MS = 5 * 60_000

const PREF = 'vault_pass_fails'

interface Fails {
  hub: number[] // üyeler
  admins: number[]
  users: Record<string, number[]>
  day: number[] // üye yanlışları, 24 saat
  adminDay: number[] // yönetici yanlışları, 24 saat
  clearedAt?: number
}

type Who = Pick<SessionUser, 'id' | 'role'>

const times = (v: unknown, now: number, windowMs = VAULT_WINDOW_MS): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && x > now - windowMs) : []

function load(q: Queries, now: number): Fails {
  let raw: { hub?: unknown; admins?: unknown; users?: unknown; day?: unknown; adminDay?: unknown; clearedAt?: unknown } = {}
  try {
    raw = JSON.parse(q.prefGet(PREF) ?? '{}') as typeof raw
  } catch {
    /* bozuk kayıt boş sayılır; parola yine doğrulanır */
  }
  const users: Record<string, number[]> = {}
  if (raw?.users && typeof raw.users === 'object') {
    for (const [id, list] of Object.entries(raw.users)) {
      const live = times(list, now)
      if (live.length) users[id] = live
    }
  }
  const clearedAt = typeof raw?.clearedAt === 'number' ? { clearedAt: raw.clearedAt } : {}
  return { hub: times(raw?.hub, now), admins: times(raw?.admins, now), users, day: times(raw?.day, now, VAULT_DAY_MS), adminDay: times(raw?.adminDay, now, VAULT_DAY_MS), ...clearedAt }
}

/** Eşikten sonra her yanlış beklemeyi iki katına çıkarır, üst sınırda durur */
export function hubDelayMs(fails: number): number {
  if (fails < VAULT_HUB_MAX_FAILS) return 0
  return Math.min(VAULT_HUB_BASE_DELAY_MS * 2 ** Math.min(fails - VAULT_HUB_MAX_FAILS, 20), VAULT_HUB_MAX_DELAY_MS)
}

function retryAfter(f: Fails, who: Who, now: number): number | null {
  const mine = f.users[who.id] ?? []
  const bucket = who.role === 'admin' ? f.admins : f.hub
  const day = who.role === 'admin' ? f.adminDay : f.day
  const until = [
    ...(mine.length >= VAULT_USER_MAX_FAILS ? [mine[mine.length - VAULT_USER_MAX_FAILS] + VAULT_WINDOW_MS] : []),
    ...(bucket.length >= VAULT_HUB_MAX_FAILS ? [bucket[bucket.length - 1] + hubDelayMs(bucket.length)] : []),
    ...(bucket.length >= VAULT_HARD_MAX_FAILS ? [bucket[bucket.length - VAULT_HARD_MAX_FAILS] + VAULT_WINDOW_MS] : []),
    ...(day.length >= VAULT_DAY_MAX_FAILS ? [day[day.length - VAULT_DAY_MAX_FAILS] + VAULT_DAY_MS] : [])
  ]
  const at = Math.max(...until, 0)
  return at > now ? at - now : null
}

function dropOne(list: number[], at: number): void {
  const i = list.lastIndexOf(at)
  if (i >= 0) list.splice(i, 1)
}

/** Kilitliyse `verify` hiç çağrılmaz (deriveKey çalışmaz) ve hata atılır. `verify` false dönerse deneme kullanıcı, rol ve (role ait) gün sayacında
 *  kalır; true dönerse rezervasyon geri alınır ve o kullanıcının sayacı silinir: rol sayacı pencereyle düşer, parolayı bilen biri
 *  başkasına hak açmaz. `verify` hata atarsa (kasa kurulu değil) deneme sayılmaz. */
export async function checkVaultPassphrase(q: Queries, who: Who, now: number, verify: () => boolean | Promise<boolean>): Promise<boolean> {
  const f = load(q, now)
  const wait = retryAfter(f, who, now)
  if (wait !== null) throw new Error(t('sync.auth.lockedOut', { count: Math.ceil(wait / 1000) }))
  const bucket = (x: Fails): number[] => (who.role === 'admin' ? x.admins : x.hub)
  const dayOf = (x: Fails): number[] => (who.role === 'admin' ? x.adminDay : x.day)
  bucket(f).push(now)
  dayOf(f).push(now)
  ;(f.users[who.id] ??= []).push(now)
  q.prefSet(PREF, JSON.stringify(f))
  const undo = (clearUser: boolean): void => {
    const cur = load(q, now)
    dropOne(bucket(cur), now)
    dropOne(dayOf(cur), now)
    if (clearUser) delete cur.users[who.id]
    else if (cur.users[who.id]) dropOne(cur.users[who.id], now)
    q.prefSet(PREF, JSON.stringify(cur))
  }
  let ok: boolean
  try {
    ok = await withKdfSlot(verify)
  } catch (e) {
    undo(false)
    throw e
  }
  if (ok) undo(true)
  return ok
}

/** Yönetici kurtarması: yeniden başlatma ya da DB düzenlemesi gerekmez. Yalnız üye sayaçlarını siler: yönetici kovası ve yönetici
 *  girişleri kalır, böylece yönetici oturumu kendi tahmin sınırını sıfırlayamaz. Bekleme süresi ve denetim kaydı vardır. */
export function clearVaultPassphraseFails(q: Queries, caller: Who, now: number): void {
  const f = load(q, now)
  if (f.clearedAt !== undefined && now < f.clearedAt + VAULT_CLEAR_COOLDOWN_MS) {
    throw new Error(t('sync.vault.clearCooldown', { seconds: Math.ceil((f.clearedAt + VAULT_CLEAR_COOLDOWN_MS - now) / 1000) }))
  }
  f.hub = [] // gün bütçesi ve yönetici kovası kalır
  for (const id of Object.keys(f.users)) {
    if (Number(id) !== caller.id && q.getUserById(Number(id))?.role !== 'admin') delete f.users[id]
  }
  f.clearedAt = now
  q.prefSet(PREF, JSON.stringify(f))
  q.insertRuleLog({ kind: 'vault', refId: caller.id, accountId: null, messageId: null, summary: tProcess('sync.vault.failsCleared'), ok: true })
  syncLog.info('kasa: parola sayaçları temizlendi', { userId: caller.id })
}

/** Sunucu kurtarması (`reset-vault-throttle`): tüm kovaları, gün bütçelerini ve temizleme bekleme kaydını siler. Parola, kullanıcı
 *  adı ya da sayaç içeriği günlüğe yazılmaz. */
export function resetVaultThrottle(q: Queries): void {
  q.prefSet(PREF, '{}')
  syncLog.info('kasa: parola sınırı sıfırlandı (sunucu komutu)')
}
