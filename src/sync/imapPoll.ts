import { isMissingMailbox } from './imapClient'
import type { ImapFlow, FetchMessageObject } from 'imapflow'
import type { FolderKind } from '../shared/rpc'
import { movedArrivals } from './movedArrivals'
import { classifyStructure } from './smime/mime'
import type { AccountRow, FolderRow, Queries, HeaderInput } from './db/queries'

const INITIAL_HEADERS = 100
const NEW_MAIL_BATCH = 500
const FLAG_WINDOW = 1000
const DEEP_FLAG_INTERVAL_MS = 6 * 3600_000
const FOLDER_LIST_TTL_MS = 6 * 3600_000

const SENT_NAMES = ['sent', 'inbox.sent', 'sent items', 'sent messages', 'inbox.sent items']
// SPECIAL-USE bildirmeyen sunucular için arayüz dillerindeki yerel adlar. Yanlış eşleşme klasördeki silmeyi kalıcı yapar:
// yalnız kesin adlar (QQ'da 垃圾箱 Spam'dir, bu yüzden yok), yalnız kök ya da INBOX altı
const TRASH_NAMES = [
  'trash', 'deleted', 'deleted items', 'deleted messages', 'bin',
  'çöp', 'çöp kutusu', 'silinenler', 'silinmiş öğeler',
  'papierkorb', 'gelöscht', 'gelöschte elemente', 'gelöschte objekte',
  'corbeille', 'éléments supprimés', 'messages supprimés',
  'papelera', 'elementos eliminados', 'correo eliminado',
  'lixeira', 'lixo', 'itens excluídos', 'itens eliminados',
  'корзина', 'удаленные', 'удалённые', 'удаленные элементы', 'удалённые элементы',
  'المحذوفات', 'سلة المهملات', 'العناصر المحذوفة',
  'ट्रैश', 'हटाए गए आइटम',
  'ゴミ箱', 'ごみ箱', '削除済み', '削除済みアイテム',
  '已删除', '已删除邮件', '废纸篓', '回收站'
]
const JUNK_NAMES = ['junk', 'inbox.junk', 'spam', 'inbox.spam', 'junk e-mail']
const ARCHIVE_NAMES = ['archive', 'inbox.archive', 'archives', 'inbox.archives']

export interface PollResult {
  changed: boolean
  newInboxMessages: number
  /** Sieve'in taşıdığı izlenen klasörlere varış: Gelen Kutusu saymaz, kurallar yine çalışmalı */
  watchedArrivals: number
}

function detectKind(path: string, specialUse: string | undefined): FolderKind {
  if (path.toUpperCase() === 'INBOX') return 'inbox'
  switch (specialUse) {
    case '\\Sent':
      return 'sent'
    case '\\Trash':
      return 'trash'
    case '\\Junk':
      return 'junk'
    case '\\Archive':
      return 'archive'
  }
  const lower = path.toLowerCase()
  if (SENT_NAMES.includes(lower)) return 'sent'
  if (TRASH_NAMES.includes(lower.normalize('NFC').replace(/^inbox[./]/, ''))) return 'trash'
  if (JUNK_NAMES.includes(lower)) return 'junk'
  if (ARCHIVE_NAMES.includes(lower)) return 'archive'
  return 'other'
}

export async function ensureFolders(q: Queries, account: AccountRow, client: ImapFlow): Promise<FolderRow[]> {
  const key = `folders_listed_${account.id}`
  const last = Number(q.prefGet(key) ?? 0)
  const known = q.getFolders(account.id)
  if (known.length && Date.now() - last < FOLDER_LIST_TTL_MS) return known
  const listed = await client.list()
  q.tx(() => {
    for (const mb of listed) {
      q.upsertFolder(account.id, mb.path, detectKind(mb.path, mb.specialUse), !!mb.specialUse && mb.specialUse !== '\\Inbox')
    }
    // Sunucuda artık olmayan klasörler (silinmiş/yeniden adlandırılmış) yerelden düşer: kalırsa her yoklama
    // "NO Mailbox does not exist" ile düşüyordu ("Command failed", 29 Eyl'de 8 hesap). Yalnız liste tam
    // görünüyorsa (INBOX içinde) — yarım/boş LIST yanıtı yerel veriyi silmesin.
    if (listed.some((mb) => mb.path.toUpperCase() === 'INBOX')) {
      const present = new Set(listed.map((mb) => mb.path))
      for (const f of known) if (!present.has(f.path)) q.deleteFolder(f.id)
    }
    q.prefSet(key, String(Date.now()))
  })
  return q.getFolders(account.id)
}

