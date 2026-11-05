// Microsoft 365 kaynağı. Delta bağlantısı yalnız tur tam bitince saklanır; yarıda kalan tur eski bağlantıdan yinelenir. calendarView seri
// ana kaydını döndürmez: her oluşum ayrı nesnedir. Beta uçları çağrılmaz; delta vermeyen takvim tam listeye ve değişim anahtarına düşer.
import { t } from '../../shared/i18n'
import type { EditScope } from '../../shared/pim'
import type { PimCollectionRow, PimSourceRow } from '../db/queries'
import { accessTokenFor } from '../oauth'
import type { PimBackend, PimDeps, RemoteCollection, RemoteObject, SyncSink } from './backend'
import { GraphClient, GraphHttpError } from './graphClient'
import { categoriesOf, draftToGraphEvent, graphContactToVCard, graphEventToIcs, seriesMasterOf, vcardToGraphContact, type GraphContact, type GraphEvent } from './graphMap'
import { eventToDraft, parseCalendar } from './ical'
import { occurrenceOf } from './recur'
import { foldLine, escapeText, parseCard } from './vcard'

const DAY_MS = 864e5
const WINDOW_BACK_MS = 365 * DAY_MS
const WINDOW_AHEAD_MS = 730 * DAY_MS
const ROTATE_MS = 30 * DAY_MS
const MAX_PAGES = 1000
const DEFAULT_FOLDER = 'default'
const HEX_COLOR = /^#[0-9a-f]{6}$/i
const GROUP_PREFIX = 'category:'
const PREFER = { prefer: 'odata.maxpagesize=100, outlook.timezone="UTC", outlook.body-content-type="text"' }

type Item<T> = T & { id: string; '@removed'?: unknown; '@odata.etag'?: string; changeKey?: string }
interface Page<T> { value: Item<T>[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }

const etagOf = (o: { '@odata.etag'?: string; changeKey?: string }): string | null => o['@odata.etag'] ?? (o.changeKey ? `W/"${o.changeKey}"` : null)
const isGroupId = (remoteId: string | null): boolean => !!remoteId?.startsWith(GROUP_PREFIX)
const gone = (e: unknown): boolean => e instanceof GraphHttpError && e.status === 410

function groupCard(name: string, memberUids: string[]): string {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', foldLine(`UID:${escapeText(GROUP_PREFIX + name)}`), foldLine(`FN:${escapeText(name)}`), 'X-ADDRESSBOOKSERVER-KIND:group']
  for (const uid of [...memberUids].sort()) lines.push(foldLine(`X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${uid}`))
  lines.push('END:VCARD', '')
  return lines.join('\r\n')
}

export function graphClientFor(d: PimDeps, accountId: number): GraphClient {
  const row = d.q.getAccountRow(accountId)
  const secret = d.creds.get(accountId)
  if (!row || !secret) throw new Error(t('pim.err.noSecret'))
  return new GraphClient({ token: (force) => accessTokenFor(row, secret, 'graph', force), baseUrl: d.graphBase, net: d.graphBase ? d.net({ ics: false }) : undefined })
}

export class GraphBackend implements PimBackend {
  private readonly client: GraphClient
  private primary: string | null = null

  constructor(private readonly d: PimDeps, src: PimSourceRow) {
    this.client = graphClientFor(d, src.account_id!)
  }

  async listCollections(): Promise<RemoteCollection[]> {
    const folders = await this.client.get<{ value: { id: string; displayName: string }[] }>('/v1.0/me/contactFolders')
    const calendars = await this.client.get<{ value: { id: string; name: string; canEdit?: boolean; isDefaultCalendar?: boolean; hexColor?: string | null }[] }>('/v1.0/me/calendars')
    this.primary = calendars.value.find((c) => c.isDefaultCalendar)?.id ?? calendars.value[0]?.id ?? null
    return [
      { type: 'addressbook', remoteId: DEFAULT_FOLDER, name: t('contacts.title'), color: null, readOnly: false },
      ...folders.value.map((f): RemoteCollection => ({ type: 'addressbook', remoteId: f.id, name: f.displayName, color: null, readOnly: false })),
      ...calendars.value.map((c): RemoteCollection => ({ type: 'calendar', remoteId: c.id, name: c.name, color: HEX_COLOR.test(c.hexColor ?? '') ? c.hexColor! : null, readOnly: c.canEdit === false }))
    ]
  }

