import { useMemo } from 'react'
import type { EventOccurrence } from '../../../../shared/pim'
import { fmtDate, fmtTime, t } from '../../../../shared/i18n'
import { dayStart, eventsOnDay, shiftDay } from '../../calendarLayout'
import { eventColor, eventTitle } from './eventChip'

const DAYS = 30

export default function AgendaView({ from, tz, events, colorOf, onEvent }: { from: string; tz: string; events: EventOccurrence[]; colorOf: (id: number) => string | null; onEvent: (o: EventOccurrence) => void }) {
  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => shiftDay(from, i)).map((day) => ({ day, list: eventsOnDay(events, day, tz) })).filter((d) => d.list.length), [from, tz, events])
  if (!days.length) return <div className="pim-empty">{t('calendar.empty')}</div>
  return (
    <div className="cal-agenda">
      {days.map(({ day, list }) => (
        <section key={day}>
          <h3>{fmtDate(dayStart(day, tz), { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
          {list.map((o) => (
            <button key={o.key} type="button" className={`cal-agenda-row${o.cancelled ? ' cancelled' : ''}`} style={eventColor(colorOf(o.collectionId))} onClick={() => onEvent(o)}>
              <span className="cal-agenda-time">{o.allDay ? t('calendar.allDay') : `${fmtTime(o.start)}–${fmtTime(o.end)}`}</span>
              <span className="cal-agenda-title">{eventTitle(o)}</span>
              {o.location && <span className="contact-sub">{o.location}</span>}
            </button>
          ))}
        </section>
      ))}
    </div>
  )
}
