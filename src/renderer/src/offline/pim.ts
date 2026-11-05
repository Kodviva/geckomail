// Kişi ve takvimin çevrimdışı kopyası. Mühürlü bloblar mevcut `meta` deposunda; düz metin yalnız ay anahtarıdır. Kapsam: açılmış ay penceresi −1 … +6 ay,
// açılmış örnekler (ham ICS yok) ve kişi özetleri (fotoğraf, not yok). Her tur blob bütünüyle değişir; yetkisi kalkan veri listelemeden önce gider.
import type { ContactSummary, EventOccurrence, PimCollectionInfo } from '../../../shared/pim'
import { rpc } from '../rpcClient'
import { getCacheKey, openJson, sealJson } from './cacheCrypto'
import * as db from './store'

export const MAX_OFFLINE_CONTACTS = 5000
const CONTACT_PAGE = 200
const MONTHS_BACK = 1
const MONTHS_AHEAD = 6
const CONTACTS = 'pim:contacts'
const COLLECTIONS = 'pim:collections'
const EVENTS_PREFIX = 'pim:events:'

export interface OfflineCollections {
  addressbook: PimCollectionInfo[]
  calendar: PimCollectionInfo[]
}

const pad = (n: number): string => String(n).padStart(2, '0')
const monthKey = (y: number, m: number): string => `${EVENTS_PREFIX}${y}-${pad(m + 1)}`
const zone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

async function fetchContacts(ids: number[], alive: () => boolean): Promise<ContactSummary[] | null> {
  const out: ContactSummary[] = []
  if (!ids.length) return out
  let cursor: { name: string; id: number } | null = null
  while (out.length < MAX_OFFLINE_CONTACTS) {
    if (!alive()) return null
    const page: ContactSummary[] = await rpc.call('listContacts', { collectionIds: ids, cursor, limit: CONTACT_PAGE })
    for (const c of page) out.push({ id: c.id, collectionId: c.collectionId, kind: c.kind, fullName: c.fullName, org: c.org, emails: c.emails })
    const last = page[page.length - 1]
    if (page.length < CONTACT_PAGE || !last) break
    cursor = { name: last.fullName, id: last.id }
  }
  return out.slice(0, MAX_OFFLINE_CONTACTS)
}

/** Kapsam değişti: eski kapsamın kopyası listeleme ve bağlantı beklemeden gider */
export async function dropOfflinePim(at: number): Promise<boolean> {
  for (const name of [CONTACTS, COLLECTIONS, ...(await db.metaKeys(EVENTS_PREFIX))]) if (!(await db.metaDelete(name, at))) return false
  return true
}

/** visible null: tür listelenemedi, kopya bırakılmaz. Listelenebildiyse artık görünmeyen koleksiyondan satır taşıyan (ya da açılamayan) blob gider */
async function dropUnseen(names: string[], visible: Set<number> | null, o: { at: number; key: CryptoKey }): Promise<boolean> {
  for (const name of names) {
    const blob = visible && (await db.metaGet<ArrayBuffer>(name))
    if (visible && !blob) continue
    const rows = blob ? await openJson<{ collectionId: number }[]>(o.key, blob).catch(() => null) : null
    if (rows?.every((r) => visible?.has(r.collectionId))) continue
    if (!(await db.metaDelete(name, o.at))) return false
  }
  return true
}

export async function syncOfflinePim(o: { alive(): boolean; at: number; key: CryptoKey }): Promise<{ contacts: number; months: number }> {
  const none = { contacts: 0, months: 0 }
  if (!o.alive()) return none
  const [books, calendars] = await Promise.allSettled([rpc.call('listPimCollections', { type: 'addressbook' }), rpc.call('listPimCollections', { type: 'calendar' })])
  // bağlantı koptu: sunucu "görünmüyor" demedi, kopya kalır. Bağlıyken liste başarısızsa kopya kapanır
  if (!o.alive()) return none
  const addressbook = books.status === 'fulfilled' ? books.value : null
  const calendar = calendars.status === 'fulfilled' ? calendars.value : null
  const shown = (list: PimCollectionInfo[]): number[] => list.filter((c) => !c.hidden).map((c) => c.id)
  const visible = (list: PimCollectionInfo[] | null): Set<number> | null => list && new Set(shown(list))
  // önce temizlik: sonraki listeleme hata verse de görünmeyen koleksiyonun kopyası kalmaz
  if (!(await dropUnseen([CONTACTS], visible(addressbook), o))) return none
  if (!(await dropUnseen(await db.metaKeys(EVENTS_PREFIX), visible(calendar), o))) return none
  const put = async (name: string, value: unknown): Promise<boolean> => o.alive() && db.metaPut(name, await sealJson(o.key, value), o.at)
  if (addressbook && calendar) {
    const collections: OfflineCollections = { addressbook, calendar }
    if (!(await put(COLLECTIONS, collections))) return none
  } else if (!(await db.metaDelete(COLLECTIONS, o.at))) return none
  let contacts: ContactSummary[] = []
  if (addressbook) {
    const got = await fetchContacts(shown(addressbook), o.alive)
    if (!got || !(await put(CONTACTS, got))) return none
    contacts = got
  }
  if (!calendar) return { contacts: contacts.length, months: 0 }

  const ids = shown(calendar)
  const tz = zone()
  const now = new Date()
  const wanted = new Set<string>()
  for (let i = -MONTHS_BACK; i <= MONTHS_AHEAD; i++) {
    const from = new Date(now.getFullYear(), now.getMonth() + i, 1)
    const to = new Date(now.getFullYear(), now.getMonth() + i + 1, 1)
    const name = monthKey(from.getFullYear(), from.getMonth())
    const events: EventOccurrence[] = ids.length ? await rpc.call('listEvents', { from: from.getTime(), to: to.getTime(), tz, collectionIds: ids }) : []
    if (!(await put(name, events))) return { contacts: contacts.length, months: wanted.size }
    wanted.add(name)
  }
  for (const name of await db.metaKeys(EVENTS_PREFIX)) if (!wanted.has(name) && !(await db.metaDelete(name, o.at))) break
  return { contacts: contacts.length, months: wanted.size }
}

async function readBlob<T>(name: string): Promise<T | null> {
  const blob = await db.metaGet<ArrayBuffer>(name)
  if (!blob) return null
  return openJson<T>(await getCacheKey(), blob).catch(() => null)
}

export const readOfflineCollections = (): Promise<OfflineCollections | null> => readBlob<OfflineCollections>(COLLECTIONS)

export async function readOfflineContacts(query?: string): Promise<ContactSummary[]> {
  const all = (await readBlob<ContactSummary[]>(CONTACTS)) ?? []
  const want = query?.trim().toLocaleLowerCase()
  if (!want) return all
  return all.filter((c) => [c.fullName, c.org ?? '', ...c.emails.map((e) => e.addr)].some((v) => v.toLocaleLowerCase().includes(want)))
}

export async function readOfflineEvents(from: number, to: number): Promise<EventOccurrence[]> {
  const first = new Date(from)
  const last = new Date(to)
  const seen = new Map<string, EventOccurrence>()
  for (let d = new Date(first.getFullYear(), first.getMonth(), 1); d <= last; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    for (const e of (await readBlob<EventOccurrence[]>(monthKey(d.getFullYear(), d.getMonth()))) ?? []) {
      if (e.start < to && (e.end > from || e.start >= from)) seen.set(e.key, e)
    }
  }
  return [...seen.values()].sort((a, b) => a.start - b.start || a.key.localeCompare(b.key))
}
