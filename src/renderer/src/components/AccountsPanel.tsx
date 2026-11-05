import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import { needsAction, primaryActionLabel } from '../accountHealth'
import HostBanner from './HostBanner'
import { usePopover } from './usePopover'
import { getUiOs, intlTag, t } from '../../../shared/i18n'
import { platformText } from '../../../shared/platformText'
import { FOLDER_ICONS } from './MoveMenu'
import { canDrop, rowMap, SPRING_MS } from '../moveDrag'
import type { FolderInfo } from '../../../shared/rpc'

import { StatusDot } from './StatusDot'
import { platform } from '../platform'
import type { AppView } from '../layout/appView'
import { closeDrawer, DRAWER_ID, useNavDrawer } from '../layout/MobileNav'
import { LongPressDiv } from '../layout/LongPressDiv'
import { adminUi } from '../adminUi'
export { StatusDot }

const APP_NAV: { id: AppView; icon: string; label: string }[] = [
  { id: 'mail', icon: 'i-inbox', label: 'contacts.nav.mail' },
  { id: 'calendar', icon: 'i-calendar', label: 'calendar.title' },
  { id: 'contacts', icon: 'i-users', label: 'contacts.title' }
]

// yalnız anahtarlar modül düzeyinde; metin çağrı anında çevrilir (dil çalışırken değişebilir)
const VIEW_KEY = { all: 'acct.view.all', starred: 'acct.view.starred', unread: 'acct.view.unread', problems: 'acct.view.problems' } as const
const SORT_KEY = { starred: 'acct.sort.starred', unread: 'acct.sort.unread', name: 'acct.sort.name' } as const
const viewLabel = (v: keyof typeof VIEW_KEY): string => t(VIEW_KEY[v])
const sortLabel = (s: keyof typeof SORT_KEY): string => t(SORT_KEY[s])

// Birçok hesabın görünen adı yerel kısmın aynısı ("software", "catch"): tek başına ayırt edilemez.
// Anlamlı görünen ad varsa o, yoksa yerel kısım; alan adı her zaman soluk ek olarak.
function AccountLabel({ a }: { a: { email: string; displayName: string | null } }) {
  const at = a.email.lastIndexOf('@')
  const local = at > 0 ? a.email.slice(0, at) : a.email
  const domain = at > 0 ? a.email.slice(at + 1) : ''
  const dn = a.displayName?.trim()
  const meaningful = !!dn && dn.toLocaleLowerCase('tr-TR') !== local.toLocaleLowerCase('tr-TR')
  return (
    <span className="acct-name">
      {meaningful ? dn : local}
      {domain && <span className="acct-domain">{meaningful ? ` · ${domain}` : `@${domain}`}</span>}
    </span>
  )
}

/** Posta, takvim ve kişiler arasında geçiş; dar ekranda çekmecede */
function AppNav() {
  const appView = useStore((s) => s.appView)
  const setAppView = useStore((s) => s.setAppView)
  return (
    <nav className="app-nav" aria-label={t('contacts.nav.label')}>
      {APP_NAV.map((v) => (
        <button key={v.id} type="button" className={`btn btn-ghost btn-sm${appView === v.id ? ' active' : ''}`} aria-current={appView === v.id ? 'page' : undefined} onClick={() => setAppView(v.id)}>
          <svg className="icon sm"><use href={`#${v.icon}`} /></svg> {t(v.label)}
        </button>
      ))}
    </nav>
  )
}

