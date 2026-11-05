// Sorgular — Kurallar, webhook'lar, zamanlanmış görevler, aktivite günlüğü.
import type { RuleAction, RuleCondition, ScheduleType, TriggerActionType } from '../../../shared/rpc'
import { type RuleLogRow, type RuleRow, type ScheduledTriggerRow, type WebhookRow } from './types'
import type { QCtx } from './ctx'

export function automationQueries(c: QCtx) {
  const { db, prep } = c
  return {
    getRuleById(id: number): RuleRow | undefined {
      return prep(`SELECT * FROM rules WHERE id = ?`).get(id) as RuleRow | undefined
    },

    getAllRules(): RuleRow[] {
      return prep(`SELECT * FROM rules ORDER BY name`).all() as RuleRow[]
    },

    // Groups artık mevcut (003), doğrudan post-Groups sorgu varyantı kullanılıyor.
    getActiveRulesFor(accountId: number): RuleRow[] {
      return prep(
        `SELECT * FROM rules WHERE enabled = 1
         AND (account_id IS NULL AND group_id IS NULL
              OR account_id = ?
              OR group_id = (SELECT group_id FROM accounts WHERE id = ?))
         ORDER BY id`
      ).all(accountId, accountId) as RuleRow[]
    },

    insertRule(r: {
      name: string; accountId: number | null; groupId: number | null; conditions: RuleCondition; actions: RuleAction[]; runOnServer?: boolean
    }): number {
      // aynı adla yeniden oluşturulan kuralın eski mezar taşı senkronda onu engellemesin
      const tombs = JSON.parse(c.q.prefGet('sync_deleted_rules') ?? '[]') as { name: string; ts: number }[]
      if (tombs.some((t) => t.name === r.name)) c.q.prefSet('sync_deleted_rules', JSON.stringify(tombs.filter((t) => t.name !== r.name)))
      const res = prep(
        `INSERT INTO rules (name, account_id, group_id, conditions_json, actions_json, run_on_server, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(r.name, r.accountId, r.groupId, JSON.stringify(r.conditions), JSON.stringify(r.actions), r.runOnServer === false ? 0 : 1, Date.now())
      return Number(res.lastInsertRowid)
    },

    updateRuleFields(
      id: number,
      f: Partial<{
        name: string; enabled: number; account_id: number | null; group_id: number | null
        conditions_json: string; actions_json: string; run_on_server: number
      }>
    ): void {
      const keys = Object.keys(f)
      if (!keys.length) return
      db.prepare(`UPDATE rules SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
        ...keys.map((k) => (f as Record<string, unknown>)[k]), id
      )
    },

    deleteRule(id: number): void {
      const r = prep(`SELECT name FROM rules WHERE id = ?`).get(id) as { name: string } | undefined
      prep(`DELETE FROM rules WHERE id = ?`).run(id)
      // cihazlar arası senkron için mezar taşı: diğer cihaz da silsin, eski kopya geri gelmesin (R36)
      if (r) {
        const list = (JSON.parse(c.q.prefGet('sync_deleted_rules') ?? '[]') as { name: string; ts: number }[]).filter(
          (t) => t.name !== r.name && Date.now() - t.ts < 90 * 86_400_000
        )
        list.push({ name: r.name, ts: Date.now() })
        c.q.prefSet('sync_deleted_rules', JSON.stringify(list.slice(-200)))
      }
    },

    deletedRuleTombstones(): { name: string; ts: number }[] {
      return JSON.parse(c.q.prefGet('sync_deleted_rules') ?? '[]') as { name: string; ts: number }[]
    },

    deleteRuleByName(name: string): void {
      prep(`DELETE FROM rules WHERE name = ?`).run(name)
    },

    allWebhooks(): WebhookRow[] {
      return prep(`SELECT * FROM webhooks ORDER BY name`).all() as WebhookRow[]
    },

    /** senkron içe alma: webhook'u adıyla upsert, yerel id'yi döndür */
    upsertWebhookByName(w: { name: string; url: string; secret: string | null; enabled: boolean }): number {
      const ex = prep(`SELECT id FROM webhooks WHERE name = ?`).get(w.name) as { id: number } | undefined
      if (ex) {
        prep(`UPDATE webhooks SET url = ?, secret = ?, enabled = ? WHERE id = ?`).run(w.url, w.secret, w.enabled ? 1 : 0, ex.id)
        return ex.id
      }
      const r = prep(`INSERT INTO webhooks (name, url, secret, enabled, created_at) VALUES (?, ?, ?, ?, ?)`).run(
        w.name, w.url, w.secret, w.enabled ? 1 : 0, Date.now()
      )
      return Number(r.lastInsertRowid)
    },

    bumpRuleTriggered(id: number, ts: number): void {
      prep(`UPDATE rules SET last_triggered_at = ?, trigger_count = trigger_count + 1 WHERE id = ?`).run(ts, id)
    },

    getWebhookById(id: number): WebhookRow | undefined {
      return prep(`SELECT * FROM webhooks WHERE id = ?`).get(id) as WebhookRow | undefined
    },

    getAllWebhooks(): WebhookRow[] {
      return prep(`SELECT * FROM webhooks ORDER BY name`).all() as WebhookRow[]
    },

    insertWebhook(w: { name: string; url: string; secret: string | null }): number {
      const res = prep(`INSERT INTO webhooks (name, url, secret, created_at) VALUES (?, ?, ?, ?)`).run(
        w.name, w.url, w.secret, Date.now()
      )
      return Number(res.lastInsertRowid)
    },

    updateWebhookFields(id: number, f: Partial<{ name: string; url: string; secret: string | null; enabled: number }>): void {
      const keys = Object.keys(f)
      if (!keys.length) return
      db.prepare(`UPDATE webhooks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
        ...keys.map((k) => (f as Record<string, unknown>)[k]), id
      )
    },

    deleteWebhook(id: number): void {
      prep(`DELETE FROM webhooks WHERE id = ?`).run(id)
    },

    touchWebhookDelivered(id: number): void {
      prep(`UPDATE webhooks SET last_delivered_at = ?, last_error = NULL WHERE id = ?`).run(Date.now(), id)
    },

    touchWebhookError(id: number, error: string): void {
      prep(`UPDATE webhooks SET last_error = ? WHERE id = ?`).run(error, id)
    },

    getScheduledTriggerById(id: number): ScheduledTriggerRow | undefined {
      return prep(`SELECT * FROM scheduled_triggers WHERE id = ?`).get(id) as ScheduledTriggerRow | undefined
    },

    getAllScheduledTriggers(): ScheduledTriggerRow[] {
      return prep(`SELECT * FROM scheduled_triggers ORDER BY name`).all() as ScheduledTriggerRow[]
    },

    getDueScheduledTriggers(now: number): ScheduledTriggerRow[] {
      return prep(`SELECT * FROM scheduled_triggers WHERE enabled = 1 AND next_run_at <= ?`).all(now) as ScheduledTriggerRow[]
    },

    insertScheduledTrigger(t: {
      name: string; scheduleType: ScheduleType; scheduleValue: string
      actionType: TriggerActionType; actionPayload: Record<string, unknown>; nextRunAt: number
    }): number {
      const res = prep(
        `INSERT INTO scheduled_triggers (name, schedule_type, schedule_value, action_type, action_payload_json, next_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(t.name, t.scheduleType, t.scheduleValue, t.actionType, JSON.stringify(t.actionPayload), t.nextRunAt, Date.now())
      return Number(res.lastInsertRowid)
    },

    updateScheduledTriggerFields(
      id: number,
      f: Partial<{
        name: string; enabled: number; schedule_type: ScheduleType; schedule_value: string
        action_type: TriggerActionType; action_payload_json: string; next_run_at: number; last_run_at: number
      }>
    ): void {
      const keys = Object.keys(f)
      if (!keys.length) return
      db.prepare(`UPDATE scheduled_triggers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
        ...keys.map((k) => (f as Record<string, unknown>)[k]), id
      )
    },

    deleteScheduledTrigger(id: number): void {
      prep(`DELETE FROM scheduled_triggers WHERE id = ?`).run(id)
    },

    insertRuleLog(l: {
      kind: 'rule' | 'webhook' | 'trigger' | 'vault'; refId: number | null; accountId: number | null; messageId: number | null
      summary: string; ok: boolean; error?: string | null
    }): void {
      prep(
        `INSERT INTO rule_log (ts, kind, ref_id, account_id, message_id, summary, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(Date.now(), l.kind, l.refId, l.accountId, l.messageId, l.summary, l.ok ? 1 : 0, l.error ?? null)
    },

    getRuleLog(limit: number): RuleLogRow[] {
      return prep(`SELECT * FROM rule_log ORDER BY ts DESC LIMIT ?`).all(limit) as RuleLogRow[]
    }
  }
}
