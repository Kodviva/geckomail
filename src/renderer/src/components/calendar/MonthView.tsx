import { useMemo, useState } from 'react'
import type { EventOccurrence } from '../../../../shared/pim'
import { fmtDate } from '../../../../shared/i18n'
import { dayStart, eventsOnDay, isoDay, monthGrid } from '../../calendarLayout'
import { EventChip, eventColor } from './eventChip'

const MAX_CHIPS = 3

export default function MonthView({ anchor, firstDay, tz, events, dots, colorOf, onDay, onEvent }: {
  anchor: string
  firstDay: number
  tz: string
  events: EventOccurrence[]
  dots: boolean
  colorOf: (id: number) => string | null
  onDay: (day: string) => void
  onEvent: (o: EventOccurrence) => void
}) {
  const [y, mo] = anchor.split('-').map(Number)
  const grid = useMemo(() => monthGrid(y, mo, firstDay), [y, mo, firstDay])
  const [today] = useState(() => isoDay(Date.now(), tz))
  const month = anchor.slice(0, 7)
  return (
    <div className="cal-month" role="grid">
      <div className="cal-month-head" role="row">
        {grid[0].map((d) => <div key={d} role="columnheader">{fmtDate(dayStart(d, tz), { weekday: 'short' })}</div>)}
      </div>
      {grid.map((week) => (
        <div className="cal-week-row" role="row" key={week[0]}>
          {week.map((day) => {
            const list = eventsOnDay(events, day, tz)
            return (
              <div key={day} role="gridcell" className={`cal-day${day.startsWith(month) ? '' : ' other'}${day === today ? ' today' : ''}`} onClick={() => onDay(day)}>
                <button type="button" className="cal-day-num" aria-label={fmtDate(dayStart(day, tz), { day: 'numeric', month: 'long' })} onClick={() => onDay(day)}>{Number(day.slice(8))}</button>
                {dots ? (
                  <span className="cal-dots" aria-hidden="true">{list.slice(0, 4).map((o) => <i key={o.key} style={eventColor(colorOf(o.collectionId))} />)}</span>
                ) : (
                  <>
                    {list.slice(0, MAX_CHIPS).map((o) => <EventChip key={o.key} o={o} color={colorOf(o.collectionId)} onOpen={onEvent} />)}
                    {list.length > MAX_CHIPS && <span className="cal-more">+{list.length - MAX_CHIPS}</span>}
                  </>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
