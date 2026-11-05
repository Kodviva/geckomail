// CalDAV/CardDAV kaynağı. Sunucunun verdiği href başka kökene çıkamaz: kimlik başlığı oraya gitmesin diye yok sayılır.
// Sunucu kazanır: yazma RPC'de eşzamanlı olduğu için yerelde bekleyen değişiklik yoktur.
import { randomUUID } from 'crypto'
import { t } from '../../shared/i18n'
import type { PimCollectionRow, PimSourceRow } from '../db/queries'
import { accessTokenFor, providerOfAuthType } from '../oauth'
import type { PimBackend, PimDeps, RemoteCollection, RemoteObject, SyncSink } from './backend'
import { DavClient, DavHttpError, type DavAuth, type DavObject } from './davClient'
import { findHome } from './discovery'
import { ensureVtimezones } from './ical'

const MULTIGET_BATCH = 100
const MAX_SYNC_ROUNDS = 20
const COLOR = /^#[0-9a-f]{6}/i
const TYPES = { calendar: 'text/calendar; charset=utf-8', addressbook: 'text/vcard; charset=utf-8' } as const

export const basicHeader = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`, 'utf-8').toString('base64')}`

/** Hesabın kaynağı: parolada kullanıcı adı e-posta (Stalwart hesabı onunla tanır); OAuth'ta Google'ın tek belirteci */
export function accountAuth(row: { id: number; email: string; auth_type: string }, secret: string): DavAuth {
  if (!providerOfAuthType(row.auth_type)) return { header: async () => basicHeader(row.email, secret) }
  return { header: async (force) => `Bearer ${await accessTokenFor(row, secret, 'mail', force)}` }
}

/** Kasa kilitliyken ya da sır henüz yüklenmemişken zamanlayıcı kaynağı bu turda atlar */
export function sourceReady(d: PimDeps, src: PimSourceRow): boolean {
  if (src.account_id == null) return true
  const row = d.q.getAccountRow(src.account_id)
  return !!row && !row.secure && d.creds.has(row.id)
}

function sourceAuth(d: PimDeps, src: PimSourceRow): DavAuth {
  if (src.auth === 'basic') {
    let header: string | null = null
    return {
      header: async () => (header ??= basicHeader(src.username ?? '', (await d.decrypt([new Uint8Array(src.secret_enc!)]))[0]))
    }
  }
  const row = d.q.getAccountRow(src.account_id!)
  const secret = d.creds.get(src.account_id!)
  if (!row || !secret) throw new Error(t('pim.err.noSecret'))
  return accountAuth(row, secret)
}

/** Aynı kökende kalan href'in yolu; başka köken ya da bozuk adres null */
function pathIn(base: string, href: string): string | null {
  try {
    const from = new URL(base)
    const to = new URL(href, from)
    return to.origin === from.origin ? to.pathname : null
  } catch {
    return null
  }
}

const trimSlash = (p: string): string => p.replace(/\/$/, '')

export class DavBackend implements PimBackend {
  private readonly client: DavClient

  constructor(private readonly d: PimDeps, private readonly src: PimSourceRow) {
    this.client = new DavClient({ auth: sourceAuth(d, src), net: d.net({ ics: false }) })
  }

  private baseOf(type: 'calendar' | 'addressbook'): string {
    return (type === 'calendar' ? this.src.caldav_url : this.src.carddav_url) ?? ''
  }

  private urlOf(c: PimCollectionRow, path: string): string {
    const origin = new URL(this.baseOf(c.type)).origin
    // `new URL(path, taban)` yol `//evil/x` ise köken değiştirir: kimlik başlığı oraya giderdi
    if (!path.startsWith('/')) throw new Error(t('pim.err.invalid'))
    const url = new URL(origin + path)
    if (url.origin !== origin) throw new Error(t('pim.err.invalid'))
    return url.toString()
  }

  async listCollections(): Promise<RemoteCollection[]> {
    const out: RemoteCollection[] = []
    for (const type of ['calendar', 'addressbook'] as const) {
      const base = this.baseOf(type)
      if (!base) continue
      // Google'ın carddav yönlendirmesi önbelleğe alınmaz
      const home = base.includes('/.well-known/') ? (await findHome(this.client, base, type)).home : base
      if (!home) {
        // geçici keşif hatası: koleksiyonlar ve kişisel tercihler silinmesin
        for (const c of this.d.q.pimCollectionsOfSource(this.src.id)) if (c.type === type) out.push({ type, remoteId: c.remote_id, name: c.name, color: c.color, readOnly: !!c.read_only })
        continue
      }
      const rows = await this.client.propfind(home, 1, ['displayname', 'resourcetype', 'calendar-color', 'supported-calendar-component-set', 'current-user-privilege-set'])
      for (const r of rows) {
        if (!r.resourceTypes.includes(type)) continue
        if (type === 'calendar' && r.components.length && !r.components.includes('VEVENT')) continue
        const remoteId = pathIn(home, r.href)
        if (!remoteId) continue
        const canWrite = !r.privileges.length || r.privileges.some((p) => p === 'write' || p === 'write-content' || p === 'all')
        out.push({
          type, remoteId, name: r.displayName ?? (decodeURIComponent(trimSlash(remoteId).split('/').pop() ?? '') || type),
          color: COLOR.exec(r.color ?? '')?.[0] ?? null, readOnly: !canWrite
        })
      }
    }
    return out
  }

