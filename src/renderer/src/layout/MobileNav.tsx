// Orta/dar ekran gezinmesi: hesaplar çekmecesi (☰), dar ekranda tek bölme yığını (liste → ileti →
// oluşturucu) ve geri tuşu. Geniş ekranda (≥1200, masaüstü bugünkü görünüm) hiçbir şey yapmaz.
import { useEffect, useLayoutEffect, useRef } from 'react'
import { create } from 'zustand'
import { useStore } from '../store'
import { platform } from '../platform'
import { t } from '../../../shared/i18n'
import { anyModalOpen, FOCUSABLE } from '../components/Modal'
import { navBreakpoint, useBreakpoint, type Breakpoint } from './useBreakpoint'
import { pimDetailOf, pimNavView } from './appView'
import { closeDrawerEntry, currentView, ensureNarrowBase, goBack, onBack, pushView, type View } from './navigation'

export const useNavDrawer = create<{ open: boolean }>(() => ({ open: false }))

/** Çekmecenin kimliği: ☰ aria-controls ve .sidebar */
export const DRAWER_ID = 'nav-drawer'

let bp: Breakpoint = 'wide'
// goBack() eşzamansız: popstate gelene kadar ikinci bir geri istenmesin (iki kayıt birden atlanırdı)
let backPending = false
let pendingTimer: ReturnType<typeof setTimeout> | undefined

function back(): void {
  backPending = true
  clearTimeout(pendingTimer)
  // popstate hiç gelmezse (geçmiş başı) kilit kalmasın
  pendingTimer = setTimeout(() => {
    backPending = false
    syncHistory() // beklerken ertelenen eşitleme (yeni açılan ileti/oluşturucunun kaydı) kaybolmasın
  }, 1000)
  goBack()
}

export function openDrawer(): void {
  useNavDrawer.setState({ open: true })
  if (bp !== 'wide') pushView('accounts')
}

export function closeDrawer(): void {
  if (!useNavDrawer.getState().open) return
  useNavDrawer.setState({ open: false })
  if (bp !== 'wide' && currentView() === 'accounts') {
    closeDrawerEntry(back) // itilmiş kayıtta geri (popstate gelene dek eşitleme bekler); kökte listeye ileri itilir
  }
}

/** Esc çekmeceyi kapatır; üstünde açık menü/pencere varsa dokunmaz (tek Esc tek şey kapatır). App'in genel
 *  Esc zincirinin başında çağrılır: pencere ve açılır menüler Esc'i buraya gelmeden yakalar */
export function drawerEscape(): boolean {
  const s = useStore.getState()
  if (!useNavDrawer.getState().open || anyModalOpen()) return false
  if (s.contextMenu || s.accountMenu || s.shortcutsOpen || s.commandPaletteOpen || s.composer) return false
  closeDrawer()
  return true
}

/** Okuma bölmesinden listeye: ileti kapanır; dar ekranda geçmiş kaydını syncHistory geri alır */
export function navBack(): void {
  void useStore.getState().select(null)
}

/** Uygulama durumu → geçmiş: açılan ileti/oluşturucu kayıt iter; başka yoldan kapananın kaydı geri alınır */
function syncHistory(): void {
  if (bp !== 'narrow' || backPending) return
  const s = useStore.getState()
  const cur = currentView()
  if (s.composer) {
    if (cur !== 'compose') pushView('compose')
  } else if (cur === 'compose') {
    back()
  } else if (s.appView !== 'mail') {
    const want = pimNavView(s.appView, pimDetailOf(s))
    if (cur === 'pimDetail' && want === 'pim') back()
    else if (want && cur !== want) pushView(want)
  } else if (cur === 'pim' || cur === 'pimDetail') {
    back()
  } else if (s.selectedMessageId != null) {
    if (cur !== 'message') pushView('message')
  } else if (cur === 'message') {
    back()
  }
}

/** Geçmiş → uygulama durumu (geri/ileri tuşu) */
function applyView(v: View): void {
  // kendi geri adımımız (durum zaten kapandı): yalnız kayıt düştü, yeni açılan oluşturucuya dokunulmaz
  const own = backPending
  backPending = false
  clearTimeout(pendingTimer)
  if (bp === 'wide') return
  useNavDrawer.setState({ open: v === 'accounts' })
  const s = useStore.getState()
  if (!own) {
    if (v !== 'compose' && s.composer) s.closeComposer() // içerik varsa taslak kaydedilir; kasa taslağı sorulur
    if (bp === 'narrow' && (v === 'list' || v === 'accounts') && s.selectedMessageId != null) void s.select(null)
    if (bp === 'narrow' && s.appView !== 'mail') {
      if (v === 'pim' || v === 'accounts') s.clearPimDetail()
      else if (v !== 'pimDetail' && v !== 'compose') s.setAppView('mail')
    }
  }
  syncHistory() // ör. kasa taslağı sorusunda vazgeçildiyse oluşturucu açık kalır → kaydı yeniden itilir
}

