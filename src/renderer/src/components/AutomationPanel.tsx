import { useEffect } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import type { RuleInfo, WebhookInfo, ScheduledTriggerInfo, RuleLogInfo } from '../../../shared/rpc'
import type { RulePlacementInfo } from '../../../shared/sieve'
import { placementBadge, reasonKey } from '../sieveView'
import Modal from './Modal'
import { t, fmtDateTime } from '../../../shared/i18n'

function conditionSummary(r: RuleInfo): string {
  const parts: string[] = []
  if (r.conditions.senderContains) parts.push(t('auto.cond.sender', { value: r.conditions.senderContains }))
  if (r.conditions.domainEquals) parts.push(t('auto.cond.domain', { value: r.conditions.domainEquals }))
  if (r.conditions.subjectContains) parts.push(t('auto.cond.subject', { value: r.conditions.subjectContains }))
  if (r.conditions.hasAttachment !== undefined) parts.push(t(r.conditions.hasAttachment ? 'auto.cond.hasAttachment' : 'auto.cond.noAttachment'))
  return parts.length ? parts.join(', ') : t('auto.cond.any')
}

function actionSummary(r: RuleInfo): string {
  const labels: Record<string, string> = {
    move: t('auto.actShort.move'),
    archive: t('auto.actShort.archive'),
    spam: t('auto.actShort.spam'),
    markRead: t('auto.actShort.markRead'),
    markUnread: t('auto.actShort.markUnread'),
    flag: t('auto.actShort.flag'),
    forward: t('auto.actShort.forward'),
    webhook: t('auto.actShort.webhook'),
    notify: t('auto.actShort.notify')
  }
  return r.actions.map((a) => labels[a.type] ?? a.type).join(' + ') || t('auto.actShort.none')
}

function scheduleSummary(tr: ScheduledTriggerInfo): string {
  return tr.scheduleType === 'daily'
    ? t('auto.schedule.daily', { time: tr.scheduleValue })
    : t('auto.schedule.interval', { minutes: tr.scheduleValue })
}

function actionTypeLabel(type: string): string {
  switch (type) {
    case 'digest_email':
      return t('auto.trigAction.digestEmail')
    case 'webhook_ping':
      return t('auto.trigAction.webhookPing')
    case 'mute_notifications':
      return t('auto.trigAction.muteNotifications')
    default:
      return type
  }
}

function PlacementBadge({ p }: { p: RulePlacementInfo | undefined }) {
  if (!p) return null
  const { kind, labelKey } = placementBadge(p)
  const why = [...new Set(p.reasons.map((r) => t(reasonKey(r))))].join(' · ')
  return <span className={`sieve-badge ${kind}`} data-testid="rule-placement" title={why || undefined}>{t(labelKey)}</span>
}

function RulesTab() {
  const rules = useStore((s) => s.rules)
  const placements = useStore((s) => s.rulePlacements)
  const setEditRule = useStore((s) => s.setEditRule)
  const toast = useStore((s) => s.toast)
  const refreshRules = useStore((s) => s.refreshRules)

  const remove = async (r: RuleInfo) => {
    if (!window.confirm(t('auto.rules.confirmDelete', { name: r.name }))) return
    try {
      await rpc.call('deleteRule', { id: r.id })
      await refreshRules()
    } catch (e) {
      toast(String((e as Error).message))
    }
  }

  return (
    <>
      <div className="problem-list">
        {rules.map((r) => (
          <div key={r.id} className={`problem-row ${r.enabled ? '' : 'disabled'}`}>
            <svg className={`eye ${r.enabled ? 'eye-ok' : 'eye-off'}`} viewBox="0 0 10 10">
              <circle cx="5" cy="5" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="5.8" cy="4.2" r="1.5" fill="currentColor" />
            </svg>
            <div className="problem-info">
              <b>{r.name} <PlacementBadge p={placements.find((p) => p.ruleId === r.id)} /></b>
              <span className="rule-summary">
                {conditionSummary(r)} → {actionSummary(r)}
              </span>
              <small>
                {t('auto.rules.triggered', { count: r.triggerCount })}
                {r.lastTriggeredAt ? t('auto.rules.lastTriggered', { time: fmtDateTime(r.lastTriggeredAt) }) : ''}
              </small>
            </div>
            <button onClick={() => setEditRule(r.id)} aria-label={t('action.edit')} title={t('action.edit')}><svg className="icon sm"><use href="#i-pencil" /></svg></button>
            <button className="danger" onClick={() => void remove(r)} aria-label={t('action.delete')} title={t('action.delete')}>
              <svg className="icon sm"><use href="#i-trash" /></svg>
            </button>
          </div>
        ))}
        {!rules.length && <div className="empty-note">{t('auto.rules.empty')}</div>}
      </div>
      <div className="modal-foot">
        <button onClick={() => setEditRule('new')}><svg className="icon sm"><use href="#i-plus" /></svg> {t('auto.rules.new')}</button>
      </div>
    </>
  )
}

