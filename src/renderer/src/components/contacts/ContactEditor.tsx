// Kart düzenleyici. Çakışmada yerel satır değişmez; kullanıcı güncel kartı görüp yeniden dener.
import { useEffect, useMemo, useState } from 'react'
import type { ContactDraft, ContactSummary, PimCollectionInfo } from '../../../../shared/pim'
import { t } from '../../../../shared/i18n'
import { rpc } from '../../rpcClient'
import { useStore } from '../../store'
import Modal from '../Modal'

type Row = { value: string; label: string | null }

const blank: ContactDraft = { kind: 'individual', fullName: '', given: null, family: null, org: null, emails: [], phones: [], addresses: [], note: null, birthday: null, memberIds: [] }

function Rows({ title, rows, type, onChange }: { title: string; rows: Row[]; type: string; onChange: (r: Row[]) => void }) {
  const list = rows.length ? rows : [{ value: '', label: null }]
  return (
    <fieldset className="pim-rows">
      <legend>{title}</legend>
      {list.map((r, i) => (
        <div className="pim-row" key={i}>
          <input type={type} aria-label={title} value={r.value} onChange={(e) => onChange(list.map((x, n) => (n === i ? { ...x, value: e.target.value } : x)))} />
          <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={t('action.remove')} title={t('action.remove')} onClick={() => onChange(list.filter((_, n) => n !== i))}>
            <svg className="icon sm"><use href="#i-x" /></svg>
          </button>
        </div>
      ))}
      <button type="button" className="sm" onClick={() => onChange([...list, { value: '', label: null }])}>{t('contacts.addRow')}</button>
    </fieldset>
  )
}

const clean = (rows: Row[]): Row[] => rows.filter((r) => r.value.trim())

export default function ContactEditor({ id, books, initialBook, onClose, onSaved }: { id: number | null; books: PimCollectionInfo[]; initialBook: number | null; onClose: () => void; onSaved: (id: number) => void }) {
  const toast = useStore((s) => s.toast)
  const [draft, setDraft] = useState<ContactDraft | null>(id == null ? blank : null)
  const [etag, setEtag] = useState<string | null | undefined>(undefined)
  const [book, setBook] = useState(initialBook ?? books[0]?.id ?? 0)
  const [candidates, setCandidates] = useState<ContactSummary[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (id == null) return
    void rpc.call('getContact', { id }).then(
      (d) => {
        setDraft({ kind: d.kind, fullName: d.fullName, given: d.given, family: d.family, org: d.org, emails: d.emails, phones: d.phones, addresses: d.addresses, note: d.note, birthday: d.birthday, memberIds: d.memberIds })
        setEtag(d.etag)
        setBook(d.collectionId)
      },
      (e: Error) => toast(e.message)
    )
  }, [id, toast])

  const info = useMemo(() => books.find((b) => b.id === book), [books, book])
  const isGroup = draft?.kind === 'group'
  useEffect(() => {
    if (!isGroup || !book) return
    void rpc.call('listContacts', { collectionIds: [book], limit: 200 }).then((list) => setCandidates(list.filter((c) => c.kind === 'individual')), () => {})
  }, [isGroup, book])

  if (!draft) return null
  const set = (patch: Partial<ContactDraft>): void => setDraft({ ...draft, ...patch })

  const saveContactDraft = useStore.getState().saveContactDraft
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const body: ContactDraft = { ...draft, emails: draft.emails.filter((e) => e.addr.trim()), phones: clean(draft.phones), addresses: clean(draft.addresses) }
      const r = await saveContactDraft({ collectionId: book, ...(id != null ? { id, etag } : {}), draft: body })
      if (!r) return
      if (r.ok) onSaved(r.id)
      else {
        toast(t('contacts.conflict'))
        onClose()
      }
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} className="pim-editor" confirmOnDirty closeOnBackdrop={false}>
      <div className="modal-title">{id == null ? t('contacts.new') : draft.fullName}</div>
      <form className="pim-form" onSubmit={(e) => { e.preventDefault(); void save() }}>
        {id == null && books.length > 1 && (
          <label>{t('contacts.book')}
            <select value={book} onChange={(e) => setBook(Number(e.target.value))}>{books.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          </label>
        )}
        {id == null && info?.supportsGroups && (
          <label className="pim-check"><input type="checkbox" checked={isGroup} onChange={(e) => set({ kind: e.target.checked ? 'group' : 'individual' })} /> {t('contacts.group.make')}</label>
        )}
        <label>{t(isGroup ? 'contacts.group.name' : 'contacts.field.fullName')}<input value={draft.fullName} required autoFocus onChange={(e) => set({ fullName: e.target.value })} /></label>
        {!isGroup && (
          <>
            <div className="pim-pair">
              <label>{t('contacts.field.given')}<input value={draft.given ?? ''} onChange={(e) => set({ given: e.target.value || null })} /></label>
              <label>{t('contacts.field.family')}<input value={draft.family ?? ''} onChange={(e) => set({ family: e.target.value || null })} /></label>
            </div>
            <label>{t('contacts.field.org')}<input value={draft.org ?? ''} onChange={(e) => set({ org: e.target.value || null })} /></label>
            <Rows title={t('contacts.field.email')} type="email" rows={draft.emails.map((e) => ({ value: e.addr, label: e.label }))} onChange={(r) => set({ emails: r.map((x) => ({ addr: x.value, label: x.label })) })} />
            <Rows title={t('contacts.field.phone')} type="tel" rows={draft.phones} onChange={(phones) => set({ phones })} />
            <Rows title={t('contacts.field.address')} type="text" rows={draft.addresses} onChange={(addresses) => set({ addresses })} />
            <label>{t('contacts.field.birthday')}<input type="date" value={/^\d{4}/.test(draft.birthday ?? '') ? draft.birthday! : ''} onChange={(e) => set({ birthday: e.target.value || null })} /></label>
            <label>{t('contacts.field.note')}<textarea rows={3} value={draft.note ?? ''} onChange={(e) => set({ note: e.target.value || null })} /></label>
          </>
        )}
        {isGroup && (
          <fieldset className="pim-rows pim-members">
            <legend>{t('contacts.group.members')}</legend>
            {candidates.map((c) => (
              <label key={c.id} className="pim-check">
                <input type="checkbox" checked={draft.memberIds?.includes(c.id) ?? false} onChange={(e) => set({ memberIds: e.target.checked ? [...(draft.memberIds ?? []), c.id] : (draft.memberIds ?? []).filter((m) => m !== c.id) })} /> {c.fullName}
              </label>
            ))}
          </fieldset>
        )}
        <div className="modal-foot">
          <button type="button" onClick={onClose}>{t('action.cancel')}</button>
          <button type="submit" className="primary" disabled={busy || !draft.fullName.trim()}>{t('action.save')}</button>
        </div>
      </form>
    </Modal>
  )
}
