// Sorgular — Kullanıcılar, gruplar, izinler.
import type { UserRole } from '../../../shared/rpc'
import { type GroupRow, type UserRow } from './types'
import type { QCtx } from './ctx'

export function authQueries(c: QCtx) {
  const { db, prep } = c
  return {
    userCount(): number {
      const r = prep(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }
      return r.n
    },

    getUserByUsername(username: string): UserRow | undefined {
      return prep(`SELECT * FROM users WHERE username = ?`).get(username) as UserRow | undefined
    },

    getUserById(id: number): UserRow | undefined {
      return prep(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined
    },

    insertUser(u: { username: string; passwordHash: string; role: UserRole }): number {
      const r = prep(`INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)`).run(
        u.username, u.passwordHash, u.role, Date.now()
      )
      return Number(r.lastInsertRowid)
    },

    touchLastLogin(id: number): void {
      prep(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(Date.now(), id)
    },

    getUsers(): UserRow[] {
      return prep(`SELECT * FROM users ORDER BY username`).all() as UserRow[]
    },

    updateUserFields(id: number, f: Partial<{ role: UserRole; enabled: number; password_hash: string }>): void {
      const keys = Object.keys(f)
      if (!keys.length) return
      db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
        ...keys.map((k) => (f as Record<string, unknown>)[k]), id
      )
    },

    deleteUser(id: number): void {
      prep(`DELETE FROM users WHERE id = ?`).run(id)
    },

    countEnabledAdmins(excludingUserId?: number): number {
      const r = prep(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND enabled = 1 AND id != ?`).get(
        excludingUserId ?? -1
      ) as { n: number }
      return r.n
    },

    getPermittedGroupIds(userId: number): number[] {
      return (
        prep(`SELECT group_id FROM user_group_permissions WHERE user_id = ? AND (can_view = 1 OR can_manage = 1)`).all(
          userId
        ) as { group_id: number }[]
      ).map((r) => r.group_id)
    },

    getManageableGroupIds(userId: number): number[] {
      return (
        prep(`SELECT group_id FROM user_group_permissions WHERE user_id = ? AND can_manage = 1`).all(userId) as {
          group_id: number
        }[]
      ).map((r) => r.group_id)
    },

    getUserPermissions(userId: number): { groupId: number; groupName: string; canView: boolean; canManage: boolean }[] {
      const rows = prep(
        `SELECT p.group_id, g.name AS group_name, p.can_view, p.can_manage
         FROM user_group_permissions p JOIN groups g ON g.id = p.group_id WHERE p.user_id = ? ORDER BY g.name`
      ).all(userId) as { group_id: number; group_name: string; can_view: number; can_manage: number }[]
      return rows.map((r) => ({
        groupId: r.group_id, groupName: r.group_name, canView: !!r.can_view, canManage: !!r.can_manage
      }))
    },

    setGroupPermission(userId: number, groupId: number, canView: boolean, canManage: boolean): void {
      if (!canView && !canManage) {
        prep(`DELETE FROM user_group_permissions WHERE user_id = ? AND group_id = ?`).run(userId, groupId)
        return
      }
      prep(
        `INSERT INTO user_group_permissions (user_id, group_id, can_view, can_manage) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, group_id) DO UPDATE SET can_view = excluded.can_view, can_manage = excluded.can_manage`
      ).run(userId, groupId, canView ? 1 : 0, canManage ? 1 : 0)
    },

    getGroups(): (GroupRow & { account_count: number })[] {
      return prep(
        `SELECT g.*, (SELECT COUNT(*) FROM accounts a WHERE a.group_id = g.id) AS account_count FROM groups g ORDER BY g.name`
      ).all() as (GroupRow & { account_count: number })[]
    },

    getGroupById(id: number): GroupRow | undefined {
      return prep(`SELECT * FROM groups WHERE id = ?`).get(id) as GroupRow | undefined
    },

    insertGroup(name: string, color: string): number {
      const r = prep(`INSERT INTO groups (name, color, created_at) VALUES (?, ?, ?)`).run(name, color, Date.now())
      return Number(r.lastInsertRowid)
    },

    updateGroupFields(id: number, f: Partial<{ name: string; color: string }>): void {
      const keys = Object.keys(f)
      if (!keys.length) return
      db.prepare(`UPDATE groups SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
        ...keys.map((k) => (f as Record<string, unknown>)[k]), id
      )
    },

    deleteGroup(id: number): void {
      prep(`DELETE FROM groups WHERE id = ?`).run(id)
    },

    setAccountGroup(accountId: number, groupId: number | null): void {
      prep(`UPDATE accounts SET group_id = ? WHERE id = ?`).run(groupId, accountId)
    },

    getAccountIdsForGroups(groupIds: number[]): number[] {
      if (!groupIds.length) return []
      return (
        prep(`SELECT id FROM accounts WHERE group_id IN (${groupIds.map(() => '?').join(',')})`).all(
          ...groupIds
        ) as { id: number }[]
      ).map((r) => r.id)
    }
  }
}
