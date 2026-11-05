// RPC — Takvim: açılmış örnekler, tekrar düzenleme kapsamları, abonelik. Renderer ham iCalendar görmez. Yazma RPC'de eşzamanlıdır;
// kalıcı açılım tablosu yok, tekrarlar sorgu anında açılır.
import { randomUUID } from 'crypto'
import type { EditScope, EventDetail, EventDraft, EventOccurrence, PimCollectionType, RecurrenceInput } from '../../shared/pim'
import { t } from '../../shared/i18n'
import type { CalendarObjectRow, PimCollectionRow, PimSourceRow } from '../db/queries'
import { viewerZone } from '../pim/apply'
import type { PimBackend } from '../pim/backend'
import { DEFERRED, gateCalendars } from '../pim/gate'
import { draftToIcs, eventToDraft, parseCalendar, removeOccurrence, type ParsedCalendar, type ParsedEvent } from '../pim/ical'
import { normalizeFeedUrl, readFeed } from '../pim/icsBackend'
import { expandObject, INTERVAL_CAPS, occurrenceOf, type Occ } from '../pim/recur'
import { isValidTz } from '../pim/tz'
import type { RpcSession } from '../rpcSession'
import type { Handler } from './common'
import { assertCollectionRead, assertCollectionWrite, canWriteSource, emitPimChanged, ensureLocalSource, visibleCollectionIds, visibleSources } from './pimAuth'
import { supportsThisAndFuture, syncSoon } from './pimSources'
import { etagOf, remoteCall, storeObject, withEtag, writeBackend, wrote } from './pimWrite'