  async sync(c: PimCollectionRow, sink: SyncSink): Promise<void> {
    const url = this.urlOf(c, c.remote_id)
    let token = c.sync_token
    if (token) {
      const known = sink.etags()
      for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
        const r = await this.client.syncCollection(url, token)
        if (r === 'token-invalid' || r === 'unsupported') {
          sink.setState({ syncToken: null })
          return this.fullSync(c, url, sink, true)
        }
        const paths = r.changed.flatMap((x) => {
          const p = pathIn(url, x.href)
          return p && (!x.etag || known.get(p) !== x.etag) ? [p] : []
        })
        await this.fetchInto(c, url, paths, sink)
        for (const href of r.removed) {
          const p = pathIn(url, href)
          if (p) sink.remove(p)
        }
        token = r.token
        if (!r.truncated) break
      }
      sink.setState({ syncToken: token })
      return
    }
    return this.fullSync(c, url, sink, false)
  }

  /** Belirteçsiz yol: getctag aynıysa biter, değilse href+etag listesi yerelle karşılaştırılır */
  private async fullSync(c: PimCollectionRow, url: string, sink: SyncSink, force: boolean): Promise<void> {
    const [self] = await this.client.propfind(url, 0, ['getctag', 'sync-token'])
    const ctag = self?.ctag ?? null
    const syncToken = self?.syncToken ?? null
    if (!force && ctag && ctag === c.ctag) {
      if (syncToken) sink.setState({ syncToken })
      return
    }
    const list = await this.client.propfind(url, 1, ['getetag', 'resourcetype'])
    const remote = new Map<string, string | null>()
    const selfPath = trimSlash(new URL(url).pathname)
    for (const r of list) {
      const p = pathIn(url, r.href)
      if (p && trimSlash(p) !== selfPath && !r.resourceTypes.includes('collection')) remote.set(p, r.etag)
    }
    const known = sink.etags()
    const stale = [...remote].filter(([p, etag]) => !etag || known.get(p) !== etag).map(([p]) => p)
    await this.fetchInto(c, url, stale, sink)
    for (const p of known.keys()) if (!remote.has(p)) sink.remove(p)
    sink.setState({ ctag, syncToken })
  }

  private async fetchInto(c: PimCollectionRow, url: string, paths: string[], sink: SyncSink): Promise<void> {
    for (let i = 0; i < paths.length; i += MULTIGET_BATCH) {
      for (const o of await this.fetchBatch(c, url, paths.slice(i, i + MULTIGET_BATCH))) {
        const remoteId = pathIn(url, o.href)
        if (remoteId) sink.upsert({ remoteId, etag: o.etag, data: o.data })
      }
    }
  }

  private async fetchBatch(c: PimCollectionRow, url: string, paths: string[]): Promise<DavObject[]> {
    try {
      return await this.client.multiget(url, c.type, paths)
    } catch (e) {
      if (!(e instanceof DavHttpError && (e.status === 400 || e.status === 501))) throw e
    }
    const out: DavObject[] = []
    for (const p of paths) {
      const o = await this.client.get(this.urlOf(c, p))
      if (o) out.push(o)
    }
    return out
  }

  private async put(c: PimCollectionRow, remoteId: string | null, body: string, ext: string, etag: string | null, name?: string): Promise<RemoteObject | 'conflict'> {
    const path = remoteId ?? `${trimSlash(c.remote_id)}/${encodeURIComponent(name ?? randomUUID())}${ext}`
    const r = await this.client.put(this.urlOf(c, path), body, TYPES[c.type], remoteId ? (etag ? { ifMatch: etag } : {}) : { ifNoneMatch: '*' })
    return r === 'conflict' ? r : { remoteId: path, etag: r.etag, data: body }
  }

  private async remove(c: PimCollectionRow, remoteId: string, etag: string | null): Promise<'ok' | 'conflict'> {
    const r = await this.client.delete(this.urlOf(c, remoteId), etag ?? undefined)
    return r === 'conflict' ? r : 'ok'
  }

  async fetchObject(c: PimCollectionRow, remoteId: string): Promise<RemoteObject | null> {
    const o = await this.client.get(this.urlOf(c, remoteId))
    return o && { remoteId, etag: o.etag, data: o.data }
  }

  putContact(c: PimCollectionRow, remoteId: string | null, vcard: string, etag: string | null): Promise<RemoteObject | 'conflict'> {
    return this.put(c, remoteId, vcard, '.vcf', etag)
  }

  deleteContact(c: PimCollectionRow, remoteId: string, etag: string | null): Promise<'ok' | 'conflict'> {
    return this.remove(c, remoteId, etag)
  }

  putEvent(c: PimCollectionRow, remoteId: string | null, ics: string, etag: string | null, o?: { uid?: string }): Promise<RemoteObject | 'conflict'> {
    return this.put(c, remoteId, ensureVtimezones(ics), '.ics', etag, o?.uid)
  }

  deleteEvent(c: PimCollectionRow, remoteId: string, etag: string | null): Promise<'ok' | 'conflict'> {
    return this.remove(c, remoteId, etag)
  }
}
