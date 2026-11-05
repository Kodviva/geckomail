// iCal aboneliği: salt okunur akış. Başarısız, aşırı büyük ya da boş yanıt eski veriyi korur, kaynak `error` olur. Adres çoğu kez
// özel belirteç taşır: şifreli saklanır, arayüze yalnız ana makine adı gider. Sunucu modunda iç ağ istisnası yoktur.
import { t } from '../../shared/i18n'
import type { PimCollectionRow, PimSourceRow } from '../db/queries'
import { safeFetch, type NetPolicy } from '../net/safeFetch'
import type { PimBackend, PimDeps, RemoteCollection, RemoteObject, SyncSink } from './backend'
import { splitFeedInWorker } from './gate'

const TIMEOUT_MS = 20_000
const MAX_FEED_BYTES = 5_000_000
const MAX_REDIRECTS = 3
const DEADLINE_MS = 60_000

export function normalizeFeedUrl(input: string): string {
  const raw = input.trim().replace(/^webcals?:/i, 'https:')
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error(t('pim.err.invalid'))
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || raw.length > 2000) throw new Error(t('pim.err.invalid'))
  return raw
}

const firstHeader = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? v[0] : v) ?? null

export interface FeedResult {
  objects: RemoteObject[]
  etag: string | null
  lastModified: string | null
}

/** null: sunucu "değişmedi" dedi */
export async function readFeed(url: string, net: NetPolicy, prev: { etag?: string | null; lastModified?: string | null } = {}, gateWorker?: string): Promise<FeedResult | null> {
  const headers: Record<string, string> = { accept: 'text/calendar, */*;q=0.5' }
  if (prev.etag) headers['if-none-match'] = prev.etag
  if (prev.lastModified) headers['if-modified-since'] = prev.lastModified
  const res = await safeFetch(url, { timeoutMs: TIMEOUT_MS, deadlineMs: DEADLINE_MS, maxBytes: MAX_FEED_BYTES, maxRedirects: MAX_REDIRECTS, net, headers })
  if (res.status === 304) return null
  if (!res.ok) throw new Error(t('pim.err.feedHttp', { status: res.status }))
  const split = await splitFeedInWorker(res.body.toString('utf-8'), gateWorker)
  if (split === 'tooLarge') throw new Error(t('pim.err.feedTooLarge'))
  if (!split.length) throw new Error(t('pim.err.feedEmpty'))
  return {
    objects: split.map((o) => ({ remoteId: o.uid, etag: null, data: o.data })),
    etag: firstHeader(res.headers.etag), lastModified: firstHeader(res.headers['last-modified'])
  }
}

const readOnly = (): never => {
  throw new Error(t('pim.err.readOnly'))
}

export class IcsBackend implements PimBackend {
  constructor(private readonly d: PimDeps, private readonly src: PimSourceRow) {}

  async listCollections(): Promise<RemoteCollection[]> {
    return this.d.q.pimCollectionsOfSource(this.src.id).map((c) => ({ type: c.type, remoteId: c.remote_id, name: c.name, color: c.color, readOnly: true }))
  }

  async sync(_c: PimCollectionRow, sink: SyncSink): Promise<void> {
    const [url] = await this.d.decrypt([new Uint8Array(this.src.ics_url_enc!)])
    const feed = await readFeed(url, this.d.net({ ics: true }), { etag: this.src.ics_etag, lastModified: this.src.ics_last_modified }, this.d.gateWorker)
    if (!feed) return
    sink.replaceAll(feed.objects)
    sink.setState({ feedEtag: feed.etag, feedLastModified: feed.lastModified })
  }

  async fetchObject(): Promise<null> {
    return null
  }

  putContact = readOnly
  deleteContact = readOnly
  putEvent = readOnly
  deleteEvent = readOnly
}
