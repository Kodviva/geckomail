// RPC handler'larının ortak türü, sınırları ve satır→bilgi dönüştürücüleri.
import { readdirSync, rmSync } from 'fs'
import { join } from 'path'
import type {
  RuleAction, RuleCondition, RuleInfo, ScheduledTriggerInfo, ScheduleType, TriggerActionType, WebhookInfo
} from '../../shared/rpc'
import { AUTOMATION_HOLD_PREF } from '../../shared/importTypes'
import type { RuleRow } from '../db/queries'
import type { RpcSession } from '../rpcSession'

/** Tek RPC yöntemi: sunucu bağlamı (deps, oturum, yetki yardımcıları, yayın) + ham parametreler */
export type Handler = (s: RpcSession, params: unknown) => Promise<unknown>

/** getPrefs/tanı paketiyle renderer'a dönebilen tercihler */
export const READABLE_PREFS = new Set([
  'backfillTarget', 'notifyScope', 'pollCadenceSec', 'trustedServer', 'vault_autolock', 'autoBackup', 'auto_backup_last',
  'sync_anchor_account', 'sync_auto', 'sync_last_pull', 'sync_last_push', 'bodyPrefetch',
  'notifyQuiet', 'notifyQuietStart', 'notifyQuietEnd', 'notifyVip', 'authBanPerDay', 'require2fa', AUTOMATION_HOLD_PREF, 'smimeRevocation'
])

/** Ayarlar ekranının yazabildiği tercihler: iç durum (watermark, biyometrik/senkron blob'ları,
 *  klasör önbelleği) renderer'dan ezilemez */
export const WRITABLE_PREFS = new Set([
  'backfillTarget', 'notifyScope', 'pollCadenceSec', 'trustedServer', 'vault_autolock', 'autoBackup', 'bodyPrefetch',
  'notifyQuiet', 'notifyQuietStart', 'notifyQuietEnd', 'notifyVip', 'authBanPerDay', 'require2fa', AUTOMATION_HOLD_PREF, 'smimeRevocation'
])

/** Kişiye ait tercihler (§10.1): user_prefs'te kullanıcı başına; setPrefs (genel) bunları reddeder,
 *  setMyPrefs ile her girişli kullanıcı kendi değerini yazar */
export const USER_PREF_KEYS = new Set(['notifyScope', 'notifyQuiet', 'notifyQuietStart', 'notifyQuietEnd', 'notifyVip'])

/** Giden kutusu dosyasının adı hesapla başlar: kasa kilitliyken mühürlü op'un yolu okunamaz, hesap silinince dosyalar yine bulunur */
export const outboxFileName = (accountId: number, name: string): string => `${accountId}-${name}`

export function removeAccountOutbox(dir: string, accountId: number): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return // giden kutusu hiç oluşmamış
  }
  for (const n of names) if (n.startsWith(outboxFileName(accountId, ''))) rmSync(join(dir, n), { force: true })
}

export const INLINE_DATA_LIMIT = 8_000_000
export const OUTBOX_TOTAL_LIMIT = 25_000_000 // ek toplamı ~25MB — paylaşımlı host SMTP limiti
export const UNDO_WINDOW_MS = 6000

export function ruleRowToInfo(r: RuleRow): RuleInfo {
  return {
    id: r.id, name: r.name, enabled: !!r.enabled, accountId: r.account_id, groupId: r.group_id,
    conditions: JSON.parse(r.conditions_json) as RuleCondition, actions: JSON.parse(r.actions_json) as RuleAction[],
    createdAt: r.created_at, lastTriggeredAt: r.last_triggered_at, triggerCount: r.trigger_count,
    runOnServer: !!r.run_on_server
  }
}

export function webhookRowToInfo(r: { id: number; name: string; url: string; secret: string | null; enabled: number; last_delivered_at: number | null; last_error: string | null }): WebhookInfo {
  return {
    id: r.id, name: r.name, url: r.url, hasSecret: !!r.secret, enabled: !!r.enabled,
    lastDeliveredAt: r.last_delivered_at, lastError: r.last_error
  }
}

export function triggerRowToInfo(r: {
  id: number; name: string; enabled: number; schedule_type: ScheduleType; schedule_value: string
  action_type: TriggerActionType; action_payload_json: string; next_run_at: number; last_run_at: number | null
}): ScheduledTriggerInfo {
  return {
    id: r.id, name: r.name, enabled: !!r.enabled, scheduleType: r.schedule_type, scheduleValue: r.schedule_value,
    actionType: r.action_type, actionPayload: JSON.parse(r.action_payload_json), nextRunAt: r.next_run_at, lastRunAt: r.last_run_at
  }
}
