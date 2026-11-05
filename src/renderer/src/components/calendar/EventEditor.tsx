// Etkinlik düzenleyici. Yazma sunucuya eşzamanlı gider; çakışmada kullanıcı sunucudaki sürümü alır ya da güncel etag ile kendininkini yazar.
import { useState } from 'react'
import type { EditScope, EventDraft, PimCollectionInfo, RecurrenceInput } from '../../../../shared/pim'
import { t } from '../../../../shared/i18n'
import { shiftDay } from '../../calendarLayout'
import { rpc } from '../../rpcClient'
import { useStore } from '../../store'
import Modal from '../Modal'

export interface EditorTarget {
  draft: EventDraft
  collectionId: number
  objectId?: number
  etag?: string | null
  scope?: EditScope
  recurrenceId?: string
}

const FREQS: RecurrenceInput['freq'][] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']
const ALARMS = [0, 5, 15, 30, 60, 1440]
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

const FREQ_KEY: Record<RecurrenceInput['freq'], string> = { DAILY: 'calendar.repeat.daily', WEEKLY: 'calendar.repeat.weekly', MONTHLY: 'calendar.repeat.monthly', YEARLY: 'calendar.repeat.yearly' }

export default function EventEditor({ target, collections, tz, onClose, onSaved }: { target: EditorTarget; collections: PimCollectionInfo[]; tz: string; onClose: () => void; onSaved: (objectId: number) => void }) {
  const toast = useStore((s) => s.toast)
  const isNew = target.objectId == null
  const [collectionId, setCollectionId] = useState(target.collectionId)
  // tüm günde bitiş taslakta hariç, formda dahil
  const [d, setD] = useState<EventDraft>(() => (target.draft.allDay ? { ...target.draft, end: shiftDay(target.draft.end, -1) } : target.draft))
  const [etag, setEtag] = useState(target.etag)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const set = (patch: Partial<EventDraft>): void => setD({ ...d, ...patch })
  const showRepeat = target.scope !== 'this'
  const rule = d.rrule

  const toggleAllDay = (allDay: boolean): void => {
    if (allDay) set({ allDay, start: d.start.slice(0, 10), end: d.end.slice(0, 10) })
    else set({ allDay, start: `${d.start.slice(0, 10)}T09:00`, end: `${d.end.slice(0, 10)}T10:00` })
  }
  const setRule = (patch: Partial<RecurrenceInput> | null): void => set({ rrule: patch && { ...(rule ?? { freq: 'WEEKLY', interval: 1 }), ...patch } })

  const saveEventDraft = useStore.getState().saveEventDraft
  const save = async (withEtag: string | null | undefined): Promise<void> => {
    setBusy(true)
    try {
      const draft: EventDraft = d.allDay ? { ...d, end: shiftDay(d.end, 1) } : d
      const r = await saveEventDraft({ collectionId, draft, ...(isNew ? {} : { objectId: target.objectId, etag: withEtag }), ...(target.scope && target.scope !== 'all' ? { scope: target.scope, recurrenceId: target.recurrenceId } : {}) })
      if (!r) return
      if (r.ok) onSaved(r.objectId)
      else setConflict(true)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const overwrite = async (): Promise<void> => {
    const fresh = await rpc.call('getEvent', { objectId: target.objectId!, tz })
    setEtag(fresh.etag)
    setConflict(false)
    await save(fresh.etag)
  }

  if (conflict)
    return (
      <Modal onClose={onClose} className="pim-editor">
        <div className="modal-title">{t('calendar.conflictTitle')}</div>
        <p>{t('calendar.conflict')}</p>
        <div className="modal-foot">
          <button type="button" onClick={onClose}>{t('calendar.conflict.theirs')}</button>
          <button type="button" className="primary" disabled={busy} onClick={() => void overwrite().catch((e: Error) => toast(e.message))}>{t('calendar.conflict.mine')}</button>
        </div>
      </Modal>
    )

  const dateType = d.allDay ? 'date' : 'datetime-local'
  return (
    <Modal onClose={onClose} className="pim-editor" confirmOnDirty closeOnBackdrop={false}>
      <div className="modal-title">{isNew ? t('calendar.new') : d.title || t('calendar.noTitle')}</div>
      <form className="pim-form" onSubmit={(e) => {
        e.preventDefault()
        void save(etag)
      }}>
        {isNew && collections.length > 1 && (
          <label>{t('calendar.field.calendar')}
            <select value={collectionId} onChange={(e) => setCollectionId(Number(e.target.value))}>{collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
        )}
        <label>{t('calendar.field.title')}<input value={d.title} autoFocus onChange={(e) => set({ title: e.target.value })} /></label>
        <label>{t('calendar.field.location')}<input value={d.location ?? ''} onChange={(e) => set({ location: e.target.value || null })} /></label>
        <label className="pim-check"><input type="checkbox" checked={d.allDay} onChange={(e) => toggleAllDay(e.target.checked)} /> {t('calendar.allDay')}</label>
        <div className="pim-pair">
          <label>{t('calendar.field.start')}<input type={dateType} required value={d.start} onChange={(e) => set({ start: e.target.value, ...(e.target.value > d.end ? { end: e.target.value } : {}) })} /></label>
          <label>{t('calendar.field.end')}<input type={dateType} required min={d.start} value={d.end} onChange={(e) => set({ end: e.target.value })} /></label>
        </div>
        {!d.allDay && <div className="contact-sub">{t('calendar.timezone', { tz: d.tz })}</div>}
        {showRepeat && (d.rruleRaw ? (
          <div className="contact-sub">{t('calendar.repeat.custom')}</div>
        ) : (
          <>
            <label>{t('calendar.field.repeat')}
              <select value={rule?.freq ?? ''} onChange={(e) => setRule(e.target.value ? { freq: e.target.value as RecurrenceInput['freq'] } : null)}>
                <option value="">{t('calendar.repeat.none')}</option>
                {FREQS.map((f) => <option key={f} value={f}>{t(FREQ_KEY[f])}</option>)}
              </select>
            </label>
            {rule && (
              <div className="pim-pair">
                <label>{t('calendar.repeat.interval')}<input type="number" min={1} max={1000} value={rule.interval} onChange={(e) => setRule({ interval: Math.max(1, Number(e.target.value) || 1) })} /></label>
                <label>{t('calendar.repeat.until')}<input type="date" value={rule.until ?? ''} onChange={(e) => setRule({ until: e.target.value || undefined, count: undefined })} /></label>
              </div>
            )}
            {rule?.freq === 'WEEKLY' && (
              <div className="chip-row" role="group" aria-label={t('calendar.repeat.days')}>
                {WEEKDAYS.map((w) => (
                  <button key={w} type="button" className="chip" aria-pressed={rule.byDay?.includes(w) ?? false} onClick={() => setRule({ byDay: rule.byDay?.includes(w) ? rule.byDay.filter((x) => x !== w) : [...(rule.byDay ?? []), w] })}>{t(`calendar.day.${w}`)}</button>
                ))}
              </div>
            )}
          </>
        ))}
        <label>{t('calendar.field.alarm')}
          <select value={d.alarmMinutes ?? ''} onChange={(e) => set({ alarmMinutes: e.target.value === '' ? null : Number(e.target.value) })}>
            <option value="">{t('calendar.alarm.none')}</option>
            {[...new Set([...ALARMS, ...(d.alarmMinutes != null ? [d.alarmMinutes] : [])])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m ? t('calendar.alarm.before', { minutes: m }) : t('calendar.alarm.atStart')}</option>)}
          </select>
        </label>
        <label>{t('calendar.field.description')}<textarea rows={4} value={d.description ?? ''} onChange={(e) => set({ description: e.target.value || null })} /></label>
        <div className="modal-foot">
          <button type="button" onClick={onClose}>{t('action.cancel')}</button>
          <button type="submit" className="primary" disabled={busy}>{t('action.save')}</button>
        </div>
      </form>
    </Modal>
  )
}
