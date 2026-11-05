// Yazma RPC'lerinin ortak yolu: eşzamanlı olarak uzak sunucuya, başarıda yerel satıra. Reddedilmiş kimlik yeniden denenmez,
// kilitli kasa ya da çevrimdışı durumda yazma sunucuya gitmez; yerel satır uzak yazma başarısından önce değişmez.
import { t } from '../../shared/i18n'
import type { PimCollectionRow, PimSourceRow } from '../db/queries'
import { syncBatch } from '../pim/apply'
import { backendFor, type PimBackend, type RemoteObject } from '../pim/backend'
import { sourceReady } from '../pim/davBackend'
import { isAuthFailure } from '../pim/pimScheduler'
import type { RpcSession } from '../rpcSession'
import { emitPimChanged } from './pimAuth'
import { syncSoon } from './pimSources'

export function writeBackend(s: RpcSession, source: PimSourceRow): PimBackend {
  if (source.status === 'needs_reauth') throw new Error(t('pim.err.needsReauth'))
  const d = s.hub.pimDeps()
  if (source.kind === 'local') return backendFor(d, source)
  if (d.offline()) throw new Error(t('pim.err.offline'))
  if (!sourceReady(d, source)) throw new Error(t('pim.err.noSecret'))
  return backendFor(d, source)
}

/** İstemcinin gördüğü sürüm. `null` If-Match'i düşüremez: yalnız dize geçer, verilmediyse satırınki */
export function etagOf(given: unknown, row: { etag: string | null }): string | null {
  if (given === undefined || given === null) return row.etag
  if (typeof given !== 'string' || given.length > 1000) throw new Error(t('pim.err.invalid'))
  return given
}

/** Uzak çağrı: kimlik reddi kaynağı durdurur, hiç yeniden denenmez */
export async function remoteCall<T>(s: RpcSession, source: PimSourceRow, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (e) {
    if (!isAuthFailure(e)) throw e
    s.deps.q.markPimSourceNeedsReauth(source.id, t('pim.err.davAuth'))
    emitPimChanged(s.hub, source, 'sources')
    throw new Error(t('pim.err.davAuth'))
  }
}

/** Etag'siz yanıtta nesne sunucudan alınır: sonraki yazma If-Match gönderebilsin */
export async function withEtag(s: RpcSession, source: PimSourceRow, backend: PimBackend, c: PimCollectionRow, o: RemoteObject): Promise<RemoteObject> {
  if (o.etag || source.kind === 'local') return o
  return (await remoteCall(s, source, () => backend.fetchObject(c, o.remoteId))) ?? o
}

/** Yazma bitti: Graph oluşumları sunucuda üretir, bir tur eşitleme gerekir */
export function wrote(s: RpcSession, source: PimSourceRow, kind: 'contacts' | 'calendar'): void {
  emitPimChanged(s.hub, source, kind)
  if (source.kind === 'graph') syncSoon(s, source)
}

/** Tek nesneyi eşitlemeyle aynı kapıdan yerel satıra yazar */
export async function storeObject(s: RpcSession, c: PimCollectionRow, o: RemoteObject): Promise<void> {
  const batch = syncBatch(s.hub.pimDeps(), c)
  batch.sink.upsert(o)
  const { changed } = await batch.commit()
  if (!changed) throw new Error(t('pim.err.invalid'))
}
