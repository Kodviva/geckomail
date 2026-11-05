// Alım kapısının denemesi: nesneyi dizinler ve açar. Yalnız kapının worker'ında çalışır; sonucu ana iş parçacığı yeniden hesaplamaz.
import { indexFields, parseCalendar } from './ical'
import { alarmMoments, expandObject, nextAlarmAt } from './recur'

const TRIAL_HORIZON_MS = 20 * 366 * 864e5
/** Ana iş parçacığının sınırı kadar: geçen nesne orada daha pahalı olmasın */
const TRIAL_ITERATIONS = 100_000

export interface GatedEvent {
  fields: NonNullable<ReturnType<typeof indexFields>>
  nextAlarmAt: number | null
}

export function trialObject(raw: string, viewerTz: string, now: number): GatedEvent | null {
  const fields = indexFields(raw, viewerTz)
  const parsed = fields && parseCalendar(raw)
  if (!fields || !parsed) return null
  // sonsuz seride indexFields açmaz: sorgunun göreceği yıllar burada denenir
  expandObject(parsed, fields.rangeStart - 1, Math.max(now, fields.rangeStart) + TRIAL_HORIZON_MS, viewerTz, { maxIterations: TRIAL_ITERATIONS })
  alarmMoments(parsed, viewerTz)
  return { fields, nextAlarmAt: nextAlarmAt(parsed, now, viewerTz) }
}