function WebhooksTab() {
  const webhooks = useStore((s) => s.webhooks)
  const setEditWebhook = useStore((s) => s.setEditWebhook)
  const toast = useStore((s) => s.toast)
  const refreshWebhooks = useStore((s) => s.refreshWebhooks)

  const remove = async (w: WebhookInfo) => {
    if (!window.confirm(t('auto.webhooks.confirmDelete', { name: w.name }))) return
    try {
      await rpc.call('deleteWebhook', { id: w.id })
      await refreshWebhooks()
    } catch (e) {
      toast(String((e as Error).message))
    }
  }

  return (
    <>
      <div className="problem-list">
        {webhooks.map((w) => (
          <div key={w.id} className={`problem-row ${w.enabled ? '' : 'disabled'}`}>
            <svg className={`eye ${w.lastError ? 'eye-err' : 'eye-ok'}`} viewBox="0 0 10 10">
              <circle cx="5" cy="5" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="5.8" cy="4.2" r="1.5" fill="currentColor" />
            </svg>
            <div className="problem-info">
              <b>{w.name}</b>
              <span className="rule-summary mono">{w.url}</span>
              {w.lastError ? (
                <small className="err-text">{t('auto.webhooks.lastError', { error: w.lastError })}</small>
              ) : (
                <small>
                  {w.lastDeliveredAt
                    ? t('auto.webhooks.lastDelivered', { time: fmtDateTime(w.lastDeliveredAt) })
                    : t('auto.webhooks.neverTriggered')}
                </small>
              )}
            </div>
            <button onClick={() => setEditWebhook(w.id)} aria-label={t('action.edit')} title={t('action.edit')}><svg className="icon sm"><use href="#i-pencil" /></svg></button>
            <button className="danger" onClick={() => void remove(w)} aria-label={t('action.delete')} title={t('action.delete')}>
              <svg className="icon sm"><use href="#i-trash" /></svg>
            </button>
          </div>
        ))}
        {!webhooks.length && <div className="empty-note">{t('auto.webhooks.empty')}</div>}
      </div>
      <div className="modal-foot">
        <button onClick={() => setEditWebhook('new')}><svg className="icon sm"><use href="#i-plus" /></svg> {t('auto.webhooks.new')}</button>
      </div>
    </>
  )
}

