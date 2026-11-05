// Takvim sayfası: ay, hafta, gün, ajanda. Dar ekranda varsayılan ajanda, hafta seçeneği yok, takvim listesi pencerede; ayrıntı tek bölme
// (geri tuşu takvime döner). Saatler istemci dilimiyle gösterilir.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { EventDraft, EventOccurrence } from '../../../../shared/pim'
import { fmtDate, getLocale, intlTag, t } from '../../../../shared/i18n'
import { dayEnd, dayStart, firstDayOfWeek, isoDay, monthGrid, shiftDay, weekOf } from '../../calendarLayout'
import { MenuButton } from '../../layout/MobileNav'
import { navBreakpoint, useBreakpoint } from '../../layout/useBreakpoint'
import { platform } from '../../platform'
import { readOfflineEvents } from '../../offline/pim'
import { rpc } from '../../rpcClient'
import { useStore } from '../../store'
import Modal from '../Modal'
import AgendaView from './AgendaView'
import CalendarList from './CalendarList'
import DayView from './DayView'
import EventDetailPane from './EventDetailPane'
import EventEditor, { type EditorTarget } from './EventEditor'
import MonthView from './MonthView'
import WeekView from './WeekView'

export type CalendarView = 'month' | 'week' | 'day' | 'agenda'

const AGENDA_DAYS = 30
const zone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const VIEW_LABEL: Record<CalendarView, string> = { month: 'calendar.view.month', week: 'calendar.view.week', day: 'calendar.view.day', agenda: 'calendar.view.agenda' }

function rangeOf(view: CalendarView, anchor: string, firstDay: number): [string, string] {
  if (view === 'day') return [anchor, shiftDay(anchor, 1)]
  if (view === 'agenda') return [anchor, shiftDay(anchor, AGENDA_DAYS)]
  if (view === 'week') {
    const days = weekOf(anchor, firstDay)
    return [days[0], shiftDay(days[6], 1)]
  }
  const [y, mo] = anchor.split('-').map(Number)
  const grid = monthGrid(y, mo, firstDay)
  return [grid[0][0], shiftDay(grid[5][6], 1)]
}

