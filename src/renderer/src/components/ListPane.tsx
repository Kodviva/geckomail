import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { defaultRangeExtractor, measureElement, useVirtualizer, type Range } from '@tanstack/react-virtual'
import { useStore, type ListRow } from '../store'
import type { FolderKind, SmartView } from '../../../shared/rpc'
import { subjectTemplateKey } from '../../../shared/noise'
import { highlightTerms, matchRanges, parseSearch } from '../../../shared/searchQuery'
import { fmtDate, fmtDateTime, fmtTime, t } from '../../../shared/i18n'
import SavedSearches from './SavedSearches'
import { usePopover } from './usePopover'
import { MenuButton, useNavDrawer } from '../layout/MobileNav'
import { LongPressDiv } from '../layout/LongPressDiv'
import { navBreakpoint, useBreakpoint } from '../layout/useBreakpoint'
import { platform } from '../platform'
import { canManageAccount, DRAG_TYPE, dragIds, mailCount, rowMap, sameAccount, toMoveRow, touchPrimary, watchDragEnd } from '../moveDrag'

const CLUSTER_WINDOW_MS = 48 * 3_600_000
const CLUSTER_MIN = 3

type DisplayRow = { kind: 'msg'; m: ListRow } | { kind: 'cluster'; key: string; msgs: ListRow[] }

// gürültü azaltma: aynı gönderen + aynı konu kalıbı, en yeniden 48s içinde ≥3 tekrar → tek satıra kümele.
// `messages` zaten tarihe göre azalan sırada (en yeni önce) geldiğinden ekstra sıralama gerekmez.
function buildDisplayRows(messages: ListRow[], expanded: Set<string>): DisplayRow[] {
  const byKey = new Map<string, ListRow[]>()
  for (const m of messages) {
    const key = `${m.fromAddr ?? ''}|${subjectTemplateKey(m.subject)}`
    const arr = byKey.get(key)
    if (arr) arr.push(m)
    else byKey.set(key, [m])
  }
  const clusterKeyOf = new Map<number, string>()
  for (const [key, msgs] of byKey) {
    if (msgs.length < CLUSTER_MIN) continue
    const newest = msgs[0].date
    const within = msgs.filter((m) => newest - m.date <= CLUSTER_WINDOW_MS)
    if (within.length >= CLUSTER_MIN) for (const m of within) clusterKeyOf.set(m.id, key)
  }
  const out: DisplayRow[] = []
  const emitted = new Set<string>()
  for (const m of messages) {
    const key = clusterKeyOf.get(m.id)
    if (!key) {
      out.push({ kind: 'msg', m })
      continue
    }
    if (!emitted.has(key)) {
      emitted.add(key)
      out.push({ kind: 'cluster', key, msgs: byKey.get(key)!.filter((x) => clusterKeyOf.get(x.id) === key) })
    }
    if (expanded.has(key)) out.push({ kind: 'msg', m })
  }
  return out
}

// arama vurgusu: Türkçe katlamalı (ı/i, ş/s …) eşleşme aralıkları; aramadaki eşleşmeyle aynı kural
function Hi({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length || !text) return <>{text}</>
  const ranges = matchRanges(text, terms)
  if (!ranges.length) return <>{text}</>
  const out: ReactNode[] = []
  let pos = 0
  ranges.forEach(([a, b], i) => {
    if (a > pos) out.push(text.slice(pos, a))
    out.push(<mark key={i}>{text.slice(a, b)}</mark>)
    pos = b
  })
  if (pos < text.length) out.push(text.slice(pos))
  return <>{out}</>
}

// etiketler render anında çevrilir (dil çalışırken değişebilir)
const FOLDER_KINDS: FolderKind[] = ['inbox', 'sent', 'archive', 'junk', 'trash']