function TriggersTab() {
  const triggers = useStore((s) => s.scheduledTriggers)
  const setEditTrigger = useStore((s) => s.setEditTrigger)
  const toast = useStore((s) => s.toast)
  const refreshScheduledTriggers = useStore((s) => s.refreshScheduledTriggers)

  const remove = async (tr: ScheduledTriggerInfo) => {
    if (!window.confirm(t('auto.triggers.confirmDelete', { name: tr.name }))) return
    try {
      await rpc.call('deleteScheduledTrigger', { id: tr.id })
      await refreshScheduledTriggers()
    } catch (e) {
      toast(String((e as Error).message))
    }
  }

  return (
    <>
      <div className="problem-list">
        {triggers.map((tr) => (
          <div key={tr.id} className={`problem-row ${tr.enabled ? '' : 'disabled'}`}>
            <svg className={`eye ${tr.enabled ? 'eye-ok' : 'eye-off'}`} viewBox="0 0 10 10">
              <circle cx="5" cy="5" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="5.8" cy="4.2" r="1.5" fill="currentColor" />
            </svg>
            <div className="problem-info">
              <b>{tr.name}</b>
              <span className="rule-summary">
                {scheduleSummary(tr)} — {actionTypeLabel(tr.actionType)}
              </span>
              <small>
                {t('auto.triggers.next', { time: fmtDateTime(tr.nextRunAt) })}
                {tr.lastRunAt ? t('auto.triggers.lastRun', { time: fmtDateTime(tr.lastRunAt) }) : ''}
              </small>
            </div>
            <button onClick={() => setEditTrigger(tr.id)} aria-label={t('action.edit')} title={t('action.edit')}><svg className="icon sm"><use href="#i-pencil" /></svg></button>
            <button className="danger" onClick={() => void remove(tr)} aria-label={t('action.delete')} title={t('action.delete')}>
              <svg className="icon sm"><use href="#i-trash" /></svg>
            </button>
          </div>
        ))}
        {!triggers.length && <div className="empty-note">{t('auto.triggers.empty')}</div>}
      </div>
      <div className="modal-foot">
        <button onClick={() => setEditTrigger('new')}><svg className="icon sm"><use href="#i-plus" /></svg> {t('auto.triggers.new')}</button>
      </div>
    </>
  )
}

function LogTab() {
  const ruleLog = useStore((s) => s.ruleLog)
  const KIND_LABEL: Record<string, string> = { rule: t('auto.kind.rule'), webhook: t('auto.kind.webhook'), trigger: t('auto.kind.trigger') }
  return (
    <div className="problem-list">
      {ruleLog.map((l: RuleLogInfo) => (
        <div key={l.id} className="problem-row">
          <svg className={`eye ${l.ok ? 'eye-ok' : 'eye-err'}`} viewBox="0 0 10 10">
            <circle cx="5" cy="5" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="5.8" cy="4.2" r="1.5" fill="currentColor" />
          </svg>
          <div className="problem-info">
            <b>
              [{KIND_LABEL[l.kind] ?? l.kind}] {l.summary}
            </b>
            {!l.ok && l.error && <span className="err-text">{l.error}</span>}
            <small>{fmtDateTime(l.ts)}</small>
          </div>
        </div>
      ))}
      {!ruleLog.length && <div className="empty-note">{t('auto.log.empty')}</div>}
    </div>
  )
}

export default function AutomationPanel() {
  const setAutomationOpen = useStore((s) => s.setAutomationOpen)
  const automationTab = useStore((s) => s.automationTab)
  const setAutomationTab = useStore((s) => s.setAutomationTab)
  const refreshRules = useStore((s) => s.refreshRules)

  useEffect(() => {
    void refreshRules()
  }, [refreshRules])

  return (
    <Modal onClose={() => setAutomationOpen(false)} className="automation">
        <div className="modal-title">
          <svg className="icon"><use href="#i-zap" /></svg> {t('auto.panel.title')}
        </div>
        <div className="segmented automation-tabs" role="tablist">
          <button role="tab" aria-selected={automationTab === 'rules'} className={automationTab === 'rules' ? 'on' : ''} onClick={() => setAutomationTab('rules')}>
            {t('auto.tab.rules')}
          </button>
          <button role="tab" aria-selected={automationTab === 'webhooks'} className={automationTab === 'webhooks' ? 'on' : ''} onClick={() => setAutomationTab('webhooks')}>
            {t('auto.tab.webhooks')}
          </button>
          <button role="tab" aria-selected={automationTab === 'triggers'} className={automationTab === 'triggers' ? 'on' : ''} onClick={() => setAutomationTab('triggers')}>
            {t('auto.tab.triggers')}
          </button>
          <button role="tab" aria-selected={automationTab === 'log'} className={automationTab === 'log' ? 'on' : ''} onClick={() => setAutomationTab('log')}>
            {t('auto.tab.log')}
          </button>
        </div>
        <div className="automation-body">
          {automationTab === 'rules' && <RulesTab />}
          {automationTab === 'webhooks' && <WebhooksTab />}
          {automationTab === 'triggers' && <TriggersTab />}
          {automationTab === 'log' && <LogTab />}
        </div>
        <div className="modal-foot">
          <button onClick={() => setAutomationOpen(false)}>{t('action.close')}</button>
        </div>
    </Modal>
  )
}
