// Kaynak türünden bağımsız yüzey: yazma RPC'leri ve zamanlayıcı yalnız bunu görür. Graph verisi vCard/VEVENT'e çevrilir,
// böylece arayüz ve açılım tek yoldan geçer.
import type { EditScope, PimChangedEvent, PimCollectionType } from '../../shared/pim'
import { t } from '../../shared/i18n'
import type { PimCollectionRow, PimSourceRow, Queries } from '../db/queries'
import type { NetPolicy } from '../net/safeFetch'
import { DavBackend } from './davBackend'
import { GraphBackend } from './graphBackend'
import { IcsBackend } from './icsBackend'
import { LocalBackend } from './localBackend'

export interface RemoteCollection {
  type: PimCollectionType
  remoteId: string
  name: string
  color: string | null
  readOnly: boolean
}

export interface RemoteObject {
  remoteId: string
  etag: string | null
  data: string
}

export interface SyncState {
  ctag?: string | null
  syncToken?: string | null
  deltaLink?: string | null
  windowStart?: number
  windowEnd?: number
  /** Abonelik akışının doğrulayıcıları (kaynak satırında durur) */
  feedEtag?: string | null
  feedLastModified?: string | null
}

export interface SyncSink {
  /** Koleksiyonun yereldeki nesneleri: remote_id → etag */
  etags(): Map<string, string | null>
  upsert(o: RemoteObject): void
  remove(remoteId: string): void
  /** Çevrilemeyen nesne: tam listede eski satırı durur */
  keep(remoteId: string): void
  replaceAll(os: RemoteObject[]): void
  setState(s: SyncState): void
}

export interface PimBackend {
  listCollections(): Promise<RemoteCollection[]>
  sync(c: PimCollectionRow, sink: SyncSink): Promise<void>
  putContact(c: PimCollectionRow, remoteId: string | null, vcard: string, etag: string | null): Promise<RemoteObject | 'conflict'>
  deleteContact(c: PimCollectionRow, remoteId: string, etag: string | null): Promise<'ok' | 'conflict'>
  putEvent(c: PimCollectionRow, remoteId: string | null, ics: string, etag: string | null, o?: { scope?: EditScope; recurrenceId?: string; uid?: string }): Promise<RemoteObject | 'conflict'>
  deleteEvent(c: PimCollectionRow, remoteId: string, etag: string | null, o?: { scope?: EditScope; raw?: string }): Promise<'ok' | 'conflict'>
  /** Sunucu yazma yanıtında etag vermediyse nesnenin güncel hâli; yerel kaynakta null */
  fetchObject(c: PimCollectionRow, remoteId: string): Promise<RemoteObject | null>
  respond?(c: PimCollectionRow, remoteId: string, partstat: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE'): Promise<void>
}

export interface PimDeps {
  q: Queries
  /** Hesap sırları (parola ya da yenileme belirteci); kasa kilitliyken eksik */
  creds: Map<number, string>
  decrypt(blobs: Uint8Array[]): Promise<string[]>
  net(o: { ics: boolean }): NetPolicy
  offline(): boolean
  emit(src: PimSourceRow, kind: PimChangedEvent['kind']): void
  now(): number
  /** yalnız testler: derlenmiş alım kapısı worker'ı */
  gateWorker?: string
  /** yalnız testler: Graph kökü */
  graphBase?: string
}

export function backendFor(d: PimDeps, src: PimSourceRow): PimBackend {
  switch (src.kind) {
    case 'dav': return new DavBackend(d, src)
    case 'local': return new LocalBackend()
    case 'ics': return new IcsBackend(d, src)
    case 'graph': return new GraphBackend(d, src)
    default: throw new Error(t('pim.err.unsupported'))
  }
}