/** Klasör listesini bir sonraki yoklamada yeniden çektir (bayat klasör tespit edildi) */
export function invalidateFolderList(q: Queries, accountId: number): void {
  q.prefSet(`folders_listed_${accountId}`, '0')
}

const P7_SIGNATURE = /^application\/(x-)?pkcs7-signature$/i
const P7_MIME = /^application\/(x-)?pkcs7-mime$/i

// bodyStructure ağacında gerçek ek var mı? (inline text/resim parçaları, imza parçası ve kökteki S/MIME kabı hariç;
// gömülü .p7m sıradan ektir)
export function hasAttachmentParts(root: unknown): boolean {
  if (P7_MIME.test((root as { type?: string } | null)?.type ?? '')) return false
  return hasAttachmentNode(root)
}

function hasAttachmentNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false
  const n = node as {
    disposition?: string
    type?: string
    childNodes?: unknown[]
    dispositionParameters?: { filename?: string }
    parameters?: { name?: string }
  }
  if (n.childNodes?.length) return n.childNodes.some(hasAttachmentNode)
  if (P7_SIGNATURE.test(n.type ?? '')) return false
  if (n.disposition === 'attachment') return true
  const named = n.dispositionParameters?.filename || n.parameters?.name
  if (named && n.type && !n.type.startsWith('text/')) return true
  return false
}

// Sıralama tarihi: gönderenin yazdığı Date: başlığı; ama sunucuya varıştan (INTERNALDATE) 1 günden
// fazla ilerideyse sahte/bozuk sayılır ve varış tarihi kullanılır — gelecek tarihli spam listenin
// tepesine yapışmasın
export function messageDate(headerDate: Date | string | undefined, internalDate: Date | string | undefined, now = Date.now()): number {
  const internal = internalDate ? new Date(internalDate).getTime() : NaN
  const header = headerDate ? new Date(headerDate).getTime() : NaN
  const arrival = Number.isFinite(internal) ? internal : now
  if (!Number.isFinite(header)) return arrival
  return header > arrival + 86_400_000 ? arrival : header
}

// ham başlık bloğundan tek bir alan çıkar (katlanmış satırları birleştirir)
function extractHeader(raw: Buffer | undefined, name: string): string | null {
  if (!raw) return null
  const m = raw.toString('utf-8').match(new RegExp(`^${name}:[ \\t]*(.+(?:\\r?\\n[ \\t]+.+)*)`, 'im'))
  return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : null
}

function headerFromFetch(msg: FetchMessageObject, folder: FolderRow, account: AccountRow) {
  const env = msg.envelope
  const from = env?.from?.[0]
  const flags = msg.flags ?? new Set<string>()
  const to = env?.to?.map((a) => ({ name: a.name ?? null, address: a.address ?? null })) ?? []
  return {
    folderId: folder.id,
    accountId: account.id,
    folderKind: folder.kind,
    uid: msg.uid,
    messageId: env?.messageId ?? null,
    inReplyTo: env?.inReplyTo ?? null,
    subject: env?.subject ?? null,
    fromName: from?.name ?? null,
    fromAddr: from?.address ?? null,
    toJson: to.length ? JSON.stringify(to) : null,
    date: messageDate(env?.date, msg.internalDate),
    size: msg.size ?? null,
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    hasAttachments: hasAttachmentParts(msg.bodyStructure),
    smimeKind: classifyStructure(msg.bodyStructure),
    listUnsubscribe: extractHeader(msg.headers, 'List-Unsubscribe'),
    listUnsubscribePost: extractHeader(msg.headers, 'List-Unsubscribe-Post'),
    autoForwarded: !!extractHeader(msg.headers, 'X-GeckoMail-Forwarded')
  }
}

const HEADER_QUERY = {
  uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true,
  headers: ['list-unsubscribe', 'list-unsubscribe-post', 'x-geckomail-forwarded']
}

