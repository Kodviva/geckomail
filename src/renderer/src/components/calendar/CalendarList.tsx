// Takvim listesi: gizleme, renk ve hatırlatma kişiye aittir. Abonelik adresi yalnız sunucuya gider, geri okunmaz.
import { useState } from 'react'
import type { PimCollectionInfo } from '../../../../shared/pim'
import { t } from '../../../../shared/i18n'
import { rpc } from '../../rpcClient'
import { useStore } from '../../store'

const DEFAULT_COLOR = '#3b82f6'

export default function CalendarList({ collections, onChanged }: { collections: PimCollectionInfo[]; onChanged: () => void }) {
  const toast = useStore((s) => s.toast)
  const offline = useStore((s) => s.offlineMode)
  const [adding, setAdding] = useState(false)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const pref = (id: number, patch: { hidden?: boolean; color?: string | null; reminders?: boolean }): void => {
    void rpc.call('setPimCollectionPref', { collectionId: id, ...patch }).then(onChanged, (e: Error) => toast(e.message))
  }
  const add = async (): Promise<void> => {
    setBusy(true)
    try {
      await rpc.call('addIcsSubscription', { url, name })
      toast(t('calendar.sub.added'), 'info')
      setUrl('')
      setName('')
      setAdding(false)
      onChanged()
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cal-list" data-testid="calendar-list">
      {collections.map((c) => (
        <div className="cal-list-row" key={c.id}>
          <input type="checkbox" checked={!c.hidden} aria-label={t('calendar.show', { name: c.name })} onChange={(e) => pref(c.id, { hidden: !e.target.checked })} />
          <input type="color" className="cal-color" aria-label={t('calendar.color', { name: c.name })} value={c.color ?? DEFAULT_COLOR} onChange={(e) => pref(c.id, { color: e.target.value })} />
          <span className="contact-name">{c.name}</span>
          <button type="button" className={`btn btn-ghost btn-icon btn-sm${c.reminders ? ' active' : ''}`} aria-pressed={c.reminders} aria-label={t('calendar.reminders', { name: c.name })} title={t('calendar.reminders', { name: c.name })} onClick={() => pref(c.id, { reminders: !c.reminders })}>
            <svg className="icon sm"><use href={c.reminders ? '#i-bell' : '#i-mute'} /></svg>
          </button>
        </div>
      ))}
      {!adding ? (
        <button type="button" className="sm" disabled={offline} onClick={() => setAdding(true)}>{t('calendar.sub.add')}</button>
      ) : (
        <form className="pim-form" onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}>
          <label>{t('calendar.sub.url')}<input type="url" inputMode="url" required value={url} placeholder="https://" spellCheck={false} onChange={(e) => setUrl(e.target.value)} onInvalid={(e) => {
            // webcal: tarayıcı doğrulamasından geçer, https'e motor çevirir
            e.currentTarget.setCustomValidity(/^webcals?:/i.test(url) ? '' : e.currentTarget.validationMessage)
          }} /></label>
          <label>{t('calendar.sub.name')}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div className="modal-foot">
            <button type="button" className="sm" onClick={() => setAdding(false)}>{t('action.cancel')}</button>
            <button type="submit" className="primary sm" disabled={busy}>{t('action.add')}</button>
          </div>
        </form>
      )}
    </div>
  )
}
