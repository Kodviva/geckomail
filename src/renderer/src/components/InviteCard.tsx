// Postadaki toplantı daveti. Metinler düz metindir; ham iCalendar buraya gelmez. Hiçbir şey tıklamasız uygulanmaz, ek çipi kartın altında kalır.
import { useCallback, useEffect, useState } from 'react'
import type { InviteInfo, InvitePartstat } from '../../../shared/pim'
import { fmtDateTime, t } from '../../../shared/i18n'
import { rpc } from '../rpcClient'
import { useStore } from '../store'

const zone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

function whenText(i: InviteInfo): string {
  if (i.allDay) return i.endDate && i.endDate !== i.startDate ? `${i.startDate} – ${i.endDate}` : (i.startDate ?? '')
  return `${fmtDateTime(i.start, { dateStyle: 'medium', timeStyle: 'short' })} – ${fmtDateTime(i.end, { timeStyle: 'short' })}`
}

function heading(i: InviteInfo): string {
  if (i.method === 'CANCEL') return t('invite.kind.cancel')
  if (i.method === 'PUBLISH') return t('invite.kind.publish')
  if (i.method === 'REPLY') {
    const key = { ACCEPTED: 'accepted', DECLINED: 'declined', TENTATIVE: 'tentative' }[i.replyFrom?.partstat ?? ''] ?? 'other'
    return t(`invite.reply.${key}`, { name: i.replyFrom?.addr ?? '' })
  }
  return i.isUpdate ? t('invite.kind.update') : t('invite.kind.request')
}

const ANSWERS: { partstat: InvitePartstat; label: string; primary?: boolean }[] = [
  { partstat: 'ACCEPTED', label: 'invite.accept', primary: true },
  { partstat: 'TENTATIVE', label: 'invite.tentative' },
  { partstat: 'DECLINED', label: 'invite.decline' }
]

export default function InviteCard({ messageId }: { messageId: number }) {
  const [info, setInfo] = useState<InviteInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [calendarId, setCalendarId] = useState<number | null>(null)
  const calendars = useStore((s) => s.pimCollections.calendar)
  const refreshCollections = useStore((s) => s.refreshPimCollections)
  const toast = useStore((s) => s.toast)

  const load = useCallback(() => {
    rpc.call('getInvite', { messageId, tz: zone() }).then(setInfo).catch(() => setInfo(null))
  }, [messageId])
  useEffect(load, [load])
  useEffect(() => rpc.on('pim:changed', ({ kind }) => kind === 'calendar' && load()), [load])
  const addable = !!info?.canAddToCalendar
  useEffect(() => {
    if (addable) void refreshCollections()
  }, [addable, refreshCollections])

  if (!info) return null
  const writable = calendars.filter((c) => c.canWrite)
  const chosen = calendarId !== null && writable.some((c) => c.id === calendarId) ? calendarId : (writable[0]?.id ?? null)
  const target = info.canAddToCalendar ? chosen : null
  const { attachmentId } = info

  const run = async (action: () => Promise<string | null>): Promise<void> => {
    setBusy(true)
    try {
      const done = await action()
      if (done) toast(t(done), 'info')
      load()
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const answer = (partstat: InvitePartstat, sendReply: boolean): Promise<void> =>
    run(async () => {
      const { sent } = await rpc.call('respondInvite', { messageId, attachmentId, partstat, sendReply, calendarId: target })
      return sent === 'none' ? (target !== null ? 'invite.done.added' : null) : 'invite.done.sent'
    })
  const conflict = (r: { ok: boolean }): string | null => {
    if (!r.ok) throw new Error(t('invite.err.conflict'))
    return null
  }
  const canAct = !!info.existing?.canWrite && !info.warnings.includes('stale') && !info.warnings.includes('organizerMismatch')
  const showAnswers = info.canRespond && !info.isUpdate

  return (
    <div className="invite-card">
      <div className="invite-head">{heading(info)}</div>
      <div className="invite-title">{info.title || t('calendar.noTitle')}</div>
      <div className="invite-line">{whenText(info)}{info.recurring ? ` · ${t('invite.recurring')}` : ''}</div>
      {info.location && <div className="invite-line">{info.location}</div>}
      {info.organizer && <div className="invite-line">{t('invite.organizer', { addr: info.organizer.addr })}</div>}
      {info.changes.length > 0 && <div className="invite-line">{t('invite.changes', { list: info.changes.map((c) => t(`invite.change.${c}`)).join(', ') })}</div>}
      {info.warnings.map((w) => (
        <div key={w} className="invite-warn" role="alert">{t(`invite.warn.${w}`, { addr: info.organizer?.addr ?? '' })}</div>
      ))}
      {info.response && <div className="invite-line">{t(`invite.answered.${info.response.partstat.toLowerCase()}`)}</div>}
      {info.existing && !info.isUpdate && info.method !== 'CANCEL' && <div className="invite-line">{t('invite.inCalendar')}</div>}
      {info.canAddToCalendar && writable.length > 0 && (
        <label className="invite-calendar">
          <span>{t('invite.calendar')}</span>
          <select value={chosen ?? ''} disabled={busy} onChange={(e) => setCalendarId(Number(e.target.value))}>
            {writable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
      <div className="invite-actions">
        {info.isUpdate && canAct && (
          <button type="button" className="btn btn-sm primary" disabled={busy} onClick={() => void run(async () => conflict(await rpc.call('applyInviteUpdate', { messageId, attachmentId })))}>
            {t('invite.applyUpdate')}
          </button>
        )}
        {info.method === 'CANCEL' && canAct && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(async () => conflict(await rpc.call('applyInviteCancel', { messageId, attachmentId })))}>
            {t('invite.applyCancel')}
          </button>
        )}
        {showAnswers && ANSWERS.map((a) => (
          <button key={a.partstat} type="button" className={`btn btn-sm${a.primary ? ' primary' : ''}`} disabled={busy} aria-pressed={info.response?.partstat === a.partstat} onClick={() => void answer(a.partstat, true)}>
            {t(a.label)}
          </button>
        ))}
        {target !== null && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void answer('ACCEPTED', false)}>
            {t(info.method === 'PUBLISH' ? 'invite.add' : 'invite.addNoReply')}
          </button>
        )}
      </div>
    </div>
  )
}