  /** Bütün sayfalar okunursa son delta bağlantısı döner; yarıda kalan ya da bağlantısız biten delta fırlatır, sink uygulanmaz: eksik liste satır sildirirdi.
   *  `list`: delta olmayan liste, son sayfada bağlantı beklenmez. */
  private async pages<T>(start: string, each: (item: Item<T>) => void, list = false): Promise<string | null> {
    let link: string | undefined = start
    for (let i = 0; i < MAX_PAGES; i++) {
      const page: Page<T> = await this.client.get<Page<T>>(link, PREFER)
      page.value.forEach(each)
      if (page['@odata.deltaLink']) return page['@odata.deltaLink']
      link = page['@odata.nextLink']
      if (!link) {
        if (list) return null
        break
      }
    }
    throw new Error(t('pim.err.graphIncomplete'))
  }

  /** Çevrilemeyen tek nesne turu düşürmez: atlanır, tam listede eski satırı durur */
  private convert(remoteId: string, sink: SyncSink, make: () => string): string | null {
    try {
      return make()
    } catch {
      sink.keep(remoteId)
      return null
    }
  }

  sync(c: PimCollectionRow, sink: SyncSink): Promise<void> {
    return c.type === 'addressbook' ? this.syncContacts(c, sink) : this.syncEvents(c, sink)
  }

  private async syncContacts(c: PimCollectionRow, sink: SyncSink): Promise<void> {
    /** Varsayılan klasörün kimliği yalnız bir kişiden öğrenilir: boş klasörde delta başlatılamaz */
    const fullDelta = async (): Promise<string | null> => {
      if (c.remote_id !== DEFAULT_FOLDER) return `/v1.0/me/contactFolders/${encodeURIComponent(c.remote_id)}/contacts/delta`
      const first = await this.client.get<{ value: { parentFolderId?: string }[] }>('/v1.0/me/contacts?$top=1&$select=parentFolderId')
      const id = first.value[0]?.parentFolderId
      return id ? `/v1.0/me/contactFolders/${encodeURIComponent(id)}/contacts/delta` : null
    }
    const objects: RemoteObject[] = []
    const removed: string[] = []
    const collect = (x: Item<GraphContact>): void => {
      if (x['@removed']) removed.push(x.id)
      else {
        const data = this.convert(x.id, sink, () => graphContactToVCard(x))
        if (data) objects.push({ remoteId: x.id, etag: etagOf(x), data })
      }
    }
    // saklı bağlantı önce: son kişi silinmişse klasör araması boş döner, @removed yalnız buradan gelir
    let replace = !c.delta_link
    let deltaLink: string | null = null
    const start = c.delta_link ?? (await fullDelta())
    if (start) {
      try {
        deltaLink = await this.pages<GraphContact>(start, collect)
      } catch (e) {
        if (!gone(e)) throw e
        objects.length = removed.length = 0
        replace = true
        const full = await fullDelta()
        if (full) deltaLink = await this.pages<GraphContact>(full, collect)
      }
    }
    if (!deltaLink && !objects.length && !removed.length && !c.delta_link) {
      sink.setState({ deltaLink: null })
      return
    }
    const stored = new Map(this.d.q.pimContactRaws(c.id).filter((r) => !r.uid.startsWith(GROUP_PREFIX)).map((r) => [r.uid, r.raw]))
    if (replace) {
      stored.clear()
      sink.replaceAll(objects)
    } else {
      for (const o of objects) sink.upsert(o)
    }
    for (const id of removed) {
      sink.remove(id)
      stored.delete(id)
    }
    for (const o of objects) stored.set(o.remoteId, o.data)
    if (objects.length || removed.length || replace) this.syncGroups(stored, sink)
    sink.setState({ deltaLink })
  }

  /** Kategoriler Graph'ın kişi gruplarıdır: üyelikten grup kartı üretilir */
  private syncGroups(contacts: Map<string, string>, sink: SyncSink): void {
    const groups = new Map<string, string[]>()
    for (const [uid, raw] of contacts) for (const name of categoriesOf(raw)) groups.set(name, [...(groups.get(name) ?? []), uid])
    for (const [name, members] of groups) sink.upsert({ remoteId: GROUP_PREFIX + name, etag: null, data: groupCard(name, members) })
    for (const remoteId of sink.etags().keys()) if (isGroupId(remoteId) && !groups.has(remoteId.slice(GROUP_PREFIX.length))) sink.remove(remoteId)
  }

