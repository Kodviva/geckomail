// Hafta ve gün ızgarası: duvar saati, 24 satır. Bloklar layoutDay'den gelir; konum mantıksal, RTL'de sütunlar aynalanır.
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { EventOccurrence } from '../../../../shared/pim'
import { fmtDate, fmtTime } from '../../../../shared/i18n'
import { dayStart, eventsOnDay, isoDay, layoutDay, weekOf } from '../../calendarLayout'
import { EventChip, eventColor, eventTitle } from './eventChip'

const HOUR_PX = 48
const HOURS = Array.from({ length: 24 }, (_, h) => h)
const DAY_START_HOUR = 8

export function TimeGrid({ days, tz, events, colorOf, onEvent }: { days: string[]; tz: string; events: EventOccurrence[]; colorOf: (id: number) => string | null; onEvent: (o: EventOccurrence) => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [today] = useState(() => isoDay(Date.now(), tz))
  const byKey = useMemo(() => new Map(events.map((o) => [o.key, o])), [events])
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = DAY_START_HOUR * HOUR_PX
  }, [])
  const hasAllDay = days.some((d) => eventsOnDay(events, d, tz).some((o) => o.allDay))
  return (
    <div className="cal-grid" style={{ '--cal-days': days.length } as React.CSSProperties}>
      <div className="cal-grid-head">
        <div className="cal-gutter" />
        {days.map((d) => <div key={d} className={`cal-grid-day${d === today ? ' today' : ''}`}>{fmtDate(dayStart(d, tz), { weekday: 'short', day: 'numeric' })}</div>)}
      </div>
      {hasAllDay && (
        <div className="cal-grid-allday">
          <div className="cal-gutter" />
          {days.map((d) => <div key={d}>{eventsOnDay(events, d, tz).filter((o) => o.allDay).map((o) => <EventChip key={o.key} o={o} color={colorOf(o.collectionId)} onOpen={onEvent} />)}</div>)}
        </div>
      )}
      <div className="cal-grid-body" ref={scroller}>
        <div className="cal-gutter">
          {HOURS.map((h) => <div key={h} className="cal-hour">{h ? fmtTime(Date.UTC(2020, 0, 1, h), { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : ''}</div>)}
        </div>
        {days.map((d) => (
          <div key={d} className="cal-grid-col" style={{ height: 24 * HOUR_PX }}>
            {HOURS.map((h) => <div key={h} className="cal-slot" />)}
            {layoutDay(events, d, tz).map((b) => {
              const o = byKey.get(b.key)!
              return (
                <button key={b.key} type="button" className={`cal-block${o.cancelled ? ' cancelled' : ''}${b.continuesBefore ? ' cont-before' : ''}${b.continuesAfter ? ' cont-after' : ''}`} title={eventTitle(o)}
                  style={{ ...eventColor(colorOf(o.collectionId)), top: (b.topMin / 60) * HOUR_PX, height: (b.heightMin / 60) * HOUR_PX, insetInlineStart: `${(b.column / b.columns) * 100}%`, width: `${100 / b.columns}%` }}
                  onClick={() => onEvent(o)}>
                  <span className="cal-chip-time">{fmtTime(o.start)}</span> {eventTitle(o)}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function WeekView({ anchor, firstDay, tz, events, colorOf, onEvent }: { anchor: string; firstDay: number; tz: string; events: EventOccurrence[]; colorOf: (id: number) => string | null; onEvent: (o: EventOccurrence) => void }) {
  const days = useMemo(() => weekOf(anchor, firstDay), [anchor, firstDay])
  return <TimeGrid days={days} tz={tz} events={events} colorOf={colorOf} onEvent={onEvent} />
}
