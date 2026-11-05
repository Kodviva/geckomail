// Sunucu soğumadaysa (olası IP engeli / limit) kalıcı şerit: hangi sunucu, ne zamana kadar, ne yapılır.
// Tek bir bildirim kaçırılabilir; bu şerit durum sürdükçe görünür kalır (UX-P1-14).
import { useStore } from '../store'
import { fmtTime, t } from '../../../shared/i18n'
import { rich } from '../rich'


export default function HostBanner() {
  const stats = useStore((s) => s.connectionStats)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const netOnline = useStore((s) => s.netOnline)
  const bad = stats?.hosts.filter((h) => h.state !== 'ok') ?? []
  // internet yoksa sunucu satırları yanıltıcı (kesinti sunucu reddi değil): yalnız bu gösterilir
  if (!netOnline)
    return (
      <div className="host-banner offline" role="status">
        <div className="host-banner-row">
          <svg className="icon sm"><use href="#i-alert" /></svg>
          <span>
            <b>{t('acct.host.offlineTitle')}</b> {t('acct.host.offlineBody')}
          </span>
        </div>
      </div>
    )
  if (!bad.length) return null
  return (
    <div className="host-banner" role="alert">
      {bad.map((h) => (
        <div key={h.host} className="host-banner-row">
          <svg className="icon sm"><use href="#i-alert" /></svg>
          <span>
            {rich(
              h.cooldownUntil
                ? t(h.reason === 'limit' ? 'acct.host.limitUntil' : 'acct.host.refusedUntil', { time: fmtTime(h.cooldownUntil) })
                : t(h.reason === 'limit' ? 'acct.host.limitProbing' : 'acct.host.refusedProbing'),
              { host: <b>{h.host}</b> }
            )}
          </span>
          <button type="button" className="link-btn" onClick={() => setSettingsOpen(true, 'baglanti')}>
            {t('acct.common.details')}
          </button>
        </div>
      ))}
    </div>
  )
}
