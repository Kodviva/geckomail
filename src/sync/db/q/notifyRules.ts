// Sorgular — Kişiye ait bildirim kuralları ve hesap başına bildirim tercihi (§10.1).
import type { NotifyRule } from '../../../shared/notifyRules'
import type { QCtx } from './ctx'

interface RuleDbRow { id: number; name: string; enabled: number; position: number; groups_json: string; level: NotifyRule['level'] }

function toRule(r: RuleDbRow): NotifyRule {
  return { id: r.id, name: r.name, enabled: r.enabled === 1, position: r.position, groups: JSON.parse(r.groups_json), level: r.level }
}

export function notifyRulesQueries(c: QCtx) {
  const { prep } = c
  return {
    listNotifyRules(userId: number): NotifyRule[] {
      return (prep(`SELECT * FROM notify_rules WHERE user_id = ? ORDER BY position, id`).all(userId) as RuleDbRow[]).map(toRule)
    },

    countNotifyRules(userId: number): number {
      return (prep(`SELECT COUNT(*) AS n FROM notify_rules WHERE user_id = ?`).get(userId) as { n: number }).n
    },

    /** id yoksa sona ekler; varsa yalnız kullanıcının kendi satırını günceller (başkasınınki ya da yok: null) */
    saveNotifyRule(userId: number, r: NotifyRule, now: number): NotifyRule | null {
      return c.db.transaction(() => {
        if (r.id) {
          const res = prep(`UPDATE notify_rules SET name = ?, enabled = ?, groups_json = ?, level = ? WHERE id = ? AND user_id = ?`)
            .run(r.name, r.enabled ? 1 : 0, JSON.stringify(r.groups), r.level, r.id, userId)
          if (res.changes === 0) return null
          return toRule(prep(`SELECT * FROM notify_rules WHERE id = ?`).get(r.id) as RuleDbRow)
        }
        const max = (prep(`SELECT MAX(position) AS m FROM notify_rules WHERE user_id = ?`).get(userId) as { m: number | null }).m
        const id = Number(
          prep(`INSERT INTO notify_rules (user_id, name, enabled, position, groups_json, level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(userId, r.name, r.enabled ? 1 : 0, (max ?? -1) + 1, JSON.stringify(r.groups), r.level, now).lastInsertRowid
        )
        return toRule(prep(`SELECT * FROM notify_rules WHERE id = ?`).get(id) as RuleDbRow)
      })()
    },

    deleteNotifyRule(userId: number, id: number): void {
      prep(`DELETE FROM notify_rules WHERE id = ? AND user_id = ?`).run(id, userId)
    },

    /** Verilen sıra kullanıcının kurallarına uygulanır; kullanıcıya ait olmayan kimlikler yok sayılır, anılmayanlar sona kalır */
    reorderNotifyRules(userId: number, ids: number[]): void {
      c.db.transaction(() => {
        const own = new Set((prep(`SELECT id FROM notify_rules WHERE user_id = ?`).all(userId) as { id: number }[]).map((r) => r.id))
        const rest = (prep(`SELECT id FROM notify_rules WHERE user_id = ? ORDER BY position, id`).all(userId) as { id: number }[]).map((r) => r.id)
        const first = [...new Set(ids)].filter((id) => own.has(id))
        const order = [...first, ...rest.filter((id) => !first.includes(id))]
        order.forEach((id, pos) => prep(`UPDATE notify_rules SET position = ? WHERE id = ? AND user_id = ?`).run(pos, id, userId))
      })()
    },

    /** Hesabı görebilen etkin kullanıcılar: yöneticiler ve hesabın grubunda izni olan üyeler */
    notifyUserIdsFor(accountId: number): number[] {
      return (
        prep(
          `SELECT u.id FROM users u WHERE u.enabled = 1 AND (u.role = 'admin' OR EXISTS (
             SELECT 1 FROM user_group_permissions p JOIN accounts a ON a.group_id = p.group_id
             WHERE p.user_id = u.id AND a.id = ? AND (p.can_view = 1 OR p.can_manage = 1)
           )) ORDER BY u.id`
        ).all(accountId) as { id: number }[]
      ).map((r) => r.id)
    },

    /** Sunucu IDLE sıcak kümesi için: en az bir uygun kullanıcının (etkin; yönetici ya da hesabın grubunu görebilen)
     *  hesabı `off` yapmadığı hesaplar. rule: o kullanıcılardan birinin etkin kuralı var; lastDate: son gelen kutusu iletisi (idx_msgs_account ile aranır, tam tarama yok) */
    notifyEligibleAccounts(): { id: number; rule: boolean; lastDate: number }[] {
      const rows = prep(
        `SELECT a.id AS id,
                EXISTS (SELECT 1 FROM notify_rules r WHERE r.enabled = 1 AND r.user_id IN (
                  SELECT u.id FROM users u WHERE u.enabled = 1 AND (u.role = 'admin' OR EXISTS (
                    SELECT 1 FROM user_group_permissions p WHERE p.user_id = u.id AND p.group_id = a.group_id AND (p.can_view = 1 OR p.can_manage = 1)))
                  AND NOT EXISTS (SELECT 1 FROM notify_account_prefs n WHERE n.user_id = u.id AND n.account_id = a.id AND n.mode = 'off')
                )) AS rule,
                COALESCE((SELECT MAX(m.date) FROM messages m WHERE m.account_id = a.id AND m.folder_kind = 'inbox'), 0) AS lastDate
           FROM accounts a
          WHERE EXISTS (SELECT 1 FROM users u WHERE u.enabled = 1 AND (u.role = 'admin' OR EXISTS (
                  SELECT 1 FROM user_group_permissions p WHERE p.user_id = u.id AND p.group_id = a.group_id AND (p.can_view = 1 OR p.can_manage = 1)))
                AND NOT EXISTS (SELECT 1 FROM notify_account_prefs n WHERE n.user_id = u.id AND n.account_id = a.id AND n.mode = 'off'))
          ORDER BY a.id`
      ).all() as { id: number; rule: number; lastDate: number }[]
      return rows.map((r) => ({ id: r.id, rule: r.rule === 1, lastDate: r.lastDate }))
    },

    listNotifyAccountPrefs(userId: number): { accountId: number; mode: 'on' | 'off' }[] {
      return prep(`SELECT account_id AS accountId, mode FROM notify_account_prefs WHERE user_id = ? ORDER BY account_id`)
        .all(userId) as { accountId: number; mode: 'on' | 'off' }[]
    },

    /** mode null: varsayılana dön (satır silinir) */
    setNotifyAccountPref(userId: number, accountId: number, mode: 'on' | 'off' | null): void {
      if (mode == null) {
        prep(`DELETE FROM notify_account_prefs WHERE user_id = ? AND account_id = ?`).run(userId, accountId)
        return
      }
      prep(`INSERT INTO notify_account_prefs (user_id, account_id, mode) VALUES (?, ?, ?)
            ON CONFLICT(user_id, account_id) DO UPDATE SET mode = excluded.mode`).run(userId, accountId, mode)
    }
  }
}
