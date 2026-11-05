import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import AccountsPanel from './components/AccountsPanel'
import CalendarPage from './components/calendar/CalendarPage'
import ContactsPage from './components/contacts/ContactsPage'
import ListPane from './components/ListPane'
import MessageView from './components/MessageView'
import Composer from './components/Composer'
import ImportWizard from './components/ImportWizard'
import ProblemsPanel from './components/ProblemsPanel'
import SettingsPanel from './components/SettingsPanel'
import AccountEdit from './components/AccountEdit'
import Login from './components/Login'
import WebLogin from './components/WebLogin'
import { platform } from './platform'
import { rpc } from './rpcClient'
import Welcome from './components/Welcome'
import { getLocale, onLocaleChange, t as translate } from '../../shared/i18n'
import BootstrapAdmin from './components/BootstrapAdmin'
import UsersPanel from './components/UsersPanel'
import UserEdit from './components/UserEdit'
import GroupsPanel from './components/GroupsPanel'
import GroupEdit from './components/GroupEdit'
import AutomationPanel from './components/AutomationPanel'
import RuleEdit from './components/RuleEdit'
import WebhookEdit from './components/WebhookEdit'
import TriggerEdit from './components/TriggerEdit'
import MessageContextMenu from './components/MessageContextMenu'
import MoveMenu from './components/MoveMenu'
import AccountContextMenu from './components/AccountContextMenu'
import RawHeadersView from './components/RawHeadersView'
import HealthBoard from './components/HealthBoard'
import AttachmentsPanel from './components/AttachmentsPanel'
import OutboxPanel from './components/OutboxPanel'
import SubscriptionsPanel from './components/SubscriptionsPanel'
import FollowupsPanel from './components/FollowupsPanel'
import CommandPalette from './components/CommandPalette'
import ShortcutsHelp from './components/ShortcutsHelp'
import VaultBar from './components/VaultBar'
import InstallBanner from './components/InstallBanner'
import { updateUnreadBadge } from './webNotify'
import { parseDeepLink, parseSwMessage, type NotificationLink } from './webPushClient'
import AppLock, { useAppLocked } from './components/AppLock'
import ServerSetup from './components/ServerSetup'
import { toNotificationLink } from './nativeLinks'
import { drainPending } from './nativeShare'
import { nativeBridge, type NativeOpen } from './platform/nativeBridge'
import IconSprite from './components/IconSprite'
import { drawerEscape, DrawerBackdrop, useMobileNav, useNavDrawer } from './layout/MobileNav'

// arayüz ölçeği: masaüstünde bugünkü gibi zoom; web'de zoom dokunma/görünüm ölçülerini bozar (innerWidth,
// dvh, bağlam menüsü konumu) — yerine kök yazı boyutu (--ui-scale, styles.css)
const isElectron = platform.kind === 'electron'
const scaleStyle = (uiScale: number) => (isElectron ? { zoom: uiScale } : undefined)

/** Sunucu bu sürede geri gelmezse yeniden başlatma bildirimi yenileme önerisine döner */
const RESTART_STALE_MS = 2 * 60_000

/** Bildirimin iletisi ya da hesabı açılır; yanıtta oluşturucu da (açık taslağın üzerine yazılmaz) */
async function openNotificationLink({ messageId, accountId, reply }: NotificationLink): Promise<void> {
  if (messageId == null) {
    if (accountId != null) useStore.getState().setAccountFilter([accountId])
    return
  }
  await useStore.getState().openMessage(messageId, accountId)
  const s = useStore.getState()
  if (reply && s.selectedMessageId === messageId && !s.composer) s.openComposer('reply')
}