  private async syncEvents(c: PimCollectionRow, sink: SyncSink): Promise<void> {
    const now = this.d.now()
    const rotate = !c.delta_link || c.window_start == null || now - c.window_start >= WINDOW_BACK_MS + ROTATE_MS
    const windowStart = rotate ? now - WINDOW_BACK_MS : c.window_start!
    const windowEnd = rotate ? now + WINDOW_AHEAD_MS : c.window_end!
    const range = `startDateTime=${encodeURIComponent(new Date(windowStart).toISOString())}&endDateTime=${encodeURIComponent(new Date(windowEnd).toISOString())}`
    const id = encodeURIComponent(c.remote_id)
    const secondary = this.primary !== null && c.remote_id !== this.primary
    const full = `${secondary ? `/v1.0/me/calendars/${id}/calendarView/delta` : '/v1.0/me/calendarView/delta'}?${range}`
    const objects: RemoteObject[] = []
    const removed: string[] = []
    const collect = (x: Item<GraphEvent>): void => {
      if (x['@removed']) removed.push(x.id)
      // seri ana kaydı açılmış oluşumlarla çakışır, calendarView zaten vermemeli
      else if (x.type !== 'seriesMaster') {
        const data = this.convert(x.id, sink, () => graphEventToIcs(x))
        if (data) objects.push({ remoteId: x.id, etag: etagOf(x), data })
      }
    }
    let replace = rotate
    let deltaLink: string | null
    try {
      try {
        deltaLink = await this.pages<GraphEvent>(rotate ? full : c.delta_link!, collect)
      } catch (e) {
        if (!gone(e)) throw e
        objects.length = removed.length = 0
        replace = true
        deltaLink = await this.pages<GraphEvent>(full, collect)
      }
    } catch (e) {
      if (!(secondary && e instanceof GraphHttpError && (e.status === 400 || e.status === 404))) throw e
      return this.listFallback(c, sink, range, windowStart, windowEnd)
    }
    if (replace) sink.replaceAll(objects)
    else for (const o of objects) sink.upsert(o)
    for (const remoteId of removed) sink.remove(remoteId)
    sink.setState({ deltaLink, windowStart, windowEnd })
  }

  /** Delta olmayan takvim: tam liste, değişim anahtarı aynıysa nesne yeniden işlenmez */
  private async listFallback(c: PimCollectionRow, sink: SyncSink, range: string, windowStart: number, windowEnd: number): Promise<void> {
    const known = sink.etags()
    const seen = new Set<string>()
    await this.pages<GraphEvent>(`/v1.0/me/calendars/${encodeURIComponent(c.remote_id)}/calendarView?${range}`, (x) => {
      seen.add(x.id)
      const etag = etagOf(x)
      if (etag && known.get(x.id) === etag) return
      const data = this.convert(x.id, sink, () => graphEventToIcs(x))
      if (data) sink.upsert({ remoteId: x.id, etag, data })
    }, true)
    for (const id of known.keys()) if (!seen.has(id)) sink.remove(id)
    sink.setState({ deltaLink: null, windowStart, windowEnd })
  }

  private contactObject(x: Item<GraphContact>): RemoteObject {
    return { remoteId: x.id, etag: etagOf(x), data: graphContactToVCard(x) }
  }

  async putContact(c: PimCollectionRow, remoteId: string | null, vcard: string, etag: string | null): Promise<RemoteObject | 'conflict'> {
    const card = parseCard(vcard)
    if (card?.kind === 'group') return this.putGroup(c, remoteId, vcard, card.fullName, card.memberUids)
    const body = vcardToGraphContact(vcard)
    const path = remoteId ? `/v1.0/me/contacts/${encodeURIComponent(remoteId)}` : c.remote_id === DEFAULT_FOLDER ? '/v1.0/me/contacts' : `/v1.0/me/contactFolders/${encodeURIComponent(c.remote_id)}/contacts`
    const r = await this.client.send<Item<GraphContact>>(remoteId ? 'PATCH' : 'POST', path, body, remoteId ? etag : null)
    return r === 'conflict' ? r : this.contactObject(r)
  }

  private async setCategories(uid: string, next: string[]): Promise<void> {
    await this.client.send('PATCH', `/v1.0/me/contacts/${encodeURIComponent(uid)}`, { categories: next })
  }

  /** Grup bir kategoridir: üyelerin kategorileri değişir */
  private async putGroup(c: PimCollectionRow, remoteId: string | null, vcard: string, name: string, members: string[]): Promise<RemoteObject> {
    const previous = remoteId?.slice(GROUP_PREFIX.length) ?? name
    const wanted = new Set(members)
    for (const { uid, raw } of this.d.q.pimContactRaws(c.id)) {
      if (uid.startsWith(GROUP_PREFIX)) continue
      const has = categoriesOf(raw)
      const renamed = [...new Set(has.map((x) => (x === previous ? name : x)))]
      const next = wanted.has(uid) ? [...new Set([...renamed, name])] : renamed.filter((x) => x !== name)
      if (next.length !== has.length || next.some((x, i) => x !== has[i])) await this.setCategories(uid, next)
    }
    return { remoteId: GROUP_PREFIX + name, etag: null, data: vcard }
  }