export default function AccountsPanel() {
  const drawerOpen = useNavDrawer((s) => s.open)
  const accounts = useStore((s) => s.accounts)
  const selected = useStore((s) => s.selectedAccountIds)
  const setFilter = useStore((s) => s.setAccountFilter)
  const toggleInFilter = useStore((s) => s.toggleAccountInFilter)
  const setImportOpen = useStore((s) => s.setImportOpen)
  const setProblemsOpen = useStore((s) => s.setProblemsOpen)
  const setHealthBoardOpen = useStore((s) => s.setHealthBoardOpen)
  const setAttachmentsOpen = useStore((s) => s.setAttachmentsOpen)
  const openWallboard = useStore((s) => s.openWallboard)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setEditAccount = useStore((s) => s.setEditAccount)
  const toggleStar = useStore((s) => s.toggleStar)
  const folders = useStore((s) => s.folders)
  const selectedFolderId = useStore((s) => s.selectedFolderId)
  const selectFolder = useStore((s) => s.selectFolder)
  const toast = useStore((s) => s.toast)
  const currentUser = useStore((s) => s.currentUser)
  const followupDue = useStore((s) => s.followupDue)
  const setUsersOpen = useStore((s) => s.setUsersOpen)
  const setGroupsOpen = useStore((s) => s.setGroupsOpen)
  const setAutomationOpen = useStore((s) => s.setAutomationOpen)
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen)
  const vaultState = useStore((s) => s.vaultState)
  const setVaultPromptOpen = useStore((s) => s.setVaultPromptOpen)
  const openComposer = useStore((s) => s.openComposer)
  const offlineMode = useStore((s) => s.offlineMode)
  const openAccountMenu = useStore((s) => s.openAccountMenu)
  const accountViewFilter = useStore((s) => s.accountViewFilter)
  const accountSort = useStore((s) => s.accountSort)
  const setAccountViewFilter = useStore((s) => s.setAccountViewFilter)
  const setAccountSort = useStore((s) => s.setAccountSort)
  const logout = useStore((s) => s.logout)
  const lockVault = useStore((s) => s.lockVault)
  const moveDrag = useStore((s) => s.moveDrag)
  const moveRows = useStore((s) => s.moveRows)
  const [filter, setFilterText] = useState('')
  const [dropFolder, setDropFolder] = useState<number | null>(null)
  const [noDropAccount, setNoDropAccount] = useState<number | null>(null)
  // sürükleme sırasında bekleyerek açılan gruplar: kalıcı katlama durumuna yazılmaz
  const [springOpen, setSpringOpen] = useState<Set<string>>(new Set())
  const spring = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const cancelSpring = (): void => {
    if (spring.current) clearTimeout(spring.current.timer)
    spring.current = null
  }
  const dragTree = useRef<HTMLDivElement>(null)
  const dragFolders = moveDrag?.folders
  // geçici ağaç hesap listesinin görünmeyen yerinde açılabilir
  useEffect(() => {
    dragTree.current?.scrollIntoView?.({ block: 'nearest' })
  }, [dragFolders])
  // sürükleme bitti (Esc, dışarı bırakma): vurgu ve geçici açılanlar temizlenir
  const [prevDrag, setPrevDrag] = useState(moveDrag)
  if (moveDrag !== prevDrag) {
    setPrevDrag(moveDrag)
    if (!moveDrag) {
      setDropFolder(null)
      setNoDropAccount(null)
      setSpringOpen(new Set())
    }
  }
  useEffect(() => {
    if (!moveDrag) cancelSpring()
  }, [moveDrag])
  const { open: userMenuOpen, setOpen: setUserMenuOpen, ref: userMenuRef, toggle: toggleUserMenu } = usePopover()
  const isAdmin = currentUser?.role === 'admin'
  const menuGo = (fn: () => void): void => {
    setUserMenuOpen(false)
    fn()
  }

  const dragAccountId = moveDrag?.accountId ?? null
  const totalUnread = useMemo(() => accounts.reduce((n, a) => n + a.unread, 0), [accounts])
  // rozet: eylem gerektirenler — ilk şifre reddi (ban öncesi tek fırsat) dahil
  const problems = useMemo(() => accounts.filter(needsAction), [accounts])
  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase()
    let list = f
      ? accounts.filter((a) => a.email.toLowerCase().includes(f) || (a.displayName ?? '').toLowerCase().includes(f) || (a.groupName ?? '').toLowerCase().includes(f))
      : accounts
    if (accountViewFilter === 'starred') list = list.filter((a) => a.starred)
    else if (accountViewFilter === 'unread') list = list.filter((a) => a.unread > 0)
    else if (accountViewFilter === 'problems')
      list = list.filter((a) => a.enabled && (a.status === 'auth_failed' || a.status === 'unreachable' || a.status === 'degraded'))
    // süzgeç sürüklenenlerin hesabını gizlemesin: klasörleri bırakma hedefi
    const dragged = dragAccountId == null ? undefined : accounts.find((a) => a.id === dragAccountId)
    if (dragged && !list.includes(dragged)) list = [...list, dragged]
    return [...list].sort((a, b) => {
      if (accountSort === 'unread') return b.unread - a.unread || a.email.localeCompare(b.email)
      if (accountSort === 'name') return a.email.localeCompare(b.email)
      return Number(b.starred) - Number(a.starred) // 'starred': yıldızlılar üste, gerisi mevcut sırasında
    })
  }, [accounts, filter, accountViewFilter, accountSort, dragAccountId])
  // eylem gerektirenler rozette sayılır; burada yalnızca kalan uyarılar (çift sayım yok)
  const degradedCount = useMemo(() => accounts.filter((a) => a.enabled && a.status === 'degraded' && !needsAction(a)).length, [accounts])
  const disabledCount = useMemo(() => accounts.filter((a) => !a.enabled).length, [accounts])
  const healthyCount = accounts.length - problems.length - degradedCount - disabledCount

  // P2-1: gruplara göre katlanır başlıklar (tek grup/grupsuzsa düz liste); katlama durumu cihazda
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('gecko-collapsed-groups') || '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const toggleCollapsed = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem('gecko-collapsed-groups', JSON.stringify([...next]))
      } catch {
        /* yalnız bu oturum */
      }
      return next
    })
  const grouped = useMemo(() => {
    const by = new Map<string | null, typeof visible>()
    for (const a of visible) {
      const k = a.groupName ?? null
      if (!by.has(k)) by.set(k, [])
      by.get(k)!.push(a)
    }
    if (by.size <= 1) return null
    return [...by.entries()]
      .sort(([x], [y]) => (x === null ? 1 : y === null ? -1 : x.localeCompare(y, intlTag())))
      .map(([name, list]) => ({ name, accounts: list }))
  }, [visible])

  /** Klasör satırı bırakma hedefi: yalnız sürükleme sürerken */
  const folderDrop = (f: FolderInfo, accountId: number, ok: boolean) => ({
    onDragOver(e: DragEvent) {
      if (!ok) return void (e.dataTransfer.dropEffect = 'none')
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropFolder(f.id)
    },
    onDragLeave(e: DragEvent) {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropFolder(null)
    },
    onDrop(e: DragEvent) {
      e.preventDefault()
      setDropFolder(null)
      if (moveDrag && canDrop(moveDrag.rows.map((r) => r.id), rowMap(moveDrag.rows), { id: f.id, accountId })) {
        void moveRows(moveDrag.rows, f.id)
      }
    }
  })

  /** Başka hesabın satırı: bırakılamaz, imleç ve açıklama */
  const accountNoDrop = (accountId: number) =>
    moveDrag && moveDrag.accountId !== accountId
      ? {
          onDragOver(e: DragEvent) {
            e.dataTransfer.dropEffect = 'none'
            setNoDropAccount(accountId)
          },
          onDragLeave(e: DragEvent) {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setNoDropAccount(null)
          }
        }
      : {}

  const renderAccount = (a: (typeof accounts)[number]) => {
    const active = selected?.includes(a.id) ?? false
    const inTree = active && selected?.length === 1
    const dragHere = moveDrag?.accountId === a.id
    const tree = dragHere ? (moveDrag.folders ?? []) : inTree ? folders : []
    const dragRows = moveDrag ? rowMap(moveDrag.rows) : null
    const dragged = moveDrag?.rows.map((r) => r.id) ?? []
    return (
      <Fragment key={a.id}>
      <LongPressDiv
        className={`acct-row ${active ? 'active' : ''} ${a.enabled ? '' : 'disabled'} ${noDropAccount === a.id ? 'no-drop' : ''}`}
        {...accountNoDrop(a.id)}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) toggleInFilter(a.id)
          else setFilter([a.id])
        }}
        onMenu={(x, y) => openAccountMenu(x, y, a.id)}
        title={`${a.email}${a.statusDetail ? ` — ${a.statusDetail}` : ''}\n${t('acct.panel.rowHint')}`}
      >
        <span className="acct-color" style={{ background: a.color }} />
        <AccountLabel a={a} />
        <button
          type="button"
          className={`acct-edit ${needsAction(a) ? 'attn' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            setEditAccount(a.id)
          }}
          title={needsAction(a) ? `${primaryActionLabel(a)} — ${a.statusDetail ?? ''}` : t('acct.panel.accountSettingsTip')}
          aria-label={`${a.email} — ${primaryActionLabel(a)}`}
        >
          <svg className="icon xs"><use href="#i-sliders" /></svg>
        </button>
        <span
          className={`star ${a.starred ? 'on' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            toggleStar(a.id)
          }}
          title={t('acct.panel.starTip')}
        >
          <svg className={`icon xs ${a.starred ? 'filled' : ''}`}><use href="#i-star" /></svg>
        </span>
        {a.unread > 0 && <span className="badge">{a.unread > 999 ? '999+' : a.unread}</span>}
        <StatusDot a={a} />
      </LongPressDiv>
      {tree.length > 0 && (
        <div ref={dragHere ? dragTree : undefined} className="folder-tree" role="group" aria-label={t('acct.panel.foldersOf', { email: a.email })}>
          {tree.map((f) => {
            const ok = !!dragRows && canDrop(dragged, dragRows, { id: f.id, accountId: a.id })
            const state = !dragRows ? '' : dropFolder === f.id ? 'drop-over' : ok ? 'droppable' : 'no-drop'
            return (
              <button
                type="button"
                key={f.id}
                className={`folder-row ${selectedFolderId === f.id ? 'active' : ''} ${state}`}
                aria-pressed={selectedFolderId === f.id}
                onClick={() => selectFolder(selectedFolderId === f.id ? null : f.id)}
                {...(dragRows ? folderDrop(f, a.id, ok) : {})}
              >
                <svg className="icon sm"><use href={`#${FOLDER_ICONS[f.kind] ?? 'i-folder'}`} /></svg> {f.display}
              </button>
            )
          })}
        </div>
      )}
      </Fragment>
    )
  }


  return (
    <aside
      id={DRAWER_ID}
      className="sidebar"
      // yalnız çekmece açıkken pencere gibi davranır (odak App/MobileNav'da taşınır)
      {...(drawerOpen ? { role: 'dialog', 'aria-modal': true, 'aria-label': t('mail.nav.menu'), tabIndex: -1 } : {})}
      // orta/dar ekran çekmecesi: hesap/klasör seçilince ya da yeni ileti açılınca kapanır (geniş ekranda etkisiz)
      onClick={(e) => {
        if (!e.metaKey && !e.ctrlKey && (e.target as HTMLElement).closest('.acct-row, .folder-row, .sf-add')) closeDrawer()
      }}
    >
      <div className="sidebar-head">
        <span className="app-title">
          Gecko<span>Mail</span>
        </span>
        <span className="spacer" />
        {problems.length > 0 && (
          <button type="button" className="head-warn" onClick={() => setProblemsOpen(true)} title={t('acct.panel.problemsTip', { count: problems.length })} aria-label={t('acct.panel.problemsAria', { count: problems.length })}>
            <svg className="icon xs"><use href="#i-alert" /></svg>
            {problems.length}
          </button>
        )}
        <div className="menu-anchor" ref={userMenuRef}>
          <button
            type="button"
            className="whoami"
            title={t('acct.panel.userMenuTip', { role: isAdmin ? t('acct.role.admin') : t('acct.role.member') })}
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
            onClick={toggleUserMenu}
          >
            <span className={`avatar ${isAdmin ? 'admin' : ''}`} aria-hidden="true">
              {(currentUser?.username ?? '?').slice(0, 1)}
            </span>
            <span className="whoami-name">{currentUser?.username}</span>
            <svg className="icon caret"><use href="#i-caret" /></svg>
          </button>
          {userMenuOpen && (
            <div className="menu user-menu" role="menu">
              <div className="menu-label">
                <b>{currentUser?.username}</b> · {isAdmin ? t('acct.role.admin') : t('acct.role.member')}
              </div>
              <button type="button" role="menuitem" className="menu-item" onClick={() => menuGo(() => setSettingsOpen(true, 'hesaplar'))}>
                <svg className="icon sm"><use href="#i-inbox" /></svg> {t('acct.common.accounts')}
              </button>
              {adminUi(currentUser) && (
                <>
                  <button type="button" role="menuitem" className="menu-item" onClick={() => menuGo(() => setAutomationOpen(true))}>
                    <svg className="icon sm"><use href="#i-zap" /></svg> {t('acct.panel.automation')}
                  </button>
                  <button type="button" role="menuitem" className="menu-item" onClick={() => menuGo(() => setUsersOpen(true))}>
                    <svg className="icon sm"><use href="#i-user" /></svg> {t('acct.common.users')}
                  </button>
                  <button type="button" role="menuitem" className="menu-item" onClick={() => menuGo(() => setGroupsOpen(true))}>
                    <svg className="icon sm"><use href="#i-folder" /></svg> {t('acct.common.groups')}
                  </button>
                </>
              )}
              <button type="button" role="menuitem" className="menu-item" onClick={() => menuGo(() => setSettingsOpen(true))}>
                <svg className="icon sm"><use href="#i-sliders" /></svg> {t('acct.common.settings')}
              </button>
              <div className="menu-sep" role="separator" />
              {vaultState === 'unlocked' && (
                <button type="button" role="menuitem" className="menu-item" onClick={() => menuGo(() => void lockVault())}>
                  <svg className="icon sm"><use href="#i-lock" /></svg> {t('acct.panel.lockVault')}
                </button>
              )}
              <button type="button" role="menuitem" className="menu-item danger" onClick={() => menuGo(() => void logout())}>
                <svg className="icon sm"><use href="#i-power" /></svg> {t('acct.panel.logout')}
              </button>
            </div>
          )}
        </div>
      </div>
      <HostBanner />
      <div className="sidebar-search">
        <div className="search-wrap">
          <svg className="icon sm search-ic"><use href="#i-search" /></svg>
          <input
            className="acct-filter"
            placeholder={t('acct.panel.searchPlaceholder', { total: accounts.length })}
            aria-label={t('acct.panel.searchAria')}
            title={t('acct.panel.searchTip')}
            value={filter}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              // Esc: aramayı temizle (boşsa odaktan çık)
              if (e.key !== 'Escape') return
              if (filter) setFilterText('')
              else e.currentTarget.blur()
            }}
          />
          <button type="button" className="cmdk-trigger" onClick={() => setCommandPaletteOpen(true)} title={t('acct.panel.commandPaletteTip')} aria-label={t('acct.panel.commandPaletteAria')}>
            {platformText('⌘K', getUiOs())}
          </button>
        </div>
        <label className={`icon-select ${accountViewFilter !== 'all' ? 'on' : ''}`} title={t('acct.panel.viewTip', { view: viewLabel(accountViewFilter), sort: sortLabel(accountSort) })}>
          <svg className="icon sm"><use href="#i-filter" /></svg>
          <select
            value={`${accountViewFilter}|${accountSort}`}
            onChange={(e) => {
              const [f, so] = e.target.value.split('|') as [typeof accountViewFilter, typeof accountSort]
              setAccountViewFilter(f)
              setAccountSort(so)
            }}
            aria-label={t('acct.panel.viewAria')}
          >
            <optgroup label={t('acct.panel.show')}>
              <option value={`all|${accountSort}`}>{viewLabel('all')}</option>
              <option value={`starred|${accountSort}`}>{viewLabel('starred')}</option>
              <option value={`unread|${accountSort}`}>{viewLabel('unread')}</option>
              <option value={`problems|${accountSort}`}>{viewLabel('problems')}</option>
            </optgroup>
            <optgroup label={t('acct.panel.sortBy')}>
              <option value={`${accountViewFilter}|starred`}>{sortLabel('starred')}</option>
              <option value={`${accountViewFilter}|unread`}>{sortLabel('unread')}</option>
              <option value={`${accountViewFilter}|name`}>{sortLabel('name')}</option>
            </optgroup>
          </select>
        </label>
      </div>
      <div className="quickbar" role="toolbar" aria-label={t('acct.panel.quickAccess')}>
        <button type="button" className="qb" data-tip={t('acct.panel.healthBoard')} data-tip-align="start" aria-label={t('acct.panel.healthBoard')} onClick={() => setHealthBoardOpen(true)}>
          <svg className="icon"><use href="#i-pulse" /></svg>
        </button>
        {platform.wallboard && (
          <button type="button" className="qb" data-tip={t('acct.panel.wallboard')} aria-label={t('acct.panel.wallboard')} onClick={() => openWallboard()}>
            <svg className="icon"><use href="#i-grid" /></svg>
          </button>
        )}
        <button type="button" className="qb" data-tip={t('acct.panel.attachments')} aria-label={t('acct.panel.attachments')} onClick={() => setAttachmentsOpen(true)}>
          <svg className="icon"><use href="#i-clip" /></svg>
        </button>
        <button type="button" className="qb" data-tip={t('acct.panel.outbox')} aria-label={t('acct.panel.outbox')} onClick={() => useStore.getState().setOutboxOpen(true)}>
          <svg className="icon"><use href="#i-send" /></svg>
        </button>
        <button
          type="button"
          className="qb"
          data-tip={followupDue ? t('acct.panel.followupsDueTip', { count: followupDue }) : t('acct.panel.followups')}
          aria-label={followupDue ? t('acct.panel.followupsDueAria', { count: followupDue }) : t('acct.panel.followups')}
          onClick={() => useStore.getState().setFollowupsOpen(true)}
        >
          <svg className="icon"><use href="#i-bell" /></svg>
          {followupDue > 0 && <span className="qb-dot">{followupDue > 99 ? '99+' : followupDue}</span>}
        </button>
        <span className="qb-sep" aria-hidden="true" />
        <button type="button" className="qb" data-tip={t('acct.common.accounts')} aria-label={t('acct.common.accounts')} onClick={() => setSettingsOpen(true, 'hesaplar')}>
          <svg className="icon"><use href="#i-inbox" /></svg>
        </button>
        <button type="button" className="qb" data-tip={t('acct.common.settings')} data-tip-align="end" aria-label={t('acct.common.settings')} onClick={() => setSettingsOpen(true)}>
          <svg className="icon"><use href="#i-sliders" /></svg>
        </button>
      </div>
      {vaultState === 'locked' && (
        <div
          className="vault-inline-bar"
          role="button"
          tabIndex={0}
          onClick={() => setVaultPromptOpen(true)}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setVaultPromptOpen(true)}
          title={t('acct.panel.openVault')}
        >
          <svg className="icon sm"><use href="#i-lock" /></svg>
          <span>{t('acct.panel.vaultLocked')}</span>
          <span className="vault-inline-open">{t('acct.panel.open')}</span>
        </div>
      )}
      <LongPressDiv
        className={`acct-row all ${selected === null ? 'active' : ''}`}
        onClick={() => setFilter(null)}
        onMenu={(x, y) => openAccountMenu(x, y, 'all')}
      >
        <span className="acct-name">
          <svg className="icon"><use href="#i-inbox" /></svg> {t('acct.panel.allInboxes')}
        </span>
        {accountViewFilter !== 'all' && (
          <span className="view-filter-tag" title={t('acct.panel.viewFilterActive')}>
            {accountViewFilter === 'starred' ? t('acct.panel.tagStarred') : accountViewFilter === 'unread' ? t('acct.panel.tagUnread') : t('acct.panel.tagProblems')}
          </span>
        )}
        {totalUnread > 0 && <span className="badge">{totalUnread > 9999 ? '9999+' : totalUnread}</span>}
      </LongPressDiv>
      <div className="acct-list">
        {grouped
          ? grouped.map((g) => {
              const key = g.name ?? ''
              const isCollapsed = collapsed.has(key) && !springOpen.has(key)
              const holdsDrag = isCollapsed && g.accounts.some((a) => a.id === dragAccountId)
              const unread = g.accounts.reduce((n, a) => n + a.unread, 0)
              const ids = g.accounts.map((a) => a.id)
              const groupActive = !!selected && selected.length === ids.length && ids.every((id) => selected.includes(id))
              return (
                <div key={key} className="acct-group" role="group" aria-label={g.name ?? t('acct.common.ungrouped')}>
                  <div
                    className={`acct-group-head ${groupActive ? 'active' : ''} ${holdsDrag ? 'drop-hold' : ''}`}
                    {...(moveDrag && isCollapsed
                      ? {
                          // kapalı grubun üstünde beklemek içindeki hesabın klasörlerini açar
                          onDragOver() {
                            if (spring.current?.key === key) return
                            cancelSpring()
                            spring.current = {
                              key,
                              timer: setTimeout(() => {
                                spring.current = null
                                setSpringOpen((prev) => new Set(prev).add(key))
                              }, SPRING_MS)
                            }
                          },
                          onDragLeave(e: DragEvent) {
                            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) cancelSpring()
                          }
                        }
                      : {})}
                  >
                    <button
                      type="button"
                      className={`acct-group-toggle ${isCollapsed ? 'collapsed' : ''}`}
                      aria-expanded={!isCollapsed}
                      aria-label={t(isCollapsed ? 'acct.panel.expandGroup' : 'acct.panel.collapseGroup', { name: g.name ?? t('acct.common.ungrouped') })}
                      onClick={() => toggleCollapsed(key)}
                    >
                      <svg className="icon sm"><use href="#i-chevron" /></svg>
                    </button>
                    <button type="button" className="acct-group-name" onClick={() => setFilter(ids)} title={t('acct.panel.showGroupTip')}>
                      {g.name ?? t('acct.common.ungrouped')} <span className="acct-group-count">{g.accounts.length}</span>
                    </button>
                    {unread > 0 && <span className="badge">{unread > 9999 ? '9999+' : unread}</span>}
                  </div>
                  {!isCollapsed && g.accounts.map(renderAccount)}
                </div>
              )
            })
          : visible.map(renderAccount)}
        {!visible.length && accounts.length > 0 && <div className="empty-note">{t('acct.common.noMatch')}</div>}
      </div>
      {accounts.length > 0 && (
        <div
          className="health-strip"
          role="button"
          tabIndex={0}
          onClick={() => setHealthBoardOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setHealthBoardOpen(true)
            }
          }}
          title={t('acct.panel.openHealthBoard')}
        >
          <span className="hs-seg">
            <span className="hs-dot ok" />
            {healthyCount}
          </span>
          {degradedCount > 0 && (
            <span className="hs-seg warn">
              <span className="hs-dot warn" />
              {degradedCount}
            </span>
          )}
          {problems.length > 0 && (
            <span className="hs-seg err">
              <span className="hs-dot err" />
              {problems.length}
            </span>
          )}
          {disabledCount > 0 && (
            <span className="hs-seg dim">
              <span className="hs-dot off" />
              {disabledCount}
            </span>
          )}
        </div>
      )}
      {moveDrag && noDropAccount != null && (
        <div className="drag-hint" role="status">
          <svg className="icon sm"><use href="#i-ban" /></svg> {t('mail.move.otherAccount')}
        </div>
      )}
      <AppNav />
      <div className="sidebar-foot">
        <button className="primary sf-add" onClick={() => openComposer('new')} disabled={offlineMode} title={offlineMode ? t('common.offlineReadOnly') : t('acct.panel.newMailTip')}>
          <svg className="icon sm"><use href="#i-pencil" /></svg> {t('acct.panel.newMail')}
        </button>
        <div className="sf-row">
          {adminUi(currentUser) && (
            <button onClick={() => setImportOpen(true)}>
              <svg className="icon sm"><use href="#i-plus" /></svg> {t('acct.common.addAccount')}
            </button>
          )}
          <button
            onClick={() => {
              void rpc.call('pollNow', { accountIds: null }).catch((e) => toast(String(e.message)))
              toast(t('acct.panel.refreshingAll'), 'info')
            }}
          >
            <svg className="icon sm"><use href="#i-refresh" /></svg> {t('action.refresh')}
          </button>
        </div>
      </div>
    </aside>
  )
}
