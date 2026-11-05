// Eski Sieve sunucusuna ulaşılamıyor: yönetici betiğin orada kalacağını onaylarsa adres yine de değişir.
import { createPortal } from 'react-dom'
import { SIEVE_UNREACHABLE } from '../../../shared/sieve'
import { t } from '../../../shared/i18n'
import Modal from './Modal'

/** Sunucu hata kodunu metnin sonuna ekler (describeError) */
export const isSieveUnreachable = (e: unknown): boolean => String((e as Error)?.message ?? '').includes(`(${SIEVE_UNREACHABLE})`)

export default function SieveLeaveDialog({ busy, onCancel, onConfirm }: { busy: boolean; onCancel(): void; onConfirm(): void }) {
  return createPortal(
    <Modal onClose={onCancel} className="sieve-dialog">
      <div className="modal-title" data-testid="sieve-leave-dialog">{t('set.sieve.leave.title')}</div>
      <p className="sieve-note">{t('set.sieve.leave.body')}</p>
      <div className="modal-foot">
        <button autoFocus onClick={onCancel}>{t('action.cancel')}</button>
        <button className="danger" onClick={onConfirm} disabled={busy} data-testid="sieve-leave-confirm">{t('set.sieve.leave.confirm')}</button>
      </div>
    </Modal>,
    document.body
  )
}