  async deleteContact(c: PimCollectionRow, remoteId: string, etag: string | null): Promise<'ok' | 'conflict'> {
    if (isGroupId(remoteId)) {
      const name = remoteId.slice(GROUP_PREFIX.length)
      for (const { uid, raw } of this.d.q.pimContactRaws(c.id)) {
        const has = categoriesOf(raw)
        if (!uid.startsWith(GROUP_PREFIX) && has.includes(name)) await this.setCategories(uid, has.filter((x) => x !== name))
      }
      return 'ok'
    }
    const r = await this.client.send('DELETE', `/v1.0/me/contacts/${encodeURIComponent(remoteId)}`, undefined, etag)
    return r === 'conflict' ? r : 'ok'
  }

  private eventObject(x: Item<GraphEvent>): RemoteObject {
    return { remoteId: x.id, etag: etagOf(x), data: graphEventToIcs(x) }
  }

  async putEvent(c: PimCollectionRow, remoteId: string | null, ics: string, etag: string | null, o?: { scope?: EditScope; recurrenceId?: string }): Promise<RemoteObject | 'conflict'> {
    if (o?.scope === 'thisAndFuture') throw new Error(t('pim.err.noThisAndFuture'))
    const draft = eventToDraft(ics, o?.recurrenceId ?? null, 'UTC')
    if (!draft) throw new Error(t('pim.err.invalid'))
    const body = draftToGraphEvent(draft)
    if (!remoteId) {
      const made = await this.client.send<Item<GraphEvent>>('POST', `/v1.0/me/calendars/${encodeURIComponent(c.remote_id)}/events`, body)
      if (made === 'conflict') return made
      return made.type === 'seriesMaster' ? this.firstInstance(made) : this.eventObject(made)
    }
    const master = o?.scope === 'this' ? null : seriesMasterOf(ics)
    if (master) {
      // taslak bir oluşumun tarihini taşır: seri ana kaydına yalnız kullanıcı zamanı değiştirdiyse gider
      const { start: _start, end: _end, ...rest } = body
      const done = await this.client.send('PATCH', `/v1.0/me/events/${encodeURIComponent(master)}`, this.timeChanged(c, remoteId, ics) ? body : rest)
      if (done === 'conflict') return done
      // oluşumlar sunucuda yeniden üretilir: güncel hâli yazma sonrası eşitlemeyle gelir
      return { remoteId, etag: null, data: ics }
    }
    const { recurrence: _single, ...patch } = body
    const r = await this.client.send<Item<GraphEvent>>('PATCH', `/v1.0/me/events/${encodeURIComponent(remoteId)}`, o?.scope === 'this' ? patch : body, etag)
    return r === 'conflict' ? r : this.eventObject(r)
  }

  private timeChanged(c: PimCollectionRow, remoteId: string, ics: string): boolean {
    const id = this.d.q.pimEventIdByRemote(c.id, remoteId)
    const stored = id === undefined ? null : parseCalendar(this.d.q.getCalendarObject(id)?.raw ?? '')
    const next = parseCalendar(ics)
    const was = stored && occurrenceOf(stored, stored.events[0].recurrenceId, 'UTC')
    const now = next && occurrenceOf(next, next.events[0].recurrenceId, 'UTC')
    return !was || !now || was.start !== now.start || was.end !== now.end
  }

  /** Yeni seri: ana kayıt saklanmaz, ilk oluşum görünsün diye alınır; kalanı yazma sonrası eşitlemeyle gelir */
  private async firstInstance(master: Item<GraphEvent>): Promise<RemoteObject> {
    const from = new Date(this.d.now() - WINDOW_BACK_MS).toISOString()
    const to = new Date(this.d.now() + WINDOW_AHEAD_MS).toISOString()
    const list = await this.client.get<Page<GraphEvent>>(`/v1.0/me/events/${encodeURIComponent(master.id)}/instances?startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}&$top=1`, PREFER)
    return this.eventObject(list.value[0] ?? master)
  }

  async deleteEvent(_c: PimCollectionRow, remoteId: string, etag: string | null, o?: { scope?: EditScope; raw?: string }): Promise<'ok' | 'conflict'> {
    const master = o?.scope === 'this' ? null : seriesMasterOf(o?.raw ?? '')
    const r = await this.client.send('DELETE', `/v1.0/me/events/${encodeURIComponent(master ?? remoteId)}`, undefined, master ? null : etag)
    return r === 'conflict' ? r : 'ok'
  }

  async fetchObject(): Promise<null> {
    return null
  }

  async respond(_c: PimCollectionRow, remoteId: string, partstat: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE'): Promise<void> {
    const action = partstat === 'ACCEPTED' ? 'accept' : partstat === 'DECLINED' ? 'decline' : 'tentativelyAccept'
    await this.client.send('POST', `/v1.0/me/events/${encodeURIComponent(remoteId)}/${action}`, { sendResponse: true })
  }
}
