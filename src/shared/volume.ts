export interface HourlyBucket {
  hour: number // saat başlangıcı, epoch ms
  count: number
}

// DB'den gelen seyrek satırları (mail olmayan saatler hiç dönmez) yoğun bir seriye tamamlar —
// duvar panosu sparkline'ı için boşluksuz 24 nokta gerekir.
export function buildHourlySeries(rows: HourlyBucket[], sinceMs: number, nowMs: number): HourlyBucket[] {
  const byHour = new Map(rows.map((r) => [r.hour, r.count]))
  const startHour = Math.floor(sinceMs / 3600_000) * 3600_000
  const endHour = Math.floor(nowMs / 3600_000) * 3600_000
  const out: HourlyBucket[] = []
  for (let h = startHour; h <= endHour; h += 3600_000) out.push({ hour: h, count: byHour.get(h) ?? 0 })
  return out
}
