import { AUTOMATION_HOLD_PREF } from '../shared/importTypes'
import type { RuleAction } from '../shared/rpc'
import type { MessageRow } from '../shared/rpc'
import type { OpQueue } from './opQueue'
import type { Queries } from './db/queries'
import { actionLabel, clientPartAfterServerMove, effectAlreadyApplied, evaluateRules, matchesServerMove, orderActions } from './rulesEngine'
import { t } from '../shared/i18n'
import { inProcessLocale } from './sessionLocale'

export interface RuleFiredEvent {
  ruleId: number
  ruleName: string
  accountId: number
  messageId: number
}

/** Bir turda işlenen en fazla ileti; dolu tur dönerse kalanı için yeniden çağrılır */
export const RULES_BATCH = 500

/** Tur sonucu: hatta giden iletiler, "Bildir" eyleminin nedeni (ileti kimliğine göre) ve taranan satır sayısı.
 *  İzlenen klasör satırları süzüldüğü için tur doluluğu `scanned` ile anlaşılır */
export type RulesBatchHandler = (rows: MessageRow[], reasons: ReadonlyMap<number, 'rule' | 'rule-urgent'>, scanned: number) => void

/** onBatch işlem bittikten hemen sonra çağrılır: sonraki adımlar patlasa da işaretlenen parti kaybolmaz */
export async function runRulesForAccount(
  q: Queries,
  opq: OpQueue,
  accountId: number,
  onMatched: (ev: RuleFiredEvent) => void,
  onBatch?: RulesBatchHandler
): Promise<void> {
  const rows = q.pendingRuleMessages(accountId, RULES_BATCH, q.sieveWatchedPaths(accountId))
  if (!rows.length) return

  const rules = q.getActiveRulesFor(accountId)
  // taşımadan sonra aynı kural sunucuda da çalışır: yerelde yalnız "Bildir" kararı sürer, işaret ilerler (geri açılınca geçmiş çalışmaz)
  const held = q.prefGet(AUTOMATION_HOLD_PREF) === '1'
  const fired: RuleFiredEvent[] = []
  // mesaj başına en güçlü bildirim nedeni (acil kural > kural)
  const reasons = new Map<number, 'rule' | 'rule-urgent'>()
  const passed: MessageRow[] = []

  // Atomik: eşleştir + kuyruğa al + logla + işareti kaldır hep birlikte ya da hiç.
  // Çökme = aynı batch bir sonraki turda yeniden işlenir — çift-tetikleme riski yok.
  q.tx(() => {
    for (const row of rows) {
      const inbox = row.folderKind === 'inbox'
      const matched = rules.length ? evaluateRules({ fromAddr: row.fromAddr, subject: row.subject, hasAttachments: row.hasAttachments }, rules) : []
      // izlenen klasörde yalnız sunucunun bir kural için taşıdığı satırın işi var: geri kalanı kullanıcının postasıdır
      if (!inbox && !matchesServerMove(matched, { path: row.folderPath, kind: row.folderKind })) continue
      passed.push(row)
      if (!matched.length) continue
      const ordered = orderActions(matched)
      const actions = inbox ? ordered : clientPartAfterServerMove(ordered)
      const seenRuleIds = new Set<number>()
      const trigger = (ruleId: number, ruleName: string, summary: string): void => {
        q.insertRuleLog({ kind: 'rule', refId: ruleId, accountId, messageId: row.id, summary: `${ruleName} → ${summary}`, ok: true })
        if (!seenRuleIds.has(ruleId)) {
          q.bumpRuleTriggered(ruleId, Date.now())
          seenRuleIds.add(ruleId)
        }
        fired.push({ ruleId, ruleName, accountId, messageId: row.id })
      }
      if (!inbox && !held) {
        const mover = ordered.find((m) => !actions.includes(m))
        if (mover) trigger(mover.ruleId, mover.ruleName, inProcessLocale(() => t('sync.rule.movedOnServer')))
      }
      // güvenlik ağı: taşıma her zaman uygulanır (Gelen Kutusu'ndaysa sunucu yapmamıştır), bayrak etkisi varsa atlanır
      const state = { seen: row.seen, flagged: row.flagged }
      for (const m of actions) {
        if (m.action.type === 'notify' && reasons.get(row.id) !== 'rule-urgent') reasons.set(row.id, m.action.urgent ? 'rule-urgent' : 'rule')
        if (held) continue
        if (!effectAlreadyApplied(state, m.action)) {
          executeMatchedAction(q, accountId, row, m.ruleId, m.ruleName, m.action)
          if (m.action.type === 'markRead') state.seen = true
          if (m.action.type === 'markUnread') state.seen = false
          if (m.action.type === 'flag') state.flagged = true
        }
        trigger(m.ruleId, m.ruleName, inProcessLocale(() => actionLabel(m.action)))
      }
    }
    q.markRulesProcessed(accountId, rows[rows.length - 1].id)
  })

  onBatch?.(passed, reasons, rows.length)
  opq.kick()
  for (const ev of fired) onMatched(ev)
}

function executeMatchedAction(
  q: Queries,
  accountId: number,
  row: MessageRow & { folderPath: string },
  ruleId: number,
  ruleName: string,
  action: RuleAction
): void {
  switch (action.type) {
    case 'markRead':
      q.setSeenLocal([row.id], true)
      q.enqueueOp(accountId, 'store_flags', { folderPath: row.folderPath, uids: [row.uid], seen: true })
      break
    case 'markUnread':
      q.setSeenLocal([row.id], false)
      q.enqueueOp(accountId, 'store_flags', { folderPath: row.folderPath, uids: [row.uid], seen: false })
      break
    case 'flag':
      q.setFlaggedLocal([row.id], true)
      q.enqueueOp(accountId, 'store_flags', { folderPath: row.folderPath, uids: [row.uid], flagged: true })
      break
    case 'archive':
      q.setHidden([row.id], true)
      q.enqueueOp(accountId, 'move_special', { folderPath: row.folderPath, uids: [row.uid], special: 'archive' })
      break
    case 'spam':
      q.setHidden([row.id], true)
      q.enqueueOp(accountId, 'move_special', { folderPath: row.folderPath, uids: [row.uid], special: 'junk' })
      break
    case 'move':
      q.setHidden([row.id], true)
      q.enqueueOp(accountId, 'move_named', { folderPath: row.folderPath, uids: [row.uid], targetFolderName: action.folderName })
      break
    case 'forward':
      // döngü koruması: bizim otomatik ilettiğimiz maili yeniden iletme (A→B→A fırtınası)
      if (row.autoForwarded) break
      q.enqueueOp(accountId, 'forward', { messageId: row.id, to: action.to })
      break
    case 'notify':
      break // bildirim işlem kuyruğuna değil: runRulesForAccount sonunda onBatch ile
    case 'webhook': {
      const acc = q.getAccountRow(accountId)
      const body = {
        event: 'rule_matched',
        firedAt: new Date().toISOString(),
        rule: { id: ruleId, name: ruleName },
        account: { email: acc?.email ?? '', displayName: acc?.display_name ?? null },
        message: {
          id: row.id,
          messageId: row.messageId,
          from: { name: row.fromName, address: row.fromAddr },
          subject: row.subject,
          date: new Date(row.date).toISOString(),
          hasAttachment: row.hasAttachments,
          preview: row.preview ?? null
        }
      }
      q.enqueueOp(accountId, 'call_webhook', { webhookId: action.webhookId, body })
      break
    }
  }
}
