// Kullanıcının taşıdığı iletiler: hedef klasörde göründüklerinde yeni posta sayılmaz (kural, bildirim yok). Yalnız
// taşınanlar işaretlenir, aynı UID aralığına düşen gerçek posta yeni kalır. Taşıma sunucuda biter bitmez normal poll
// hedefi önce okuyabilir: bu yüzden kayıt taşımadan ÖNCE Message-ID ile açılır, UID eşlemesi sonra eklenir.
// Tanımlanamayan satır yeni sayılır (eski bir bildirim, kaybolan gerçek postadan iyidir). Bellekte tutulur: süreç
// yeniden başlarsa ya da ne Message-ID ne UIDPLUS varsa, kural satırı izlenen klasörde yeniden çalışabilir ve
// forward/webhook bir kez daha gider. Başka istemcinin taşıdığı posta da burada görünmez: izlenen klasöre
// izleme başladıktan sonra gelen ve kuralla eşleşen her satır sunucu taşıması sayılır (Ayarlar'daki yardım metni).
const TTL_MS = 5 * 60_000

interface Entry { src: number; messageId: string | null; uid: number | null; until: number }

const pending = new Map<string, Entry[]>()
const key = (accountId: number, path: string): string => `${accountId}|${path}`

function live(k: string, now: number): Entry[] {
  const list = (pending.get(k) ?? []).filter((e) => e.until > now)
  if (list.length) pending.set(k, list)
  else pending.delete(k)
  return list
}

export const movedArrivals = {
  /** Taşıma başlamadan önce: kaynak UID ve iletinin Message-ID'si */
  expect(accountId: number, targetPath: string, moved: { uid: number; messageId: string | null }[], now = Date.now()): void {
    const k = key(accountId, targetPath)
    pending.set(k, [...live(k, now), ...moved.map((m) => ({ src: m.uid, messageId: m.messageId, uid: null, until: now + TTL_MS }))])
  },

  /** Taşıma bitince sunucunun verdiği kaynak UID -> hedef UID eşlemesi (COPYUID); yoksa Message-ID'ye güvenilir */
  resolve(accountId: number, targetPath: string, srcUids: number[], uidMap: ReadonlyMap<number, number> | undefined): void {
    if (!uidMap) return
    for (const e of live(key(accountId, targetPath), Date.now())) if (srcUids.includes(e.src)) e.uid = uidMap.get(e.src) ?? null
  },

  /** Taşıma başarısız: bu kaynak UID'lerin kaydı düşer */
  cancel(accountId: number, targetPath: string, srcUids: number[]): void {
    const k = key(accountId, targetPath)
    const rest = live(k, Date.now()).filter((e) => !srcUids.includes(e.src))
    if (rest.length) pending.set(k, rest)
    else pending.delete(k)
  },

  /** Çekilen satır taşınan iletiyse true (kayıt bir kez harcanır) */
  consume(accountId: number, targetPath: string, uid: number, messageId: string | null, now = Date.now()): boolean {
    const k = key(accountId, targetPath)
    const list = live(k, now)
    const i = list.findIndex((e) => (e.uid != null ? e.uid === uid : messageId != null && e.messageId === messageId))
    if (i < 0) return false
    list.splice(i, 1)
    if (list.length) pending.set(k, list)
    else pending.delete(k)
    return true
  },

  reset(): void {
    pending.clear()
  }
}
