// Bildirimden eylem: service worker (POST /api/notify/action), masaüstü ajanı (RPC) ve yerel mod (ana süreç sinyali) aynı çekirdeği
// kullanır. Yetki RPC'deki karşılıklarıyla aynı: okundu markSeen gibi görme, arşiv moveSpecial gibi yönetme ister. İşlem yerelde
// hemen uygulanır, IMAP tarafı mevcut işlem kuyruğundan gider. Çift tıklama ya da iki cihaz aynı işlemi yinelemez.
import type { PushActionId, PushItem } from '../shared/pushTypes'
import type { SessionUser } from '../shared/rpc'
import { sessionUserFromRow, userCanManage, userCanView } from './auth/sessionUser'
import type { Queries } from './db/queries'
import type { RpcHub } from './rpcHub'

export type NotifyActionId = Exclude<PushActionId, 'reply'>

const ACTIONS: readonly PushActionId[] = ['read', 'archive', 'reply']

/** Bildirimde gösterilecek eylemler. Özette ileti yok, kasa bildirimi içerik göstermez: eylem de yok. Yalnız görme izni
 *  olan üyede arşiv her zaman reddedilir, yanıt da yönetme ister: bu düğmeler gösterilmez. */
export function notifyActionsFor(q: Queries, user: SessionUser, item: Pick<PushItem, 'accountId' | 'messageId'>): PushActionId[] {
  const { accountId, messageId } = item
  if (messageId == null || (accountId != null && q.isAccountSecure(accountId))) return []
  const manage = accountId != null && userCanManage(q, user, accountId)
  return ACTIONS.filter((a) => a === 'read' || manage)
}

export function parseNotifyAction(b: Record<string, unknown>): { messageId: number; action: NotifyActionId } | null {
  const { messageId, action } = b
  if (!Number.isSafeInteger(messageId) || (action !== 'read' && action !== 'archive')) return null
  return { messageId: messageId as number, action }
}

/** false: ileti yok, kasa kilitli ya da yetki yok (ayırt edilmez: başka hesabın ileti kimlikleri yoklanamasın) */
export function applyNotifyAction(hub: RpcHub, user: SessionUser, { messageId, action }: { messageId: number; action: NotifyActionId }): boolean {
  const { q, opq } = hub.deps
  const [m] = q.getMessages([messageId])
  if (!m || m.locked) return false // kilitli kasada içerik görünmez: kör eylem yapılmaz, sekme iletiyi açar
  const { accountId, folderPath, uid } = m
  if (!(action === 'read' ? userCanView : userCanManage)(q, user, accountId)) return false
  if (action === 'read') {
    if (m.seen) return true
    q.setSeenLocal([messageId], true)
    q.enqueueOp(accountId, 'store_flags', { folderPath, uids: [uid], seen: true })
  } else {
    if (q.isMessageHidden(messageId)) return true
    q.setHidden([messageId], true)
    q.enqueueOp(accountId, 'move_special', { folderPath, uids: [uid], special: 'archive' })
  }
  opq.kick()
  // açık sekmeler de görsün: eylem o sekmeden gelmedi, iyimser güncelleme yok
  hub.broadcast('messages:changed', { accountId })
  hub.broadcastDebounced('counts:changed', {}, 100)
  return true
}

/** Yerel modda eylemin sahibi. Pencere kapalıyken oturum yoktur: tek kullanıcılı kurulumda o kullanıcı, birden çok kullanıcıda
 *  kimin bastığı bilinmez, null döner (eylem yapılmaz, pencere açılır). Yetkiler her seferinde DB'den. */
export function hostActor(hub: RpcHub): SessionUser | null {
  const { q } = hub.deps
  const id = hub.sessions().find((s) => s.currentUser)?.currentUser?.id
  const rows = q.getUsers().filter((u) => u.enabled)
  const row = id != null ? rows.find((u) => u.id === id) : rows.length === 1 ? rows[0] : undefined
  return row ? sessionUserFromRow(q, row) : null
}