async function fetchHeaderRange(
  q: Queries,
  client: ImapFlow,
  folder: FolderRow,
  account: AccountRow,
  range: string,
  minUid: number,
  // true yalnız yerleşik klasörde uidNext ilerlediğinde: kurallar ve "yeni mail" bildirimi bunu esas alır
  arrived = false,
  // izlenen klasör: bu andan eski INTERNALDATE sunucu taşıması değildir (başka istemcinin dosyaladığı eski posta)
  watchedSince: number | null = null
): Promise<{ count: number; newInbox: number; arrivals: number; lowUid: number | null; highUid: number | null }> {
  const rows: HeaderInput[] = []
  const movedUids = new Set<number>()
  const staleUids = new Set<number>()
  for await (const msg of client.fetch(range, HEADER_QUERY, { uid: true })) {
    if (msg.uid < minUid) continue // 'X:*' tuhaflığı: X > uidnext-1 ise en yüksek uid'li mesaj döner
    const h = headerFromFetch(msg, folder, account)
    // kullanıcının taşıdığı ileti yeni posta değil; aynı aralıktaki gerçek posta etkilenmez
    const moved = arrived && movedArrivals.consume(account.id, folder.path, h.uid, h.messageId)
    const stale = watchedSince !== null && (msg.internalDate ? new Date(msg.internalDate).getTime() : 0) < watchedSince
    rows.push({ ...h, rulesEligible: arrived && !moved && !stale })
    if (moved) movedUids.add(h.uid)
    if (stale) staleUids.add(h.uid)
  }
  let newCount = 0
  let eligible = 0
  let lowUid: number | null = null
  let highUid: number | null = null
  q.tx(() => {
    for (const h of rows) {
      const { id, isNew } = q.upsertHeader(h)
      if (isNew) {
        if (!movedUids.has(h.uid)) newCount++
        if (!movedUids.has(h.uid) && !staleUids.has(h.uid)) eligible++
        q.ftsUpsert(id, h.subject, `${h.fromName ?? ''} ${h.fromAddr ?? ''}`, h.toJson, null)
      }
      if (lowUid === null || h.uid < lowUid) lowUid = h.uid
      if (highUid === null || h.uid > highUid) highUid = h.uid
    }
  })
  return { count: rows.length, newInbox: folder.kind === 'inbox' && arrived ? newCount : 0, arrivals: arrived ? eligible : 0, lowUid, highUid }
}

