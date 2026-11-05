// RPC — Kişiler: adres defterleri, gruplar, vCard içe/dışa aktarma, otomatik tamamlama. Yazma RPC'de eşzamanlıdır.
import { randomUUID } from 'crypto'
import type { ContactDetail, ContactDraft, ContactSummary, PimCollectionType } from '../../shared/pim'
import { norm } from '../../shared/notifyRules'
import type { Contact } from '../../shared/rpc'
import { t } from '../../shared/i18n'
import type { ContactRow, PimCollectionRow, PimSourceRow } from '../db/queries'
import { syncBatch } from '../pim/apply'
import { parseCard, splitVcf, draftToCard, type ParsedCard } from '../pim/vcard'
import { isAuthFailure } from '../pim/pimScheduler'
import type { RpcSession } from '../rpcSession'
import type { Handler } from './common'
import { assertCollectionRead, assertCollectionWrite, visibleCollectionIds } from './pimAuth'
import { isGoogle } from './pimSources'
import { etagOf, remoteCall, storeObject, withEtag, writeBackend, wrote } from './pimWrite'

const MAX_PAGE = 200
const DEFAULT_PAGE = 100
const SCAN_PAGE = 500
const MAX_IMPORT_BYTES = 1_100_000
const IMPORT_PARALLEL = 4
const MAX_MERGE = 50
const MAX_CARD_ADDRESSES = 2000
const MAX_COLLECTED = 800
const MAX_LIST = 50
const ADDR = /^[^\s@,;<>"]+@[^\s@,;<>"]+$/

const invalid = (): Error => new Error(t('pim.err.invalid'))

/** Görülebilir ve bu kullanıcı için gizlenmemiş koleksiyonlar */
function shownCollectionIds(s: RpcSession, type: PimCollectionType): number[] {
  const hidden = new Set(s.deps.q.listPimCollectionPrefs(s.currentUser!.id).filter((p) => p.hidden).map((p) => p.collection_id))
  return visibleCollectionIds(s, type).filter((id) => !hidden.has(id))
}

function summaries(s: RpcSession, rows: { id: number; collection_id: number; kind: ContactSummary['kind']; full_name: string; org: string | null }[]): ContactSummary[] {
  const emails = new Map<number, ContactSummary['emails']>()
  for (const e of s.deps.q.pimContactEmails(rows.map((r) => r.id))) {
    const list = emails.get(e.contact_id) ?? []
    list.push({ addr: e.addr, label: e.label })
    emails.set(e.contact_id, list)
  }
  return rows.map((r) => ({ id: r.id, collectionId: r.collection_id, kind: r.kind, fullName: r.full_name, org: r.org, emails: emails.get(r.id) ?? [] }))
}

function contactRow(s: RpcSession, id: unknown): ContactRow {
  const row = s.deps.q.getPimContact(Number(id))
  if (!row) throw new Error(t('pim.err.noAccess'))
  return row
}

const text = (v: unknown, max: number): string | null => {
  if (v == null || v === '') return null
  if (typeof v !== 'string' || v.length > max) throw invalid()
  return v
}

function labelled(list: unknown, max: number): { value: string; label: string | null }[] {
  if (!Array.isArray(list) || list.length > MAX_LIST) throw invalid()
  return list.flatMap((x: { value?: unknown; label?: unknown }) => {
    const value = text(x?.value, max)?.trim()
    return value ? [{ value, label: text(x?.label, 100) }] : []
  })
}

function checkDraft(d: ContactDraft): ContactDraft {
  if (!d || (d.kind !== 'individual' && d.kind !== 'group')) throw invalid()
  const fullName = text(d.fullName, 500)?.trim()
  if (!fullName) throw invalid()
  if (!Array.isArray(d.emails) || d.emails.length > MAX_LIST) throw invalid()
  const emails = d.emails.flatMap((e) => {
    const addr = text(e?.addr, 320)?.trim()
    if (!addr) return []
    if (!ADDR.test(addr)) throw invalid()
    return [{ addr, label: text(e.label, 100) }]
  })
  const birthday = text(d.birthday, 10)
  if (birthday && !/^(\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})$/.test(birthday)) throw invalid()
  if (d.memberIds !== undefined && (!Array.isArray(d.memberIds) || d.memberIds.length > 5000 || d.memberIds.some((m) => !Number.isInteger(m)))) throw invalid()
  return {
    kind: d.kind, fullName, given: text(d.given, 200), family: text(d.family, 200), org: text(d.org, 500), emails,
    phones: labelled(d.phones, 100), addresses: labelled(d.addresses, 1000), note: text(d.note, 100_000), birthday, memberIds: d.memberIds
  }
}

