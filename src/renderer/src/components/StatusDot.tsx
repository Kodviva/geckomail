import type { AccountInfo } from '../../../shared/rpc'
import { statusLabel } from '../accountHealth'

// gözcü noktası: logodaki iri gözlerden gelen durum motifi — halka + kayık göz bebeği
export function StatusDot({ a }: { a: AccountInfo }) {
  const cls =
    a.status === 'ok' ? 'ok' : a.status === 'degraded' ? 'warn' : a.status === 'unknown' ? 'idle' : a.status === 'disabled' ? 'off' : 'err'
  // uyarıda sunucunun ayrıntısı (varsa) daha açıklayıcı
  const label = a.status === 'degraded' && a.statusDetail ? a.statusDetail : statusLabel(a.status)
  // renk tek başına yetmez (renk körlüğü, gri tonlu ekran): her durumun ayrı bir iç şekli var (UX-P1-9)
  return (
    <svg className={`eye eye-${cls} ${cls === 'ok' ? 'pulse' : ''}`} viewBox="0 0 10 10" role="img" aria-label={label}>
      <title>{label}</title>
      <circle cx="5" cy="5" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      {cls === 'ok' && <circle cx="5.8" cy="4.2" r="1.5" fill="currentColor" />}
      {cls === 'warn' && (
        <>
          <rect x="4.35" y="2.2" width="1.3" height="3.4" rx="0.5" fill="currentColor" />
          <circle cx="5" cy="7.1" r="0.8" fill="currentColor" />
        </>
      )}
      {cls === 'err' && <path d="M3.3 3.3 L6.7 6.7 M6.7 3.3 L3.3 6.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
      {cls === 'off' && <path d="M3.2 6.8 L6.8 3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
    </svg>
  )
}
