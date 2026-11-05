import { useEffect, useMemo, useState } from 'react'
import type { AccountInfo, AccountStatus, HourlyVolumePoint, IncidentInfo } from '../../../shared/rpc'
import LogoMark from './LogoMark'
import IconSprite from './IconSprite'
import { StatusDot } from './StatusDot'
import { t, fmtTime, getLocale, isLocale, onLocaleChange } from '../../../shared/i18n'
import { applyLocale } from '../locale'

export interface WallboardSnapshot {
  accounts: AccountInfo[]
  incidents: IncidentInfo[]
  hourlyVolume: HourlyVolumePoint[]
  updatedAt: number
}

const STATUS_ORDER: Record<AccountStatus, number> = { auth_failed: 0, unreachable: 1, degraded: 2, unknown: 3, ok: 4, disabled: 5 }
const STALE_AFTER_MS = 5 * 60_000


function dotClass(s: AccountStatus): string {
  return s === 'ok' ? 'ok' : s === 'degraded' ? 'warn' : s === 'unknown' ? 'idle' : s === 'disabled' ? 'off' : 'err'
}

export default function Wallboard() {
  const [snap, setSnap] = useState<WallboardSnapshot | null>(null)
  const [live, setLive] = useState(true)
  const [, setLocaleState] = useState(getLocale())

  // dil main.tsx'teki bootLocale() ile açılışta uygulanır; duvar ayrı pencere olduğundan ana pencerede
  // dil değişince (aynı origin localStorage'ı 'gecko-locale') storage olayıyla izlenir ve yeniden çizilir
  useEffect(() => {
    const off = onLocaleChange(setLocaleState)
    const onStorage = (e: StorageEvent): void => {
      if (e.key === 'gecko-locale' && isLocale(e.newValue)) void applyLocale(e.newValue, false)
    }
    window.addEventListener('storage', onStorage)
    return () => {
      off()
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  // duvar penceresi kasıtlı olarak sabit koyu — sistem temasını takip etmez (bir NOC ekranı gibi)
  useEffect(() => {
    document.documentElement.dataset.theme = 'dark'
  }, [])

  useEffect(() => {
    const onMsg = (e: MessageEvent): void => {
      if (e.source === window && e.data?.type === 'gecko-wallboard-data') {
        setSnap(e.data.data as WallboardSnapshot)
        setLive(true)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  useEffect(() => {
    if (!snap) return
    const t = setTimeout(() => setLive(false), STALE_AFTER_MS)
    return () => clearTimeout(t)
  }, [snap])

  const stats = useMemo(() => {
    if (!snap) return null
    const a = snap.accounts
    const unread = a.reduce((n, x) => n + x.unread, 0)
    const problems = a.filter((x) => x.enabled && (x.status === 'auth_failed' || x.status === 'unreachable')).length
    const degraded = a.filter((x) => x.enabled && x.status === 'degraded').length
    return { total: a.length, unread, problems, degraded, incidents: snap.incidents.length }
  }, [snap])

  const sortedAccounts = useMemo(
    () => (snap ? [...snap.accounts].sort((x, y) => STATUS_ORDER[x.status] - STATUS_ORDER[y.status] || x.email.localeCompare(y.email)) : []),
    [snap]
  )

  if (!snap || !stats) {
    return (
      <div className="wallboard">
        <IconSprite />
        <div className="wb-empty">
          <LogoMark className="logo-mark" />
          <div>{t('auto.wall.waiting')}</div>
        </div>
      </div>
    )
  }

  const volMax = Math.max(1, ...snap.hourlyVolume.map((p) => p.count))

  return (
    <div className="wallboard">
      <IconSprite />
      <div className="wb-head">
        <div className="wb-brand">
          <LogoMark className="logo-mark" />
          <span>Gecko<b>Mail</b> · {t('auto.wall.mode')}</span>
        </div>
        <div className={`wb-clock ${live ? '' : 'stale'}`}>
          <span className={`wb-live-dot ${live ? '' : 'stale'}`} />
          {live ? t('auto.wall.updated', { time: fmtTime(snap.updatedAt) }) : t('auto.wall.stale')}
        </div>
      </div>

      <div className="wb-stats">
        <div className="wb-stat"><div className="wb-num">{stats.total}</div><div className="wb-lbl">{t('auto.wall.accounts')}</div></div>
        <div className="wb-stat"><div className="wb-num">{stats.unread}</div><div className="wb-lbl">{t('auto.wall.unread')}</div></div>
        <div className={`wb-stat ${stats.problems ? 'err' : ''}`}><div className="wb-num">{stats.problems}</div><div className="wb-lbl">{t('auto.wall.problems')}</div></div>
        <div className={`wb-stat ${stats.degraded ? 'warn' : ''}`}><div className="wb-num">{stats.degraded}</div><div className="wb-lbl">{t('auto.wall.warnings')}</div></div>
        <div className={`wb-stat ${stats.incidents ? 'warn' : ''}`}><div className="wb-num">{stats.incidents}</div><div className="wb-lbl">{t('auto.wall.incidents')}</div></div>
      </div>

      <div className="wb-body">
        <div className="wb-col-main">
          <div className="wb-panel wb-panel-grow">
            <div className="wb-panel-h">{t('auto.wall.health')} <span className="wb-panel-note">{t('auto.wall.problemsFirst')}</span></div>
            <div className="wb-acct-grid">
              {sortedAccounts.map((a) => (
                <div key={a.id} className={`wb-acct s-${dotClass(a.status)}`} title={a.statusDetail ?? a.status}>
                  <StatusDot a={a} />
                  <span className="wb-acct-mail">{a.email}</span>
                  {a.unread > 0 && <span className="wb-acct-unread">{a.unread > 999 ? '999+' : a.unread}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="wb-col-side">
          <div className="wb-panel">
            <div className="wb-panel-h">{t('auto.wall.incidentsTitle')}</div>
            {snap.incidents.length > 0 ? (
              <div className="wb-incidents">
                {snap.incidents.map((inc) => (
                  <div key={inc.key} className="wb-incident-card">
                    <div className="wb-incident-subject"><svg className="icon sm"><use href="#i-alert" /></svg>{inc.subjectSample || t('auto.common.noSubject')}</div>
                    <div className="wb-incident-meta">
                      {t('auto.count.accounts', { count: inc.accountIds.length })} · {t('auto.count.messages', { count: inc.messageCount })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="wb-clear"><svg className="icon"><use href="#i-check-circle" /></svg> {t('auto.wall.noIncidents')}</div>
            )}
          </div>

          <div className="wb-panel">
            <div className="wb-panel-h">{t('auto.wall.last24h')} <span className="wb-panel-note">{t('auto.wall.hourlyVolume')}</span></div>
            <div className="wb-volume">
              {snap.hourlyVolume.map((h) => (
                <div
                  key={h.hour}
                  className="wb-bar"
                  style={{ height: `${Math.max(3, (h.count / volMax) * 100)}%` }}
                  title={`${fmtTime(h.hour, { hour: '2-digit' })} — ${t('auto.count.messages', { count: h.count })}`}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
