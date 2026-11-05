import { useEffect, useState } from 'react'
import { fmtDateTime, t } from '../../../shared/i18n'
import { OFFLINE_DAYS, loadOfflineSettings, offlineSupported, type OfflineDays } from '../offline/settings'
import { readOfflineSnapshot } from '../offline/sync'
import { useStore } from '../store'
import { onOfflineSynced, setOfflineMode } from '../store/offline'

/** Web: postaları cihazda şifreli tutma. Cihaz başına ve açan kullanıcıya özel, varsayılan kapalı */
export default function OfflineSettings() {
  const user = useStore((s) => s.currentUser)
  const offlineMode = useStore((s) => s.offlineMode)
  const [stored] = useState(loadOfflineSettings)
  const [on, setOn] = useState(stored.on && stored.userId === user?.id)
  const [days, setDays] = useState<OfflineDays>(stored.days)
  const [syncing, setSyncing] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const supported = offlineSupported()

  const refreshStatus = (): void => {
    if (!loadOfflineSettings().on) return setStatus(null)
    void readOfflineSnapshot()
      .then((s) => setStatus(s ? t('set.offline.status', { n: s.count, when: fmtDateTime(s.syncedAt, { dateStyle: 'short', timeStyle: 'short' }) }) : null))
      .catch(() => setStatus(null))
  }
  useEffect(() => {
    if (on) refreshStatus()
    return onOfflineSynced(refreshStatus)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnız açılışta
  }, [])

  const apply = (nextOn: boolean, nextDays: OfflineDays): void => {
    setOn(nextOn)
    setDays(nextDays)
    if (!nextOn) setStatus(null)
    setSyncing(nextOn)
    const get = useStore.getState
    void setOfflineMode(get, nextOn, nextDays).finally(() => {
      setSyncing(false)
      refreshStatus()
    })
  }

  const hint = !supported ? t('set.offline.unsupported') : offlineMode ? t('set.offline.needConnection') : t('set.offline.hint')
  return (
    <>
      <div className="set-field">
        <div className="sf-l">
          <div className="sf-t">{t('set.offline.title')}</div>
          <div className="sf-h">{hint}</div>
          {supported && <div className="sf-h">{t('set.offline.pimScope')}</div>}
          {on && (syncing || status) && <div className="sf-h" role="status">{syncing ? t('set.offline.syncing') : status}</div>}
        </div>
        <div className="sf-c">
          <input type="checkbox" aria-label={t('set.offline.toggle')} checked={on} disabled={!supported || offlineMode} onChange={(e) => apply(e.target.checked, days)} />
        </div>
      </div>
      {on && (
        <div className="set-field">
          <div className="sf-l"><div className="sf-t">{t('set.offline.days')}</div></div>
          <div className="sf-c">
            <select aria-label={t('set.offline.days')} value={days} disabled={offlineMode} onChange={(e) => apply(true, Number(e.target.value) as OfflineDays)}>
              {OFFLINE_DAYS.map((d) => <option key={d} value={d}>{t('set.offline.daysOption', { n: d })}</option>)}
            </select>
          </div>
        </div>
      )}
    </>
  )
}
