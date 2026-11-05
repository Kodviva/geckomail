// Takipte (R30): "yanıt gelmezse hatırlat" ile gönderilen mailler. Yanıt gelince liste kendiliğinden
// temizlenir; süresi dolanlar üstte. Hatırlatma maili, orijinalle aynı konuşmaya bağlanır.
import { useEffect, useState } from 'react'
import type { FollowupInfo } from '../../../shared/rpc'
import { intlTag, t } from '../../../shared/i18n'
import { rpc } from '../rpcClient'
import { useStore } from '../store'
import Modal from './Modal'

// gün hassasiyetinde göreli tarih: "bugün", "yarın", "3 gün önce" (arayüz dilinde)
function rel(ts: number): string {
  const d = Math.round((ts - Date.now()) / 86_400_000)
  return new Intl.RelativeTimeFormat(intlTag(), { numeric: 'auto' }).format(d, 'day')
}

export default function FollowupsPanel() {
  const setOpen = useStore((s) => s.setFollowupsOpen)
  const accounts = useStore((s) => s.accounts)
  const setComposer = useStore((s) => s.setComposer)
  const toast = useStore((s) => s.toast)
  const [items, setItems] = useState<FollowupInfo[] | null>(null)

  const load = async (): Promise<void> => {
    try {
      const list = await rpc.call('listFollowups', {})
      setItems(list)
      useStore.setState({ followupDue: list.filter((f) => f.state === 'due').length })
    } catch (e) {
      toast(t('compose.followups.loadFailed', { error: (e as Error).message }))
      setItems([])
    }
  }
  useEffect(() => {
    void load()
    const off = rpc.on('followups:changed', () => void load())
    return () => {
      off()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- bilinçli: yalnız açılışta / belirtilen değişkenlerle
  }, [])

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
      await load()
    } catch (e) {
      toast((e as Error).message)
    }
  }

  const nudge = (f: FollowupInfo): void => {
    const subject = f.subject ?? ''
    setOpen(false)
    setComposer({
      fromAccountId: f.accountId,
      to: f.to ?? '',
      cc: '',
      bcc: '',
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      text: '',
      rich: false,
      html: '',
      inReplyTo: f.messageId,
      references: f.messageId,
      attachments: [],
      mode: 'reply',
      followupDays: 3,
      // hatırlatma gönderilince bu kayıt kapanır, yenisi takip edilir; vazgeçilirse takip sürer
      closeFollowupId: f.id
    })
  }

  const due = items?.filter((f) => f.state === 'due') ?? []
  const waiting = items?.filter((f) => f.state === 'waiting') ?? []
  const email = (id: number) => accounts.find((a) => a.id === id)?.email ?? '—'

  const row = (f: FollowupInfo) => (
    <div key={f.id} className={`outbox-row ${f.state === 'due' ? 'due' : ''}`}>
      <div className="ob-main">
        <div className="ob-title">
          <b>{f.subject || t('compose.common.noSubject')}</b>
        </div>
        <div className="ob-sub">
          {f.to} · {email(f.accountId)}
        </div>
        <div className={`ob-status ${f.state === 'due' ? 'warn' : ''}`}>
          {f.pendingSend
            ? t('compose.followups.pendingSend')
            : f.state === 'due'
              ? t('compose.followups.dueStatus', { when: rel(f.dueAt) })
              : t('compose.followups.waitingStatus', { when: rel(f.dueAt) })}
        </div>
      </div>
      <div className="ob-actions">
        {f.state === 'due' && (
          <button type="button" className="primary" onClick={() => nudge(f)} title={t('compose.followups.nudgeTip')}>
            {t('compose.followups.nudge')}
          </button>
        )}
        <button type="button" onClick={() => void act(() => rpc.call('snoozeFollowup', { id: f.id, days: 2 }))} title={t('compose.followups.snoozeTip', { count: 2 })}>
          {t('compose.followups.snooze', { count: 2 })}
        </button>
        <button type="button" onClick={() => void act(() => rpc.call('closeFollowup', { id: f.id }))} title={t('compose.followups.closeTip')}>
          {t('action.close')}
        </button>
      </div>
    </div>
  )

  return (
    <Modal onClose={() => setOpen(false)} className="outbox">
      <div className="modal-title">{t('compose.followups.title')}</div>
      {!items && <div className="empty-note">{t('state.loading')}</div>}
      {items && !items.length && (
        <div className="empty-note">{t('compose.followups.empty', { example: t('compose.followup.afterDays', { count: 3 }) })}</div>
      )}
      {due.length > 0 && (
        <>
          <div className="ob-section">{t('compose.followups.dueSection', { count: due.length })}</div>
          {due.map(row)}
        </>
      )}
      {waiting.length > 0 && (
        <>
          <div className="ob-section">{t('compose.followups.waitingSection', { count: waiting.length })}</div>
          {waiting.map(row)}
        </>
      )}
      <div className="modal-foot">
        <span />
        <button className="primary" onClick={() => setOpen(false)}>
          {t('action.close')}
        </button>
      </div>
    </Modal>
  )
}
