// Mağaza — Pencereler, menüler, görünüm tercihleri, bildirimler (toast).

import { rpc } from '../rpcClient'
import { applyTheme } from '../themes'
import type { GetState, SetState, State } from './types'
import { platform } from '../platform'

let toastSeq = 0

export const uiSlice = (set: SetState, get: GetState) =>
  ({
    openContextMenu(x, y, messageId, source) {
      set({ contextMenu: { x, y, messageId, source } })
    },

    closeContextMenu() {
      set({ contextMenu: null })
    },

    openMoveDialog(rows) {
      set({ moveDialog: { rows } })
    },

    closeMoveDialog() {
      set({ moveDialog: null })
    },

    startMoveDrag(rowId, rows) {
      const { accountId } = rows[0]
      const sel = get().selectedAccountIds
      const shown = sel?.length === 1 && sel[0] === accountId
      set({ moveDrag: { rowId, rows, accountId, folders: shown ? get().folders : null } })
      if (shown) return
      // birleşik görünümde ağaç kapalı: sürüklenenlerin hesabının klasörleri geçici gelir
      void rpc
        .call('getFoldersOf', { accountId })
        .then((folders) => {
          const cur = get().moveDrag
          if (cur?.rowId === rowId) set({ moveDrag: { ...cur, folders } })
        })
        .catch(() => {})
    },

    endMoveDrag() {
      if (get().moveDrag) set({ moveDrag: null })
    },

    openAccountMenu(x, y, accountId) {
      set({ accountMenu: { x, y, accountId } })
    },

    closeAccountMenu() {
      set({ accountMenu: null })
    },

    setAccountViewFilter(v) {
      set({ accountViewFilter: v })
    },

    setAccountSort(v) {
      localStorage.setItem('gecko-acct-sort', v)
      set({ accountSort: v })
    },

    setViewSource(id) {
      set({ viewSourceMessageId: id })
    },

    setHealthBoardOpen(v) {
      set({ healthBoardOpen: v })
    },

    setOutboxOpen(v) {
      set({ outboxOpen: v })
    },

    setSubscriptionsOpen(v) {
      set({ subscriptionsOpen: v })
    },

    setFollowupsOpen(v) {
      set({ followupsOpen: v })
    },

    async refreshFollowupDue() {
      try {
        const list = await rpc.call('listFollowups', {})
        set({ followupDue: list.filter((f) => f.state === 'due').length })
      } catch {
        /* oturum yoksa sıradaki olayda */
      }
    },

    setAttachmentsOpen(v) {
      set({ attachmentsOpen: v })
    },

    setCommandPaletteOpen(v) {
      set({ commandPaletteOpen: v })
    },

    setShortcutsOpen(v) {
      set({ shortcutsOpen: v })
    },

    async refreshIncidents() {
      try {
        set({ incidents: await rpc.call('getIncidents', {}) })
        get().pushWallboardSnapshot()
      } catch (e) {
        get().toast(String((e as Error).message))
      }
    },

    async refreshHourlyVolume() {
      try {
        set({ hourlyVolume: await rpc.call('getHourlyVolume', {}) })
        get().pushWallboardSnapshot()
      } catch {
        /* sıradaki periyodik denemede tekrar dener */
      }
    },

    pushWallboardSnapshot() {
      const { accounts, incidents, hourlyVolume } = get()
      platform.wallboard?.push({ accounts, incidents, hourlyVolume, updatedAt: Date.now() })
    },

    openWallboard() {
      void platform.wallboard?.open()
    },

    setImportOpen(v) {
      set({ importOpen: v })
    },

    setProblemsOpen(v) {
      set({ problemsOpen: v })
    },

    async refreshConnectionStats() {
      try {
        set({ connectionStats: await rpc.call('getConnectionStats', {}) })
      } catch {
        /* oturum yok / sync yeniden başlıyor: sonraki turda */
      }
    },

    setSettingsOpen(v, section) {
      set({ settingsOpen: v, settingsSection: v ? (section ?? null) : null })
    },

    setEditAccount(id) {
      set({ editAccountId: id })
    },

    setTheme(t) {
      set({ theme: t })
      localStorage.setItem('gecko-theme', t)
      if (t === 'auto') delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = t
    },

    setThemePack(id) {
      set({ themePack: id, customAccent: null })
      localStorage.setItem('gecko-theme-pack', id)
      localStorage.removeItem('gecko-accent')
      applyTheme(id, null)
    },

    setCustomAccent(light, dark) {
      const custom = { light, dark }
      set({ themePack: 'custom', customAccent: custom })
      localStorage.setItem('gecko-theme-pack', 'custom')
      localStorage.setItem('gecko-accent', JSON.stringify(custom))
      applyTheme('custom', custom)
    },

    setIdleLockMin(min) {
      set({ idleLockMin: min })
      localStorage.setItem('gecko-idle-min', String(min))
    },

    setCompact(v) {
      localStorage.setItem('gecko-compact', v ? '1' : '0')
      set({ compact: v })
    },

    setUiScale(n) {
      localStorage.setItem('gecko-ui-scale', String(n))
      set({ uiScale: n })
    },

    toast(text, kind = 'error', action) {
      const id = ++toastSeq
      set({ toasts: [...get().toasts, { id, text, kind, action }] })
      // hata okunmadan kaybolmasın: hatalar 10 sn, eylemli bildirimler (Geri al vb.) 8 sn, bilgi 5 sn
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 10_000 : action ? 8000 : 5000)
    },

    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) })
    }
  }) satisfies Partial<State>
