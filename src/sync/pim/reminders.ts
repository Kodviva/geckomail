// Takvim hatırlatmaları. Sıradaki an teslimden önce, tek transaction'da ilerler: yeniden başlatma aynı hatırlatmayı iki kez göndermez,
// sessiz saate denk gelen sonradan gönderilmez. Bir saatten eski hatırlatma (uygulama kapalıydı) sessizce atlanır.
import { tFor, type Locale } from '../../shared/i18n'
import type { DueAlarmRow, Queries } from '../db/queries'
import type { NotifyPipeline } from '../notifyPipeline'
import { usersFor } from '../notifyPipeline'
import { viewerZone } from './apply'
import { parseCalendar, type ParsedCalendar } from './ical'
import { expandObject, nextAlarmAt } from './recur'

const STALE_MS = 3_600_000
const BATCH = 500
const LOOKAHEAD_MS = 8 * 864e5

function recipients(q: Queries, row: DueAlarmRow): number[] {
  const off = q.reminderOffUsers(row.collection_id)
  const users = row.account_id != null ? usersFor(q, row.account_id) : [row.owner_user_id!]
  return users.filter((u) => !off.has(u))
}

/** Hatırlatmanın ait olduğu örnek: alarmdan sonraki ilk başlangıç */
function occurrenceAfter(c: ParsedCalendar, alarm: number): { title: string; minutes: number } {
  const occ = expandObject(c, alarm - 1, alarm + LOOKAHEAD_MS, 'UTC').find((o) => o.start >= alarm)
  return { title: (occ?.event ?? c.events[0]).summary, minutes: occ ? Math.round((occ.start - alarm) / 60_000) : 0 }
}

/** Gönderilen duyuru sayısı */
export function deliverDueReminders(q: Queries, notifications: Pick<NotifyPipeline, 'notice'>, now: number): number {
  const rows = q.dueAlarms(now, BATCH)
  const zone = viewerZone()
  const parsed = new Map(rows.map((r) => [r.id, parseCalendar(r.raw)]))
  q.pimTransaction(() => {
    for (const r of rows) {
      const c = parsed.get(r.id)
      q.setNextAlarm(r.id, c ? nextAlarmAt(c, now, zone) : null)
    }
  })
  let sent = 0
  for (const r of rows) {
    const c = parsed.get(r.id)
    if (!c || now - r.next_alarm_at > STALE_MS) continue
    const userIds = recipients(q, r)
    if (!userIds.length) continue
    const { title, minutes } = occurrenceAfter(c, r.next_alarm_at)
    // dönüş 'retry' ise (sessiz saat) yeniden denenmez
    notifications.notice({
      title: title || ((loc) => tFor(loc, 'calendar.noTitle')),
      body: (loc) => tFor(loc, 'calendar.reminder.startsIn', { minutes }),
      accountId: r.account_id, userIds,
      // kişisel takvim: masaüstünde kimse girişli değilken başlık görünmez
      ...(r.account_id == null ? { anonymousTitle: (loc: Locale) => tFor(loc, 'calendar.title') } : {})
    })
    sent++
  }
  return sent
}
