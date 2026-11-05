// Postaları klasöre taşıma: sürükle bırak ve Taşı penceresinin ortak kuralları (saf yardımcılar).
import type { AccountInfo, FolderInfo, SessionUser, ThreadMember } from '../../shared/rpc'

export const DRAG_TYPE = 'application/x-gecko-messages'
/** Sürükleyip kapalı grubun üstünde bekleme süresi */
export const SPRING_MS = 700
/** Sürükleme sürerken tarayıcı fare olayı üretmez; son sürükleme olayından bu kadar sonraki fare hareketi "bitti" demektir */
const DRAG_IDLE_MS = 500

export type MoveRow = {
  id: number
  accountId: number
  folderId: number
  /** konu satırı: taşıma bütün konuyu kapsar */
  threadRoot?: string | null
  threadCount?: number
}
export type RowsById = Map<number, { accountId: number; folderId: number }>

export interface MoveDrag {
  /** tutulan satır: sanal listede ekrandan çıksa da DOM'da kalır */
  rowId: number
  rows: MoveRow[]
  accountId: number
  /** null: yükleniyor */
  folders: FolderInfo[] | null
}

export const toMoveRow = (m: Pick<MoveRow, 'id' | 'accountId' | 'folderId' | 'threadRoot' | 'threadCount'>): MoveRow => ({
  id: m.id, accountId: m.accountId, folderId: m.folderId, threadRoot: m.threadRoot, threadCount: m.threadCount
})

/** Sürükleme görseli ve pencere sayacı: konu satırı içindeki ileti sayısıyla */
export const mailCount = (rows: MoveRow[]): number => rows.reduce((n, r) => n + (r.threadCount ?? 1), 0)

/** Konu satırının taşınacak iletileri: yalnız satırın hesabı ve klasörü (konu Gönderilenler'e de yayılır) */
export function threadMemberIds(row: MoveRow, thread: ThreadMember[]): number[] {
  const ids = thread.filter((m) => m.accountId === row.accountId && m.folderId === row.folderId).map((m) => m.id)
  return ids.includes(row.id) ? ids : [row.id, ...ids]
}

export const isThreadRow = (r: MoveRow): r is MoveRow & { threadRoot: string } => (r.threadCount ?? 1) > 1 && !!r.threadRoot

/** İstemci tarafı yetki: sunucu assertCanManage ile aynı kural (yönetici her hesabı) */
export function canManageAccount(user: SessionUser | null, account: Pick<AccountInfo, 'groupId'> | undefined): boolean {
  if (user?.role === 'admin') return true
  return !!user && account?.groupId != null && user.manageableGroupIds.includes(account.groupId)
}

export const rowMap = (rows: MoveRow[]): Map<number, MoveRow> => new Map(rows.map((r) => [r.id, r]))

/** Satır seçiliyse tüm seçim, değilse yalnız satır */
export function dragIds(rowId: number, checkedIds: number[]): number[] {
  return checkedIds.includes(rowId) ? checkedIds : [rowId]
}

export function sameAccount(ids: number[], rowsById: RowsById): boolean {
  return new Set(ids.map((id) => rowsById.get(id)?.accountId)).size === 1
}

/** Aynı hesap ve en az bir ileti hedeften başka klasörde (zaten orada olanları sunucu atlar) */
export function canDrop(ids: number[], rowsById: RowsById, target: { id: number; accountId: number }): boolean {
  if (!ids.length) return false
  const rows = ids.map((id) => rowsById.get(id))
  if (rows.some((r) => r?.accountId !== target.accountId)) return false
  return rows.some((r) => r?.folderId !== target.id)
}

/** Taşınabilecek klasörler (Taşı penceresi, bağlam menüsü) */
export function moveTargets(folders: FolderInfo[], ids: number[], rowsById: RowsById, accountId: number): FolderInfo[] {
  return folders.filter((f) => canDrop(ids, rowsById, { id: f.id, accountId }))
}

/** Sürükleme yalnız kenar çubuğu yanındayken ve fareyle; dokunmatikte uzun basma bağlam menüsünündür */
export function touchPrimary(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(hover: none) and (pointer: coarse)').matches
}

/** Sürüklemenin bitişini izler. Kaynak satır DOM'dan düşerse (eşitleme listeyi değiştirdi) dragend gelmez:
 *  sürükleme boyunca susan fare olayları yeniden başlayınca bitmiş sayılır. drop kabarcıkta: hedefin işleyicisinden sonra */
export function watchDragEnd(onEnd: () => void, target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window, now: () => number = Date.now): () => void {
  let last = now()
  const alive = (): void => {
    last = now()
  }
  const ended = (): void => onEnd()
  const moved = (): void => {
    if (now() - last > DRAG_IDLE_MS) onEnd()
  }
  target.addEventListener('dragover', alive, true)
  target.addEventListener('dragend', ended, true)
  target.addEventListener('drop', ended)
  target.addEventListener('mousemove', moved, true)
  return () => {
    target.removeEventListener('dragover', alive, true)
    target.removeEventListener('dragend', ended, true)
    target.removeEventListener('drop', ended)
    target.removeEventListener('mousemove', moved, true)
  }
}