// akıllı posta kutuları (P2-3): klasör değil, tüm klasörlerde filtre
const smartViews = (): { view: SmartView; label: string; icon: string; title: string }[] => [
  { view: 'starred', label: t('mail.smart.starred'), icon: 'i-star', title: t('mail.smart.starredTitle') },
  { view: 'snoozed', label: t('mail.smart.snoozed'), icon: 'i-clock', title: t('mail.smart.snoozedTitle') },
  { view: 'attachments', label: t('mail.smart.attachments'), icon: 'i-clip', title: t('mail.smart.attachmentsTitle') }
]

function listDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return fmtTime(d)
  if (d.getFullYear() === now.getFullYear()) return fmtDate(d, { day: 'numeric', month: 'short' })
  return fmtDate(d, { day: 'numeric', month: 'short', year: 'numeric' })
}

function Row({
  m, color, active, checked, terms, isNewSender, onClick, onMenu, drag
}: {
  m: ListRow
  color: string
  active: boolean
  checked: boolean
  terms: string[]
  isNewSender: boolean
  onClick: (e: MouseEvent) => void
  /** sağ tık ya da dokunmatik uzun basma */
  onMenu: (x: number, y: number) => void
  /** yalnız sürüklenebilirken (geniş yerleşim, fare, çevrimiçi) */
  drag?: { onDragStart: (e: DragEvent) => void; onDragEnd: () => void }
}) {
  const unread = m.threadUnread != null ? m.threadUnread > 0 : !m.seen
  return (
    <LongPressDiv
      className={`msg-row ${active ? 'active' : ''} ${checked ? 'checked' : ''} ${unread ? 'unread' : ''}`}
      onClick={onClick}
      onMenu={onMenu}
      draggable={drag ? true : undefined}
      {...drag}
    >
      <span className="msg-color" style={{ background: color }} />
      <div className="msg-main">
        <div className="msg-top">
          <span className="msg-from">
            {m.locked ? (
              <span className="locked-from"><svg className="icon sm"><use href="#i-lock" /></svg> {t('mail.list.vaultLocked')}</span>
            ) : (
              <Hi text={m.fromName || m.fromAddr || t('mail.common.unknownSender')} terms={terms} />
            )}
            {(m.threadCount ?? 1) > 1 && <span className="thread-badge">{m.threadCount}</span>}
            {isNewSender && !m.locked && (
              <span className="new-badge" title={t('mail.list.newSenderTitle')}>
                {t('mail.list.newSender')}
              </span>
            )}
          </span>
          <span className="msg-date">
            {m.flagged && <svg className="icon sm filled star-ic"><use href="#i-star" /></svg>}
            {m.hasAttachments && <svg className="icon sm"><use href="#i-clip" /></svg>}
            {/* yalnız yapı: "imzalı" güven ifadesi değildir, doğrulama ileti açılınca yapılır */}
            {m.smimeKind === 'encrypted' && <svg className="icon sm" role="img" aria-label={t('smime.list.encrypted')}><use href="#i-lock" /></svg>}
            {m.smimeKind === 'signed' && <svg className="icon sm" role="img" aria-label={t('smime.list.signed')}><use href="#i-seal" /></svg>}
            {m.snoozeUntil ? (
              <span className="snooze-at" title={t('mail.list.snoozedUntil', { when: fmtDateTime(m.snoozeUntil) })}>
                <svg className="icon sm"><use href="#i-clock" /></svg>
                {listDate(m.snoozeUntil)}
              </span>
            ) : (
              listDate(m.date)
            )}
          </span>
        </div>
        <div className="msg-subject">
          {m.locked ? <span className="locked-subject">{t('mail.list.lockedContent')}</span> : <Hi text={m.subject || t('mail.common.noSubject')} terms={terms} />}
        </div>
        {!m.locked && m.preview && (
          <div className="msg-preview">
            <Hi text={m.preview} terms={terms} />
          </div>
        )}
      </div>
    </LongPressDiv>
  )
}

