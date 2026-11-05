import { useStore } from '../store'
import { rpc } from '../rpcClient'
import { statusLabel } from '../accountHealth'
import Modal from './Modal'
import { t, fmtDateTime } from '../../../shared/i18n'

export default function ProblemsPanel() {
  const accounts = useStore((s) => s.accounts)
  const setProblemsOpen = useStore((s) => s.setProblemsOpen)
  const refreshAccounts = useStore((s) => s.refreshAccounts)
  const setEditAccount = useStore((s) => s.setEditAccount)
  const problems = accounts.filter((a) => a.status !== 'ok' && a.status !== 'unknown')

  return (
    <Modal onClose={() => setProblemsOpen(false)} className="problems">
        <div className="modal-title">{t('auto.problems.title')}</div>
        {!problems.length && (
          <p>
            <svg className="icon sm"><use href="#i-check-circle" /></svg> {t('auto.problems.allHealthy')}
          </p>
        )}
        <div className="problem-list">
          {problems.map((a) => (
            <div key={a.id} className="problem-row">
              <span className="acct-color" style={{ background: a.color }} />
              <div className="problem-info">
                <b>{a.email}</b>
                <span className="problem-detail">
                  {statusLabel(a.status)}
                  {a.statusDetail ? ` — ${a.statusDetail}` : ''}
                </span>
                {a.lastSuccessAt && (
                  <small>{t('auto.problems.lastSync', { time: fmtDateTime(a.lastSuccessAt) })}</small>
                )}
              </div>
              <button
                className={a.status === 'auth_failed' ? 'primary' : ''}
                onClick={() => {
                  setProblemsOpen(false)
                  setEditAccount(a.id)
                }}
              >
                {a.status === 'auth_failed' ? t('auto.problems.updatePassword') : t('action.edit')}
              </button>
              {/* şifre hatalıyken "tekrar dene" yalnızca bir başarısız login daha üretir — sunucu banının sebebi */}
              {a.status !== 'auth_failed' && (
                <button
                  onClick={() => {
                    void rpc.call('retryAccount', { accountId: a.id }).then(() => refreshAccounts())
                  }}
                >
                  {t('action.retry')}
                </button>
              )}
              <button
                onClick={() => {
                  void rpc.call('setAccountEnabled', { accountId: a.id, enabled: !a.enabled }).then(() => refreshAccounts())
                }}
              >
                {a.enabled ? t('auto.problems.disable') : t('auto.problems.enable')}
              </button>
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <button onClick={() => setProblemsOpen(false)}>{t('action.close')}</button>
        </div>
    </Modal>
  )
}