const MAX_WINDOW_MS = 400 * 864e5
/** Pencerenin dışı: sonsuz seri uzak yıla kadar açılıp iş parçacığını tutmasın */
const MIN_TIME_MS = Date.UTC(1900, 0, 1)
const MAX_TIME_MS = Date.UTC(2200, 0, 1)
const RECURRENCE_ID = /^\d{8}(T\d{6}Z?)?$/
const MAX_SUBSCRIPTIONS = 50
const COLOR = /^#[0-9a-f]{6}$/i
const FREQS: readonly string[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']
const DRAFT_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/
const BYDAY = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/
const RAW_RULE = /^[A-Z0-9=;,:+-]{1,500}$/

const invalid = (): Error => new Error(t('pim.err.invalid'))

function shownCalendars(s: RpcSession): Set<number> {
  const type: PimCollectionType = 'calendar'
  const hidden = new Set(s.deps.q.listPimCollectionPrefs(s.currentUser!.id).filter((p) => p.hidden).map((p) => p.collection_id))
  return new Set(visibleCollectionIds(s, type).filter((id) => !hidden.has(id)))
}

/** Kaynağın sahibi olarak yazdığım adres: hesap e-postası ya da kişisel DAV kullanıcı adı */
export function myAddress(s: RpcSession, src: PimSourceRow): string | null {
  const addr = src.account_id != null ? s.deps.q.getAccountRow(src.account_id)?.email : src.username
  return addr?.toLowerCase() ?? null
}

/** Düzenleyen başkaysa kopyam değişmez: sonraki güncellemeyle sunucu ezerdi */
const organizerAllows = (row: Pick<CalendarObjectRow, 'organizer'>, me: string | null): boolean => !row.organizer || row.organizer === me

function occurrenceInfo(row: CalendarObjectRow, o: Occ, editable: boolean, me: string | null): EventOccurrence {
  const ev = o.event
  return {
    key: `${row.id}:${o.recurrenceId ?? ''}`, objectId: row.id, collectionId: row.collection_id, uid: row.uid, recurrenceId: o.recurrenceId, title: ev.summary, location: ev.location,
    start: o.start, end: o.end, allDay: o.allDay, startDate: o.startDate, endDate: o.endDate, tz: o.tz, cancelled: ev.status === 'CANCELLED', recurring: !!row.recurring || !!o.recurrenceId,
    canEdit: editable && organizerAllows(row, me), myPartstat: me ? (ev.attendees.find((a) => a.addr === me)?.partstat ?? null) : null
  }
}

function eventRow(s: RpcSession, id: unknown): CalendarObjectRow {
  const row = s.deps.q.getCalendarObject(Number(id))
  if (!row) throw new Error(t('pim.err.noAccess'))
  return row
}

const text = (v: unknown, max: number): string | null => {
  if (v == null || v === '') return null
  if (typeof v !== 'string' || v.length > max) throw invalid()
  return v
}

function checkRule(r: RecurrenceInput | null | undefined): RecurrenceInput | null {
  if (r == null) return null
  if (!FREQS.includes(r.freq) || !Number.isInteger(r.interval) || r.interval < 1 || r.interval > INTERVAL_CAPS[r.freq]) throw invalid()
  if (r.byDay !== undefined && (!Array.isArray(r.byDay) || r.byDay.length > 7 || r.byDay.some((d) => !BYDAY.test(d)))) throw invalid()
  if (r.count !== undefined && r.count !== null && (!Number.isInteger(r.count) || r.count < 1 || r.count > 10_000)) throw invalid()
  if (r.until !== undefined && r.until !== null && (typeof r.until !== 'string' || !DRAFT_DATE.test(r.until))) throw invalid()
  return { freq: r.freq, interval: r.interval, ...(r.byDay ? { byDay: r.byDay } : {}), ...(r.count ? { count: r.count } : {}), ...(r.until ? { until: r.until } : {}) }
}

function checkDraft(d: EventDraft): EventDraft {
  if (!d || typeof d.allDay !== 'boolean' || typeof d.start !== 'string' || typeof d.end !== 'string' || !DRAFT_DATE.test(d.start) || !DRAFT_DATE.test(d.end)) throw invalid()
  if (typeof d.tz !== 'string' || !isValidTz(d.tz) || d.end < d.start) throw invalid()
  if (d.alarmMinutes != null && (!Number.isInteger(d.alarmMinutes) || d.alarmMinutes < -10_080 || d.alarmMinutes > 525_600)) throw invalid()
  if (d.rruleRaw !== undefined && (typeof d.rruleRaw !== 'string' || !RAW_RULE.test(d.rruleRaw))) throw invalid()
  return {
    title: text(d.title, 2000) ?? '', location: text(d.location, 2000), description: text(d.description, 100_000), allDay: d.allDay, start: d.start, end: d.end, tz: d.tz,
    rrule: checkRule(d.rrule), ...(d.rruleRaw ? { rruleRaw: d.rruleRaw } : {}), alarmMinutes: d.alarmMinutes ?? null
  }
}

function toIcs(d: EventDraft, o: Parameters<typeof draftToIcs>[1]): string {
  try {
    return draftToIcs(d, o)
  } catch {
    // geçersiz tarih ya da kural: istemci hatası, ayrıntı ayrıştırıcıdan gelmez
    throw invalid()
  }
}

function cutOccurrence(raw: string, recurrenceId: string, mode: 'this' | 'thisAndFuture', now: number): string | null {
  try {
    return removeOccurrence(raw, recurrenceId, mode, now)
  } catch {
    // ayrıştırıcı metni kullanıcıya gitmez
    throw invalid()
  }
}

function checkScope(scope: unknown, recurrenceId: unknown, source: PimSourceRow): { scope: EditScope; recurrenceId?: string } {
  if (scope === undefined || scope === 'all') return { scope: 'all' }
  if ((scope !== 'this' && scope !== 'thisAndFuture') || typeof recurrenceId !== 'string' || !RECURRENCE_ID.test(recurrenceId)) throw invalid()
  if (scope === 'thisAndFuture' && !supportsThisAndFuture(source)) throw new Error(t('pim.err.noThisAndFuture'))
  return { scope, recurrenceId }
}

const objectIdOf = (s: RpcSession, c: PimCollectionRow, remoteId: string): number => s.deps.q.pimEventIdByRemote(c.id, remoteId)!

export interface Target {
  s: RpcSession
  collection: PimCollectionRow
  source: PimSourceRow
  backend: PimBackend
}

/** Uzak nesneyi yazar, başarıda yerel satırı günceller */
export async function putObject(t2: Target, remoteId: string | null, ics: string, etag: string | null, o?: { scope?: EditScope; recurrenceId?: string; uid?: string }): Promise<{ objectId: number; etag: string | null } | 'conflict'> {
  const { s, collection, source, backend } = t2
  // kapının reddedeceği nesne sunucuya hiç gitmez: yoksa uzakta durur, kullanıcı "geçersiz" görürdü
  const d = s.hub.pimDeps()
  const [verdict] = await gateCalendars([ics], { viewerTz: viewerZone(), now: s.hub.now(), workerPath: d.gateWorker })
  if (!verdict || verdict === DEFERRED) throw invalid()
  const put = await remoteCall(s, source, () => backend.putEvent(collection, remoteId, ics, etag, o))
  if (put === 'conflict') return put
  const stored = await withEtag(s, source, backend, collection, put)
  await storeObject(s, collection, stored)
  return { objectId: objectIdOf(s, collection, stored.remoteId), etag: stored.etag }
}

export async function dropObject(t2: Target, row: Pick<CalendarObjectRow, 'remote_id' | 'raw'>, etag: string | null, scope?: EditScope): Promise<'ok' | 'conflict'> {
  const { s, collection, source, backend } = t2
  const r = await remoteCall(s, source, () => backend.deleteEvent(collection, row.remote_id, etag, { scope, raw: row.raw }))
  if (r === 'ok') s.deps.q.deletePimEvent(collection.id, row.remote_id)
  return r
}

/** Önce yeni seri açılır, sonra eski kesilir: çakışmada yeni seri geri alınır, veri kaybolmaz */
async function splitSeries(t2: Target, row: CalendarObjectRow, draft: EventDraft, etag: string | null, recurrenceId: string): Promise<{ objectId: number; etag: string | null } | 'conflict'> {
  const now = t2.s.hub.now()
  const truncated = cutOccurrence(row.raw, recurrenceId, 'thisAndFuture', now)
  if (truncated === null) return putObject(t2, row.remote_id, toIcs(draft, { base: row.raw, now, scope: 'all' }), etag)
  const uid = randomUUID()
  const created = await putObject(t2, null, toIcs(draft, { base: row.raw, now, scope: 'thisAndFuture', uid, recurrenceId }), null, { uid })
  if (created === 'conflict') return created
  const undo = async (): Promise<void> => {
    const fresh = t2.s.deps.q.getCalendarObject(created.objectId)
    if (fresh) await dropObject(t2, fresh, created.etag).catch(() => 'conflict')
  }
  try {
    const cut = await putObject(t2, row.remote_id, truncated, etag, { scope: 'thisAndFuture', recurrenceId })
    if (cut !== 'conflict') return created
  } catch (e) {
    await undo()
    throw e
  }
  await undo()
  return 'conflict'
}

const eventOf = (c: ParsedCalendar, rid: string | null): ParsedEvent => (rid ? c.events.find((e) => e.recurrenceId === rid) : undefined) ?? c.events.find((e) => !e.recurrenceId) ?? c.events[0]

export const calendarHandlers: Record<string, Handler> = {
  async listEvents(s, params) {
    const p = params as { from?: unknown; to?: unknown; tz?: unknown; collectionIds?: unknown }
    const from = Number(p.from)
    const to = Number(p.to)
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > MAX_WINDOW_MS || from < MIN_TIME_MS || to > MAX_TIME_MS) throw new Error(t('pim.err.range'))
    const tz = typeof p.tz === 'string' && isValidTz(p.tz) ? p.tz : 'UTC'
    const shown = shownCalendars(s)
    let ids: number[]
    if (p.collectionIds == null) ids = [...shown]
    else {
      if (!Array.isArray(p.collectionIds)) throw invalid()
      for (const id of p.collectionIds) assertCollectionRead(s, Number(id))
      ids = p.collectionIds.map(Number).filter((id) => shown.has(id))
    }
    const sources = new Map(visibleSources(s).map((v) => [v.source.id, v]))
    const collections = new Map(ids.map((id) => [id, s.deps.q.getPimCollection(id)!]))
    const info = new Map([...collections].map(([id, c]) => {
      const v = sources.get(c.source_id)!
      return [id, { editable: v.canWrite && !c.read_only, me: myAddress(s, v.source) }]
    }))
    const out: EventOccurrence[] = []
    for (const row of s.deps.q.calendarObjectsInRange(ids, from, to)) {
      const c = parseCalendar(row.raw)
      if (!c) continue
      const { editable, me } = info.get(row.collection_id)!
      for (const o of expandObject(c, from, to, tz)) out.push(occurrenceInfo(row, o, editable, me))
    }
    return out.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key))
  },

  async getEvent(s, params) {
    const p = params as { objectId?: unknown; recurrenceId?: unknown; tz?: unknown }
    const row = eventRow(s, p.objectId)
    const { collection, source } = assertCollectionRead(s, row.collection_id)
    const tz = typeof p.tz === 'string' && isValidTz(p.tz) ? p.tz : 'UTC'
    const rid = typeof p.recurrenceId === 'string' ? p.recurrenceId : null
    const c = parseCalendar(row.raw)
    const occ = c && occurrenceOf(c, rid, tz)
    const draft = eventToDraft(row.raw, rid, tz)
    if (!c || !occ || !draft) throw new Error(t('pim.err.noAccess'))
    const ev = eventOf(c, rid)
    const detail: EventDetail = {
      occurrence: occurrenceInfo(row, occ, canWriteSource(s, source) && !collection.read_only, myAddress(s, source)), etag: row.etag, draft,
      organizer: ev.organizer, attendees: ev.attendees.map((a) => ({ addr: a.addr, name: a.name, partstat: a.partstat })), description: ev.description
    }
    return detail
  },

  async saveEvent(s, params) {
    const p = params as { collectionId?: unknown; objectId?: unknown; etag?: unknown; draft: EventDraft; scope?: unknown; recurrenceId?: unknown }
    const { collection, source } = assertCollectionWrite(s, Number(p.collectionId))
    const row = p.objectId === undefined ? null : eventRow(s, p.objectId)
    if (row && row.collection_id !== collection.id) throw new Error(t('pim.err.noAccess'))
    const draft = checkDraft(p.draft)
    const scoped = checkScope(p.scope, p.recurrenceId, source)
    if (row && !organizerAllows(row, myAddress(s, source))) throw new Error(t('pim.err.notOrganizer'))
    const target: Target = { s, collection, source, backend: writeBackend(s, source) }
    const now = s.hub.now()
    const etag = row ? etagOf(p.etag, row) : null
    let r: { objectId: number; etag: string | null } | 'conflict'
    if (!row) {
      const uid = randomUUID()
      r = await putObject(target, null, toIcs(draft, { uid, now }), null, { uid })
    } else if (scoped.scope === 'thisAndFuture') {
      r = await splitSeries(target, row, draft, etag, scoped.recurrenceId!)
    } else {
      r = await putObject(target, row.remote_id, toIcs(draft, { base: row.raw, now, ...scoped }), etag, scoped)
    }
    if (r === 'conflict') return { ok: false, conflict: true }
    wrote(s, source, 'calendar')
    return { ok: true, ...r }
  },

  async deleteEvent(s, params) {
    const p = params as { objectId?: unknown; etag?: unknown; scope?: unknown; recurrenceId?: unknown }
    const row = eventRow(s, p.objectId)
    const { collection, source } = assertCollectionWrite(s, row.collection_id)
    const scoped = checkScope(p.scope, p.recurrenceId, source)
    const target: Target = { s, collection, source, backend: writeBackend(s, source) }
    const etag = etagOf(p.etag, row)
    // Graph'ta oluşum kendi nesnesidir: kural yazılmaz, nesne silinir
    const rest = scoped.scope === 'all' || source.kind === 'graph' ? null : cutOccurrence(row.raw, scoped.recurrenceId!, scoped.scope, s.hub.now())
    const r = rest === null ? await dropObject(target, row, etag, scoped.scope) : await putObject(target, row.remote_id, rest, etag, scoped)
    if (r === 'conflict') return { ok: false, conflict: true }
    wrote(s, source, 'calendar')
    return { ok: true }
  },

  async addIcsSubscription(s, params) {
    const p = params as { url?: unknown; name?: unknown; color?: unknown }
    if (typeof p.url !== 'string') throw invalid()
    const url = normalizeFeedUrl(p.url)
    const host = new URL(url).hostname
    const name = text(p.name, 200)?.trim() || host
    if (p.color != null && !(typeof p.color === 'string' && COLOR.test(p.color))) throw invalid()
    ensureLocalSource(s)
    const userId = s.currentUser!.id
    if (s.deps.q.countIcsSources(userId) >= MAX_SUBSCRIPTIONS) throw new Error(t('pim.err.tooManySubscriptions'))
    // kayıttan önce denenir: iç ağa giden ya da takvim olmayan adres saklanmaz
    await readFeed(url, s.hub.pimDeps().net({ ics: true }), {}, s.hub.pimDeps().gateWorker)
    const [enc] = await s.deps.encrypt([url])
    // yukarıda await var: eşzamanlı ekleme sınırı geçmesin
    if (s.deps.q.countIcsSources(userId) >= MAX_SUBSCRIPTIONS) throw new Error(t('pim.err.tooManySubscriptions'))
    const src = s.deps.q.insertIcsPimSource({ userId, label: host, urlEnc: Buffer.from(enc), name, color: (p.color as string | null | undefined) ?? null, now: s.hub.now() })
    emitPimChanged(s.hub, src, 'sources')
    syncSoon(s, src)
    return { sourceId: src.id }
  }
}