/** active: oturum açık (giriş ekranında geçmişe kayıt itilmez) */
export function useMobileNav(active: boolean): Breakpoint {
  const breakpoint = navBreakpoint(useBreakpoint(), platform.kind, active)
  // modül düzeyi kırılım (olay işleyicileri okur): diğer etkilerden önce güncellenir
  useLayoutEffect(() => {
    bp = breakpoint
  }, [breakpoint])
  const drawerOpen = useNavDrawer((s) => s.open)
  const hasMsg = useStore((s) => s.selectedMessageId != null)
  const composerOpen = useStore((s) => s.composer != null)
  const appView = useStore((s) => s.appView)
  const pimDetail = useStore(pimDetailOf)

  useEffect(() => onBack(applyView), [])

  useEffect(() => {
    if (breakpoint === 'wide') {
      useNavDrawer.setState({ open: false })
      return
    }
    if (breakpoint === 'narrow') ensureNarrowBase()
    // yeniden yükleme / kırılım değişimi: çekmece geçmişteki konumla aynı olsun
    useNavDrawer.setState({ open: currentView() === 'accounts' })
  }, [breakpoint])

  useEffect(() => {
    syncHistory()
  }, [breakpoint, hasMsg, composerOpen, appView, pimDetail])

  // açılınca odak çekmeceye (ilk alana değil: telefonda klavye açılmasın), kapanınca ☰ düğmesine döner.
  // Oluşturucu/pencere açılarak kapandıysa odak onda kalır
  const wasOpen = useRef(false)
  useEffect(() => {
    if (drawerOpen) document.getElementById(DRAWER_ID)?.focus()
    else if (wasOpen.current && !anyModalOpen()) document.querySelector<HTMLElement>('.nav-menu-btn')?.focus()
    wasOpen.current = drawerOpen
  }, [drawerOpen])

  // odak tuzağı: Tab çekmecenin içinde döner (WebKit düğmeleri atladığı için sıra elle yürütülür)
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || anyModalOpen()) return
      const s = useStore.getState()
      if (s.contextMenu || s.accountMenu) return
      const el = document.getElementById(DRAWER_ID)
      if (!el) return
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null)
      if (!items.length) return
      e.preventDefault()
      const i = items.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length
      items[next].focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  // hesap/klasör/görünüm değişince çekmece kapanır (dar/orta ekranda seçim yapıldı)
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (
          s.selectedAccountIds !== prev.selectedAccountIds ||
          s.selectedFolderId !== prev.selectedFolderId ||
          s.folderKind !== prev.folderKind ||
          s.smartView !== prev.smartView ||
          s.appView !== prev.appView
        )
          closeDrawer()
      }),
    []
  )
  return breakpoint
}

/** ☰: yalnız orta/dar ekranda görünür (CSS) */
export function MenuButton() {
  const open = useNavDrawer((s) => s.open)
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon btn-sm nav-menu-btn"
      aria-label={t('mail.nav.menu')}
      title={t('mail.nav.menu')}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={DRAWER_ID}
      onClick={() => openDrawer()}
    >
      <svg className="icon"><use href="#i-menu" /></svg>
    </button>
  )
}

/** Dar ekranda okuma bölmesinden listeye dönüş (tarayıcı geri tuşuyla aynı) */
export function BackButton() {
  return (
    <button type="button" className="btn btn-ghost btn-icon btn-sm nav-back-btn" aria-label={t('mail.nav.back')} title={t('mail.nav.back')} onClick={navBack}>
      <svg className="icon nav-back-ic"><use href="#i-chevron" /></svg>
    </button>
  )
}

/** Çekmece açıkken içeriği örten katman: dokununca çekmece kapanır */
export function DrawerBackdrop() {
  const open = useNavDrawer((s) => s.open)
  if (!open) return null
  return <div className="drawer-backdrop" onClick={() => closeDrawer()} aria-hidden="true" />
}
