// Çevrimdışı önbellek: IndexedDB katmanı. Burada yalnız mühürlü kayıt taşınır (mühürleme cacheCrypto, içerik sync).
// Düz alan olarak yalnız ileti kimliği ve sıralama için tarih durur; konu/gönderen/gövde/hesap hep mühürlüdür.
// Bütün yazmalar "dönem" (epoch) ister: wipeOffline dönemi ilerletir, sürmekte olan eşitleme silinmiş veritabanını
// yeniden yaratamaz.

export const DB_NAME = 'gecko-offline'
export const SHELL_PREFIX = 'gecko-shell-'
const WIPE_WAIT_MS = 3000
const BYTES_KEY = 'bodyBytes'

export interface SealedRow {
  id: number
  date: number
  sealed: ArrayBuffer
}
export interface SealedBody {
  id: number
  sealed: ArrayBuffer
}

let epoch = 0
let handle: Promise<IDBDatabase> | null = null

export const currentEpoch = (): number => epoch

const done = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => {
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error ?? new Error('IndexedDB'))
  })

const committed = (tx: IDBTransaction): Promise<void> =>
  new Promise((res, rej) => {
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error ?? new Error('IndexedDB'))
    tx.onabort = () => rej(tx.error ?? new Error('IndexedDB'))
  })

function db(): Promise<IDBDatabase> {
  if (handle) return handle
  const opening = new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1)
    r.onupgradeneeded = () => {
      const d = r.result
      d.createObjectStore('meta')
      d.createObjectStore('messages', { keyPath: 'id' }).createIndex('date', 'date')
      d.createObjectStore('bodies', { keyPath: 'id' })
    }
    r.onerror = () => rej(r.error ?? new Error('IndexedDB'))
    r.onsuccess = () => {
      const d = r.result
      // başka sekme siliyor: bağlantı bırakılır (yoksa silme bekler), bu sekmenin eşitlemesi de durur
      const release = (): void => {
        if (handle !== opening) return
        epoch++
        handle = null
      }
      d.onversionchange = () => {
        d.close()
        release()
      }
      d.onclose = release
      res(d)
    }
  })
  handle = opening
  opening.catch(() => {
    if (handle === opening) handle = null
  })
  return opening
}

/** Anahtar deposu: nesne olarak saklanan CryptoKey ve mühürlü anlık görüntü */
export async function metaGet<T>(name: string): Promise<T | undefined> {
  const d = await db()
  return done(d.transaction('meta').objectStore('meta').get(name) as IDBRequest<T | undefined>)
}

/** Yoksa yazar, varsa var olanı döner; tek işlemde (iki sekme aynı anda üretirse tek anahtarda buluşur) */
export async function metaPutIfAbsent<T>(name: string, value: T): Promise<T> {
  const d = await db()
  const tx = d.transaction('meta', 'readwrite')
  const store = tx.objectStore('meta')
  const existing = await done(store.get(name) as IDBRequest<T | undefined>)
  if (existing !== undefined) return existing
  store.put(value, name)
  await committed(tx)
  return value
}

export async function metaPut(name: string, value: unknown, at: number): Promise<boolean> {
  if (at !== epoch) return false
  const d = await db()
  if (at !== epoch) return false
  const tx = d.transaction('meta', 'readwrite')
  tx.objectStore('meta').put(value, name)
  await committed(tx)
  return true
}

export async function putRows(rows: SealedRow[], at: number): Promise<boolean> {
  if (at !== epoch) return false
  const d = await db()
  if (at !== epoch) return false
  const tx = d.transaction('messages', 'readwrite')
  const store = tx.objectStore('messages')
  for (const r of rows) store.put(r)
  await committed(tx)
  return true
}

const readBytes = async (meta: IDBObjectStore): Promise<number> => ((await done(meta.get(BYTES_KEY))) as number | undefined) ?? 0

