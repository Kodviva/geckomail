export interface AnomalyResult {
  isAnomaly: boolean
  kind: 'silence' | 'burst' | null
  baseline: number
  current: number
}

const DAY_MS = 86_400_000

// İzleme kutusunda sessizlik arızanın kendisi olabilir: hesap normalden çok az/çok mail
// alırsa işaretler. Taban çizgisi = geçmiş günlük sayımların medyanı (ML yok, kayan pencere).
// `dates`: hesabın inbox mesaj zaman damgaları (ms). `nowMs` test edilebilirlik için enjekte edilir.
// Yeterli geçmiş yoksa (hesap yeni/az veri) hep false döner — erken/yanlış alarmı önler.
export function detectAccountAnomaly(dates: number[], nowMs: number, lookbackDays = 14, minHistoryDays = 5): AnomalyResult {
  const oldest = dates.length ? Math.min(...dates) : nowMs
  const historyDays = Math.floor((nowMs - oldest) / DAY_MS)
  if (historyDays < minHistoryDays) return { isAnomaly: false, kind: null, baseline: 0, current: 0 }

  // lookback, hesabın gerçekte gözlemlenen geçmişini aşmasın — aşarsa "veri yok" günleri
  // sahte sıfır olarak medyanı aşağı çeker (henüz 14 günlük geçmişi olmayan hesaplarda yanlış alarm)
  const effectiveLookback = Math.min(lookbackDays, historyDays)
  const current = dates.filter((d) => d > nowMs - DAY_MS && d <= nowMs).length
  const dayCounts: number[] = []
  for (let i = 1; i <= effectiveLookback; i++) {
    const from = nowMs - (i + 1) * DAY_MS
    const to = nowMs - i * DAY_MS
    dayCounts.push(dates.filter((d) => d > from && d <= to).length)
  }
  const sorted = [...dayCounts].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const baseline = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2

  if (baseline === 0) return { isAnomaly: current >= 3, kind: current >= 3 ? 'burst' : null, baseline, current }
  if (current >= baseline * 3) return { isAnomaly: true, kind: 'burst', baseline, current }
  if (current <= baseline * 0.2) return { isAnomaly: true, kind: 'silence', baseline, current }
  return { isAnomaly: false, kind: null, baseline, current }
}