export async function pollFolder(
  q: Queries,
  account: AccountRow,
  folder: FolderRow,
  client: ImapFlow,
  pollSeq: number
): Promise<PollResult> {
  const result: PollResult = { changed: false, newInboxMessages: 0, watchedArrivals: 0 }
  const watched = folder.kind !== 'inbox' && q.sieveWatchedPaths(account.id).includes(folder.path)
  const watchedSince = watched ? q.sieveWatchSince(account.id)[folder.path] ?? null : null
  const lock = await client.getMailboxLock(folder.path)
  try {
    const mb = client.mailbox
    if (!mb || typeof mb === 'boolean') return result
    const uv = Number(mb.uidValidity ?? 0)
    // Açık oturumda (IDLE) sunucu yalnız EXISTS yollar: imapflow uidNext ve highestModseq'i SELECT anındaki değerde bırakır,
    // kilit de klasörü yeniden seçmez. STATUS sunucudan taze değeri alır
    const live = await client.status(folder.path, { uidNext: true, highestModseq: true })
    const uidNext = Math.max(mb.uidNext ?? 1, (live && live.uidNext) || 0)
    const exists = mb.exists ?? 0
    const liveModseq = (live && live.highestModseq) || mb.highestModseq
    // Modseq Number'a sığar varsayılır (Dovecot pratikte küçük tutar); taşarsa CONDSTORE yolu deep-sync'e düşer
    const modseq = liveModseq ? Number(liveModseq) : null
    const supportsCondstore = !!liveModseq

    let f = { ...folder }
    if (f.uidvalidity !== null && f.uidvalidity !== uv) {
      q.resetFolder(f.id)
      f = { ...f, uidvalidity: null, last_seen_uidnext: null, highest_modseq: null, backfill_low_uid: null, last_seen_exists: null }
      result.changed = true
    }

    if (f.uidvalidity === null) {
      // İlk senkron 1. aşama: en yeni başlıklar
      const start = Math.max(1, uidNext - INITIAL_HEADERS)
      // hiç yoklanmamış izlenen klasör (Sieve'in açtığı dahil): etkinleşmeden sonra düşen posta burada görülür. UIDVALIDITY sıfırlaması yeni posta değildir
      const firstWatch = watchedSince !== null && folder.uidvalidity === null
      const r = exists > 0 ? await fetchHeaderRange(q, client, folder, account, `${start}:*`, start, firstWatch, watchedSince) : { count: 0, newInbox: 0, arrivals: 0, lowUid: null }
      q.updateFolderSync(f.id, {
        uidvalidity: uv,
        last_seen_uidnext: uidNext,
        highest_modseq: modseq,
        backfill_low_uid: r.lowUid ?? uidNext,
        last_seen_exists: exists
      })
      result.changed = r.count > 0
      result.newInboxMessages = r.newInbox
      result.watchedArrivals = r.arrivals
      return result
    }

    // 1) Yeni mailler
    // STATUS seçili klasörde bayat dönebilir (RFC 9051 kullanılmamasını önerir): sayı arttıysa uidNext'e bakmadan `son:*` istenir
    const lastUid = f.last_seen_uidnext ?? 1
    const grew = f.last_seen_exists !== null && exists > f.last_seen_exists
    if (uidNext > lastUid || grew) {
      const top = Math.max(uidNext, lastUid + 1)
      let from = lastUid
      let highest = uidNext - 1
      while (from < top) {
        const to = Math.min(from + NEW_MAIL_BATCH - 1, top - 1)
        const r = await fetchHeaderRange(q, client, folder, account, `${from}:${to === top - 1 ? '*' : to}`, from, !watched || watchedSince !== null, watchedSince)
        result.newInboxMessages += r.newInbox
        if (watched) result.watchedArrivals += r.arrivals
        if (r.count > 0) result.changed = true
        if (r.highUid !== null && r.highUid > highest) highest = r.highUid
        from = to + 1
      }
      q.updateFolderSync(f.id, { last_seen_uidnext: Math.max(lastUid, highest + 1) })
    }

    // 2) Bayrak değişiklikleri
    if (supportsCondstore && f.highest_modseq && modseq && modseq > f.highest_modseq) {
      for await (const msg of client.fetch('1:*', { uid: true, flags: true }, { uid: true, changedSince: BigInt(f.highest_modseq) })) {
        const flags = msg.flags ?? new Set<string>()
        if (q.updateFlagsByUid(f.id, msg.uid, flags.has('\\Seen'), flags.has('\\Flagged'), flags.has('\\Answered')))
          result.changed = true
      }
      q.updateFolderSync(f.id, { highest_modseq: modseq })
    } else if (!supportsCondstore) {
      // Yedek yol: pencere içi bayrak taraması (her poll) + 6 saatte bir derin tarama
      const deep = Date.now() - (f.last_deep_flag_sync_at ?? 0) > DEEP_FLAG_INTERVAL_MS
      const low = deep ? 1 : q.windowLowUid(f.id, FLAG_WINDOW)
      if (low !== null && exists > 0) {
        for await (const msg of client.fetch(`${low}:*`, { uid: true, flags: true }, { uid: true })) {
          const flags = msg.flags ?? new Set<string>()
          if (q.updateFlagsByUid(f.id, msg.uid, flags.has('\\Seen'), flags.has('\\Flagged'), flags.has('\\Answered')))
            result.changed = true
        }
      }
      if (deep) q.updateFolderSync(f.id, { last_deep_flag_sync_at: Date.now() })
    } else if (supportsCondstore && modseq) {
      q.updateFolderSync(f.id, { highest_modseq: modseq })
    }

    // 3) Silinen (expunge edilmiş) mesaj tespiti
    const existsDropped = f.last_seen_exists !== null && exists < f.last_seen_exists
    // günde bir tam karşılaştırma: pencere (son FLAG_WINDOW UID) dışındaki eski mailler başka istemciden
    // silinirse yerelde hayalet kalıyordu (R35). UID SEARCH ALL sıkıştırılmış liste döner — ucuz.
    const fullKey = `full_uid_check_${f.id}`
    if (Date.now() - Number(q.prefGet(fullKey) ?? 0) > 24 * 3600_000) {
      const all = exists > 0 ? await client.search({ all: true }, { uid: true }) : []
      if (Array.isArray(all)) {
        const serverUids = new Set(all)
        const vanished = q.uidsInWindow(f.id, 1).filter((m) => !serverUids.has(m.uid)).map((m) => m.id)
        if (vanished.length) {
          q.deleteMessagesLocal(vanished)
          result.changed = true
        }
        q.prefSet(fullKey, String(Date.now()))
      }
    } else if (existsDropped || pollSeq % 10 === 0) {
      const low = q.windowLowUid(f.id, FLAG_WINDOW)
      if (low !== null) {
        const serverUids = new Set<number>()
        if (exists > 0) {
          for await (const msg of client.fetch(`${low}:*`, { uid: true }, { uid: true })) serverUids.add(msg.uid)
        }
        const local = q.uidsInWindow(f.id, low)
        const vanished = local.filter((m) => !serverUids.has(m.uid)).map((m) => m.id)
        if (vanished.length) {
          q.deleteMessagesLocal(vanished)
          result.changed = true
        }
      }
    }
    q.updateFolderSync(f.id, { last_seen_exists: exists })
  } finally {
    lock.release()
  }
  return result
}

