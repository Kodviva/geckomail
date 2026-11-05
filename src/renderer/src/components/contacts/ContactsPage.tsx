// Kişiler sayfası: geniş ve orta ekranda liste + ayrıntı, dar ekranda tek bölme (geri tuşu listeye döner). Toplanan adresler salt okunur
// sanal defter olarak görünür; kişi kartı yalnız kullanıcının tıklamasıyla oluşur.
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import type { ContactSummary, PimCollectionInfo } from '../../../../shared/pim'
import type { Contact } from '../../../../shared/rpc'
import { t } from '../../../../shared/i18n'
import { norm } from '../../../../shared/notifyRules'
import { MenuButton } from '../../layout/MobileNav'
import { navBreakpoint, useBreakpoint } from '../../layout/useBreakpoint'
import { platform } from '../../platform'
import { readOfflineContacts } from '../../offline/pim'
import { rpc } from '../../rpcClient'
import { useStore } from '../../store'
import ContactDetailPane from './ContactDetailPane'
import ContactEditor from './ContactEditor'
import ContactList from './ContactList'
import { importVcf } from './importVcf'

export const COLLECTED = 'collected'
export type BookChoice = number | 'all' | typeof COLLECTED

const PAGE = 100
const SEARCH_DEBOUNCE_MS = 200

export default function ContactsPage() {
  const narrow = navBreakpoint(useBreakpoint(), platform.kind, true) === 'narrow'
  const selectedId = useStore((s) => s.selectedContactId)
  const select = useStore((s) => s.setSelectedContact)
  const books = useStore((s) => s.pimCollections.addressbook)
  const refreshCollections = useStore((s) => s.refreshPimCollections)
  const collected = useStore((s) => s.contacts)
  const refreshContacts = useStore((s) => s.refreshContacts)
  const toast = useStore((s) => s.toast)
  const offline = useStore((s) => s.offlineMode)

  const [book, setBook] = useState<BookChoice>('all')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<ContactSummary[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const [editing, setEditing] = useState<'new' | number | null>(null)
  const [importing, setImporting] = useState<{ done: number; total: number } | null>(null)
  const seq = useRef(0)
  const file = useRef<HTMLInputElement>(null)
  const writable = useMemo(() => books.filter((b) => b.canWrite), [books])
  const targetBook: PimCollectionInfo | undefined = useMemo(() => writable.find((b) => b.id === book) ?? writable[0], [writable, book])

  useEffect(() => {
    void refreshCollections()
    void refreshContacts()
  }, [refreshCollections, refreshContacts])

  const load = useCallback(
    async (after: ContactSummary | null): Promise<void> => {
      if (book === COLLECTED) return
      const mine = ++seq.current
      try {
        if (offline) {
          const all = await readOfflineContacts(query)
          if (mine !== seq.current) return
          setRows(all.filter((c) => typeof book !== 'number' || c.collectionId === book))
          setHasMore(false)
          setFailed(false)
          return
        }
        const page = await rpc.call('listContacts', {
          collectionIds: book === 'all' ? null : [book], query: query.trim() || undefined, limit: PAGE, cursor: after ? { name: after.fullName, id: after.id } : null
        })
        if (mine !== seq.current) return
        setRows((cur) => (after ? [...cur, ...page] : page))
        setHasMore(page.length === PAGE)
        setFailed(false)
      } catch {
        if (mine === seq.current) setFailed(true)
      }
    },
    [book, query, offline]
  )

  const reload = useCallback(() => void load(null), [load])
  useEffect(() => {
    const id = setTimeout(reload, query ? SEARCH_DEBOUNCE_MS : 0)
    return () => clearTimeout(id)
  }, [reload, query])
  useEffect(() => rpc.on('pim:changed', ({ kind }) => kind === 'contacts' && reload()), [reload])

  const collectedRows = useMemo<Contact[]>(() => {
    if (book !== COLLECTED) return []
    const want = norm(query.trim())
    return collected.filter((c) => c.contactId == null && c.groupId == null && (!want || norm(`${c.addr} ${c.name ?? ''}`).includes(want)))
  }, [book, collected, query])

  const onFile = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f || !targetBook) return
    try {
      const r = await importVcf(f, targetBook.id, (done, total) => setImporting({ done, total }))
      toast(t('contacts.import.done', r), 'info')
    } catch (err) {
      toast((err as Error).message)
    } finally {
      setImporting(null)
      reload()
    }
  }

  const exportBook = async (id: number): Promise<void> => {
    try {
      const { filename, data } = await rpc.call('exportContacts', { collectionId: id })
      await platform.saveBytes(filename, data)
    } catch (e) {
      toast((e as Error).message)
    }
  }

  const showList = !narrow || selectedId == null
  const showDetail = !narrow || selectedId != null
  return (
    <main className="pim-page" aria-label={t('contacts.title')}>
      {showList && (
        <section className="listpane pim-listpane">
          <div className="list-head">
            <div className="list-title-row">
              <MenuButton />
              <div className="list-title">{t('contacts.title')}</div>
              {!!writable.length && (
                <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={t('contacts.new')} title={t('contacts.new')} disabled={offline} onClick={() => setEditing('new')}>
                  <svg className="icon"><use href="#i-plus" /></svg>
                </button>
              )}
            </div>
            <select aria-label={t('contacts.book')} value={String(book)} onChange={(e) => {
              const v = e.target.value
              setBook(v === 'all' || v === COLLECTED ? v : Number(v))
              select(null)
            }}>
              <option value="all">{t('contacts.allBooks')}</option>
              {books.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              <option value={COLLECTED}>{t('contacts.collected')}</option>
            </select>
            <input type="search" value={query} aria-label={t('contacts.search')} placeholder={t('contacts.search')} onChange={(e) => setQuery(e.target.value)} />
            {book !== COLLECTED && (
              <div className="chip-row">
                {targetBook && (
                  <button type="button" className="chip" disabled={offline || !!importing} onClick={() => file.current?.click()}>
                    {importing ? t('contacts.import.progress', importing) : t('contacts.import.action')}
                  </button>
                )}
                {typeof book === 'number' && <button type="button" className="chip" onClick={() => void exportBook(book)}>{t('contacts.export')}</button>}
                <input ref={file} type="file" accept=".vcf,text/vcard,text/x-vcard" hidden onChange={(e) => void onFile(e)} />
              </div>
            )}
          </div>
          {failed && <div className="pim-empty" role="alert">{t('contacts.loadFailed')}</div>}
          <ContactList book={book} rows={rows} collected={collectedRows} hasMore={hasMore} selectedId={selectedId} target={targetBook ?? null} onSelect={select} onMore={() => void load(rows[rows.length - 1] ?? null)} />
        </section>
      )}
      {showDetail && (
        <section className="viewpane pim-detailpane">
          {selectedId != null ? (
            <ContactDetailPane key={selectedId} id={selectedId} books={books} onEdit={() => setEditing(selectedId)} onGone={() => select(null)} onChanged={reload} />
          ) : (
            <div className="pim-empty">{t('contacts.pick')}</div>
          )}
        </section>
      )}
      {editing !== null && <ContactEditor id={editing === 'new' ? null : editing} books={writable} initialBook={targetBook?.id ?? null} onClose={() => setEditing(null)} onSaved={(id) => {
        setEditing(null)
        select(id)
        reload()
      }} />}
    </main>
  )
}
