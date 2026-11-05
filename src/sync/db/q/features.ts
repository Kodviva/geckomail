// Sorgular — Takip hatırlatıcısı (R30), abonelikler (R29), şablonlar (R28).
import type { FollowupInfo, SubscriptionSender, SyncTemplate, TemplateRow } from '../../../shared/rpc'
import { extractUnsubscribeUrl, isOneClickUnsubscribe } from '../../../shared/unsubscribe'
import type { QCtx } from './ctx'
import { t } from '../../../shared/i18n'

export function featuresQueries(c: QCtx) {
  const { db, prep } = c
  return {
    addFollowup(f: { accountId: number; opId: number | null; messageId: string; subject: string | null; to: string | null; dueAt: number; userId?: number | null }, now = Date.now()): number {
      const r = prep(
        `INSERT INTO followups (account_id, op_id, message_id, subject, to_text, created_at, due_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(f.accountId, f.opId, f.messageId, f.subject, f.to, now, f.dueAt, f.userId ?? null)
      return Number(r.lastInsertRowid)
    },

    listFollowups(accountIds: number[] | null): FollowupInfo[] {
      const where = [`f.state IN ('waiting', 'due')`]
      const args: unknown[] = []
      if (accountIds) {
        if (!accountIds.length) return []
        where.push(`f.account_id IN (${accountIds.map(() => '?').join(',')})`)
        args.push(...accountIds)
      }
      return (
        prep(
          `SELECT f.*, (o.id IS NOT NULL) AS pending FROM followups f
           LEFT JOIN op_queue o ON o.id = f.op_id AND o.state IN ('pending', 'running') AND o.kind = 'smtp_send' AND o.created_at <= f.created_at
           WHERE ${where.join(' AND ')} ORDER BY f.state = 'due' DESC, f.due_at ASC`
        ).all(...args) as Record<string, unknown>[]
      ).map((r) => ({
        id: r.id as number,
        accountId: r.account_id as number,
        messageId: r.message_id as string,
        subject: (r.subject as string | null) ?? null,
        to: (r.to_text as string | null) ?? null,
        createdAt: r.created_at as number,
        dueAt: r.due_at as number,
        state: r.state as 'waiting' | 'due',
        pendingSend: !!r.pending
      }))
    },

    getFollowup(id: number): { id: number; account_id: number } | undefined {
      return prep(`SELECT id, account_id FROM followups WHERE id = ?`).get(id) as { id: number; account_id: number } | undefined
    },

    closeFollowup(id: number, now = Date.now()): void {
      prep(`UPDATE followups SET state = 'dismissed', closed_at = ? WHERE id = ?`).run(now, id)
    },

    snoozeFollowup(id: number, until: number): void {
      prep(`UPDATE followups SET state = 'waiting', due_at = ?, notified_at = NULL WHERE id = ? AND state IN ('waiting', 'due')`).run(until, id)
    },

    /** gönderim iptal edildi: takip de düşer */
    deleteFollowupsForOp(opId: number): void {
      // işlem satırı silinmeden çağrılır: op_queue.id geri dönüşümlü, eski işlemin takibi silinmesin
      prep(`DELETE FROM followups WHERE op_id = ? AND created_at >= (SELECT created_at FROM op_queue WHERE id = ?)`).run(opId, opId)
    },

    /** Yanıt gelen takipleri kapatır: yanıt = bizim Message-ID'mize In-Reply-To ya da aynı konuşmada,
     *  gönderimden sonra, hesabın kendisinden olmayan bir mail. Kapatılan sayısı. */
    resolveRepliedFollowups(now = Date.now()): number {
      const r = prep(
        `UPDATE followups SET state = 'replied', closed_at = ?
         WHERE state IN ('waiting', 'due') AND EXISTS (
           SELECT 1 FROM messages r
           WHERE r.account_id = followups.account_id AND r.folder_kind NOT IN ('sent', 'trash', 'junk') AND r.date > followups.created_at
             AND LOWER(COALESCE(r.from_addr, '')) != (SELECT LOWER(email) FROM accounts WHERE id = followups.account_id)
             AND (r.in_reply_to = followups.message_id
                  OR r.thread_root = followups.message_id
                  OR r.thread_root IN (SELECT s.thread_root FROM messages s WHERE s.account_id = followups.account_id AND s.message_id = followups.message_id))
         )`
      ).run(now)
      return r.changes
    },

    /** Süresi dolan (ve gönderimi tamamlanmış) takipleri 'due' yapar; yeni dolanları döndürür. notified_at
     *  bildirim verilince yazılır (markFollowupNotified): sessiz saatte dolan takip kaybolmasın */
    markDueFollowups(now = Date.now()): { id: number; accountId: number; subject: string | null; to: string | null; userId: number | null }[] {
      const rows = prep(
        `SELECT f.id, f.account_id, f.subject, f.to_text, f.user_id FROM followups f
         WHERE f.state = 'waiting' AND f.due_at <= ?
           AND NOT EXISTS (SELECT 1 FROM op_queue o WHERE o.id = f.op_id AND o.state IN ('pending', 'running', 'failed')
                             AND o.kind = 'smtp_send' AND o.created_at <= f.created_at)`
      ).all(now) as { id: number; account_id: number; subject: string | null; to_text: string | null; user_id: number | null }[]
      const upd = prep(`UPDATE followups SET state = 'due' WHERE id = ?`)
      for (const r of rows) upd.run(r.id)
      return rows.map((r) => ({ id: r.id, accountId: r.account_id, subject: r.subject, to: r.to_text, userId: r.user_id }))
    },

    /** Süresi dolmuş, bildirimi henüz verilmemiş takipler */
    followupsToNotify(): { id: number; accountId: number; subject: string | null; to: string | null; userId: number | null }[] {
      return prep(
        `SELECT id, account_id AS accountId, subject, to_text AS "to", user_id AS userId FROM followups WHERE state = 'due' AND notified_at IS NULL ORDER BY id`
      ).all() as { id: number; accountId: number; subject: string | null; to: string | null; userId: number | null }[]
    },

    markFollowupNotified(id: number, now = Date.now()): void {
      prep(`UPDATE followups SET notified_at = ? WHERE id = ?`).run(now, id)
    },

    subscriptionSenders(accountIds: number[] | null, since: number, limit = 300): SubscriptionSender[] {
      const where = ['m.enc = 0', 'm.hidden = 0', 'm.list_unsubscribe IS NOT NULL', "m.from_addr IS NOT NULL", "m.from_addr != ''", 'm.date > ?']
      const args: unknown[] = [since]
      if (accountIds && accountIds.length) {
        where.push(`m.account_id IN (${accountIds.map(() => '?').join(',')})`)
        args.push(...accountIds)
      }
      args.push(limit)
      const rows = prep(
        `SELECT LOWER(m.from_addr) AS addr, MAX(m.from_name) AS name, COUNT(*) AS cnt, SUM(m.seen = 0) AS unread, MAX(m.date) AS last,
                COUNT(DISTINCT m.account_id) AS accts,
                MAX(CASE WHEN m.list_unsubscribe_post LIKE '%one-click%' AND m.list_unsubscribe LIKE '%<http%' THEN 1 ELSE 0 END) AS one_click,
                u.ts AS u_ts, u.ok AS u_ok, u.error AS u_error,
                SUM(CASE WHEN u.ts IS NOT NULL AND m.date > u.ts THEN 1 ELSE 0 END) AS since_u
         FROM messages m LEFT JOIN unsubscribes u ON u.addr = LOWER(m.from_addr)
         WHERE ${where.join(' AND ')}
         GROUP BY LOWER(m.from_addr) ORDER BY cnt DESC LIMIT ?`
      ).all(...args) as Record<string, unknown>[]
      return rows.map((r) => ({
        addr: r.addr as string,
        name: (r.name as string | null) || null,
        count: r.cnt as number,
        unread: r.unread as number,
        lastDate: r.last as number,
        accounts: r.accts as number,
        oneClick: !!r.one_click,
        unsubscribedAt: r.u_ok ? (r.u_ts as number) : null,
        unsubscribeError: r.u_ok === 0 ? ((r.u_error as string | null) ?? t('sync.unsub.failed')) : null,
        sinceUnsubscribed: r.u_ok ? (r.since_u as number) : 0
      }))
    },

    /** Göndericinin tek-tık destekli en yeni mesajı (izinli hesaplarda) */
    latestOneClickFrom(addr: string, accountIds: number[] | null): number | null {
      const where = ['enc = 0', 'LOWER(from_addr) = ?', 'list_unsubscribe IS NOT NULL']
      const args: unknown[] = [addr.toLowerCase()]
      if (accountIds && accountIds.length) {
        where.push(`account_id IN (${accountIds.map(() => '?').join(',')})`)
        args.push(...accountIds)
      }
      const rows = prep(`SELECT id, list_unsubscribe, list_unsubscribe_post FROM messages WHERE ${where.join(' AND ')} ORDER BY date DESC LIMIT 20`).all(
        ...args
      ) as { id: number; list_unsubscribe: string | null; list_unsubscribe_post: string | null }[]
      return rows.find((r) => isOneClickUnsubscribe(r.list_unsubscribe, r.list_unsubscribe_post))?.id ?? null
    },

    recordUnsubscribe(addr: string, ok: boolean, error: string | null, ts = Date.now()): void {
      prep(
        `INSERT INTO unsubscribes (addr, ts, ok, error) VALUES (?, ?, ?, ?)
         ON CONFLICT(addr) DO UPDATE SET ts = excluded.ts, ok = excluded.ok, error = excluded.error`
      ).run(addr.toLowerCase(), ts, ok ? 1 : 0, error)
    },

    // renderer'a asla ham header gitmez — yalnızca RPC handler'ın POST atacağı URL için
    getUnsubscribeUrl(id: number): string | null {
      const r = prep(`SELECT list_unsubscribe, list_unsubscribe_post FROM messages WHERE id = ?`).get(id) as
        | { list_unsubscribe: string | null; list_unsubscribe_post: string | null }
        | undefined
      if (!r || !isOneClickUnsubscribe(r.list_unsubscribe, r.list_unsubscribe_post)) return null
      return extractUnsubscribeUrl(r.list_unsubscribe)
    },

    /** paylaşılanlar + kullanıcının kendi şablonları; aynı adda kişisel şablon paylaşılanı gizler (ad tekil) */
    listTemplates(userId: number): TemplateRow[] {
      return (
        prep(
          `SELECT name, subject, body, updated_at AS updatedAt, owner_user_id IS NULL AS shared FROM templates t
           WHERE deleted_at IS NULL AND (owner_user_id = ? OR (owner_user_id IS NULL AND NOT EXISTS (
             SELECT 1 FROM templates p WHERE p.owner_user_id = ? AND p.name = t.name AND p.deleted_at IS NULL)))
           ORDER BY name COLLATE NOCASE`
        ).all(userId, userId) as (Omit<TemplateRow, 'shared'> & { shared: number })[]
      ).map((r) => ({ ...r, shared: !!r.shared }))
    },

    /** shared → owner NULL, userId kullanılmaz (null verilir); kişiselde userId zorunlu.
     *  Yetki kontrolü RPC'de: paylaşılanı yalnız admin yazar */
    saveTemplate(t: { name: string; subject: string | null; body: string; shared: boolean }, userId: number | null, now = Date.now()): void {
      if (t.shared || userId == null) {
        prep(
          `INSERT INTO templates (owner_user_id, name, subject, body, updated_at, deleted_at) VALUES (NULL, ?, ?, ?, ?, NULL)
           ON CONFLICT(name) WHERE owner_user_id IS NULL
           DO UPDATE SET subject = excluded.subject, body = excluded.body, updated_at = excluded.updated_at, deleted_at = NULL`
        ).run(t.name, t.subject, t.body, now)
      } else {
        prep(
          `INSERT INTO templates (owner_user_id, name, subject, body, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)
           ON CONFLICT(owner_user_id, name)
           DO UPDATE SET subject = excluded.subject, body = excluded.body, updated_at = excluded.updated_at, deleted_at = NULL`
        ).run(userId, t.name, t.subject, t.body, now)
      }
    },

    /** userId null = paylaşılan şablon (mezar taşı bırakır: senkronda diğer cihazdan geri gelmesin);
     *  kişisel şablon senkrona girmediği için doğrudan silinir */
    deleteTemplate(name: string, userId: number | null, now = Date.now()): void {
      if (userId == null) {
        prep(`UPDATE templates SET deleted_at = ?, updated_at = ?, body = '', subject = NULL WHERE owner_user_id IS NULL AND name = ?`).run(now, now, name)
      } else {
        prep(`DELETE FROM templates WHERE owner_user_id = ? AND name = ?`).run(userId, name)
      }
    },

    /** RPC silme kararı için: adın kişisel / paylaşılan canlı kopyası var mı */
    templateExists(name: string, userId: number | null): boolean {
      const r =
        userId == null
          ? prep(`SELECT 1 FROM templates WHERE owner_user_id IS NULL AND name = ? AND deleted_at IS NULL`).get(name)
          : prep(`SELECT 1 FROM templates WHERE owner_user_id = ? AND name = ? AND deleted_at IS NULL`).get(userId, name)
      return !!r
    },

    /** senkron: yalnız paylaşılanlar — canlılar + 90 günden yeni mezar taşları */
    templatesForSync(now = Date.now()): SyncTemplate[] {
      prep(`DELETE FROM templates WHERE deleted_at IS NOT NULL AND deleted_at < ?`).run(now - 90 * 86_400_000)
      return (
        prep(`SELECT name, subject, body, updated_at, deleted_at FROM templates WHERE owner_user_id IS NULL ORDER BY name`).all() as {
          name: string; subject: string | null; body: string; updated_at: number; deleted_at: number | null
        }[]
      ).map((r) => ({ name: r.name, subject: r.subject, body: r.body, updatedAt: r.updated_at, deleted: r.deleted_at !== null }))
    },

    /** senkron içe alma (yalnız paylaşılanlar): ad başına son yazan kazanır; döndürür: uygulanan sayısı */
    mergeSyncTemplates(list: SyncTemplate[]): number {
      let applied = 0
      db.transaction(() => {
        for (const t of list) {
          const local = prep(`SELECT updated_at FROM templates WHERE owner_user_id IS NULL AND name = ?`).get(t.name) as { updated_at: number } | undefined
          if (local && local.updated_at >= t.updatedAt) continue
          if (t.deleted) {
            if (!local) {
              prep(`INSERT INTO templates (owner_user_id, name, subject, body, updated_at, deleted_at) VALUES (NULL, ?, NULL, '', ?, ?)`).run(t.name, t.updatedAt, t.updatedAt)
            } else c.q.deleteTemplate(t.name, null, t.updatedAt)
          } else c.q.saveTemplate({ name: t.name, subject: t.subject, body: t.body, shared: true }, null, t.updatedAt)
          applied++
        }
      })()
      return applied
    }
  }
}
