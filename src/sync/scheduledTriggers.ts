import { AUTOMATION_HOLD_PREF } from '../shared/importTypes'
import type { DraftOut, TriggerActionType } from '../shared/rpc'
import type { OpQueue } from './opQueue'
import type { Queries } from './db/queries'
import { buildIncidents } from '../shared/incident'
import { fmtDate, t } from '../shared/i18n'
import { tProcess } from './sessionLocale'

// "HH:MM" + referans an → o andan SONRAKİ ilk gerçekleşme (bugün geçmediyse bugün, yoksa yarın).
// <=, < değil: sweep tam 09:00:00.000'da çalışıp "sıradaki"ni hesaplarsa yarına atlamalı,
// yoksa bir sonraki 60s tick'te anında yeniden tetiklenir.
export function computeNextDailyRun(hhmm: string, fromMs: number): number {
  const [h, m] = hhmm.split(':').map(Number)
  const from = new Date(fromMs)
  const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate(), h, m, 0, 0)
  if (candidate.getTime() <= fromMs) candidate.setDate(candidate.getDate() + 1)
  return candidate.getTime()
}

function computeNextRun(scheduleType: 'daily' | 'interval', scheduleValue: string, fromMs: number): number {
  if (scheduleType === 'daily') return computeNextDailyRun(scheduleValue, fromMs)
  const minutes = Math.max(1, Number(scheduleValue) || 30)
  return fromMs + minutes * 60_000 // driftten, birikmiş-telafi'den değil — Mac kapalıyken geçen zaman telafi edilmez
}

export function runDueScheduledTriggers(q: Queries, opq: OpQueue): void {
  const now = Date.now()
  const held = q.prefGet(AUTOMATION_HOLD_PREF) === '1'
  for (const trg of q.getDueScheduledTriggers(now)) {
    // taşımadan sonra özet ve ping sunucudan gider; sessize alma yalnız bu cihazın bildirim kararıdır, sürer.
    // Görev öne alınır: geri açılınca birikmiş iş bir anda çalışmaz
    if (held && trg.action_type !== 'mute_notifications') {
      q.updateScheduledTriggerFields(trg.id, { next_run_at: computeNextRun(trg.schedule_type, trg.schedule_value, now) })
      continue
    }
    let ok = true
    let errorMsg: string | undefined
    try {
      const payload = JSON.parse(trg.action_payload_json) as Record<string, unknown>
      runTriggerAction(q, opq, trg.id, trg.action_type, payload)
    } catch (e) {
      ok = false
      errorMsg = String((e as Error)?.message ?? e)
    }
    // Hata olsa bile next_run_at ilerletilir — aksi halde bozuk bir görev her 60s'de yeniden dener.
    q.updateScheduledTriggerFields(trg.id, { next_run_at: computeNextRun(trg.schedule_type, trg.schedule_value, now), last_run_at: now })
    q.insertRuleLog({
      kind: 'trigger', refId: trg.id, accountId: null, messageId: null,
      summary: tProcess(ok ? 'sync.trigger.ran' : 'sync.trigger.failed', { name: trg.name }), ok, error: errorMsg
    })
  }
}

function runTriggerAction(
  q: Queries, opq: OpQueue, triggerId: number, actionType: TriggerActionType, payload: Record<string, unknown>
): void {
  switch (actionType) {
    case 'digest_email':
      runDigestEmail(q, opq, payload as { fromAccountId: number; toAddr: string; accountIds: number[] | null })
      break
    case 'webhook_ping':
      runWebhookPing(q, opq, triggerId, payload as { webhookId: number })
      break
    case 'mute_notifications':
      runMuteNotifications(q, payload as { resumeAtHHMM: string })
      break
  }
}

// Basit COUNT'lar + mevcut AccountInfo.status, artık çapraz-hesap olay korelasyonuyla (shared/incident.ts) zenginleştirilmiş.
function runDigestEmail(q: Queries, opq: OpQueue, p: { fromAccountId: number; toAddr: string; accountIds: number[] | null }): void {
  const from = q.getAccountRow(p.fromAccountId)
  if (!from) throw new Error(t('sync.err.senderNotFound'))
  const since = Date.now() - 24 * 3600_000
  const counts = q.newMailCountsSince(since, p.accountIds)
  const infos = q.getAccountInfos()
  const infoById = new Map(infos.map((a) => [a.id, a]))
  const total = counts.reduce((n, c) => n + c.count, 0)
  const top = [...counts].sort((a, b) => b.count - a.count).slice(0, 5)
  const problems = infos.filter((a) => a.enabled && (a.status === 'auth_failed' || a.status === 'unreachable'))
  const totalUnread = infos.reduce((n, a) => n + a.unread, 0)

  let incidentRows = q.getRecentInboxMessages(since, 5000)
  if (p.accountIds && p.accountIds.length) {
    const scope = new Set(p.accountIds)
    incidentRows = incidentRows.filter((r) => scope.has(r.accountId))
  }
  const incidents = buildIncidents(incidentRows, 3).slice(0, 5)

  const lines: string[] = [t('sync.digest.summary', { count: total, accounts: counts.length }), '']
  if (incidents.length) {
    lines.push(t('sync.digest.incidents'))
    for (const inc of incidents)
      lines.push(
        `- ${inc.subjectSample || t('sync.digest.noSubject')}: ${t('sync.digest.incidentLine', { accounts: inc.accountIds.length, messages: inc.messageCount })}`
      )
    lines.push('')
  }
  if (top.length) {
    lines.push(t('sync.digest.busiest'))
    for (const c of top) lines.push(`- ${infoById.get(c.accountId)?.email ?? c.accountId}: ${t('sync.digest.newCount', { count: c.count })}`)
    lines.push('')
  }
  if (problems.length) {
    lines.push(t('sync.digest.problems'))
    for (const a of problems) lines.push(`- ${a.email}: ${a.statusDetail ?? a.status}`)
    lines.push('')
  }
  lines.push(t('sync.digest.totalUnread', { count: totalUnread }))

  const draft: DraftOut = {
    accountId: p.fromAccountId,
    to: p.toAddr,
    subject: t('sync.digest.subject', { date: fmtDate(Date.now()) }),
    text: lines.join('\n')
  }
  q.enqueueOp(p.fromAccountId, 'smtp_send', { draft, attachments: [] })
  opq.kick()
}

function runWebhookPing(q: Queries, opq: OpQueue, triggerId: number, p: { webhookId: number }): void {
  const webhook = q.getWebhookById(p.webhookId)
  if (!webhook) throw new Error(t('sync.err.webhookNotFound'))
  const body = { event: 'scheduled_ping', firedAt: new Date().toISOString(), trigger: { id: triggerId } }
  // account_id=0: hesaba bağlı olmayan zamanlanmış olay için ayrılmış sentinel (FK yok, hiç dereference edilmez)
  q.enqueueOp(0, 'call_webhook', { webhookId: p.webhookId, body })
  opq.kick()
}

// Sadece OS bildirim popup'ını susturur — kural/webhook/senkron çalışmaya devam eder.
// İkinci bir "unmute tetikleyicisi" gerekmez: zaman damgası kendiliğinden geçerliliğini yitirir.
function runMuteNotifications(q: Queries, p: { resumeAtHHMM: string }): void {
  q.prefSet('notifyMutedUntil', String(computeNextDailyRun(p.resumeAtHHMM, Date.now())))
}
