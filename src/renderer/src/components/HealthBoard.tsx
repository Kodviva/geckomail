import { useEffect, useMemo } from 'react'
import { useStore } from '../store'
import { StatusDot } from './AccountsPanel'
import { fmtRelative, needsAction, primaryActionLabel } from '../accountHealth'
import Modal from './Modal'
import { t } from '../../../shared/i18n'

const STATUS_ORDER: Record<string, number> = { auth_failed: 0, unreachable: 1, degraded: 2, unknown: 3, ok: 4, disabled: 5 }

export default function HealthBoard() {
  const accounts = useStore((s) => s.accounts)
  const setHealthBoardOpen = useStore((s) => s.setHealthBoardOpen)
  const setEditAccount = useStore((s) => s.setEditAccount)
  const incidents = useStore((s) => s.incidents)
  const refreshIncidents = useStore((s) => s.refreshIncidents)
  const setAccountFilter = useStore((s) => s.setAccountFilter)

  useEffect(() => {
    void refreshIncidents()
  }, [refreshIncidents])

  const sorted = useMemo(
    () => [...accounts].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.email.localeCompare(b.email)),
    [accounts]
  )
  const problems = accounts.filter((a) => a.enabled && (a.status === 'auth_failed' || a.status === 'unreachable')).length
  const degraded = accounts.filter((a) => a.enabled && a.status === 'degraded').length
  const disabled = accounts.filter((a) => !a.enabled).length
  const ok = accounts.length - problems - degraded - disabled

  return (
    <Modal onClose={() => setHealthBoardOpen(false)} className="health-board">
        <div className="modal-title">{t('auto.health.title')}</div>
        <div className="rule-summary">
          {t('auto.count.accounts', { count: accounts.length })} · {t('auto.health.connected', { count: ok })}
          {problems > 0 && ` · ${t('auto.health.problems', { count: problems })}`}
          {degraded > 0 && ` · ${t('auto.health.warnings', { count: degraded })}`}
          {disabled > 0 && ` · ${t('auto.health.disabled', { count: disabled })}`}
        </div>
        {incidents.length > 0 && (
          <div className="incident-list">
            {incidents.map((inc) => {
              const goToAffected = (): void => {
                setAccountFilter(inc.accountIds)
                setHealthBoardOpen(false)
              }
              return (
                <div
                  key={inc.key}
                  className="incident-row"
                  role="button"
                  tabIndex={0}
                  onClick={goToAffected}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      goToAffected()
                    }
                  }}
                  title={t('auto.health.goToAffected')}
                >
                  <svg className="icon sm"><use href="#i-alert" /></svg>
                  <span className="incident-subject">{inc.subjectSample || t('auto.common.noSubject')}</span>
                  <small>
                    {t('auto.count.accounts', { count: inc.accountIds.length })} · {t('auto.count.messages', { count: inc.messageCount })} ·{' '}
                    {t('auto.health.lastSeen', { when: fmtRelative(inc.lastDate) })}
                  </small>
                </div>
              )
            })}
          </div>
        )}
        <div className="import-table">
          <table>
            <thead>
              <tr>
                <th />
                <th>{t('auto.health.colAccount')}</th>
                <th>{t('auto.health.colGroup')}</th>
                <th>{t('auto.health.colStatus')}</th>
                <th>{t('auto.health.colLastSync')}</th>
                <th>{t('auto.health.colUnread')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => (
                <tr
                  key={a.id}
                  className={`hb-row ${a.enabled ? '' : 'dim'}`}
                  onClick={() => setEditAccount(a.id)}
                  title={t('auto.health.openAccount')}
                >
                  <td>
                    <span className="acct-color" style={{ background: a.color }} />
                  </td>
                  <td>{a.email}</td>
                  <td>{a.groupName ?? '—'}</td>
                  <td>
                    <StatusDot a={a} /> {a.statusDetail ?? ''}
                  </td>
                  <td>{fmtRelative(a.lastSuccessAt)}</td>
                  <td>{a.unread || ''}</td>
                  <td>
                    {needsAction(a) && (
                      <button
                        type="button"
                        className="primary sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditAccount(a.id)
                        }}
                      >
                        {primaryActionLabel(a)}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-foot">
          <button onClick={() => setHealthBoardOpen(false)}>{t('action.close')}</button>
        </div>
    </Modal>
  )
}