function ClusterRow({ msgs, color, expanded, onToggle }: { msgs: ListRow[]; color: string; expanded: boolean; onToggle: () => void }) {
  const newest = msgs[0]
  return (
    <div className="msg-row cluster-row" onClick={onToggle}>
      <span className="msg-color" style={{ background: color }} />
      <div className="msg-main">
        <div className="msg-top">
          <span className="msg-from">
            {newest.fromName || newest.fromAddr || t('mail.common.unknownSender')}
            <span className="thread-badge">×{msgs.length}</span>
          </span>
          <span className="msg-date">{listDate(newest.date)}</span>
        </div>
        <div className="msg-subject">
          {newest.subject || t('mail.common.noSubject')}
          <span className="cluster-hint">
            {' — '}
            {t(expanded ? 'mail.list.clusterExpanded' : 'mail.list.clusterCollapsed', { count: msgs.length })}
          </span>
        </div>
      </div>
    </div>
  )
}

export default function ListPane() {
  const drawerOpen = useNavDrawer((s) => s.open)
  const messages = useStore((s) => s.messages)
  const hasMore = useStore((s) => s.hasMore)
  const listLoading = useStore((s) => s.listLoading)
  const loadMore = useStore((s) => s.loadMore)
  const select = useStore((s) => s.select)
  const selectNextUnread = useStore((s) => s.selectNextUnread)
  const selectedMessageId = useStore((s) => s.selectedMessageId)
  const folderKind = useStore((s) => s.folderKind)
  const setFolder = useStore((s) => s.setFolder)
  const smartView = useStore((s) => s.smartView)
  const setSmartView = useStore((s) => s.setSmartView)
  const unreadOnly = useStore((s) => s.unreadOnly)
  const setUnreadOnly = useStore((s) => s.setUnreadOnly)
  const setSearch = useStore((s) => s.setSearch)
  const searchSort = useStore((s) => s.searchSort)
  const setSearchSort = useStore((s) => s.setSearchSort)
  const searchQuery = useStore((s) => s.searchQuery)
  const accounts = useStore((s) => s.accounts)
  const selectedAccountIds = useStore((s) => s.selectedAccountIds)
  const connected = useStore((s) => s.connected)
  const offlineMode = useStore((s) => s.offlineMode)
  const checkedIds = useStore((s) => s.checkedIds)
  const openContextMenu = useStore((s) => s.openContextMenu)
  const toggleChecked = useStore((s) => s.toggleChecked)
  const rangeCheck = useStore((s) => s.rangeCheck)
  const clearChecked = useStore((s) => s.clearChecked)
  const selectMode = useStore((s) => s.selectMode)
  const endSelect = useStore((s) => s.endSelect)
  const openMoveDialog = useStore((s) => s.openMoveDialog)
  const moveDrag = useStore((s) => s.moveDrag)
  const startMoveDrag = useStore((s) => s.startMoveDrag)
  const endMoveDrag = useStore((s) => s.endMoveDrag)
  const toast = useStore((s) => s.toast)
  const currentUser = useStore((s) => s.currentUser)
  const markSeen = useStore((s) => s.markSeen)
  const deleteMessages = useStore((s) => s.deleteMessages)
  const markAllSeen = useStore((s) => s.markAllSeen)
  const moveSpecial = useStore((s) => s.moveSpecial)
  const folders = useStore((s) => s.folders)
  const selectedFolderId = useStore((s) => s.selectedFolderId)
  const threadView = useStore((s) => s.threadView)
  const setThreadView = useStore((s) => s.setThreadView)

  const [clusterView, setClusterView] = useState(localStorage.getItem('gecko-cluster') === '1')
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set())
  const { open: viewMenuOpen, ref: viewMenuRef, toggle: toggleViewMenu } = usePopover()
  const toggleClusterView = (v: boolean): void => {
    setClusterView(v)
    localStorage.setItem('gecko-cluster', v ? '1' : '0')
  }

  // vurgu terimleri: filtre anahtarları (from:, is:, önce: …) hariç arama sözcükleri
  const hiTerms = useMemo(() => highlightTerms(parseSearch(searchQuery)), [searchQuery])

  const [searchDraft, setSearchDraft] = useState('')
  const parentRef = useRef<HTMLDivElement>(null)
  const colorMap = useRef(new Map<number, string>())
  useEffect(() => {
    colorMap.current = new Map(accounts.map((a) => [a.id, a.color]))
  }, [accounts])

  // arama kutusu: 300ms debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchDraft.trim() !== searchQuery) setSearch(searchDraft)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchDraft, searchQuery, setSearch])

  // dışarıdan (kayıtlı arama) gelen sorguyu arama kutusuna yansıt; debounce'un geri almasını önler
  useEffect(() => {
    setSearchDraft((d) => (d === searchQuery ? d : searchQuery))
  }, [searchQuery])

  const displayRows = useMemo(
    () => (clusterView ? buildDisplayRows(messages, expandedClusters) : messages.map((m): DisplayRow => ({ kind: 'msg', m }))),
    [messages, clusterView, expandedClusters]
  )

  // "yeni gönderen" rozeti: yalnızca bu görünümde (yüklü sayfa) hesap+gönderen tam bir kez
  // geçiyorsa — tam geçmiş sorgusu değil, ucuz bir sinyal. Gelen kutusu dışında/aramada yanıltıcı
  // olabileceğinden sadece filtresiz gelen kutusu görünümünde gösterilir.
  const newSenderIds = useMemo(() => {
    if (folderKind !== 'inbox' || unreadOnly || searchQuery.trim()) return new Set<number>()
    const counts = new Map<string, number>()
    for (const m of messages) {
      if (!m.fromAddr) continue
      const key = `${m.accountId}|${m.fromAddr.toLowerCase()}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const out = new Set<number>()
    for (const m of messages) {
      if (!m.fromAddr) continue
      if (counts.get(`${m.accountId}|${m.fromAddr.toLowerCase()}`) === 1) out.add(m.id)
    }
    return out
  }, [messages, folderKind, unreadOnly, searchQuery])

  // seçim modu son seçim kalkınca biter (taşıma, silme, klasör değişimi, Esc: hepsi checkedIds'i boşaltır)
  useEffect(() => {
    if (selectMode && !checkedIds.length) endSelect()
  }, [selectMode, checkedIds.length, endSelect])

  // sürüklenen satır kaydırmada DOM'dan düşerse tarayıcı sürüklemeyi yarıda keser, dragend de gelmez:
  // pencere dışına çıksa da çizilir
  const dragIndex = useMemo(
    () => (moveDrag ? displayRows.findIndex((r) => r.kind === 'msg' && r.m.id === moveDrag.rowId) : -1),
    [moveDrag, displayRows]
  )
  const rangeExtractor = useCallback(
    (range: Range) => {
      const base = defaultRangeExtractor(range)
      return dragIndex < 0 || base.includes(dragIndex) ? base : [...base, dragIndex].sort((a, b) => a - b)
    },
    [dragIndex]
  )

  const count = displayRows.length + (hasMore ? 1 : 0)
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 74,
    // telefonda ileti açıkken liste gizlidir, satırlar 0 ölçülür: geri dönüşte düzeltme listeyi sona atardı
    measureElement: (el, entry, inst) =>
      parentRef.current?.clientHeight ? measureElement(el, entry, inst) : (inst.measurementsCache[inst.indexFromElement(el)]?.size ?? 74),
    overscan: 12,
    rangeExtractor
  })

  useEffect(() => {
    if (!moveDrag) return
    return watchDragEnd(endMoveDrag)
    // sürükleme boyunca tek dinleyici
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!moveDrag, endMoveDrag])

  const dragStartTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const canDrag = navBreakpoint(useBreakpoint(), platform.kind, true) === 'wide' && !offlineMode && !touchPrimary()
  const onRowDragStart = (e: DragEvent, m: ListRow): void => {
    const chosen = dragIds(m.id, checkedIds)
    const rows = messages.filter((x) => chosen.includes(x.id)).map(toMoveRow)
    if (!sameAccount(rows.map((r) => r.id), rowMap(rows))) {
      e.preventDefault()
      toast(t('mail.move.mixedAccounts'), 'info')
      return
    }
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(rows.map((r) => r.id)))
    e.dataTransfer.effectAllowed = 'move'
    // sürükleme görseli: ekran dışı rozet; tarayıcı kopyasını aldıktan sonra silinir
    const badge = document.createElement('div')
    badge.className = 'drag-badge'
    badge.textContent = t('mail.move.dragCount', { count: mailCount(rows) })
    document.body.append(badge)
    e.dataTransfer.setDragImage(badge, 12, 12)
    setTimeout(() => badge.remove(), 0) // sürükleme hemen bitse de kalmaz
    // dragstart içinde DOM değişirse Chromium sürüklemeyi hemen bitirebilir: kenar çubuğu sonraki turda açılır
    dragStartTimer.current = setTimeout(() => startMoveDrag(m.id, rows), 0)
  }
  const onRowDragEnd = (): void => {
    clearTimeout(dragStartTimer.current)
    endMoveDrag()
  }

  const items = virtualizer.getVirtualItems()
  useEffect(() => {
    const lastItem = items[items.length - 1]
    if (lastItem && lastItem.index >= displayRows.length && hasMore && !listLoading) void loadMore()
  }, [items, displayRows.length, hasMore, listLoading, loadMore])

  // klavye ile gezinirken (j/k) seçili satır sanal pencerenin dışına çıkarsa görünüre kaydır
  useEffect(() => {
    if (selectedMessageId == null) return
    const i = displayRows.findIndex((r) =>
      r.kind === 'msg' ? r.m.id === selectedMessageId : r.msgs.some((mm) => mm.id === selectedMessageId)
    )
    if (i >= 0) virtualizer.scrollToIndex(i, { align: 'auto' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMessageId])

  const checkedRows = useMemo(() => messages.filter((m) => checkedIds.includes(m.id)).map(toMoveRow), [messages, checkedIds])
  const canManage = (accountId: number): boolean => canManageAccount(currentUser, accounts.find((a) => a.id === accountId))
  // Taşı kapalıysa neden: görünür not (dokunmatikte üzerine gelme yok)
  const moveBlock =
    new Set(checkedRows.map((r) => r.accountId)).size > 1
      ? t('mail.move.mixedAccounts')
      : checkedRows.some((r) => !canManage(r.accountId))
        ? t('sync.perm.cannotManage')
        : null
  const folderName = selectedFolderId != null ? folders.find((f) => f.id === selectedFolderId)?.display : null
  const one = selectedAccountIds?.length === 1 ? accounts.find((a) => a.id === selectedAccountIds[0]) : undefined
  const smart = smartViews()
  const scopeLabel =
    selectedAccountIds === null
      ? t('mail.scope.allAccounts')
      : one
        ? one.displayName || one.email
        : t('mail.scope.selected', { count: selectedAccountIds.length })
  const viewLabel = smartView ? smart.find((v) => v.view === smartView)?.label : folderName
  const title = viewLabel ? `${scopeLabel} › ${viewLabel}` : scopeLabel

  return (
    <section className="listpane" inert={drawerOpen}>
      {offlineMode && (
        <div className="host-banner offline list-offline" role="status">
          <div className="host-banner-row">
            <svg className="icon sm"><use href="#i-alert" /></svg>
            <span>{t('common.offlineBanner')}</span>
          </div>
        </div>
      )}
      <div className="list-head">
        <div className="list-title-row">
          <MenuButton />
          <h2 className="list-title" title={title}>
            {title}
          </h2>
          <div className="toolbar-group">
            <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => selectNextUnread()} data-tip={t('mail.list.nextUnread')} aria-label={t('mail.list.nextUnread')}>
              <svg className="icon sm"><use href="#i-chevron" /></svg>
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              data-tip={t('mail.list.markAllRead')}
              aria-label={t('mail.list.markAllReadAria')}
              onClick={() => void markAllSeen()} // onay store'da (her giriş noktasında aynı)
            >
              <svg className="icon sm"><use href="#i-check2" /></svg>
            </button>
            <div className="menu-anchor" ref={viewMenuRef}>
              <button
                type="button"
                className={`btn btn-ghost btn-icon btn-sm ${threadView || clusterView ? 'active' : ''}`}
                data-tip={t('mail.list.viewOptions')}
                data-tip-align="end"
                aria-label={t('mail.list.viewOptions')}
                aria-haspopup="menu"
                aria-expanded={viewMenuOpen}
                onClick={toggleViewMenu}
              >
                <svg className="icon sm"><use href="#i-more" /></svg>
              </button>
              {viewMenuOpen && (
                <div className="menu view-menu" role="menu">
                  <div className="menu-label">{t('mail.list.listView')}</div>
                  <button type="button" role="menuitemcheckbox" aria-checked={threadView} className="menu-item" onClick={() => setThreadView(!threadView)}>
                    <svg className="icon sm"><use href="#i-thread" /></svg> {t('mail.list.groupThreads')}
                    <svg className="icon sm check"><use href="#i-check" /></svg>
                  </button>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={clusterView}
                    className="menu-item"
                    title={t('mail.list.clusterTitle')}
                    onClick={() => toggleClusterView(!clusterView)}
                  >
                    <svg className="icon sm"><use href="#i-mute" /></svg> {t('mail.list.clusterToggle')}
                    <svg className="icon sm check"><use href="#i-check" /></svg>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="segmented fill folder-seg" role="tablist" aria-label={t('mail.list.folderTabs')}>
          {FOLDER_KINDS.map((kind) => {
            const on = !smartView && selectedFolderId == null && folderKind === kind
            return (
              <button key={kind} type="button" role="tab" aria-selected={on} className={on ? 'on' : ''} onClick={() => setFolder(kind)}>
                <span>{t(`mail.folder.${kind}`)}</span>
              </button>
            )
          })}
        </div>
        {checkedIds.length > 0 ? (
          <div className="bulk-bar toolbar" role="toolbar" aria-label={t('mail.list.selectedMails')}>
            <b className="bulk-count">{t('mail.list.selectedCount', { n: checkedIds.length })}</b>
            <span className="spacer" />
            <button type="button" className="btn btn-ghost btn-icon btn-sm" data-tip={t('mail.action.markRead')} aria-label={t('mail.action.markRead')} onClick={() => markSeen(checkedIds, true)}>
              <svg className="icon sm"><use href="#i-mail-open" /></svg>
            </button>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" data-tip={t('mail.action.markUnread')} aria-label={t('mail.action.markUnread')} onClick={() => markSeen(checkedIds, false)}>
              <svg className="icon sm"><use href="#i-mail-dot" /></svg>
            </button>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" data-tip={t('mail.action.archive')} aria-label={t('mail.action.archive')} onClick={() => moveSpecial(checkedIds, 'archive')}>
              <svg className="icon sm"><use href="#i-archive" /></svg>
            </button>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" data-tip={t('mail.action.spam')} aria-label={t('mail.action.markSpam')} onClick={() => moveSpecial(checkedIds, 'junk')}>
              <svg className="icon sm"><use href="#i-alert" /></svg>
            </button>
            <button type="button" className="btn btn-ghost btn-icon btn-sm danger" data-tip={t('action.delete')} aria-label={t('action.delete')} onClick={() => deleteMessages(checkedIds)}>
              <svg className="icon sm"><use href="#i-trash" /></svg>
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              data-tip={t('mail.view.moveToFolder')}
              aria-label={t('mail.view.moveToFolder')}
              aria-haspopup="dialog"
              aria-describedby={moveBlock ? 'bulk-move-note' : undefined}
              disabled={offlineMode || !!moveBlock || !checkedRows.length}
              title={offlineMode ? t('common.offlineReadOnly') : (moveBlock ?? undefined)}
              onClick={() => openMoveDialog(checkedRows)}
            >
              <svg className="icon sm"><use href="#i-folder" /></svg>
            </button>
            <span className="toolbar-sep" aria-hidden="true" />
            <button type="button" className="btn btn-ghost btn-icon btn-sm" data-tip={t('mail.list.clearSelectionTip')} data-tip-align="end" aria-label={t('mail.list.clearSelection')} onClick={clearChecked}>
              <svg className="icon sm"><use href="#i-x" /></svg>
            </button>
            {moveBlock && <span id="bulk-move-note" className="bulk-note">{moveBlock}</span>}
          </div>
        ) : null}
        <div className="search-wrap">
          <svg className="icon sm search-ic"><use href="#i-search" /></svg>
          <input
            className="search"
            placeholder={t('mail.search.placeholder')}
            aria-label={t('action.search')}
            title={t('mail.search.help')}
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="search-sort"
              onClick={() => setSearchSort(searchSort === 'relevance' ? 'date' : 'relevance')}
              title={searchSort === 'relevance' ? t('mail.search.sortRelevanceTitle') : t('mail.search.sortDateTitle')}
            >
              {searchSort === 'relevance' ? t('mail.search.sortRelevance') : t('mail.search.sortDate')}
              <svg className="icon xs"><use href="#i-caret" /></svg>
            </button>
          )}
        </div>
        <div className="chip-row" role="group" aria-label={t('mail.list.filters')}>
          <button type="button" className={`chip ${unreadOnly ? 'on' : ''}`} onClick={() => setUnreadOnly(!unreadOnly)} title={t('mail.list.unreadOnlyTitle')} aria-pressed={unreadOnly}>
            <svg className="icon xs"><use href="#i-mail-dot" /></svg>
            {t('mail.list.unread')}
          </button>
          {smart.map((v) => {
            const on = smartView === v.view
            return (
              <button key={v.view} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} title={v.title} onClick={() => setSmartView(on ? null : v.view)}>
                <svg className="icon xs"><use href={`#${v.icon}`} /></svg>
                {v.label}
              </button>
            )
          })}
          <SavedSearches />
        </div>
      </div>
      <div className="list-body" ref={parentRef}>
        {!connected && !offlineMode && <div className="empty-note">{t('mail.list.connecting')}</div>}
        {(connected || offlineMode) && !messages.length && !listLoading && (
          <div className="empty-note">{searchQuery ? t('mail.list.noResults') : t('mail.list.empty')}</div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
          {items.map((vi) => {
            if (vi.index >= displayRows.length) {
              return (
                <div
                  key="more"
                  className="msg-more"
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                >
                  {t('state.loading')}
                </div>
              )
            }
            const row = displayRows[vi.index]
            return (
              <div
                key={row.kind === 'msg' ? row.m.id : `c-${row.key}`}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
              >
                {row.kind === 'cluster' ? (
                  <ClusterRow
                    msgs={row.msgs}
                    color={colorMap.current.get(row.msgs[0].accountId) ?? '#888'}
                    expanded={expandedClusters.has(row.key)}
                    onToggle={() =>
                      setExpandedClusters((prev) => {
                        const next = new Set(prev)
                        if (next.has(row.key)) next.delete(row.key)
                        else next.add(row.key)
                        return next
                      })
                    }
                  />
                ) : (
                  <Row
                    m={row.m}
                    color={colorMap.current.get(row.m.accountId) ?? '#888'}
                    active={row.m.id === selectedMessageId}
                    checked={checkedIds.includes(row.m.id)}
                    terms={hiTerms}
                    isNewSender={newSenderIds.has(row.m.id)}
                    onClick={(e) => {
                      if (selectMode || e.metaKey || e.ctrlKey) toggleChecked(row.m.id)
                      else if (e.shiftKey) rangeCheck(row.m.id)
                      else void select(row.m.id)
                    }}
                    onMenu={(x, y) => openContextMenu(x, y, row.m.id, 'list')}
                    drag={canDrag && canManage(row.m.accountId) ? { onDragStart: (e) => onRowDragStart(e, row.m), onDragEnd: onRowDragEnd } : undefined}
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
