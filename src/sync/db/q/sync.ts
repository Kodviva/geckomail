// Sorgular — Cihazlar arası senkron: dışa/içe aktarma.
import type { RuleAction, RuleCondition } from '../../../shared/rpc'
import { type SyncExportAccount, type SyncExportRule } from './types'
import type { QCtx } from './ctx'
import { t } from '../../../shared/i18n'

export function syncQueries(c: QCtx) {
  const { prep } = c
  return {
    // Şifresiz yapı; şifreler rpcServer'da creds Map'inden eklenir. Kimlikler email/isimle taşınır.
    getSyncExport(): {
      accounts: SyncExportAccount[]
      groups: { name: string; color: string }[]
      rules: SyncExportRule[]
    } {
      const accounts = prep(
        `SELECT a.id, a.email, a.display_name AS displayName, a.imap_host AS imapHost, a.imap_port AS imapPort, a.imap_tls AS imapTls,
                a.smtp_host AS smtpHost, a.smtp_port AS smtpPort, a.smtp_tls AS smtpTls, a.color, a.signature,
                a.allow_invalid_certs AS allowInvalidCerts, a.secure, g.name AS groupName,
                a.password_changed_at AS passwordChangedAt, a.auth_type AS authType
         FROM accounts a LEFT JOIN groups g ON g.id = a.group_id ORDER BY a.email`
      ).all() as SyncExportAccount[]
      const groups = prep(`SELECT name, color FROM groups ORDER BY name`).all() as { name: string; color: string }[]
      const rules = prep(
        `SELECT r.name, r.enabled, r.conditions_json, r.actions_json, r.run_on_server, a.email AS accountEmail, g.name AS groupName
         FROM rules r LEFT JOIN accounts a ON a.id = r.account_id LEFT JOIN groups g ON g.id = r.group_id ORDER BY r.name`
      ).all() as SyncExportRule[]
      return { accounts, groups, rules }
    },

    ensureGroupByName(name: string, color: string): number {
      const ex = prep(`SELECT id FROM groups WHERE name = ?`).get(name) as { id: number } | undefined
      return ex ? ex.id : c.q.insertGroup(name, color)
    },

    getAccountIdByEmail(email: string): number | undefined {
      return (prep(`SELECT id FROM accounts WHERE email = ?`).get(email) as { id: number } | undefined)?.id
    },

    // senkron import: hesabı email ile upsert (passwordEnc rpcServer'da safeStorage ile hazırlanır).
    upsertSyncAccount(a: {
      email: string; displayName: string | null; imapHost: string; imapPort: number; imapTls: string
      smtpHost: string; smtpPort: number; smtpTls: string; color: string; signature: string | null
      allowInvalidCerts: boolean; groupId: number | null
      /** eski blob'larda yok → 'password' */
      authType?: string
      // null: şifreye dokunma (yerel daha yeni ya da eşit — remotePasswordWins)
      password: { enc: Buffer; changedAt: number } | null
    }): { id: number; isNew: boolean } {
      const ex = prep(`SELECT id FROM accounts WHERE email = ?`).get(a.email) as { id: number } | undefined
      if (ex) {
        prep(
          `UPDATE accounts SET display_name=?, imap_host=?, imap_port=?, imap_tls=?, smtp_host=?, smtp_port=?, smtp_tls=?,
                  color=?, signature=?, allow_invalid_certs=?, group_id=? WHERE id=?`
        ).run(a.displayName, a.imapHost, a.imapPort, a.imapTls, a.smtpHost, a.smtpPort, a.smtpTls, a.color, a.signature,
          a.allowInvalidCerts ? 1 : 0, a.groupId, ex.id)
        if (a.password) {
          // sır ile türü birlikte: OAuth belirteci şifre sanılmasın (ya da tersi)
          prep(`UPDATE accounts SET password_enc = ?, password_changed_at = ?, auth_type = ? WHERE id = ?`).run(
            a.password.enc, a.password.changedAt, a.authType ?? 'password', ex.id
          )
        }
        return { id: ex.id, isNew: false }
      }
      if (!a.password) throw new Error(t('sync.err.passwordRequired'))
      const r = prep(
        `INSERT INTO accounts (email, display_name, imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls,
                color, signature, allow_invalid_certs, group_id, password_enc, created_at, password_changed_at, auth_type)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(a.email, a.displayName, a.imapHost, a.imapPort, a.imapTls, a.smtpHost, a.smtpPort, a.smtpTls, a.color,
        a.signature, a.allowInvalidCerts ? 1 : 0, a.groupId, a.password.enc, Date.now(), a.password.changedAt, a.authType ?? 'password')
      return { id: Number(r.lastInsertRowid), isNew: true }
    },

    /** Taşıma defteri: yalnız öge anahtarı ve neden kodu, sır yok */
    importLedgerRows(sourceId: string): { itemKey: string; status: 'done' | 'blocked'; detail: string | null; userId: number }[] {
      return prep(`SELECT item_key AS itemKey, status, detail, user_id AS userId FROM import_ledger WHERE source_id = ?`).all(sourceId) as {
        itemKey: string; status: 'done' | 'blocked'; detail: string | null; userId: number
      }[]
    },

    importLedgerSet(r: { sourceId: string; itemKey: string; status: 'done' | 'blocked'; detail: string | null; userId: number; now: number }): void {
      prep(
        `INSERT INTO import_ledger (source_id, item_key, status, detail, user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, item_key) DO UPDATE SET status = excluded.status, detail = excluded.detail, user_id = excluded.user_id, updated_at = excluded.updated_at`
      ).run(r.sourceId, r.itemKey, r.status, r.detail, r.userId, r.now)
    },

    /** Yerelde kalan işler: tamamlanmamış kuyruk ve zamanlanmış gönderimler */
    importStayingCounts(now: number): { scheduled: number; pending: number } {
      const row = prep(
        `SELECT COALESCE(SUM(kind = 'smtp_send' AND not_before > ?), 0) AS scheduled, COUNT(*) AS total FROM op_queue WHERE state IN ('pending', 'running')`
      ).get(now) as { scheduled: number; total: number }
      return { scheduled: row.scheduled, pending: row.total - row.scheduled }
    },

    // senkron import: kuralı isimle upsert.
    upsertSyncRuleByName(r: {
      name: string; enabled: boolean; accountId: number | null; groupId: number | null; conditions: RuleCondition; actions: RuleAction[]
      /** eski paketlerde yok: var olan kuralda yerel değer korunur, yeni kuralda 1 */
      runOnServer?: boolean
    }): void {
      const ex = prep(`SELECT id, run_on_server FROM rules WHERE name = ?`).get(r.name) as { id: number; run_on_server: number } | undefined
      const runOnServer = r.runOnServer === undefined ? (ex?.run_on_server ?? 1) : r.runOnServer ? 1 : 0
      if (ex) {
        prep(`UPDATE rules SET enabled=?, account_id=?, group_id=?, conditions_json=?, actions_json=?, run_on_server=? WHERE id=?`).run(
          r.enabled ? 1 : 0, r.accountId, r.groupId, JSON.stringify(r.conditions), JSON.stringify(r.actions), runOnServer, ex.id
        )
      } else {
        prep(
          `INSERT INTO rules (name, account_id, group_id, conditions_json, actions_json, enabled, run_on_server, created_at) VALUES (?,?,?,?,?,?,?,?)`
        ).run(r.name, r.accountId, r.groupId, JSON.stringify(r.conditions), JSON.stringify(r.actions), r.enabled ? 1 : 0, runOnServer, Date.now())
      }
    }
  }
}
