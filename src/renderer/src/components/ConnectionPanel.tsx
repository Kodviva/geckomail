// Ayarlar › Bağlantı: sunucu başına governor durumu, açık oturumlar ve son 24 saatin login sonuçları.
// Sunucunun otomatik engelleme eşiği (günlük başarısız giriş) sunucuya göre değişir: yönetici girerse sayaç
// eşiğe yaklaşınca uyarır; girilmemişse yalnız sayı gösterilir.
import { useEffect, useState } from 'react'
import { rpc } from '../rpcClient'
import { useStore } from '../store'
import { fmtDateTime, fmtNumber, t } from '../../../shared/i18n'
import { platform } from '../platform'
import { adminUi } from '../adminUi'

const RESULT_KEYS = new Set(['auth', 'preauth', 'net', 'limit', 'other'])

function resultLabel(r: string): string {
  return RESULT_KEYS.has(r) ? t(`set.connp.result.${r}`) : r
}

function fmtShort(ts: number): string {
  return fmtDateTime(ts, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function ConnectionPanel() {
  const stats = useStore((s) => s.connectionStats)
  const refresh = useStore((s) => s.refreshConnectionStats)
  const isAdmin = useStore((s) => adminUi(s.currentUser))
  const toast = useStore((s) => s.toast)
  const exportDiag = async () => {
    try {
      const { filename, data } = await rpc.call('exportDiagnostics', {})
      if (await platform.saveBytes(filename, data)) toast(t('set.connp.diagSaved'), 'info')
    } catch (e) {
      toast(t('set.connp.diagFailed', { error: (e as Error).message }))
    }
  }

  const [banLimit, setBanLimit] = useState<number | null>(null)
  const [banDraft, setBanDraft] = useState('')
  useEffect(() => {
    void rpc.call('getPrefs', {}).then((p) => {
      const n = Number(p.authBanPerDay)
      setBanLimit(n > 0 ? n : null)
      setBanDraft(n > 0 ? String(n) : '')
    })
  }, [])
  const saveBanLimit = async () => {
    const n = Math.round(Number(banDraft))
    const v = n > 0 && n < 100_000 ? String(n) : ''
    try {
      await rpc.call('setPrefs', { values: { authBanPerDay: v } })
      setBanLimit(v ? n : null)
    } catch (e) {
      toast((e as Error).message)
    }
  }

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 10_000)
    return () => clearInterval(timer)
  }, [refresh])

  if (!stats) return <div className="empty-note">{t('state.loading')}</div>
  if (!stats.hosts.length) return <div className="empty-note">{t('set.connp.noConnections')}</div>

  return (
    <div className="conn-panel">
      {isAdmin && (
        <div className="conn-actions">
          <button type="button" onClick={() => void exportDiag()} title={t('set.connp.exportDiagTitle')}>
            <svg className="icon sm"><use href="#i-save" /></svg> {t('set.connp.exportDiag')}
          </button>
        </div>
      )}
      {stats.hosts.map((h) => {
        const authPct = banLimit ? Math.round((h.last24h.auth / banLimit) * 100) : null
        // eşik bilinmiyorsa temkinli varsayılan: 20+ uyarı, 50+ tehlike
        const authLevel = banLimit
          ? h.last24h.auth >= banLimit * 0.5 ? 'bad' : h.last24h.auth >= banLimit * 0.2 ? 'warn' : 'ok'
          : h.last24h.auth >= 50 ? 'bad' : h.last24h.auth >= 20 ? 'warn' : 'ok'
        return (
          <div key={h.host} className="set-group conn-host">
            <div className="set-field">
              <div className="sf-l">
                <div className="sf-t">{h.host}</div>
                <div className="sf-h">
                  {h.state === 'ok'
                    ? t('set.connp.okHint')
                    : h.state === 'probing'
                      ? t('set.connp.probingHint')
                      : h.cooldownUntil
                        ? t('set.connp.cooldownHint', { reason: t(h.reason === 'limit' ? 'set.connp.reasonLimit' : 'set.connp.reasonBan'), until: fmtShort(h.cooldownUntil) })
                        : t('set.connp.cooldownHintNoTime', { reason: t(h.reason === 'limit' ? 'set.connp.reasonLimit' : 'set.connp.reasonBan') })}
                </div>
              </div>
              <div className={`conn-state ${h.state}`}>{h.state === 'ok' ? t('set.connp.stateOk') : h.state === 'probing' ? t('set.connp.stateProbing') : t('set.connp.stateCooldown')}</div>
            </div>
            <div className="set-field">
              <div className="sf-l">
                <div className="sf-t">{t('set.connp.sessions')}</div>
                <div className="sf-h">{t('set.connp.sessionsHint')}</div>
              </div>
              <div className="sf-c conn-num">
                {h.sessions} / {h.maxSessions}
              </div>
            </div>
            <div className="set-field">
              <div className="sf-l">
                <div className="sf-t">{t('set.connp.authFails')}</div>
                <div className="sf-h">
                  {banLimit ? t('set.connp.banKnown', { limit: banLimit }) : t('set.connp.banUnknown')} {t('set.connp.retryNote')}
                </div>
              </div>
              <div className={`sf-c conn-num ${authLevel}`}>
                {h.last24h.auth}
                {banLimit && (
                  <>
                    {' '}/ {fmtNumber(banLimit)} <small>({fmtNumber((authPct ?? 0) / 100, { style: 'percent' })})</small>
                  </>
                )}
              </div>
            </div>
            <div className="set-field">
              <div className="sf-l">
                <div className="sf-t">{t('set.connp.logins')}</div>
                <div className="sf-h">{t('set.connp.loginsHint', { rate: h.loginsPerMin })}</div>
              </div>
              <div className="sf-c conn-counts">
                <span>✓ {h.last24h.ok}</span>
                <span>{t('set.connp.countPreauth', { count: h.last24h.preauth })}</span>
                <span>{t('set.connp.countLimit', { count: h.last24h.limit })}</span>
              </div>
            </div>
          </div>
        )
      })}
      {isAdmin && (
        <div className="set-group">
          <div className="set-field">
            <div className="sf-l">
              <div className="sf-t">{t('set.connp.banThreshold')}</div>
              <div className="sf-h">{t('set.connp.banThresholdHint')}</div>
            </div>
            <div className="sf-c">
              <input
                type="number"
                min={1}
                value={banDraft}
                placeholder={t('set.connp.banPlaceholder')}
                onChange={(e) => setBanDraft(e.target.value)}
                onBlur={() => void saveBanLimit()}
                aria-label={t('set.connp.banAria')}
              />
            </div>
          </div>
        </div>
      )}
      {stats.recentFailures.length > 0 && (
        <div className="set-group">
          <div className="set-field">
            <div className="sf-l">
              <div className="sf-t">{t('set.connp.recentFails')}</div>
            </div>
          </div>
          <div className="conn-fails">
            {stats.recentFailures.map((f, i) => (
              <div key={i} className="conn-fail">
                <span className="conn-fail-time">{fmtShort(f.ts)}</span>
                <span className="conn-fail-acct">{f.email ?? '—'}</span>
                <span className="conn-fail-kind">
                  {f.lane.toUpperCase()} · {resultLabel(f.result)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
