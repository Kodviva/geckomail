// Çevrimdışı eşitleme: görülebilen, kasa dışı hesapların son N gününü sunucudan sırayla çeker, mühürleyip saklar.
// Nazik: tek seferde tek istek, küçük partiler arası bekleme, bağlantı kopunca ya da silinince durur. Gövdesi
// sunucuda olmayan ileti IMAP'ten çekilir: ona da sırayla ve tur başına sınırlı gidilir.
// Sınırlar: en fazla 2000 ileti, 200 MB gövde (cihaz başına). Ekler ve satır içi resimler saklanmaz.
import type { AccountInfo, BodyResult, FolderKind, MessageRow, SessionUser } from '../../../shared/rpc'
import { rpc } from '../rpcClient'
import { getCacheKey, openJson, sealJson } from './cacheCrypto'
import { dropOfflinePim, syncOfflinePim } from './pim'
import * as db from './store'

export const MAX_MESSAGES = 2000
export const MAX_BODY_BYTES = 200 * 1024 * 1024
/** Tur başına IMAP'e gidebilecek en fazla gövde; kalanı sonraki tura */
const MAX_BODY_FETCHES = 200
const KINDS: FolderKind[] = ['inbox', 'sent', 'archive']
const PAGE = 200
const BATCH = 20
const PAUSE_MS = 1000
const BODY_WAIT_MS = 15_000
const DAY_MS = 86_400_000