export default function App({ needsWelcome = false }: { needsWelcome?: boolean }) {
  // ilk açılış: dil seçimi; dil değişince tüm ağaç yeni dille yeniden kurulur
  const [welcome, setWelcome] = useState(needsWelcome)
  const [locale, setLocaleState] = useState(getLocale())
  useEffect(() => onLocaleChange(setLocaleState), [])
  const init = useStore((s) => s.init)
  const currentUser = useStore((s) => s.currentUser)
  const needsBootstrap = useStore((s) => s.needsBootstrap)
  const signingOut = useStore((s) => s.signingOut)
  const composer = useStore((s) => s.composer)
  const importOpen = useStore((s) => s.importOpen)
  const problemsOpen = useStore((s) => s.problemsOpen)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const editAccountId = useStore((s) => s.editAccountId)
  const usersOpen = useStore((s) => s.usersOpen)
  const editUserId = useStore((s) => s.editUserId)
  const groupsOpen = useStore((s) => s.groupsOpen)
  const editGroupId = useStore((s) => s.editGroupId)
  const automationOpen = useStore((s) => s.automationOpen)
  const editRuleId = useStore((s) => s.editRuleId)
  const editWebhookId = useStore((s) => s.editWebhookId)
  const editTriggerId = useStore((s) => s.editTriggerId)
  const viewSourceMessageId = useStore((s) => s.viewSourceMessageId)
  const healthBoardOpen = useStore((s) => s.healthBoardOpen)
  const attachmentsOpen = useStore((s) => s.attachmentsOpen)
  const outboxOpen = useStore((s) => s.outboxOpen)
  const subscriptionsOpen = useStore((s) => s.subscriptionsOpen)
  const followupsOpen = useStore((s) => s.followupsOpen)
  const idleLockMin = useStore((s) => s.idleLockMin)
  const compact = useStore((s) => s.compact)
  const uiScale = useStore((s) => s.uiScale)
  const commandPaletteOpen = useStore((s) => s.commandPaletteOpen)
  const toasts = useStore((s) => s.toasts)
  const serverRestarting = useStore((s) => s.serverRestarting)
  // yeniden başlatma 2 dk'da bitmediyse (Docker yeniden açmadı, açılış başarısız): yenileme önerilir
  const [staleTimer, setStaleTimer] = useState(false)
  useEffect(() => {
    if (!serverRestarting) return
    const id = setTimeout(() => setStaleTimer(true), RESTART_STALE_MS)
    return () => {
      clearTimeout(id)
      setStaleTimer(false)
    }
  }, [serverRestarting])
  const restartStale = serverRestarting && staleTimer
  const dismissToast = useStore((s) => s.dismissToast)
  const appView = useStore((s) => s.appView)
  const hasMsg = useStore((s) => s.appView === 'mail' && s.selectedMessageId != null)
  const drawerOpen = useNavDrawer((s) => s.open)
  useMobileNav(!!currentUser && !welcome)
  useEffect(() => {
    if (!isElectron) document.documentElement.style.setProperty('--ui-scale', String(uiScale))
  }, [uiScale])

  useEffect(() => {
    init()
  }, [init])

  // sayfadayken posta tarafında seçim yapıldı (kenar çubuğu, bildirim, derin bağlantı): posta görünümü açılır
  useEffect(
    () =>
      useStore.subscribe((s, p) => {
        if (s.appView === 'mail') return
        const opened = s.selectedMessageId != null && s.selectedMessageId !== p.selectedMessageId
        if (opened || s.selectedAccountIds !== p.selectedAccountIds || s.selectedFolderId !== p.selectedFolderId || s.folderKind !== p.folderKind || s.smartView !== p.smartView) s.setAppView('mail')
      }),
    []
  )

  // web'de sekme başlığı ve uygulama rozeti (masaüstünde Dock rozeti main'den). Görünen hesapların toplamı:
  // çıkışta hesaplar boşalır, ortak makinede sayı kalmaz
  const unreadTotal = useStore((s) => s.accounts.reduce((n, a) => n + a.unread, 0))
  useEffect(() => {
    if (!isElectron) updateUnreadBadge(unreadTotal)
  }, [unreadTotal])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState()
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        // girdi alanlarından bile çalışır (Slack/Linear deseni) — Cmd+K harf olarak nadiren gerekir
        e.preventDefault()
        if (s.currentUser) s.setCommandPaletteOpen(!s.commandPaletteOpen)
        return
      }
      if (e.key === 'Escape' && drawerEscape()) return // girdi alanında da (çekmecenin arama kutusu)
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) return
      if (!s.currentUser) return // Login/Bootstrap ekranında genel kısayollar geçersiz
      if (s.composer) return // compose açıkken liste kısayolları devre dışı (composer kendi tuşlarını yönetir)
      if (s.appView !== 'mail' && e.key !== 'Escape') return // liste görünmüyor: arka plandaki postaya dokunulmaz

      if (e.key === 'Escape') {
        if (s.shortcutsOpen) s.setShortcutsOpen(false)
        else if (s.commandPaletteOpen) s.setCommandPaletteOpen(false)
        else if (s.contextMenu) s.closeContextMenu()
        else if (s.accountMenu) s.closeAccountMenu()
        else if (s.checkedIds.length) s.clearChecked()
        return
      }
      // açık bir modal/overlay varken liste kısayolları çalışmamalı — arka plandaki maili
      // yanlışlıkla arşivleme/silme (ör. ? yardımı açıkken 'e' okunan tuş, arka planı arşivler)
      if (
        s.shortcutsOpen || s.attachmentsOpen || s.outboxOpen || s.subscriptionsOpen || s.followupsOpen || s.healthBoardOpen || s.settingsOpen || s.importOpen ||
        s.automationOpen || s.usersOpen || s.groupsOpen || s.problemsOpen || s.commandPaletteOpen ||
        s.editAccountId != null || s.viewSourceMessageId != null
      )
        return

      if (e.metaKey || e.ctrlKey || e.altKey) return // kalan kısayollar tek-tuş (Shift serbest)

      if (e.key === '?') {
        e.preventDefault()
        s.setShortcutsOpen(!s.shortcutsOpen)
        return
      }

      // liste gezinme: j/k (ya da ok tuşları) → aç-git
      const msgs = s.messages
      const idx = s.selectedMessageId != null ? msgs.findIndex((m) => m.id === s.selectedMessageId) : -1
      const openAt = (i: number): void => {
        if (i >= 0 && i < msgs.length) void s.select(msgs[i].id)
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        openAt(idx < 0 ? 0 : Math.min(idx + 1, msgs.length - 1))
        return
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        openAt(idx < 0 ? 0 : Math.max(idx - 1, 0))
        return
      }

      // triyaj aksiyonları: seçim varsa onu, yoksa açık mesajı hedefler
      const sel = s.selectedMessageId
      const targets = s.checkedIds.length ? s.checkedIds : sel != null ? [sel] : []
      if (!targets.length && e.key !== 'n') return
      // arşiv/sil sonrası tekil akışta bir sonrakine geç (triyaj hızı)
      const advance = (): void => {
        if (s.checkedIds.length) return
        const n = msgs[idx + 1]?.id ?? msgs[idx - 1]?.id ?? null
        if (n != null) void s.select(n)
      }

      if (e.key === 'Delete' || e.key === 'Backspace' || e.key === '#') {
        e.preventDefault()
        s.deleteMessages(targets)
        advance()
      } else if (e.key === 'e') {
        e.preventDefault()
        s.moveSpecial(targets, 'archive')
        advance()
      } else if (e.key === 's' && sel != null) {
        e.preventDefault()
        const m = msgs.find((x) => x.id === sel)
        s.setFlagged(targets, !m?.flagged)
      } else if (e.key === 'u') {
        e.preventDefault()
        s.markSeen(targets, false)
      } else if (e.key === 'I') {
        e.preventDefault()
        s.markSeen(targets, true)
      } else if (e.key === 'r' && sel != null) {
        e.preventDefault()
        s.openComposer('reply')
      } else if (e.key === 'a' && sel != null) {
        e.preventDefault()
        s.openComposer('replyAll')
      } else if (e.key === 'f' && sel != null) {
        e.preventDefault()
        s.openComposer('forward')
      } else if (e.key === 'n') {
        e.preventDefault()
        s.openComposer('new')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // bildirimden gelen adres (/?m=, /?reply=): giriş ekranından sonra da geçerli, hesaplar gelince açılır
  const signedInWithAccounts = useStore((s) => !!s.currentUser && s.accounts.length > 0)
  useEffect(() => {
    if (isElectron || !signedInWithAccounts) return
    const link = parseDeepLink(window.location.search)
    if (!link) return
    window.history.replaceState(null, '', '/')
    void openNotificationLink(link)
  }, [signedInWithAccounts])

  // masaüstü: bildirimden açılan ileti ana süreçte bekler, kullanıcı ve hesaplar gelince gönderilir. Başlangıçtaki "hazır değil"
  // bildirilmez: giriş ekranını bekleyen tıklamayı silerdi, yalnız çıkış siler
  const linkReady = useRef(false)
  useEffect(() => {
    if (signedInWithAccounts === linkReady.current) return
    linkReady.current = signedInWithAccounts
    platform.rendererReady(signedInWithAccounts)
  }, [signedInWithAccounts])
  useEffect(() => rpc.on('local:open-reply', ({ messageId, accountId }) => void openNotificationLink({ messageId, accountId, reply: true })), [])

  // açık pencereye service worker'dan: bildirim tıklandı
  useEffect(() => {
    if (isElectron || platform.native || !('serviceWorker' in navigator)) return
    const onMessage = (e: MessageEvent): void => {
      const link = parseSwMessage(e.data)
      if (!link) return
      if (useStore.getState().currentUser) void openNotificationLink(link)
      else if (link.messageId != null) window.history.replaceState(null, '', `/?${link.reply ? 'reply' : 'm'}=${link.messageId}`)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [])

  // mobil bildirim dokunuşu ve paylaşım: soğuk açılışta bekleyenler de oturum açıldıktan, hesaplar geldikten ve kilit kalktıktan sonra işlenir
  const appLocked = useAppLocked()
  const canTakeNative = signedInWithAccounts && !appLocked
  useEffect(() => {
    const host = nativeBridge()
    if (!host || !canTakeNative) return
    const open = (link: NotificationLink): void => void openNotificationLink(link)
    const drain = (): void => void drainPending(host.plugin, open).catch(() => {})
    drain()
    const subs = [
      host.plugin.addListener('open', (d) => {
        const link = toNotificationLink(d as NativeOpen)
        if (link) open(link)
      }).catch(() => null),
      host.plugin.addListener('share', drain).catch(() => null)
    ]
    return () => subs.forEach((sub) => void sub.then((s) => s?.remove()))
  }, [canTakeNative])

  // boşta oturum zaman aşımı: gerçek ops verisi taşıyan bir araç için makul bir sertleştirme —
  // v1'de bilinçli atlanmıştı ("manuel çıkış yeterli"), artık otomatikleştiriliyor.
  useEffect(() => {
    if (!currentUser || !(idleLockMin > 0)) return // 0/NaN = kapalı (NaN <= 0 false olur, güvenli değil)
    const ms = idleLockMin * 60_000
    let timer: ReturnType<typeof setTimeout>
    const reset = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const st = useStore.getState()
        // kasa varsa önce onu kilitle (kritik veri korunur), sonra oturumu kapat
        if (st.vaultState === 'unlocked') void st.lockVault()
        st.toast(translate('common.idleLoggedOut'), 'info')
        void st.logout()
      }, ms)
    }
    const events = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const
    events.forEach((ev) => window.addEventListener(ev, reset, { passive: true }))
    reset()
    return () => {
      clearTimeout(timer)
      events.forEach((ev) => window.removeEventListener(ev, reset))
    }
  }, [currentUser, idleLockMin])

  // olaylar + saatlik hacim periyodik tazelemesi: Sağlık Panosu/Duvar Modu açık olmasa bile
  // taze kalsın — ikisi de aynı store alanlarını okuyor.
  useEffect(() => {
    if (!currentUser) return
    const tick = (): void => {
      if (useStore.getState().offlineMode) return // sunucu verisi: bağlantı gelince sıradaki tur alır
      void useStore.getState().refreshIncidents()
      void useStore.getState().refreshHourlyVolume()
      void useStore.getState().refreshConnectionStats() // host şeridi + Ayarlar › Bağlantı
    }
    tick()
    const t = setInterval(tick, 90_000)
    return () => clearInterval(t)
  }, [currentUser])

  if (welcome)
    return (
      <div className="app" style={scaleStyle(uiScale)}>
        <IconSprite />
        <Welcome onDone={() => setWelcome(false)} />
      </div>
    )

  if (platform.native && !platform.serverOrigin)
    return (
      <div className="app" style={scaleStyle(uiScale)}>
        <IconSprite />
        <ServerSetup />
      </div>
    )

  return (
    <div
      key={locale}
      // has-msg / drawer-open yalnız orta/dar ekran CSS'inde etkili (geniş görünüm değişmez)
      className={`app${compact ? ' compact' : ''}${hasMsg ? ' has-msg' : ''}${drawerOpen ? ' drawer-open' : ''}`}
      style={scaleStyle(uiScale)}
    >
      <IconSprite />
      {platform.native && <AppLock />}
      {signingOut ? null : !currentUser ? (
        needsBootstrap ? (
          <BootstrapAdmin />
        ) : platform.kind === 'web' ? (
          <WebLogin />
        ) : (
          <Login />
        )
      ) : (
        <>
          {isElectron && <div className="dragbar" />}
          <VaultBar />
          {!isElectron && <InstallBanner />}
          <AccountsPanel />
          <DrawerBackdrop />
          {appView === 'contacts' ? (
            <ContactsPage />
          ) : appView === 'calendar' ? (
            <CalendarPage />
          ) : (
            <>
              <ListPane />
              <MessageView />
            </>
          )}
          {composer && <Composer />}
          {importOpen && <ImportWizard />}
          {problemsOpen && <ProblemsPanel />}
          {settingsOpen && <SettingsPanel />}
          {usersOpen && <UsersPanel />}
          {editUserId != null && <UserEdit key={editUserId} />}
          {groupsOpen && <GroupsPanel />}
          {editGroupId != null && <GroupEdit key={editGroupId} />}
          {automationOpen && <AutomationPanel />}
          {editRuleId != null && <RuleEdit key={editRuleId} />}
          {editWebhookId != null && <WebhookEdit key={editWebhookId} />}
          {editTriggerId != null && <TriggerEdit key={editTriggerId} />}
          <MessageContextMenu />
          <MoveMenu />
          <AccountContextMenu />
          {viewSourceMessageId != null && <RawHeadersView />}
          {healthBoardOpen && <HealthBoard />}
          {attachmentsOpen && <AttachmentsPanel />}
          {outboxOpen && <OutboxPanel />}
          {subscriptionsOpen && <SubscriptionsPanel />}
          {followupsOpen && <FollowupsPanel />}
          {commandPaletteOpen && <CommandPalette />}
          {/* en üstte: Ayarlar, Sorunlar, Sağlık Panosu ve bildirimlerden açılır */}
          {editAccountId != null && <AccountEdit key={editAccountId} />}
          <ShortcutsHelp />
        </>
      )}
      {/* web: sunucu yeniden başlıyor (geri yükleme); yeniden bağlanınca ya da giriş ekranına düşünce kalkar */}
      {serverRestarting && (
        <div className="restart-banner" role="status" aria-live="polite">
          {restartStale ? translate('set.backup.web.notBack') : translate('set.backup.web.restarting')}
          {restartStale && (
            <button type="button" onClick={() => window.location.reload()}>{translate('set.backup.web.reload')}</button>
          )}
        </div>
      )}
      {/* ekran okuyucu: bilgi bildirimleri kibarca, hatalar hemen okunur */}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.kind}`}
            role={t.kind === 'error' ? 'alert' : undefined}
            onClick={() => !t.action && dismissToast(t.id)}
            title={t.action ? undefined : translate('common.clickToDismiss')}
          >
            {t.text}
            {t.action && (
              <button
                className="toast-action"
                onClick={(e) => {
                  e.stopPropagation()
                  t.action!.fn()
                  dismissToast(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
