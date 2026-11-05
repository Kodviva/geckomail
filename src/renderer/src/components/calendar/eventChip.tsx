// Örnek gösterimi: başlık düz metin; saat istemci diliminde.
import type { CSSProperties } from 'react'
import type { EventOccurrence } from '../../../../shared/pim'
import { fmtTime, t } from '../../../../shared/i18n'

export const eventTitle = (o: EventOccurrence): string => o.title || t('calendar.noTitle')
export const eventColor = (color: string | null): CSSProperties => (color ? ({ '--cal-color': color } as CSSProperties) : {})

export function EventChip({ o, color, onOpen, time = true }: { o: EventOccurrence; color: string | null; onOpen: (o: EventOccurrence) => void; time?: boolean }) {
  return (
    <button type="button" className={`cal-chip${o.cancelled ? ' cancelled' : ''}`} style={eventColor(color)} title={eventTitle(o)} onClick={(e) => {
      e.stopPropagation()
      onOpen(o)
    }}>
      {time && !o.allDay && <span className="cal-chip-time">{fmtTime(o.start)}</span>} {eventTitle(o)}
    </button>
  )
}