/** Google CardDAV kişi gruplarını taşımaz */
const assertGroups = (s: RpcSession, source: PimSourceRow): void => {
  if (isGoogle(s, source)) throw new Error(t('pim.err.readOnly'))
}

/** Kartı uzak sunucuya, başarıda yerel satıra yazar */
async function putCard(s: RpcSession, collection: PimCollectionRow, source: PimSourceRow, remoteId: string | null, card: string, etag: string | null): Promise<{ id: number; etag: string | null } | 'conflict'> {
  const backend = writeBackend(s, source)
  const put = await remoteCall(s, source, () => backend.putContact(collection, remoteId, card, etag))
  if (put === 'conflict') return put
  const stored = await withEtag(s, source, backend, collection, put)
  await storeObject(s, collection, stored)
  return { id: s.deps.q.pimContactIdByRemote(collection.id, stored.remoteId)!, etag: stored.etag }
}

const cardVersion = (source: PimSourceRow): '3.0' | '4.0' => (source.kind === 'local' ? '4.0' : '3.0')

async function dropCard(s: RpcSession, collection: PimCollectionRow, source: PimSourceRow, row: ContactRow, etag: string | null): Promise<'ok' | 'conflict'> {
  const backend = writeBackend(s, source)
  const r = await remoteCall(s, source, () => backend.deleteContact(collection, row.remote_id, etag))
  if (r === 'ok') s.deps.q.deletePimContact(collection.id, row.remote_id)
  return r
}

function detailOf(s: RpcSession, row: ContactRow): ContactDetail {
  const card = parseCard(row.raw)
  if (!card) throw new Error(t('pim.err.noAccess'))
  return {
    ...card.detail, id: row.id, collectionId: row.collection_id, etag: row.etag, kind: row.kind, fullName: row.full_name, org: row.org,
    memberIds: row.kind === 'group' ? s.deps.q.pimGroupMemberIds(row.id, row.collection_id) : []
  }
}

/** Sonuna eklenecek UID: içe aktarılan kartta yoksa sunucu reddetmesin */
const withUid = (raw: string, card: ParsedCard): string =>
  /^UID[:;]/im.test(raw) ? raw : raw.replace(/END:VCARD\s*$/i, `UID:${card.uid}\r\nEND:VCARD\r\n`)

