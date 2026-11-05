// Etkinlik ayrıntısı. Metin düz metindir; bağlantı yalnız http(s). Tekrar eden etkinlikte kapsam sorulur, düzenleyen başkaysa salt okunur.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { EditScope, EventDetail, PimCollectionInfo } from '../../../../shared/pim'
import { fmtDateTime, t } from '../../../../shared/i18n'
import { BackButton } from '../../layout/MobileNav'
import { readOfflineEvents } from '../../offline/pim'
import { rpc } from '../../rpcClient'
import { useStore } from '../../store'
import Modal from '../Modal'
import { eventTitle } from './eventChip'
import type { EditorTarget } from './EventEditor'

const OFFLINE_SPAN_MS = 250 * 864e5
const LINK = /(https?:\/\/[^\s<>"']+)/gi

function Linked({ text }: { text: string }) {
  const parts: ReactNode[] = text.split(LINK).map((p, i) => (i % 2 ? <a key={i} href={p} target="_blank" rel="noopener noreferrer">{p}</a> : p))
  return <>{parts}</>
}

function whenText(d: EventDetail): string {
  const o = d.occurrence
  if (o.allDay) return o.startDate === null ? '' : o.endDate && o.endDate !== o.startDate ? `${o.startDate} – ${o.endDate}` : o.startDate
  return `${fmtDateTime(o.start, { dateStyle: 'medium', timeStyle: 'short' })} – ${fmtDateTime(o.end, { timeStyle: 'short' })}`
}

export default function EventDetailPane({ objectId, recurrenceId, tz, collections, onEdit, onClose, onChanged }: {
  objectId: number
  recurrenceId: string | null
  tz: string
  collections: PimCollectionInfo[]
  onEdit: (t: EditorTarget) => void
  onClose: () => void
  onChanged: () => void
}) {
  const toast = useStore((s) => s.toast)
  const offline = useStore((s) => s.offlineMode)
  const removeEvent = useStore((s) => s.removeEvent)
  const [d, setD] = useState<EventDetail | null>(null)
  const [ask, setAsk] = useState<'edit' | 'delete' | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback((): void => {
    if (offline) {
      // kopyada açılmış örnek var, açıklama ve katılımcı yok
      void readOfflineEvents(Date.now() - OFFLINE_SPAN_MS, Date.now() + OFFLINE_SPAN_MS).then((list) => {
        const occurrence = list.find((e) => e.objectId === objectId && e.recurrenceId === recurrenceId)
        if (occurrence) setD({ occurrence, etag: null, description: null, organizer: null, attendees: [], draft: null as never })
        else onClose()
      }, () => onClose())
      return
    }
    void rpc.call('getEvent', { objectId, recurrenceId, tz }).then(setD, () => onClose())
  }, [objectId, recurrenceId, tz, onClose, offline])
  useEffect(load, [load])
  useEffect(() => rpc.on('pim:changed', ({ kind }) => kind === 'calendar' && load()), [load])

  if (!d) return null
  const o = d.occurrence
  const calendar = collections.find((c) => c.id === o.collectionId)
  const canDelete = !!calendar?.canWrite && !offline
  const canEdit = o.canEdit && !offline

  const startEdit = async (scope: EditScope): Promise<void> => {
    setAsk(null)
    const fresh = scope === 'all' && o.recurring ? await rpc.call('getEvent', { objectId, recurrenceId: null, tz }) : d
    onEdit({ draft: fresh.draft, collectionId: o.collectionId, objectId, etag: d.etag, scope: o.recurring ? scope : undefined, recurrenceId: o.recurrenceId ?? undefined })
  }

  const remove = async (scope: EditScope): Promise<void> => {
    setAsk(null)
    if (!window.confirm(t(o.canEdit ? 'calendar.deleteConfirm' : 'calendar.deleteOthers', { title: eventTitle(o) }))) return
    setBusy(true)
    try {
      const r = await removeEvent({ objectId, etag: d.etag, ...(o.recurring && o.recurrenceId && scope !== 'all' ? { scope, recurrenceId: o.recurrenceId } : {}) })
      if (!r) return
      if (!r.ok) {
        toast(t('calendar.conflict'))
        load()
        return
      }
      onChanged()
      onClose()
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const act = (kind: 'edit' | 'delete'): void => {
    if (o.recurring) setAsk(kind)
    else if (kind === 'edit') void startEdit('all')
    else void remove('all')
  }
  const pick = (scope: EditScope): void => {
    if (ask === 'edit') void startEdit(scope)
    else void remove(scope)
  }

  return (
    <article className="pim-detail">
      <header className="pim-detail-head">
        <BackButton />
        <div className="pim-detail-title">
          <h2>{eventTitle(o)}</h2>
          <div className="contact-sub">{whenText(d)}</div>
          {calendar && <div className="contact-sub">{calendar.name}</div>}
        </div>
        <div className="pim-detail-actions">
          {canEdit && <button type="button" className="sm" disabled={busy} onClick={() => act('edit')}>{t('action.edit')}</button>}
          {canDelete && <button type="button" className="sm danger" disabled={busy} onClick={() => act('delete')}>{t('action.delete')}</button>}
          <button type="button" className="btn btn-ghost btn-icon btn-sm cal-detail-close" aria-label={t('action.close')} title={t('action.close')} onClick={onClose}><svg className="icon sm"><use href="#i-x" /></svg></button>
        </div>
      </header>
      {o.cancelled && <div className="pim-banner" role="status">{t('calendar.cancelled')}</div>}
      {!o.canEdit && !!calendar?.canWrite && d.organizer && <div className="pim-banner">{t('calendar.organizerOnly', { addr: d.organizer.name ?? d.organizer.addr })}</div>}
      {o.location && <dl className="pim-fields"><dt>{t('calendar.field.location')}</dt><dd><Linked text={o.location} /></dd></dl>}
      {d.organizer && <dl className="pim-fields"><dt>{t('calendar.field.organizer')}</dt><dd>{d.organizer.name ?? d.organizer.addr}</dd></dl>}
      {!!d.attendees.length && (
        <dl className="pim-fields">
          <dt>{t('calendar.field.attendees')}</dt>
          {d.attendees.map((a) => <dd key={a.addr}>{a.name ?? a.addr}</dd>)}
        </dl>
      )}
      {d.description && <dl className="pim-fields"><dt>{t('calendar.field.description')}</dt><dd className="pim-text"><Linked text={d.description} /></dd></dl>}
      {ask && (
        <Modal onClose={() => setAsk(null)} className="pim-editor">
          <div className="modal-title">{t(ask === 'edit' ? 'calendar.scope.editTitle' : 'calendar.scope.deleteTitle')}</div>
          <div className="pim-form">
            <button type="button" onClick={() => pick('this')}>{t('calendar.scope.this')}</button>
            {calendar?.supportsThisAndFuture && <button type="button" onClick={() => pick('thisAndFuture')}>{t('calendar.scope.future')}</button>}
            <button type="button" onClick={() => pick('all')}>{t('calendar.scope.all')}</button>
          </div>
        </Modal>
      )}
    </article>
  )
}
