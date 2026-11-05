// Taşı penceresi: bulk-bar, okuma araç çubuğu ve bağlam menüsü aynı listeyi açar. Arama kutusu odakta kalır;
// ok tuşları ve Enter klasör seçer, Esc ve odak tuzağı Modal'da. autoFocus değil data-autofocus: Modal odağı
// tetikleyiciye geri verebilmek için önceki odağı kendi alır.
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import { mailCount, moveTargets, rowMap, type MoveRow } from '../moveDrag'
import { matchRanges } from '../../../shared/searchQuery'
import { t } from '../../../shared/i18n'
import type { FolderInfo } from '../../../shared/rpc'
import Modal from './Modal'

export const FOLDER_ICONS: Record<string, string> = {
  inbox: 'i-inbox',
  sent: 'i-send',
  trash: 'i-trash',
  junk: 'i-alert',
  archive: 'i-archive',
  other: 'i-folder'
}

function MovePicker({ rows }: { rows: MoveRow[] }) {
  const closeMoveDialog = useStore((s) => s.closeMoveDialog)
  const moveRows = useStore((s) => s.moveRows)
  const [folders, setFolders] = useState<FolderInfo[] | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const { accountId } = rows[0]

  useEffect(() => {
    let live = true
    void rpc
      .call('getFoldersOf', { accountId })
      .then((f) => live && setFolders(f))
      .catch(() => live && setFolders([]))
    return () => {
      live = false
    }
  }, [accountId])

  const ids = useMemo(() => rows.map((r) => r.id), [rows])
  const list = useMemo(() => {
    const all = moveTargets(folders ?? [], ids, rowMap(rows), accountId)
    const q = query.trim()
    return q ? all.filter((f) => matchRanges(f.display, [q]).length > 0) : all
  }, [folders, ids, rows, accountId, query])
  const current = Math.min(active, Math.max(list.length - 1, 0))

  const choose = (f: FolderInfo | undefined): void => {
    if (!f) return
    closeMoveDialog()
    void moveRows(rows, f.id)
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (list.length) setActive((current + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(list[current])
    }
  }

  // etkin satır uzun listede görünür kalır
  useEffect(() => {
    document.getElementById(`move-opt-${current}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [current])

  return (
    <Modal onClose={closeMoveDialog} className="move-dialog">
      <div className="modal-title">{t('mail.view.moveToFolder')}</div>
      <div className="move-count">{t('mail.move.dragCount', { count: mailCount(rows) })}</div>
      <input
        data-autofocus
        className="move-search"
        role="combobox"
        aria-expanded="true"
        aria-controls="move-list"
        aria-autocomplete="list"
        aria-activedescendant={list.length ? `move-opt-${current}` : undefined}
        aria-label={t('mail.move.search')}
        placeholder={t('mail.move.search')}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
        }}
        onKeyDown={onKey}
      />
      <div id="move-list" className="move-list" role="listbox" aria-label={t('mail.view.moveToFolder')}>
        {!folders && <div className="move-item dim">{t('state.loading')}</div>}
        {folders && !list.length && <div className="move-item dim">{t('mail.move.noFolders')}</div>}
        {list.map((f, i) => (
          <div
            key={f.id}
            id={`move-opt-${i}`}
            role="option"
            aria-selected={i === current}
            className={`menu-item ${i === current ? 'active' : ''}`}
            onMouseMove={() => setActive(i)}
            onClick={() => choose(f)}
          >
            <svg className="icon sm"><use href={`#${FOLDER_ICONS[f.kind] ?? 'i-folder'}`} /></svg> {f.display}
          </div>
        ))}
      </div>
      <div className="move-actions">
        <button type="button" className="btn btn-sm" onClick={closeMoveDialog}>
          {t('action.cancel')}
        </button>
      </div>
    </Modal>
  )
}

export default function MoveMenu() {
  const dialog = useStore((s) => s.moveDialog)
  return dialog ? <MovePicker rows={dialog.rows} /> : null
}