function stepOf(view: CalendarView, anchor: string, dir: 1 | -1): string {
  if (view === 'day') return shiftDay(anchor, dir)
  if (view === 'week') return shiftDay(anchor, 7 * dir)
  if (view === 'agenda') return shiftDay(anchor, AGENDA_DAYS * dir)
  const [y, mo] = anchor.split('-').map(Number)
  const d = new Date(Date.UTC(y, mo - 1 + dir, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

function blankDraft(day: string, tz: string): EventDraft {
  const hour = new Date().getHours()
  const start = `${String(Math.min(hour + 1, 23)).padStart(2, '0')}:00`
  const end = `${String(Math.min(hour + 2, 23)).padStart(2, '0')}:${hour + 2 > 23 ? '59' : '00'}`
  return { title: '', location: null, description: null, allDay: false, start: `${day}T${start}`, end: `${day}T${end}`, tz, rrule: null, alarmMinutes: null }
}

export default function CalendarPage() {
  const narrow = navBreakpoint(useBreakpoint(), platform.kind, true) === 'narrow'
  const wide = navBreakpoint(useBreakpoint(), platform.kind, true) === 'wide'
  const selected = useStore((s) => s.selectedEvent)
  const select = useStore((s) => s.setSelectedEvent)
  const collections = useStore((s) => s.pimCollections.calendar)
  const refreshCollections = useStore((s) => s.refreshPimCollections)
  const offline = useStore((s) => s.offlineMode)
  const tz = useMemo(() => zone(), [])
  const firstDay = useMemo(() => firstDayOfWeek(intlTag(getLocale())), [])
  const [chosen, setChosen] = useState<CalendarView>(narrow ? 'agenda' : 'month')
  const view: CalendarView = narrow && chosen === 'week' ? 'day' : chosen
  const [anchor, setAnchor] = useState(() => isoDay(Date.now(), tz))
  const [events, setEvents] = useState<EventOccurrence[]>([])
  const [failed, setFailed] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [editing, setEditing] = useState<EditorTarget | null>(null)
  const writable = useMemo(() => collections.filter((c) => c.canWrite), [collections])
  const [from, to] = useMemo(() => rangeOf(view, anchor, firstDay), [view, anchor, firstDay])

  const load = useCallback((): void => {
    const start = dayStart(from, tz)
    const end = dayEnd(shiftDay(to, -1), tz)
    void (offline ? readOfflineEvents(start, end) : rpc.call('listEvents', { from: start, to: end, tz })).then(
      (list) => {
        setEvents(list)
        setFailed(false)
      },
      () => setFailed(true)
    )
  }, [from, to, tz, offline])
  useEffect(load, [load])
  useEffect(() => {
    void refreshCollections()
  }, [refreshCollections])
  useEffect(() => rpc.on('pim:changed', ({ kind }) => {
    if (kind === 'calendar' || kind === 'sources') load()
  }), [load])

  const colorOf = useCallback((id: number) => collections.find((c) => c.id === id)?.color ?? null, [collections])
  const title = useMemo(() => {
    const at = dayStart(anchor, tz)
    return view === 'month' ? fmtDate(at, { month: 'long', year: 'numeric' }) : fmtDate(at, { day: 'numeric', month: 'long', year: 'numeric' })
  }, [anchor, tz, view])
  const beyondWindow = collections.some((c) => !c.hidden && c.windowEnd != null && dayStart(from, tz) + 1 > c.windowEnd)
  const openEvent = (o: EventOccurrence): void => select({ objectId: o.objectId, recurrenceId: o.recurrenceId })
  const openDay = (day: string): void => {
    setAnchor(day)
    setChosen(narrow ? 'agenda' : 'day')
  }
  const showCalendar = !narrow || !selected
  const viewOptions: CalendarView[] = narrow ? ['agenda', 'day', 'month'] : ['month', 'week', 'day', 'agenda']
  const list = <CalendarList collections={collections} onChanged={() => { void refreshCollections(); load() }} />

  return (
    <main className="pim-page cal-page" aria-label={t('calendar.title')}>
      {wide && <aside className="cal-side">{list}</aside>}
      {showCalendar && (
        <section className="cal-main">
          <header className="cal-head">
            <MenuButton />
            <div className="cal-title">{title}</div>
            <div className="btn-group">
              <button type="button" className="btn-icon btn-sm" aria-label={t('calendar.prev')} title={t('calendar.prev')} onClick={() => setAnchor(stepOf(view, anchor, -1))}><svg className="icon sm cal-prev-ic"><use href="#i-chevron" /></svg></button>
              <button type="button" className="btn-sm" onClick={() => setAnchor(isoDay(Date.now(), tz))}>{t('calendar.today')}</button>
              <button type="button" className="btn-icon btn-sm" aria-label={t('calendar.next')} title={t('calendar.next')} onClick={() => setAnchor(stepOf(view, anchor, 1))}><svg className="icon sm cal-next-ic"><use href="#i-chevron" /></svg></button>
            </div>
            <select className="cal-view-select" aria-label={t('calendar.view.label')} value={view} onChange={(e) => setChosen(e.target.value as CalendarView)}>
              {viewOptions.map((v) => <option key={v} value={v}>{t(VIEW_LABEL[v])}</option>)}
            </select>
            {!wide && <button type="button" className="btn-sm" onClick={() => setListOpen(true)}>{t('calendar.list')}</button>}
            {!!writable.length && (
              <button type="button" className="primary btn-sm" disabled={offline} onClick={() => setEditing({ draft: blankDraft(anchor, tz), collectionId: writable[0].id })}>
                <svg className="icon sm"><use href="#i-plus" /></svg> {t('calendar.new')}
              </button>
            )}
          </header>
          {beyondWindow && <div className="pim-banner" role="status">{t('calendar.windowWarning')}</div>}
          {failed && <div className="pim-empty" role="alert">{t('calendar.loadFailed')}</div>}
          {offline && !failed && !events.length && <div className="pim-empty" role="status">{t('calendar.offlineEmpty')}</div>}
          <div className="cal-body">
            {view === 'month' && <MonthView anchor={anchor} firstDay={firstDay} tz={tz} events={events} dots={narrow} colorOf={colorOf} onDay={openDay} onEvent={openEvent} />}
            {view === 'week' && <WeekView anchor={anchor} firstDay={firstDay} tz={tz} events={events} colorOf={colorOf} onEvent={openEvent} />}
            {view === 'day' && <DayView day={anchor} tz={tz} events={events} colorOf={colorOf} onEvent={openEvent} />}
            {view === 'agenda' && <AgendaView from={anchor} tz={tz} events={events} colorOf={colorOf} onEvent={openEvent} />}
          </div>
        </section>
      )}
      {selected && (
        <section className="viewpane pim-detailpane cal-detail">
          <EventDetailPane key={`${selected.objectId}:${selected.recurrenceId ?? ''}`} objectId={selected.objectId} recurrenceId={selected.recurrenceId} tz={tz} collections={collections}
            onEdit={setEditing} onClose={() => select(null)} onChanged={load} />
        </section>
      )}
      {listOpen && (
        <Modal onClose={() => setListOpen(false)} className="pim-editor">
          <div className="modal-title">{t('calendar.list')}</div>
          {list}
        </Modal>
      )}
      {editing && <EventEditor target={editing} collections={writable} tz={tz} onClose={() => setEditing(null)} onSaved={(objectId) => {
        setEditing(null)
        select({ objectId, recurrenceId: editing.scope === 'this' ? editing.recurrenceId ?? null : null })
        load()
      }} />}
    </main>
  )
}
