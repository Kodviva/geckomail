import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import type { AttachmentRow } from '../../../shared/rpc'
import Modal from './Modal'
import { fmtNumber, t } from '../../../shared/i18n'

function fmtSize(n: number | null): string {
  if (!n) return ''
  if (n < 1024) return t('mail.size.b', { n: fmtNumber(n) })
  if (n < 1048576) return t('mail.size.kb', { n: fmtNumber(n / 1024, { maximumFractionDigits: 0 }) })
  return t('mail.size.mb', { n: fmtNumber(n / 1048576, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
}

// Ekler: tüm görünür gelen kutularındaki son ekleri tek listede gör, tıkla → mesajı aç
// (dosyayı açan yer mesaj görünümü; burada yalnızca bulup mesaja gidilir).
export default function AttachmentsPanel() {
  const setAttachmentsOpen = useStore((s) => s.setAttachmentsOpen)
  const accounts = useStore((s) => s.accounts)
  const select = useStore((s) => s.select)
  const setAccountFilter = useStore((s) => s.setAccountFilter)
  const toast = useStore((s) => s.toast)
  const [rows, setRows] = useState<AttachmentRow[] | null>(null)

  useEffect(() => {
    void rpc
      .call('getAttachments', {})
      .then(setRows)
      .catch((e) => {
        toast(String((e as Error).message))
        setRows([])
      })
  }, [toast])

  const emailOf = (id: number): string => accounts.find((a) => a.id === id)?.email ?? ''

  const open = (r: AttachmentRow): void => {
    setAccountFilter([r.accountId])
    void select(r.messageId)
    setAttachmentsOpen(false)
  }

  return (
    <Modal onClose={() => setAttachmentsOpen(false)} className="attachments">
        <div className="modal-title">{t('mail.attachments.title')}</div>
        {rows === null && <p className="auth-hint">{t('state.loading')}</p>}
        {rows?.length === 0 && <p className="auth-hint">{t('mail.attachments.empty')}</p>}
        {rows && rows.length > 0 && (
          <div className="att-list">
            {rows.map((r) => (
              <div key={r.id} className="att-row" onClick={() => open(r)}>
                <svg className="icon sm att-ic"><use href="#i-clip" /></svg>
                <div className="att-main">
                  <div className="att-file">
                    <span className="att-name">{r.filename}</span>
                    <span className="att-size">{[fmtSize(r.size), r.mime].filter(Boolean).join(' · ')}</span>
                  </div>
                  <div className="att-meta">
                    {[r.subject || t('mail.common.noSubject'), r.fromName || r.fromAddr, emailOf(r.accountId)].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="modal-foot">
          <button className="primary" onClick={() => setAttachmentsOpen(false)}>{t('action.close')}</button>
        </div>
    </Modal>
  )
}
