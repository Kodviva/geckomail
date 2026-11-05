// Kişiler ve takvim yetkisi (§10.1). Hesaba bağlı kaynak hesabın yetkisini izler; kişisel kaynağı yalnız sahibi
// görür, yönetici dahil. Oturumdaki grup listesi bayatlar: yetki her çağrıda veritabanından okunur.
import type { PimChangedEvent, PimCollectionType } from '../../shared/pim'
import type { SessionUser } from '../../shared/rpc'
import { t } from '../../shared/i18n'
import { sessionUserFromRow, userCanManage, userCanView } from '../auth/sessionUser'
import type { PimCollectionRow, PimSourceRow, Queries } from '../db/queries'
import type { RpcHub } from '../rpcHub'
import type { RpcSession } from '../rpcSession'

/** Veritabanındaki güncel kimlik; silinen ya da devre dışı kullanıcı hiçbir şey göremez */
function freshUser(s: RpcSession): SessionUser | null {
  const id = s.currentUser?.id
  if (id == null) return null
  const row = s.deps.q.getUserById(id)
  return row && row.enabled ? sessionUserFromRow(s.deps.q, row) : null
}

function readable(q: Queries, u: SessionUser, src: PimSourceRow): boolean {
  return src.owner_user_id != null ? src.owner_user_id === u.id : userCanView(q, u, src.account_id!)
}

function writable(q: Queries, u: SessionUser, src: PimSourceRow): boolean {
  return src.owner_user_id != null ? src.owner_user_id === u.id : userCanManage(q, u, src.account_id!)
}

export function canReadSource(s: RpcSession, src: PimSourceRow): boolean {
  const u = freshUser(s)
  return !!u && readable(s.deps.q, u, src)
}

export function canWriteSource(s: RpcSession, src: PimSourceRow): boolean {
  const u = freshUser(s)
  return !!u && writable(s.deps.q, u, src)
}

/** Oturumun görebildiği kaynaklar; yetki tek kez okunur */
export function visibleSources(s: RpcSession): { source: PimSourceRow; canWrite: boolean }[] {
  const u = freshUser(s)
  if (!u) return []
  const q = s.deps.q
  return q.pimSourceCandidates(u.id).filter((src) => readable(q, u, src)).map((source) => ({ source, canWrite: writable(q, u, source) }))
}

/** Hesabı yönetme yetkisi veritabanından: `s.assertCanManage` oturumdaki grup listesine bakar */
export function assertAccountManage(s: RpcSession, accountId: number): void {
  const u = freshUser(s)
  if (!u || !userCanManage(s.deps.q, u, accountId)) throw new Error(t('sync.perm.cannotManage'))
}

export function assertAccountView(s: RpcSession, accountId: number): void {
  const u = freshUser(s)
  if (!u || !userCanView(s.deps.q, u, accountId)) throw new Error(t('sync.perm.cannotView'))
}

export function assertCollectionRead(s: RpcSession, collectionId: number): { collection: PimCollectionRow; source: PimSourceRow } {
  const collection = s.deps.q.getPimCollection(collectionId)
  const source = collection && s.deps.q.getPimSource(collection.source_id)
  // yok ile yetkisiz aynı yanıtı alır: kimlik taramasıyla başkasının kaynağı anlaşılmasın
  if (!collection || !source || !canReadSource(s, source)) throw new Error(t('pim.err.noAccess'))
  return { collection, source }
}

export function assertCollectionWrite(s: RpcSession, collectionId: number): { collection: PimCollectionRow; source: PimSourceRow } {
  const found = assertCollectionRead(s, collectionId)
  if (!canWriteSource(s, found.source)) throw new Error(t('pim.err.noWrite'))
  if (found.collection.read_only) throw new Error(t('pim.err.readOnly'))
  return found
}

export function visibleCollectionIds(s: RpcSession, type: PimCollectionType): number[] {
  const sources = new Set(visibleSources(s).map((v) => v.source.id))
  return s.deps.q.listPimCollectionsByType(type).filter((c) => sources.has(c.source_id)).map((c) => c.id)
}

/** Kullanıcının yerel kaynağı; ilk kullanımda "Kişilerim" + "Takvimim" ile açılır */
export function ensureLocalSource(s: RpcSession): PimSourceRow {
  const q = s.deps.q
  const userId = s.currentUser!.id
  return q.getLocalPimSource(userId) ?? q.insertLocalPimSource({
    userId, label: t('pim.local.label'), contactsName: t('pim.local.contacts'), calendarName: t('pim.local.calendar'), now: s.hub.now()
  })
}

/** Hesaba bağlı olay hesabı görenlere süzülür; kişisel kaynak olayı yalnız sahibine gider */
export function emitPimChanged(hub: RpcHub, src: PimSourceRow, kind: PimChangedEvent['kind']): void {
  const data: PimChangedEvent = { kind, sourceId: src.id, accountId: src.account_id }
  if (src.account_id != null) hub.broadcast('pim:changed', data)
  else hub.sendToUser(src.owner_user_id!, 'pim:changed', data)
}