/** Otomatik tamamlama: gruplar, kartlar, sonra toplanan adresler. Kart adı kazanır; kaynak yoksa çıktı toplananların aynısı. */
export function mergedContacts(s: RpcSession): Contact[] {
  const { q } = s.deps
  const accountIds = s.resolveAccountIds(null)
  const collected = accountIds !== null && accountIds.length === 0 ? [] : q.getContacts(accountIds, MAX_COLLECTED)
  const books = shownCollectionIds(s, 'addressbook')
  const groups = new Map<number, Contact & { members: string[] }>()
  for (const g of q.pimGroupAddresses(books)) {
    if (!g.addr) continue
    const group = groups.get(g.id) ?? { addr: '', name: g.full_name, groupId: g.id, members: [] }
    group.members.push(g.addr)
    groups.set(g.id, group)
  }
  const seen = new Set<string>()
  const out: Contact[] = [...groups.values()]
  for (const c of q.pimCardAddresses(books, MAX_CARD_ADDRESSES)) {
    const key = c.addr.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ addr: c.addr, name: c.full_name || null, contactId: c.contact_id })
  }
  for (const c of collected) {
    const key = c.addr.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

export const contactsHandlers: Record<string, Handler> = {
  async listContacts(s, params) {
    const p = params as { collectionIds?: unknown; query?: unknown; cursor?: { name?: unknown; id?: unknown } | null; limit?: unknown }
    const limit = p.limit === undefined ? DEFAULT_PAGE : Number(p.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw invalid()
    let ids: number[]
    if (p.collectionIds == null) ids = shownCollectionIds(s, 'addressbook')
    else {
      if (!Array.isArray(p.collectionIds)) throw invalid()
      ids = p.collectionIds.map(Number)
      for (const id of ids) assertCollectionRead(s, id)
    }
    if (p.query != null && (typeof p.query !== 'string' || p.query.length > 200)) throw invalid()
    let cursor = p.cursor ? { name: String(p.cursor.name), id: Number(p.cursor.id) } : null
    const words = norm(typeof p.query === 'string' ? p.query : '').split(/\s+/).filter(Boolean)
    if (!words.length) return summaries(s, s.deps.q.pimContactPage(ids, cursor, limit))
    // Türkçe i katlaması SQLite'ta yok: ada göre sırayla taranır, sınır dolunca durur
    const out: ContactSummary[] = []
    for (;;) {
      const rows = s.deps.q.pimContactPage(ids, cursor, SCAN_PAGE)
      for (const c of summaries(s, rows)) {
        const hay = norm(`${c.fullName} ${c.org ?? ''} ${c.emails.map((e) => e.addr).join(' ')}`)
        if (words.every((w) => hay.includes(w))) out.push(c)
        if (out.length === limit) return out
      }
      if (rows.length < SCAN_PAGE) return out
      const last = rows[rows.length - 1]
      cursor = { name: last.full_name, id: last.id }
    }
  },

  async getContact(s, params) {
    const row = contactRow(s, (params as { id?: unknown }).id)
    assertCollectionRead(s, row.collection_id)
    return detailOf(s, row)
  },

  async saveContact(s, params) {
    const p = params as { collectionId?: unknown; id?: unknown; etag?: unknown; draft: ContactDraft }
    const { collection, source } = assertCollectionWrite(s, Number(p.collectionId))
    const row = p.id === undefined ? null : contactRow(s, p.id)
    if (row && row.collection_id !== collection.id) throw new Error(t('pim.err.noAccess'))
    const draft = checkDraft(p.draft)
    if (draft.kind === 'group' || row?.kind === 'group') assertGroups(s, source)
    const memberUids = draft.kind === 'group' ? s.deps.q.pimContactUidsOfIds(collection.id, draft.memberIds ?? []) : undefined
    const card = draftToCard(draft, { base: row?.raw, version: cardVersion(source), memberUids, now: s.hub.now(), uid: row ? undefined : randomUUID() })
    const r = await putCard(s, collection, source, row?.remote_id ?? null, card, row ? etagOf(p.etag, row) : null)
    if (r === 'conflict') return { ok: false, conflict: true }
    wrote(s, source, 'contacts')
    return { ok: true, ...r }
  },

  async deleteContact(s, params) {
    const p = params as { id?: unknown; etag?: unknown }
    const row = contactRow(s, p.id)
    const { collection, source } = assertCollectionWrite(s, row.collection_id)
    if (row.kind === 'group') assertGroups(s, source)
    const r = await dropCard(s, collection, source, row, etagOf(p.etag, row))
    if (r === 'conflict') return { ok: false, conflict: true }
    wrote(s, source, 'contacts')
    return { ok: true }
  },

  async importContacts(s, params) {
    const p = params as { collectionId?: unknown; vcards?: unknown }
    const { collection, source } = assertCollectionWrite(s, Number(p.collectionId))
    if (typeof p.vcards !== 'string' || Buffer.byteLength(p.vcards) > MAX_IMPORT_BYTES) throw invalid()
    const known = new Set(s.deps.q.pimContactRaws(collection.id).map((c) => c.uid))
    const backend = writeBackend(s, source)
    let skipped = 0
    let failed = 0
    let added = 0
    const queue: { raw: string; card: ParsedCard }[] = []
    for (const raw of splitVcf(p.vcards)) {
      const card = parseCard(raw)
      if (!card) failed++
      else if (known.has(card.uid)) skipped++
      else {
        known.add(card.uid)
        queue.push({ raw: withUid(raw, card), card })
      }
    }
    const batch = syncBatch(s.hub.pimDeps(), collection)
    let halted = false
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        if (halted) {
          failed++
          continue
        }
        try {
          const put = await remoteCall(s, source, () => backend.putContact(collection, null, next.raw, null))
          if (put === 'conflict') {
            failed++
            continue
          }
          batch.sink.upsert(put)
        } catch (e) {
          failed++
          // kimlik reddinde sıradakiler aynı parolayı denemesin: sunucu IP'yi engeller
          if (isAuthFailure(e) || s.deps.q.getPimSource(source.id)?.status === 'needs_reauth') halted = true
        }
      }
    }
    // ilk kart tek başına: parola yanlışsa dört istek birden gitmesin
    const first = queue.splice(1)
    await worker()
    queue.push(...first)
    await Promise.all(Array.from({ length: IMPORT_PARALLEL }, worker))
    const { changed, skipped: bad } = await batch.commit()
    added = changed
    failed += bad
    if (added) wrote(s, source, 'contacts')
    return { added, skipped, failed }
  },

  async exportContacts(s, params) {
    const { collection } = assertCollectionRead(s, Number((params as { collectionId?: unknown }).collectionId))
    const data = Buffer.from(s.deps.q.pimContactRaws(collection.id).map((c) => c.raw.replace(/\r?\n?$/, '\r\n')).join(''), 'utf-8')
    const name = collection.name.replace(/[\\/:*?"<>|\p{Cc}]/gu, '').trim() || 'contacts'
    return { filename: `${name}.vcf`, data: new Uint8Array(data) }
  },

  async promoteCollected(s, params) {
    const p = params as { addr?: unknown; name?: unknown; collectionId?: unknown }
    const { collection, source } = assertCollectionWrite(s, Number(p.collectionId))
    const addr = text(p.addr, 320)?.trim()
    if (!addr || !ADDR.test(addr)) throw invalid()
    const existing = s.deps.q.pimContactIdByEmail(collection.id, addr)
    if (existing != null) return { id: existing }
    const draft = checkDraft({ kind: 'individual', fullName: text(p.name, 500)?.trim() || addr, given: null, family: null, org: null, emails: [{ addr, label: null }], phones: [], addresses: [], note: null, birthday: null })
    const r = await putCard(s, collection, source, null, draftToCard(draft, { version: cardVersion(source), now: s.hub.now(), uid: randomUUID() }), null)
    if (r === 'conflict') throw new Error(t('pim.err.invalid'))
    wrote(s, source, 'contacts')
    return { id: r.id }
  },

  async mergeContacts(s, params) {
    const p = params as { keepId?: unknown; dropIds?: unknown }
    if (!Array.isArray(p.dropIds) || !p.dropIds.length || p.dropIds.length > MAX_MERGE) throw invalid()
    const keep = contactRow(s, p.keepId)
    const { collection, source } = assertCollectionWrite(s, keep.collection_id)
    const drops = p.dropIds.map((id) => contactRow(s, id))
    if (drops.some((d) => d.collection_id !== keep.collection_id || d.id === keep.id || d.kind !== 'individual') || keep.kind !== 'individual') throw invalid()
    const base = detailOf(s, keep)
    const merged: ContactDraft = { kind: 'individual', fullName: base.fullName, given: base.given, family: base.family, org: base.org, emails: base.emails, phones: base.phones, addresses: base.addresses, note: base.note, birthday: base.birthday }
    const union = <T>(a: T[], b: T[], key: (x: T) => string): T[] => {
      const seen = new Set(a.map(key))
      return [...a, ...b.filter((x) => !seen.has(key(x)) && !!seen.add(key(x)))]
    }
    for (const row of drops) {
      const d = detailOf(s, row)
      merged.emails = union(merged.emails, d.emails, (e) => e.addr.toLowerCase())
      merged.phones = union(merged.phones, d.phones, (x) => x.value)
      merged.addresses = union(merged.addresses, d.addresses, (x) => x.value)
      merged.org ??= d.org
      merged.note ??= d.note
      merged.birthday ??= d.birthday
      merged.given ??= d.given
      merged.family ??= d.family
    }
    const r = await putCard(s, collection, source, keep.remote_id, draftToCard(merged, { base: keep.raw, version: cardVersion(source), now: s.hub.now() }), keep.etag)
    if (r === 'conflict') return { ok: false, conflict: true }
    // silme çakışırsa kart durur, birleşen kart yine doğrudur
    for (const row of drops) await dropCard(s, collection, source, row, row.etag)
    wrote(s, source, 'contacts')
    return { ok: true, id: keep.id }
  }
}

