import type { EventOccurrence } from '../../../../shared/pim'
import { TimeGrid } from './WeekView'

export default function DayView({ day, tz, events, colorOf, onEvent }: { day: string; tz: string; events: EventOccurrence[]; colorOf: (id: number) => string | null; onEvent: (o: EventOccurrence) => void }) {
  return <TimeGrid days={[day]} tz={tz} events={events} colorOf={colorOf} onEvent={onEvent} />
}
