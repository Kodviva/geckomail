import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import type { ScheduleType, TriggerActionType } from '../../../shared/rpc'
import Modal from './Modal'
import { t } from '../../../shared/i18n'

export default function TriggerEdit() {
  const editTriggerId = useStore((s) => s.editTriggerId)
  const setEditTrigger = useStore((s) => s.setEditTrigger)
  const triggers = useStore((s) => s.scheduledTriggers)
  const accounts = useStore((s) => s.accounts)
  const webhooks = useStore((s) => s.webhooks)
  const refreshScheduledTriggers = useStore((s) => s.refreshScheduledTriggers)
  const refreshWebhooks = useStore((s) => s.refreshWebhooks)
  const toast = useStore((s) => s.toast)

  const isNew = editTriggerId === 'new'
  const existing = !isNew ? triggers.find((t) => t.id === editTriggerId) : undefined
  const payload = (existing?.actionPayload ?? {}) as Record<string, unknown>

  const [name, setName] = useState(existing?.name ?? '')
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [scheduleType, setScheduleType] = useState<ScheduleType>(existing?.scheduleType ?? 'daily')
  const [scheduleValue, setScheduleValue] = useState(existing?.scheduleValue ?? '09:00')
  const [actionType, setActionType] = useState<TriggerActionType>(existing?.actionType ?? 'digest_email')
  const [digestFrom, setDigestFrom] = useState<number | null>((payload.fromAccountId as number) ?? accounts[0]?.id ?? null)
  const [digestTo, setDigestTo] = useState((payload.toAddr as string) ?? '')
  const [pingWebhookId, setPingWebhookId] = useState<number | null>((payload.webhookId as number) ?? null)
  const [resumeAt, setResumeAt] = useState((payload.resumeAtHHMM as string) ?? '08:00')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refreshWebhooks()
  }, [refreshWebhooks])

  useEffect(() => {
    if (!digestTo && digestFrom) {
      const acc = accounts.find((a) => a.id === digestFrom)
      if (acc) setDigestTo(acc.email)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digestFrom])

  if (!isNew && !existing) return null

  const buildPayload = (): Record<string, unknown> => {
    switch (actionType) {
      case 'digest_email':
        return { fromAccountId: digestFrom, toAddr: digestTo, accountIds: null }
      case 'webhook_ping':
        return { webhookId: pingWebhookId }
      case 'mute_notifications':
        return { resumeAtHHMM: resumeAt }
    }
  }

  const save = async () => {
    if (!name.trim()) {
      toast(t('auto.trigger.nameRequired'), 'error')
      return
    }
    if (actionType === 'digest_email' && (!digestFrom || !digestTo.trim())) {
      toast(t('auto.trigger.digestRequired'), 'error')
      return
    }
    if (actionType === 'webhook_ping' && !pingWebhookId) {
      toast(t('auto.trigger.webhookRequired'), 'error')
      return
    }
    setBusy(true)
    try {
      if (isNew) {
        await rpc.call('createScheduledTrigger', { name: name.trim(), scheduleType, scheduleValue, actionType, actionPayload: buildPayload() })
      } else if (existing) {
        await rpc.call('updateScheduledTrigger', {
          id: existing.id,
          patch: { name: name.trim(), enabled, scheduleType, scheduleValue, actionType, actionPayload: buildPayload() }
        })
      }
      await refreshScheduledTriggers()
      toast(t(isNew ? 'auto.trigger.created' : 'auto.trigger.updated'), 'info')
      setEditTrigger(null)
    } catch (e) {
      toast(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={() => setEditTrigger(null)} confirmOnDirty>
        <div className="modal-title">{isNew ? t('auto.trigger.newTitle') : name || t('auto.kind.trigger')}</div>
        <div className="cc-row">
          <label>
            {t('auto.trigger.name')}
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          {!isNew && (
            <label className="check-row" style={{ flex: '0 0 auto' }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span>{t('auto.common.enabled')}</span>
            </label>
          )}
        </div>
        <div className="cc-row">
          <label>
            {t('auto.trigger.schedule')}
            <select value={scheduleType} onChange={(e) => setScheduleType(e.target.value as ScheduleType)}>
              <option value="daily">{t('auto.trigger.scheduleDaily')}</option>
              <option value="interval">{t('auto.trigger.scheduleInterval')}</option>
            </select>
          </label>
          <label>
            {scheduleType === 'daily'
              ? t(actionType === 'mute_notifications' ? 'auto.trigger.startTime' : 'auto.trigger.time')
              : t('auto.trigger.minutes')}
            {scheduleType === 'daily' ? (
              <input type="time" value={scheduleValue} onChange={(e) => setScheduleValue(e.target.value)} />
            ) : (
              <input type="number" min={1} value={scheduleValue} onChange={(e) => setScheduleValue(e.target.value)} />
            )}
          </label>
        </div>
        <label>
          {t('auto.trigger.action')}
          <select value={actionType} onChange={(e) => setActionType(e.target.value as TriggerActionType)}>
            <option value="digest_email">{t('auto.trigger.digestEmailOption')}</option>
            <option value="webhook_ping">{t('auto.trigAction.webhookPing')}</option>
            <option value="mute_notifications">{t('auto.trigAction.muteNotifications')}</option>
          </select>
        </label>
        {actionType === 'digest_email' && (
          <div className="cc-row">
            <label>
              {t('auto.trigger.fromAccount')}
              <select value={digestFrom ?? ''} onChange={(e) => setDigestFrom(Number(e.target.value) || null)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.email}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('auto.trigger.recipient')}
              <input value={digestTo} onChange={(e) => setDigestTo(e.target.value)} />
            </label>
          </div>
        )}
        {actionType === 'webhook_ping' &&
          (webhooks.length ? (
            <label>
              {t('auto.common.webhook')}
              <select value={pingWebhookId ?? ''} onChange={(e) => setPingWebhookId(Number(e.target.value) || null)}>
                <option value="">{t('auto.trigger.pick')}</option>
                {webhooks.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="auth-hint">
              {t('auto.common.needWebhook')}{' '}
              <button
                type="button"
                className="link-btn inline"
                onClick={() => {
                  setEditTrigger(null)
                  useStore.getState().setAutomationOpen(true)
                  useStore.getState().setAutomationTab('webhooks')
                }}
              >
                {t('auto.common.goToWebhooks')}
              </button>
            </span>
          ))}
        {actionType === 'mute_notifications' && (
          <label>
            {t('auto.trigger.endTime')}
            <input type="time" value={resumeAt} onChange={(e) => setResumeAt(e.target.value)} />
          </label>
        )}
        <div className="modal-foot">
          <button onClick={() => setEditTrigger(null)}>{t('action.cancel')}</button>
          <button className="primary" onClick={() => void save()} disabled={busy}>
            {isNew ? t('auto.common.create') : t('action.save')}
          </button>
        </div>
    </Modal>
  )
}
