// Tatil yanıtı: sunucuda çalışır, istemci yedeği yoktur (K18). Düz metin. Bayt sayacı doğrulamayla aynı ölçüyü kullanır.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { SIEVE_VACATION_TOO_LARGE, type SieveAccountInfo, type SieveVacation } from '../../../shared/sieve'
import { t } from '../../../shared/i18n'
import { rpc } from '../rpcClient'
import { remainingBytes } from '../sieveView'
import Modal from './Modal'

type Loaded = { vacation: SieveVacation; supported: boolean; dateRange: boolean; conflict: boolean }

export default function SieveVacationSettings({ info, onClose, onSaved }: { info: SieveAccountInfo; onClose(): void; onSaved(i: SieveAccountInfo): void }) {
  const accountId = info.accountId
  const [meta, setMeta] = useState<Loaded | null>(null)
  const [form, setForm] = useState<SieveVacation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // kilitli kasa burada hata döner: boş formla gerçek metnin üzerine yazılmasın
    void rpc.call('getSieveVacation', { accountId }).then(
      (r) => {
        setMeta(r)
        setForm(r.vacation)
      },
      (e: Error) => setError(e.message)
    )
  }, [accountId])

  const save = async (): Promise<void> => {
    if (!form) return
    setBusy(true)
    setError(null)
    try {
      onSaved(await rpc.call('setSieveVacation', { accountId, vacation: form }))
      onClose()
    } catch (e) {
      setError(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const left = form ? remainingBytes(form.body) : 0
  const patch = (p: Partial<SieveVacation>): void => setForm((f) => (f ? { ...f, ...p } : f))

  return createPortal(
    <Modal onClose={onClose} className="sieve-dialog" confirmOnDirty>
      <div className="modal-title">{t('set.sieve.vacation.title')}</div>
      {error && <div className="err-text" data-testid="sieve-vacation-error">{error}</div>}
      {meta && !meta.supported && <div className="sieve-meta sieve-warn">{t('set.sieve.vacation.unsupported')}</div>}
      {meta?.conflict && <div className="sieve-meta sieve-warn">{t('set.sieve.detail.vacationConflict')}</div>}
      {info.detail === SIEVE_VACATION_TOO_LARGE && <div className="sieve-meta sieve-warn">{t('set.sieve.detail.vacationTooLarge')}</div>}
      {form && meta?.supported && (
        <div className="sieve-form">
          <label className="sieve-check">
            <input type="checkbox" checked={form.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
            {t('set.sieve.vacation.on')}
          </label>
          <label>
            {t('set.sieve.vacation.subject')}
            <input value={form.subject} maxLength={200} onChange={(e) => patch({ subject: e.target.value })} />
          </label>
          <label>
            {t('set.sieve.vacation.body')}
            <textarea rows={6} value={form.body} onChange={(e) => patch({ body: e.target.value })} />
          </label>
          <small className={left < 0 ? 'err-text' : 'sieve-meta'} data-testid="sieve-vacation-left">{t('set.sieve.vacation.left', { count: left })}</small>
          <label>
            {t('set.sieve.vacation.days')}
            <input type="number" min={1} max={30} value={form.days} onChange={(e) => patch({ days: Number(e.target.value) })} />
          </label>
          {meta.dateRange && (
            <div className="sieve-endpoint-row">
              <label>
                {t('set.sieve.vacation.start')}
                <input type="date" value={form.startDate ?? ''} onChange={(e) => patch({ startDate: e.target.value || null })} />
              </label>
              <label>
                {t('set.sieve.vacation.end')}
                <input type="date" value={form.endDate ?? ''} onChange={(e) => patch({ endDate: e.target.value || null })} />
              </label>
            </div>
          )}
          {meta.dateRange && <small className="sieve-meta">{t('set.sieve.vacation.serverTime')}</small>}
        </div>
      )}
      <div className="modal-foot">
        <button onClick={onClose}>{t('action.close')}</button>
        {form && meta?.supported && <button className="primary" disabled={busy || left < 0} onClick={() => void save()}>{t('action.save')}</button>}
      </div>
    </Modal>,
    document.body
  )
}
