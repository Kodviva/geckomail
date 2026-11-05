import type { Queries } from './db/queries'
import { detectAccountAnomaly } from '../shared/anomaly'

export interface AnomalyEvent {
  accountId: number
  kind: 'silence' | 'burst'
  baseline: number
  current: number
}

const LOOKBACK_MS = 20 * 86_400_000 // detectAccountAnomaly'nin varsayılan 14 günlük penceresi + pay
const RENOTIFY_MS = 24 * 3_600_000 // aynı duran anomali için günde en fazla bir bildirim

const lastNotified = new Map<number, { kind: string; at: number }>()

// Periyodik (saatlik) çağrılır — onSuccess() her poll'da değil, çünkü medyan hesabı
// 67 hesap × sık poll ile gereksiz yere pahalılaşır; saatlik yeterli hassasiyet sağlar.
export function checkAnomalies(q: Queries, onAnomaly: (ev: AnomalyEvent) => void): void {
  const now = Date.now()
  for (const row of q.getAccountRows()) {
    if (!row.enabled) continue
    const dates = q.getRecentMessageDates(row.id, now - LOOKBACK_MS)
    const r = detectAccountAnomaly(dates, now)
    if (!r.isAnomaly || !r.kind) continue
    const prev = lastNotified.get(row.id)
    if (prev && prev.kind === r.kind && now - prev.at < RENOTIFY_MS) continue
    lastNotified.set(row.id, { kind: r.kind, at: now })
    onAnomaly({ accountId: row.id, kind: r.kind, baseline: r.baseline, current: r.current })
  }
}