// Bir hesabın rutin poll'u: INBOX her seferinde, Sent her 5. turda
// Sent nadiren değişir (kendi gönderdiklerimizi zaten APPEND ile biliyoruz)
export async function pollAccount(
  q: Queries,
  account: AccountRow,
  client: ImapFlow,
  pollSeq: number
): Promise<PollResult> {
  const folders = await ensureFolders(q, account, client)
  const total: PollResult = { changed: false, newInboxMessages: 0, watchedArrivals: 0 }
  // INBOX her tur; Sent her 5. tur; Junk her 8. tur (~16 dk — spam filtresine düşen meşru mail görünsün, R20).
  // Sent/Junk çiftlerinde yalnız sunucunun işaretlediği (getFolderByKind: special_use öncelikli) klasör
  const special = (kind: 'sent' | 'junk') => {
    const f = q.getFolderByKind(account.id, kind)
    return f ? [f] : []
  }
  // Sunucu taşımalarının hedefleri her tur: yerel listede olmayan yol atlanır, klasör listesi tazelenince girer
  const watched = q.sieveWatchedPaths(account.id)
  const targets = [
    ...folders.filter((f) => f.kind === 'inbox'),
    ...(pollSeq % 5 === 0 ? special('sent') : []),
    ...(pollSeq % 8 === 0 ? special('junk') : [])
  ]
  for (const f of folders) if (watched.includes(f.path) && !targets.some((x) => x.id === f.id)) targets.push(f)
  for (const folder of targets) {
    const fresh = q.getFolderById(folder.id)
    if (!fresh) continue
    try {
      const r = await pollFolder(q, account, fresh, client, pollSeq)
      total.changed = total.changed || r.changed
      total.newInboxMessages += r.newInboxMessages
      total.watchedArrivals += r.watchedArrivals
    } catch (e) {
      // bayat klasör hesabı düşürmesin: listeyi tazele, sıradaki klasöre geç
      if (!isMissingMailbox(e)) throw e
      invalidateFolderList(q, account.id)
      total.changed = true
    }
  }
  return total
}

// Arka plan backfill: bir klasörün geçmişini hedef derinliğe kadar partiler halinde indir
export async function backfillFolder(
  q: Queries,
  account: AccountRow,
  folder: FolderRow,
  client: ImapFlow,
  batchSize: number,
  targetCount: number
): Promise<{ fetched: number; done: boolean }> {
  if (folder.uidvalidity === null || folder.backfill_low_uid === null) return { fetched: 0, done: false }
  if (folder.backfill_low_uid <= 1) return { fetched: 0, done: true }
  if (q.folderMessageCount(folder.id) >= targetCount) return { fetched: 0, done: true }
  const lock = await client.getMailboxLock(folder.path)
  try {
    const mb = client.mailbox
    if (!mb || typeof mb === 'boolean') return { fetched: 0, done: false }
    if (Number(mb.uidValidity ?? 0) !== folder.uidvalidity) return { fetched: 0, done: false } // sıradaki poll sıfırlar
    const high = folder.backfill_low_uid - 1
    const low = Math.max(1, high - batchSize + 1)
    const collected: ReturnType<typeof headerFromFetch>[] = []
    for await (const msg of client.fetch(`${low}:${high}`, HEADER_QUERY, { uid: true })) {
      if (msg.uid > high) continue
      collected.push(headerFromFetch(msg, folder, account))
    }
    q.tx(() => {
      for (const h of collected) {
        const { id, isNew } = q.upsertHeader(h)
        if (isNew) q.ftsUpsert(id, h.subject, `${h.fromName ?? ''} ${h.fromAddr ?? ''}`, h.toJson, null)
      }
      q.updateFolderSync(folder.id, { backfill_low_uid: low })
    })
    return { fetched: collected.length, done: low <= 1 }
  } finally {
    lock.release()
  }
}
