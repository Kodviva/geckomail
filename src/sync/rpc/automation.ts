// RPC — Otomasyon: kurallar, webhook'lar, zamanlanmış tetikleyiciler, kural günlüğü. Yetki kapısı (giriş / yönetici) RpcSession.handle'da; hesap düzeyi kontroller burada.
import { safeFetch, webhookNetPolicy } from '../net/safeFetch'
import { createHmac } from 'crypto'
import type { RuleAction, RuleCondition, ScheduleType, TriggerActionType } from '../../shared/rpc'
import type { RuleRow } from '../db/queries'
import { evaluateRules } from '../rulesEngine'
import { computeNextDailyRun } from '../scheduledTriggers'
import type { RpcSession } from '../rpcSession'
import { type Handler, ruleRowToInfo, triggerRowToInfo, webhookRowToInfo } from './common'
import { t } from '../../shared/i18n'

/** Grup ve genel kuralın hesap listesi burada çözülmez: özeti değişmeyen hesap bağlantı açmaz */
function scheduleSieve(s: RpcSession, accountId: number | null | undefined): void {
  const { sieve } = s.deps
  if (accountId == null) sieve?.scheduleAll()
  else sieve?.schedule(accountId)
}

export const automationHandlers: Record<string, Handler> = {
  async getRules(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    return q.getAllRules().map(ruleRowToInfo)
  },

  async createRule(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const p = params as { name: string; accountId: number | null; groupId: number | null; conditions: RuleCondition; actions: RuleAction[]; runOnServer?: boolean }
    if (!p.name.trim()) throw new Error(t('sync.auto.ruleNameEmpty'))
    const id = q.insertRule(p)
    const rule = q.getRuleById(id)!
    scheduleSieve(s, rule.account_id)
    return ruleRowToInfo(rule)
  },

  async updateRule(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const p = params as { id: number; patch: Partial<{ name: string; enabled: boolean; accountId: number | null; groupId: number | null; conditions: RuleCondition; actions: RuleAction[]; runOnServer: boolean }> }
    const fields: Record<string, unknown> = {}
    if (p.patch.name !== undefined) fields.name = p.patch.name
    if (p.patch.enabled !== undefined) fields.enabled = p.patch.enabled ? 1 : 0
    if ('accountId' in p.patch) fields.account_id = p.patch.accountId
    if ('groupId' in p.patch) fields.group_id = p.patch.groupId
    if (p.patch.conditions) fields.conditions_json = JSON.stringify(p.patch.conditions)
    if (p.patch.actions) fields.actions_json = JSON.stringify(p.patch.actions)
    if (p.patch.runOnServer !== undefined) fields.run_on_server = p.patch.runOnServer ? 1 : 0
    const before = q.getRuleById(p.id)
    q.updateRuleFields(p.id, fields)
    const after = q.getRuleById(p.id)
    scheduleSieve(s, before?.account_id)
    if (after?.account_id !== before?.account_id) scheduleSieve(s, after?.account_id)
    return null
  },

  async deleteRule(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { id } = params as { id: number }
    const rule = q.getRuleById(id)
    q.deleteRule(id)
    if (rule) scheduleSieve(s, rule.account_id)
    return null
  },

  async testRule(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const p = params as { conditions: RuleCondition; accountId: number | null; sampleCount?: number }
    const limit = p.sampleCount ?? 50
    const rows = q.listMessages({ accountIds: p.accountId ? [p.accountId] : null, folderKind: 'inbox', cursor: null, limit })
    const fakeRule: RuleRow = {
      id: 0, name: 'test', enabled: 1, account_id: null, group_id: null,
      conditions_json: JSON.stringify(p.conditions), actions_json: '[]',
      created_at: 0, last_triggered_at: null, trigger_count: 0, run_on_server: 1
    }
    const matches = rows.filter(
      (r) => evaluateRules({ fromAddr: r.fromAddr, subject: r.subject, hasAttachments: r.hasAttachments }, [fakeRule]).length > 0
    )
    return { matchedCount: matches.length, samples: matches.slice(0, 5) }
  },

  async getWebhooks(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    return q.getAllWebhooks().map(webhookRowToInfo)
  },

  async createWebhook(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const p = params as { name: string; url: string; secret: string | null }
    if (!p.name.trim() || !p.url.trim()) throw new Error(t('sync.auto.webhookFieldsEmpty'))
    const id = q.insertWebhook(p)
    return webhookRowToInfo(q.getWebhookById(id)!)
  },

  async updateWebhook(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const p = params as { id: number; patch: Partial<{ name: string; url: string; secret: string | null; enabled: boolean }> }
    const fields: Record<string, unknown> = {}
    if (p.patch.name !== undefined) fields.name = p.patch.name
    if (p.patch.url !== undefined) fields.url = p.patch.url
    if ('secret' in p.patch) fields.secret = p.patch.secret
    if (p.patch.enabled !== undefined) fields.enabled = p.patch.enabled ? 1 : 0
    q.updateWebhookFields(p.id, fields)
    return null
  },

  async deleteWebhook(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { id } = params as { id: number }
    q.deleteWebhook(id)
    return null
  },

  async testWebhook(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { id } = params as { id: number }
    const webhook = q.getWebhookById(id)
    if (!webhook) throw new Error(t('sync.err.webhookNotFound'))
    const body = JSON.stringify({ event: 'test', firedAt: new Date().toISOString(), message: 'GeckoMail test webhook' })
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'GeckoMail-Webhook/1.0' }
      if (webhook.secret) headers['X-GeckoMail-Signature'] = `sha256=${createHmac('sha256', webhook.secret).update(body).digest('hex')}`
      const res = await safeFetch(webhook.url, { method: 'POST', headers, body, timeoutMs: 10_000, deadlineMs: 10_000, net: webhookNetPolicy(s.hub.mode) })
      if (res.ok) q.touchWebhookDelivered(id)
      else q.touchWebhookError(id, `HTTP ${res.status}`)
      return { ok: res.ok, status: res.status }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      q.touchWebhookError(id, msg)
      return { ok: false, error: msg }
    }
  },

  async getScheduledTriggers(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    return q.getAllScheduledTriggers().map(triggerRowToInfo)
  },

  async createScheduledTrigger(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const p = params as { name: string; scheduleType: ScheduleType; scheduleValue: string; actionType: TriggerActionType; actionPayload: Record<string, unknown> }
    if (!p.name.trim()) throw new Error(t('sync.auto.taskNameEmpty'))
    const nextRunAt = p.scheduleType === 'daily' ? computeNextDailyRun(p.scheduleValue, Date.now()) : Date.now() + Math.max(1, Number(p.scheduleValue) || 30) * 60_000
    const id = q.insertScheduledTrigger({ ...p, nextRunAt })
    return triggerRowToInfo(q.getScheduledTriggerById(id)!)
  },

  async updateScheduledTrigger(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const p = params as { id: number; patch: Partial<{ name: string; enabled: boolean; scheduleType: ScheduleType; scheduleValue: string; actionType: TriggerActionType; actionPayload: Record<string, unknown> }> }
    const fields: Record<string, unknown> = {}
    if (p.patch.name !== undefined) fields.name = p.patch.name
    if (p.patch.enabled !== undefined) fields.enabled = p.patch.enabled ? 1 : 0
    if (p.patch.scheduleType !== undefined) fields.schedule_type = p.patch.scheduleType
    if (p.patch.scheduleValue !== undefined) fields.schedule_value = p.patch.scheduleValue
    if (p.patch.actionType !== undefined) fields.action_type = p.patch.actionType
    if (p.patch.actionPayload !== undefined) fields.action_payload_json = JSON.stringify(p.patch.actionPayload)
    // Zamanlama değiştiyse next_run_at'i hemen yeniden hesapla (kullanıcı saati değiştirdiğinde eski zamanda beklemesin)
    if (p.patch.scheduleType !== undefined || p.patch.scheduleValue !== undefined) {
      const current = q.getScheduledTriggerById(p.id)
      const type = p.patch.scheduleType ?? current?.schedule_type ?? 'daily'
      const value = p.patch.scheduleValue ?? current?.schedule_value ?? '09:00'
      fields.next_run_at = type === 'daily' ? computeNextDailyRun(value, Date.now()) : Date.now() + Math.max(1, Number(value) || 30) * 60_000
    }
    q.updateScheduledTriggerFields(p.id, fields)
    return null
  },

  async deleteScheduledTrigger(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { id } = params as { id: number }
    q.deleteScheduledTrigger(id)
    return null
  },

  async getRuleLog(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { limit } = params as { limit: number }
    return q.getRuleLog(Math.min(limit, 500)).map((r) => ({
      id: r.id, ts: r.ts, kind: r.kind, accountId: r.account_id, messageId: r.message_id,
      summary: r.summary, ok: !!r.ok, error: r.error,
      ...(r.kind === 'vault' ? { actor: r.ref_id != null ? (q.getUserById(r.ref_id)?.username ?? null) : null } : {})
    }))
  }
}
