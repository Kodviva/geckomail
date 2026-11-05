import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import Modal from './Modal'
import { t } from '../../../shared/i18n'

export default function RawHeadersView() {
  const messageId = useStore((s) => s.viewSourceMessageId)
  const setViewSource = useStore((s) => s.setViewSource)
  // sonuç hangi mesaja aitse onunla saklanır: mesaj değişince eskisi görünmez, yenisi gelene dek "yükleniyor"
  const [res, setRes] = useState<{ id: number; raw?: string; error?: string } | null>(null)

  useEffect(() => {
    if (messageId == null) return
    void rpc
      .call('getRawHeaders', { messageId })
      .then((r) => setRes({ id: messageId, raw: r.raw }))
      .catch((e) => setRes({ id: messageId, error: String((e as Error).message) }))
  }, [messageId])
  const cur = res?.id === messageId ? res : null
  const raw = cur?.raw ?? null
  const error = cur?.error ?? null

  if (messageId == null) return null

  return (
    <Modal onClose={() => setViewSource(null)} className="raw-headers">
        <div className="modal-title">{t('mail.source.title')}</div>
        {error && <div className="empty-note">{t('mail.source.error', { error })}</div>}
        {!error && raw == null && <div className="empty-note">{t('state.loading')}</div>}
        {raw != null && <pre className="raw-headers-body">{raw || t('mail.source.empty')}</pre>}
        <div className="modal-foot">
          <button onClick={() => setViewSource(null)}>{t('action.close')}</button>
        </div>
    </Modal>
  )
}
