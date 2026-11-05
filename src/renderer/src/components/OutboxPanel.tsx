// Giden kutusu (R12): bekleyen, zamanlanmış ve başarısız işlemler. Önceden görünmüyordu — zamanlanmış
// mail iptal edilemiyor, başarısız gönderim sessizce kalıyordu.
import { useEffect, useState } from 'react'
import type { OutboxItem } from '../../../shared/rpc'
import { fmtDateTime, t } from '../../../shared/i18n'
import { rpc } from '../rpcClient'
import { composerFromDraft } from '../smimeCompose'
import { useStore } from '../store'
import Modal from './Modal'

function fmt(ts: number): string {
  return fmtDateTime(ts, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function OutboxPanel() {
  const setOutboxOpen = useStore((s) => s.setOutboxOpen)
  const setComposer = useStore((s) => s.setComposer)
  const toast = useStore((s) => s.toast)
  const [items, setItems] = useState<OutboxItem[] | null>(null)

  const refresh = () =>
    rpc
      .call('listOutbox', {})
      .then(setItems)
      .catch((e) => toast(t('compose.outbox.loadFailed', { error: (e as Error).message })))

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
    // aralık yalnız açılışta kurulur (refresh her render'da yeni kimlik alır)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- bilinçli: yalnız açılışta / belirtilen değişkenlerle
  }, [])

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn()
      toast(done, 'info')
      await refresh()
    } catch (e) {
      toast((e as Error).message)
    }
  }

  const openDraft = async (it: OutboxItem) => {
    try {
      const draft = await rpc.call('getOpDraft', { id: it.id })
      if (!draft) return toast(t('compose.outbox.draftNotFound'))
      await rpc.call('cancelOp', { id: it.id }) // taslağa dönüşen gönderim kuyruktan çıkar
      setOutboxOpen(false)
      setComposer(composerFromDraft(draft))
      toast(t('compose.outbox.convertedToDraft'), 'info')
    } catch (e) {
      toast((e as Error).message)
    }
  }

  const failed = items?.filter((i) => i.state === 'failed') ?? []
  const pending = items?.filter((i) => i.state === 'pending') ?? []

  const row = (it: OutboxItem) => (
    <div key={it.id} className={`outbox-row ${it.state}`}>
      <div className="ob-main">
        <div className="ob-title">
          <b>{it.kindLabel}</b> · {it.email ?? '—'}
          {it.locked && <span className="vault-tag">{t('compose.outbox.vaultLocked')}</span>}
        </div>
        <div className="ob-sub">
          {it.subject != null
            ? `${it.to ?? ''} — ${it.subject || t('compose.common.noSubject')}`
            : it.count != null
              ? t('compose.common.mailCount', { count: it.count })
              : ''}
        </div>
        <div className={`ob-status ${it.state}`}>
          {it.state === 'failed'
            ? t('compose.outbox.failed', { error: it.lastError ?? t('compose.outbox.unknownError') })
            : it.scheduledAt
              ? t('compose.outbox.scheduled', { when: fmt(it.scheduledAt) })
              : it.attempts > 0
                ? t('compose.outbox.willRetry', { attempt: it.attempts, error: it.lastError ?? '' })
                : t('compose.outbox.queued')}
        </div>
      </div>
      <div className="ob-actions">
        {it.kind === 'smtp_send' && !it.locked && (
          <button type="button" onClick={() => void openDraft(it)} title={t('compose.outbox.openAsDraftTip')}>
            {t('compose.outbox.openAsDraft')}
          </button>
        )}
        {it.state === 'failed' && (
          <button type="button" onClick={() => void act(() => rpc.call('retryOp', { id: it.id }), t('compose.outbox.retrying'))}>
            {t('action.retry')}
          </button>
        )}
        <button
          type="button"
          className="danger"
          onClick={() => {
            if (it.kind === 'smtp_send' && it.state === 'pending' && !window.confirm(t('compose.outbox.confirmCancel'))) return
            void act(() => rpc.call('cancelOp', { id: it.id }), it.state === 'failed' ? t('compose.outbox.removed') : t('compose.outbox.cancelled'))
          }}
        >
          {it.state === 'failed' ? t('action.remove') : t('compose.outbox.cancel')}
        </button>
      </div>
    </div>
  )

  return (
    <Modal onClose={() => setOutboxOpen(false)} className="outbox">
      <div className="modal-title">{t('compose.outbox.title')}</div>
      {!items && <div className="empty-note">{t('state.loading')}</div>}
      {items && !items.length && <div className="empty-note">{t('compose.outbox.empty')}</div>}
      {failed.length > 0 && (
        <>
          <div className="ob-section">{t('compose.outbox.failedSection', { count: failed.length })}</div>
          {failed.map(row)}
        </>
      )}
      {pending.length > 0 && (
        <>
          <div className="ob-section">{t('compose.outbox.pendingSection', { count: pending.length })}</div>
          {pending.map(row)}
        </>
      )}
      <div className="modal-foot">
        <span />
        <button className="primary" onClick={() => setOutboxOpen(false)}>{t('action.close')}</button>
      </div>
    </Modal>
  )
}
