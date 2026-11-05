import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import { exportContactsCsv } from '../exportContacts'
import type { FolderKind } from '../../../shared/rpc'
import { getUiOs, t } from '../../../shared/i18n'
import { platformText } from '../../../shared/platformText'
import { platform } from '../platform'
import { adminUi } from '../adminUi'

interface CmdItem {
  id: string
  section: string
  label: string
  sub?: string
  icon: string
  run: () => void
}

// etiket render anında çevrilir: t(`mail.folderLong.${kind}`)
const FOLDER_ITEMS: { kind: FolderKind; icon: string }[] = [
  { kind: 'inbox', icon: 'i-inbox' },
  { kind: 'sent', icon: 'i-send' },
  { kind: 'archive', icon: 'i-archive' },
  { kind: 'junk', icon: 'i-alert' },
  { kind: 'trash', icon: 'i-trash' }
]

export default function CommandPalette() {
  const open = useStore((s) => s.commandPaletteOpen)
  const setOpen = useStore((s) => s.setCommandPaletteOpen)
  const currentUser = useStore((s) => s.currentUser)
  const accounts = useStore((s) => s.accounts)
  const selectedMessageId = useStore((s) => s.selectedMessageId)
  const checkedIds = useStore((s) => s.checkedIds)
  const theme = useStore((s) => s.theme)
  const openComposer = useStore((s) => s.openComposer)
  const markAllSeen = useStore((s) => s.markAllSeen)
  const moveSpecial = useStore((s) => s.moveSpecial)
  const setFlagged = useStore((s) => s.setFlagged)
  const deleteMessages = useStore((s) => s.deleteMessages)
  const setAccountFilter = useStore((s) => s.setAccountFilter)
  const setFolder = useStore((s) => s.setFolder)
  const setHealthBoardOpen = useStore((s) => s.setHealthBoardOpen)
  const openWallboard = useStore((s) => s.openWallboard)
  const vaultState = useStore((s) => s.vaultState)
  const lockVault = useStore((s) => s.lockVault)
  const setVaultPromptOpen = useStore((s) => s.setVaultPromptOpen)
  const setAutomationOpen = useStore((s) => s.setAutomationOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setImportOpen = useStore((s) => s.setImportOpen)
  const setUsersOpen = useStore((s) => s.setUsersOpen)
  const setGroupsOpen = useStore((s) => s.setGroupsOpen)
  const setTheme = useStore((s) => s.setTheme)
  const logout = useStore((s) => s.logout)
  const toast = useStore((s) => s.toast)
  const setEditAccount = useStore((s) => s.setEditAccount)
  const setSmartView = useStore((s) => s.setSmartView)
  const setAttachmentsOpen = useStore((s) => s.setAttachmentsOpen)
  const setShortcutsOpen = useStore((s) => s.setShortcutsOpen)

  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // açılışta arama sıfırlanır (render sırasında: önceki açılışın metni bir kare bile görünmez)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setQ('')
      setActive(0)
    }
  }
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  const items = useMemo<CmdItem[]>(() => {
    // bölüm adları (dil değişince App yeniden bağlanır; useMemo yeterli)
    const S = {
      actions: t('mail.cmd.section.actions'),
      nav: t('mail.cmd.section.navigation'),
      goToAccount: t('mail.cmd.section.goToAccount'),
      accountSettings: t('mail.cmd.section.accountSettings'),
      panel: t('mail.cmd.section.panel'),
      vault: t('mail.cmd.section.vault'),
      appearance: t('mail.cmd.section.appearance'),
      session: t('mail.cmd.section.session')
    }
    const list: CmdItem[] = [
      { id: 'new-mail', section: S.actions, label: t('mail.cmd.newMail'), icon: 'i-pencil', run: () => openComposer('new') },
      { id: 'mark-all', section: S.actions, label: t('mail.list.markAllRead'), icon: 'i-check2', run: () => void markAllSeen() },
      {
        id: 'export-contacts', section: S.actions, label: t('mail.cmd.exportContacts'), icon: 'i-save',
        run: () => {
          void rpc
            .call('getContacts', {})
            .then((all) => {
              const contacts = all.filter((c) => c.groupId == null)
              return contacts.length ? exportContactsCsv(contacts) : toast(t('mail.contacts.none'), 'info')
            })
            .catch((e) => toast(t('mail.contacts.failed', { error: (e as Error).message }), 'error'))
        }
      }
    ]
    const targets = checkedIds.length ? checkedIds : selectedMessageId != null ? [selectedMessageId] : []
    if (targets.length) {
      list.push(
        {
          id: 'archive-sel', section: S.actions, label: t('mail.cmd.archiveSelected', { n: targets.length }), icon: 'i-archive',
          run: () => moveSpecial(targets, 'archive')
        },
        {
          id: 'flag-sel', section: S.actions, label: t('mail.cmd.starSelected', { n: targets.length }), icon: 'i-star',
          run: () => setFlagged(targets, true)
        },
        {
          id: 'delete-sel', section: S.actions, label: t('mail.cmd.deleteSelected', { n: targets.length }), icon: 'i-trash',
          run: () => deleteMessages(targets)
        }
      )
    }
    list.push({ id: 'calendar-page', section: S.nav, label: t('calendar.title'), icon: 'i-calendar', run: () => useStore.getState().setAppView('calendar') })
    list.push({ id: 'contacts-page', section: S.nav, label: t('contacts.title'), icon: 'i-users', run: () => useStore.getState().setAppView('contacts') })
    list.push({ id: 'all-inboxes', section: S.nav, label: t('mail.scope.allInboxes'), icon: 'i-inbox', run: () => setAccountFilter(null) })
    for (const f of FOLDER_ITEMS) {
      list.push({ id: `folder-${f.kind}`, section: S.nav, label: t(`mail.folderLong.${f.kind}`), icon: f.icon, run: () => setFolder(f.kind) })
    }
    list.push(
      { id: 'snoozed', section: S.nav, label: t('mail.cmd.snoozed'), icon: 'i-clock', run: () => setSmartView('snoozed') },
      { id: 'starred', section: S.nav, label: t('mail.cmd.starred'), icon: 'i-star', run: () => setSmartView('starred') },
      { id: 'with-attachments', section: S.nav, label: t('mail.cmd.withAttachments'), icon: 'i-clip', run: () => setSmartView('attachments') },
      { id: 'attachments', section: S.nav, label: t('mail.attachments.title'), icon: 'i-clip', run: () => setAttachmentsOpen(true) },
      { id: 'outbox', section: S.nav, label: t('mail.cmd.outbox'), icon: 'i-send', run: () => useStore.getState().setOutboxOpen(true) },
      { id: 'followups', section: S.nav, label: t('mail.cmd.followups'), icon: 'i-bell', run: () => useStore.getState().setFollowupsOpen(true) },
      { id: 'subscriptions', section: S.nav, label: t('mail.cmd.subscriptions'), icon: 'i-ban', run: () => useStore.getState().setSubscriptionsOpen(true) }
    )
    for (const a of accounts) {
      list.push({
        id: `acct-${a.id}`,
        section: S.goToAccount,
        label: a.displayName || a.email,
        sub: a.displayName ? a.email : undefined,
        icon: 'i-user',
        run: () => setAccountFilter([a.id])
      })
    }
    // ikinci eylem: aynı hesabın ayarları ('düzenle', 'şifre', e-posta ile aranır)
    for (const a of accounts) {
      list.push({
        id: `acct-edit-${a.id}`,
        section: S.accountSettings,
        label: t('mail.cmd.editAccount', { name: a.displayName || a.email }),
        sub: `${a.displayName ? `${a.email} · ` : ''}${t('mail.cmd.editAccountSub')}`,
        icon: 'i-sliders',
        run: () => setEditAccount(a.id)
      })
    }
    list.push(
      { id: 'health', section: S.panel, label: t('mail.cmd.health'), icon: 'i-pulse', run: () => setHealthBoardOpen(true) },
      // duvar modu yalnız masaüstünde
      ...(platform.wallboard ? [{ id: 'wallboard', section: S.panel, label: t('mail.cmd.wallboard'), icon: 'i-pulse', run: () => openWallboard() }] : []),
      { id: 'accounts', section: S.panel, label: t('mail.cmd.accounts'), icon: 'i-user', run: () => setSettingsOpen(true, 'hesaplar') },
      { id: 'connection', section: S.panel, label: t('mail.cmd.connection'), icon: 'i-pulse', run: () => setSettingsOpen(true, 'baglanti') },
      { id: 'settings', section: S.panel, label: t('mail.cmd.settings'), sub: platformText('⌘,', getUiOs()), icon: 'i-sliders', run: () => setSettingsOpen(true) },
      { id: 'shortcuts', section: S.panel, label: t('mail.cmd.shortcuts'), sub: '?', icon: 'i-grid', run: () => setShortcutsOpen(true) }
    )
    if (adminUi(currentUser)) {
      // hızlı erişim çubuğuyla aynı yetki: otomasyon ve hesap ekleme yalnız yönetici (UX-P1-5)
      list.push(
        { id: 'automation', section: S.panel, label: t('mail.cmd.automation'), icon: 'i-zap', run: () => setAutomationOpen(true) },
        { id: 'import', section: S.panel, label: t('mail.cmd.addAccount'), icon: 'i-plus', run: () => setImportOpen(true) },
        { id: 'users', section: S.panel, label: t('mail.cmd.users'), icon: 'i-user', run: () => setUsersOpen(true) },
        { id: 'groups', section: S.panel, label: t('mail.cmd.groups'), icon: 'i-folder', run: () => setGroupsOpen(true) }
      )
    }
    if (vaultState === 'unlocked') {
      list.push({ id: 'vault-lock', section: S.vault, label: t('mail.cmd.lockVault'), icon: 'i-lock', run: () => void lockVault() })
    } else if (vaultState === 'locked') {
      list.push({ id: 'vault-unlock', section: S.vault, label: t('mail.view.unlockVault'), icon: 'i-unlock', run: () => setVaultPromptOpen(true) })
    }
    list.push(
      {
        id: 'theme',
        section: S.appearance,
        label: theme === 'dark' ? t('mail.cmd.themeLight') : t('mail.cmd.themeDark'),
        icon: 'i-sliders',
        run: () => setTheme(theme === 'dark' ? 'light' : 'dark')
      },
      { id: 'logout', section: S.session, label: t('mail.cmd.logout'), icon: 'i-power', run: () => void logout() }
    )
    return list
  }, [
    accounts, currentUser, checkedIds, selectedMessageId, theme, openComposer, markAllSeen, moveSpecial, setFlagged,
    deleteMessages, setAccountFilter, setFolder, setHealthBoardOpen, openWallboard, setAutomationOpen, setSettingsOpen,
    setImportOpen, setUsersOpen, setGroupsOpen, setTheme, logout, vaultState, lockVault, setVaultPromptOpen, toast,
    setEditAccount, setSmartView, setAttachmentsOpen, setShortcutsOpen
  ])

  const filtered = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return items.slice(0, 40)
    return items.filter((it) => words.every((w) => `${it.label} ${it.sub ?? ''}`.toLowerCase().includes(w))).slice(0, 40)
  }, [items, q])

  if (!open) return null

  const runAt = (i: number) => {
    const it = filtered[i]
    if (!it) return
    setOpen(false)
    it.run()
  }

  let lastSection = ''

  return (
    <div className="cmdk-overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="cmdk">
        <div className="cmdk-input-row">
          <svg className="icon"><use href="#i-search" /></svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
            }}
            placeholder={t('mail.cmd.placeholder')}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, filtered.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                runAt(active)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setOpen(false)
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="cmdk-list">
          {!filtered.length && <div className="cmdk-empty">{t('mail.cmd.empty')}</div>}
          {filtered.map((it, i) => {
            const showSection = it.section !== lastSection
            lastSection = it.section
            return (
              <div key={it.id}>
                {showSection && <div className="cmdk-section">{it.section}</div>}
                <div className={`cmdk-item ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => runAt(i)}>
                  <svg className="icon sm"><use href={`#${it.icon}`} /></svg>
                  <span>{it.label}</span>
                  {it.sub && <small>{it.sub}</small>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