export type OfflineRow = MessageRow & { folderKind: FolderKind }
export interface OfflineSnapshot {
  user: SessionUser | null
  accounts: AccountInfo[]
  syncedAt: number
  count: number
}
export interface OfflineListQuery {
  folderKind: FolderKind
  accountIds?: number[] | null
  folderId?: number
  unreadOnly?: boolean
  query?: string
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

/** Sunucu gövdeyi IMAP'ten çekerken: hazır olayını bekler (süre dolarsa ileti bu turda atlanır) */
function bodyReady(id: number): Promise<void> {
  return new Promise((res) => {
    const timer = setTimeout(finish, BODY_WAIT_MS)
    const off = rpc.on('body:ready', ({ messageId }) => {
      if (messageId === id) finish()
    })
    function finish(): void {
      clearTimeout(timer)
      off()
      res()
    }
  })
}

async function fetchRows(accountIds: number[], cutoff: number, alive: () => boolean, pauseMs: number): Promise<OfflineRow[] | null> {
  const out: OfflineRow[] = []
  const allowed = new Set(accountIds)
  if (!allowed.size) return out
  for (const folderKind of KINDS) {
    let cursor: { date: number; id: number } | null = null
    let fetched = 0
    while (fetched < MAX_MESSAGES) {
      if (!alive()) return null
      const page: MessageRow[] = await rpc.call('listMessages', { accountIds, folderKind, cursor, limit: PAGE })
      fetched += page.length
      for (const r of page) if (r.date >= cutoff && !r.locked && allowed.has(r.accountId)) out.push({ ...r, folderKind })
      const last = page[page.length - 1]
      if (page.length < PAGE || !last || last.date < cutoff) break
      cursor = { date: last.date, id: last.id }
      await sleep(pauseMs)
    }
  }
  return out.sort((a, b) => b.date - a.date || b.id - a.id).slice(0, MAX_MESSAGES)
}

async function openRows(key: CryptoKey): Promise<OfflineRow[]> {
  const sealed = await db.allRows()
  const out = await Promise.all(sealed.map((r) => openJson<OfflineRow>(key, r.sealed).catch(() => null)))
  return out.filter((r): r is OfflineRow => r !== null)
}

type Phase = { messages: number; rows: OfflineRow[] | null }

/** rows: gövde evresine geçecek tam liste; yarıda kalırsa null */
async function syncMail(o: SyncOptions, key: CryptoKey, at: number, alive: () => boolean, pauseMs: number): Promise<Phase> {
  const stop = (messages = 0): Phase => ({ messages, rows: null })
  // sunucunun şu anki listesi esas: kasaya alınan ya da yetkisi kalkan hesap ayrıca filtrelenir
  const visible = await rpc.call('getAccounts', {})
  const wanted = new Set(o.accountIds)
  const accounts = visible.filter((a) => !a.secure && wanted.has(a.id))
  const allowed = new Set(accounts.map((a) => a.id))
  if (!alive()) return stop()
  const snapshot = async (count: number): Promise<boolean> => {
    const s: OfflineSnapshot = { user: o.user ?? null, accounts, syncedAt: Date.now(), count }
    return db.metaPut('snapshot', await sealJson(key, s), at)
  }

  // önce temizlik: ağ sonraki adımda kopsa bile kasaya alınan hesabın kopyası (hesap kaydı dahil) kalmasın
  const before = await openRows(key)
  const gone = before.filter((r) => !allowed.has(r.accountId)).map((r) => r.id)
  if (!(await db.deleteMessages(gone, at))) return stop()
  if (gone.length && !(await snapshot(before.length - gone.length))) return stop()

  const cutoff = Date.now() - o.days * DAY_MS
  const rows = await fetchRows(accounts.map((a) => a.id), cutoff, alive, pauseMs)
  if (!rows || !alive()) return stop(before.length - gone.length)
  const keep = new Set(rows.map((r) => r.id))
  const stale = before.filter((r) => !keep.has(r.id)).map((r) => r.id)
  if (!(await db.deleteMessages(stale, at))) return stop()
  for (let i = 0; i < rows.length; i += PAGE) {
    const part = rows.slice(i, i + PAGE)
    const sealed = await Promise.all(part.map(async (r) => ({ id: r.id, date: r.date, sealed: await sealJson(key, r) })))
    if (!alive() || !(await db.putRows(sealed, at))) return stop()
  }
  if (!alive() || !(await snapshot(rows.length))) return stop()
  return { messages: rows.length, rows }
}

async function runSync(o: SyncOptions): Promise<{ messages: number }> {
  const at = db.currentEpoch()
  const gen = generation
  const pauseMs = o.pauseMs ?? PAUSE_MS
  // kapsam değişince (hesap kasaya alındı, gün değişti) bu tur yarıda bırakılır, yenisi temizleyerek başlar
  const alive = (): boolean => rpc.isOpen && at === db.currentEpoch() && gen === generation
  if (o.restart) await dropOfflinePim(at)
  if (!alive()) return { messages: 0 }
  const key = await getCacheKey()
  if (!alive()) return { messages: 0 }

  // iki evre birbirinin erken dönüşünden ve hatasından etkilenmez: posta durunca kişi ve takvim temizliği yine çalışır
  const mail = await syncMail(o, key, at, alive, pauseMs).catch((): Phase => ({ messages: 0, rows: null }))
  await syncOfflinePim({ alive, at, key }).catch(() => {})
  if (mail.rows) await fetchBodies(key, mail.rows, at, alive, pauseMs, o.maxBodyBytes ?? MAX_BODY_BYTES)
  return { messages: mail.messages }
}

async function fetchBodies(key: CryptoKey, rows: OfflineRow[], at: number, alive: () => boolean, pauseMs: number, maxBytes: number): Promise<void> {
  if (!alive()) return
  const { ids, bytes } = await db.bodyStats()
  let total = bytes
  let sent = 0
  let imap = 0
  for (const r of rows) {
    if (ids.has(r.id) || r.smimeKind === 'encrypted') continue // şifreli içerik çevrimdışı saklanmaz, arka plan çözümü yok
    if (!alive() || total >= maxBytes || imap >= MAX_BODY_FETCHES) return
    if (sent > 0 && sent % BATCH === 0) await sleep(pauseMs)
    sent++
    let body: BodyResult = await rpc.call('getBody', { messageId: r.id })
    if (body.state === 'fetching') {
      imap++
      await bodyReady(r.id)
      if (!alive()) return
      body = await rpc.call('getBody', { messageId: r.id })
    }
    // imzalı kabuk içinde şifreli ileti: satır "signed" görünür, çözülmüş gövde cihaza inmez
    if (body.state !== 'ready' || (body.smime && body.smime.enc !== 'none')) continue
    const sealed = await sealJson(key, body)
    if (!alive() || total + sealed.byteLength > maxBytes) return
    if (!(await db.putBody({ id: r.id, sealed }, at))) return
    total += sealed.byteLength
  }
}

export interface SyncOptions {
  days: number
  accountIds: number[]
  /** çevrimdışı açılışta gösterilecek kullanıcı (mühürlü saklanır) */
  user?: SessionUser
  pauseMs?: number
  maxBodyBytes?: number
  /** kapsam değişti: sürmekte olan tura katılma, onu kes */
  restart?: boolean
}

let running: Promise<{ messages: number }> | null = null
let generation = 0
/** Yarıda bırakılan turun ardından çalışacak olan; arada silme olduysa (başka kullanıcı) çalışmaz */
let next: { o: SyncOptions; at: number } | null = null

async function drain(first: SyncOptions): Promise<{ messages: number }> {
  let o = first
  for (;;) {
    const r = await runSync(o).catch(() => ({ messages: 0 }))
    const queued: { o: SyncOptions; at: number } | null = next
    next = null
    if (!queued || queued.at !== db.currentEpoch()) {
      running = null // await araya girmeden: sonraki çağrı bu turu bitmiş görür
      return r
    }
    o = queued.o
  }
}

/** Aynı anda tek tur: normal çağrı sürene katılır. restart sürmekte olanı keser, bitince bu seçeneklerle yeniden
 *  başlar. Bağlantı koparsa ya da kota dolarsa o ana dek saklananlar kalır, hata atmaz. */
export function syncOffline(o: SyncOptions): Promise<{ messages: number }> {
  if (running) {
    if (o.restart) {
      generation++
      next = { o, at: db.currentEpoch() }
    }
    return running
  }
  running = drain(o)
  return running
}

/** Çevrimdışı açılış için; kayıt yok ya da açılamıyorsa null */
export async function readOfflineSnapshot(): Promise<OfflineSnapshot | null> {
  const sealed = await db.metaGet<ArrayBuffer>('snapshot')
  if (!sealed) return null
  try {
    return await openJson<OfflineSnapshot>(await getCacheKey(), sealed)
  } catch {
    return null
  }
}

export async function readOfflineList(q: OfflineListQuery): Promise<OfflineRow[]> {
  const rows = await openRows(await getCacheKey())
  const text = q.query?.trim().toLocaleLowerCase()
  return rows.filter(
    (r) =>
      (q.folderId != null ? r.folderId === q.folderId : r.folderKind === q.folderKind) &&
      (!q.accountIds || q.accountIds.includes(r.accountId)) &&
      (!q.unreadOnly || !r.seen) &&
      (!text || [r.subject, r.fromName, r.fromAddr, r.preview].some((s) => s?.toLocaleLowerCase().includes(text)))
  )
}

export async function readOfflineBody(id: number): Promise<BodyResult | null> {
  const b = await db.getBody(id)
  if (!b) return null
  try {
    return await openJson<BodyResult>(await getCacheKey(), b.sealed)
  } catch {
    return null
  }
}