/** Toplam boyut gövdeyle aynı işlemde güncellenir: sayaç kaymaz, kota için gövdeler belleğe okunmaz */
export async function putBody(body: SealedBody, at: number): Promise<boolean> {
  if (at !== epoch) return false
  const d = await db()
  if (at !== epoch) return false
  const tx = d.transaction(['bodies', 'meta'], 'readwrite')
  const bodies = tx.objectStore('bodies')
  const meta = tx.objectStore('meta')
  const total = await readBytes(meta)
  // iki sekme aynı gövdeyi yazarsa ikinci sayılmaz
  if (!(await done(bodies.count(body.id)))) {
    bodies.put(body)
    meta.put(total + body.sealed.byteLength, BYTES_KEY)
  }
  await committed(tx)
  return true
}

/** İleti ve varsa gövdesi birlikte */
export async function deleteMessages(ids: number[], at: number): Promise<boolean> {
  if (!ids.length) return true
  if (at !== epoch) return false
  const d = await db()
  if (at !== epoch) return false
  const tx = d.transaction(['messages', 'bodies', 'meta'], 'readwrite')
  const bodies = tx.objectStore('bodies')
  const meta = tx.objectStore('meta')
  let total = await readBytes(meta)
  for (const id of ids) {
    tx.objectStore('messages').delete(id)
    const b = (await done(bodies.get(id))) as SealedBody | undefined
    if (!b) continue
    total -= b.sealed.byteLength
    bodies.delete(id)
  }
  meta.put(Math.max(0, total), BYTES_KEY)
  await committed(tx)
  return true
}

/** Yeniden eskiye */
export async function allRows(): Promise<SealedRow[]> {
  const d = await db()
  const rows = await done(d.transaction('messages').objectStore('messages').index('date').getAll() as IDBRequest<SealedRow[]>)
  return rows.reverse()
}

export async function getBody(id: number): Promise<SealedBody | undefined> {
  const d = await db()
  return done(d.transaction('bodies').objectStore('bodies').get(id) as IDBRequest<SealedBody | undefined>)
}

/** Saklı gövdelerin kimlikleri ve toplam boyutu (kota denetimi için); gövdeler okunmaz */
export async function bodyStats(): Promise<{ ids: Set<number>; bytes: number }> {
  const d = await db()
  const tx = d.transaction(['bodies', 'meta'])
  const [ids, bytes] = await Promise.all([done(tx.objectStore('bodies').getAllKeys()), readBytes(tx.objectStore('meta'))])
  return { ids: new Set(ids as number[]), bytes }
}

async function deleteShellCaches(): Promise<void> {
  try {
    if (typeof caches === 'undefined' || !caches) return // güvensiz köken
    const names = await caches.keys()
    await Promise.all(names.filter((n) => n.startsWith(SHELL_PREFIX)).map((n) => caches.delete(n)))
  } catch {
    /* depo kapalı: silinecek önbellek de yok */
  }
}
export async function metaDelete(name: string, at: number): Promise<boolean> {
  if (at !== epoch) return false
  const d = await db()
  if (at !== epoch) return false
  const tx = d.transaction('meta', 'readwrite')
  tx.objectStore('meta').delete(name)
  await committed(tx)
  return true
}

export async function metaKeys(prefix: string): Promise<string[]> {
  const d = await db()
  const keys = await done(d.transaction('meta').objectStore('meta').getAllKeys())
  return keys.filter((k): k is string => typeof k === 'string' && k.startsWith(prefix))
}

/** Bu cihazdaki bütün çevrimdışı veri: veritabanı (anahtarla birlikte) + uygulama kabuğu önbelleği. Silme isteği
 *  ilk senkron adımda verilir: çağıran beklemeden çıksa da (sekme kapansa da) istek gitmiştir. */
export async function wipeOffline(): Promise<void> {
  epoch++
  const open = handle
  handle = null
  void open?.then((d) => d.close(), () => {})
  const deleted = new Promise<void>((res) => {
    try {
      const r = indexedDB.deleteDatabase(DB_NAME)
      r.onsuccess = () => res()
      r.onerror = () => res()
      // başka sekme hâlâ bağlıysa versionchange ile bırakır; bırakınca silme kendiliğinden tamamlanır
      setTimeout(res, WIPE_WAIT_MS)
    } catch {
      res() // IndexedDB kapalı (gizli pencere): silinecek veri yok
    }
  })
  await Promise.all([deleted, deleteShellCaches()])
}
