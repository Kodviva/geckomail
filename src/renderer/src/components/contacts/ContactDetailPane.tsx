// Kart ayrıntısı. Kişi metni düz metindir: not ve adlar React metni olarak gösterilir, fotoğraf yalnız `data:` görseli.
import { useCallback, useEffect, useState } from 'react'
import type { ContactDetail, PimCollectionInfo } from '../../../../shared/pim'
import { fmtDate, t } from '../../../../shared/i18n'
import { BackButton } from '../../layout/MobileNav'
import { readOfflineContacts } from '../../offline/pim'
import { rpc } from '../../rpcClient'
import { useStore } from '../../store'
import MergePrompt from './MergePrompt'

const SAFE_PHOTO = /^data:image\/(png|jpeg);base64,/i

function birthdayText(v: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtDate(Date.parse(`${v}T12:00:00Z`)) : v.replace(/^--/, '')
}

export default function ContactDetailPane({ id, books, onEdit, onGone, onChanged }: { id: number; books: PimCollectionInfo[]; onEdit: () => void; onGone: () => void; onChanged: () => void }) {
  const toast = useStore((s) => s.toast)
  const offline = useStore((s) => s.offlineMode)
  const removeContact = useStore((s) => s.removeContact)
  const openComposer = useStore((s) => s.openComposer)
  const setComposer = useStore((s) => s.setComposer)
  const canCompose = useStore((s) => s.accounts.length > 0)
  const [d, setD] = useState<ContactDetail | null>(null)
  const [members, setMembers] = useState<{ id: number; name: string }[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback((): void => {
    if (offline) {
      // kopyada özet var: not, telefon ve fotoğraf saklanmaz
      void readOfflineContacts().then((list) => {
        const c = list.find((x) => x.id === id)
        if (c) setD({ ...c, etag: null, given: null, family: null, phones: [], addresses: [], note: null, birthday: null, photoDataUrl: null, memberIds: [] })
        else onGone()
      }, () => onGone())
      return
    }
    void rpc.call('getContact', { id }).then(
      async (detail) => {
        setD(detail)
        const list = await Promise.all(detail.memberIds.map((m) => rpc.call('getContact', { id: m })))
        setMembers(list.map((m) => ({ id: m.id, name: m.fullName })))
      },
      () => onGone()
    )
  }, [id, onGone, offline])
  useEffect(load, [load])
  useEffect(() => rpc.on('pim:changed', ({ kind }) => kind === 'contacts' && load()), [load])

  if (!d) return null
  const book = books.find((b) => b.id === d.collectionId)
  const canWrite = !!book?.canWrite && !offline && (d.kind === 'individual' || book.supportsGroups)

  const mailTo = (addrs: string[]): void => {
    const c = useStore.getState().composer
    if (!c) openComposer('new')
    const open = useStore.getState().composer
    if (open) setComposer({ ...open, to: [open.to, ...addrs].filter(Boolean).join(', ') })
  }

  const remove = async (): Promise<void> => {
    if (!window.confirm(t('contacts.deleteConfirm', { name: d.fullName }))) return
    setBusy(true)
    try {
      const r = await removeContact({ id, etag: d.etag })
      if (!r) return
      if (!r.ok) {
        toast(t('contacts.conflict'))
        load()
        return
      }
      onChanged()
      onGone()
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="pim-detail">
      <header className="pim-detail-head">
        <BackButton />
        {d.photoDataUrl && SAFE_PHOTO.test(d.photoDataUrl) && <img className="contact-photo" src={d.photoDataUrl} alt="" />}
        <div className="pim-detail-title">
          <h2>{d.fullName}</h2>
          {d.org && <div className="contact-sub">{d.org}</div>}
          {book && <div className="contact-sub">{book.name}</div>}
        </div>
        {canWrite && (
          <div className="pim-detail-actions">
            <button type="button" className="sm" disabled={busy} onClick={onEdit}>{t('action.edit')}</button>
            <button type="button" className="sm danger" disabled={busy} onClick={() => void remove()}>{t('action.delete')}</button>
          </div>
        )}
      </header>
      {canWrite && <MergePrompt contact={d} onMerged={() => { load(); onChanged() }} />}
      {!!d.emails.length && (
        <dl className="pim-fields">
          <dt>{t('contacts.field.email')}</dt>
          {d.emails.map((e) => (
            <dd key={e.addr}>
              {canCompose ? <button type="button" className="linklike" onClick={() => mailTo([e.addr])}>{e.addr}</button> : e.addr}
              {e.label && <span className="contact-sub"> {e.label}</span>}
            </dd>
          ))}
        </dl>
      )}
      {!!d.phones.length && (
        <dl className="pim-fields">
          <dt>{t('contacts.field.phone')}</dt>
          {d.phones.map((p) => <dd key={p.value}>{p.value}{p.label && <span className="contact-sub"> {p.label}</span>}</dd>)}
        </dl>
      )}
      {!!d.addresses.length && (
        <dl className="pim-fields">
          <dt>{t('contacts.field.address')}</dt>
          {d.addresses.map((a) => <dd key={a.value}>{a.value}{a.label && <span className="contact-sub"> {a.label}</span>}</dd>)}
        </dl>
      )}
      {d.birthday && (
        <dl className="pim-fields">
          <dt>{t('contacts.field.birthday')}</dt>
          <dd>{birthdayText(d.birthday)}</dd>
        </dl>
      )}
      {d.note && (
        <dl className="pim-fields">
          <dt>{t('contacts.field.note')}</dt>
          <dd className="pim-text">{d.note}</dd>
        </dl>
      )}
      {d.kind === 'group' && (
        <dl className="pim-fields">
          <dt>{t('contacts.group.members')}</dt>
          {members.length ? members.map((m) => <dd key={m.id}>{m.name}</dd>) : <dd>{t('contacts.group.noMembers')}</dd>}
        </dl>
      )}
    </article>
  )
}
