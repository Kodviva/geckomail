// Kullanıcı satırından oturum kimliği: masaüstü girişi (RpcSession) ve web girişi (WebAuth) aynı kuralla kurar.
import type { SessionUser } from '../../shared/rpc'
import type { Queries, UserRow } from '../db/queries'

export function sessionUserFromRow(q: Queries, row: UserRow): SessionUser {
  const permittedGroupIds = row.role === 'admin' ? [] : q.getPermittedGroupIds(row.id)
  const manageableGroupIds = row.role === 'admin' ? [] : q.getManageableGroupIds(row.id)
  return { id: row.id, username: row.username, role: row.role, permittedGroupIds, manageableGroupIds }
}

/** Hesabı görme yetkisi: yönetici hepsini, üye yalnız izinli gruplardaki hesapları görür. RPC oturumu
 *  (assertCanView/canViewAccount) ve HTTP ek uçları aynı kuralı buradan kullanır. */
export function userCanView(q: Queries, u: SessionUser, accountId: number): boolean {
  if (u.role === 'admin') return true
  const acc = q.getAccountRow(accountId)
  return !!acc && acc.group_id != null && u.permittedGroupIds.includes(acc.group_id)
}

/** Hesapta durum değiştirme yetkisi: yönetici hepsinde, üye yalnız yönetme izni olan gruplarda */
export function userCanManage(q: Queries, u: SessionUser, accountId: number): boolean {
  if (u.role === 'admin') return true
  const acc = q.getAccountRow(accountId)
  return !!acc && acc.group_id != null && u.manageableGroupIds.includes(acc.group_id)
}
