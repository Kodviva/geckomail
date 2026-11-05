// Mağaza — Hesap filtresi, klasörler, liste, arama, seçim, gövde ve mail eylemleri.

import { rpc } from '../rpcClient'
import { mergeFirstPage } from '../listMerge'
import type { GetState, ListRow, SetState, State } from './types'
import { runtime } from './runtime'
import { fmtDateTime, t } from '../../../shared/i18n'
import { readOfflineBody, readOfflineList } from '../offline/sync'
import { offlineAccountsChanged } from './offline'
import { writeSavedSearches } from './savedSearches'
import { isThreadRow, threadMemberIds } from '../moveDrag'

let listNonce = 0
let lastFullListRefresh = 0
const PAGE = 100

/** Sürmekte olan liste istekleri sonuçlarını yazmaz (web çıkışı) */
export function invalidateListReads(): void {
  listNonce++
}

export const mailSlice = (set: SetState, get: GetState) =>
  ({
    async refreshAccounts() {
      if (get().offlineMode) return // kopyadaki hesap listesi gösteriliyor
      try {
        const accounts = await rpc.call('getAccounts', {})
        set({ accounts })
        offlineAccountsChanged(get)
        get().pushWallboardSnapshot()
        if (!runtime.followupPrimed) {
          runtime.followupPrimed = true
          void get().refreshFollowupDue()
        }
      } catch {
        /* bağlantı yoksa sıradaki olayda tekrar denenir */
      }
    },

    async refreshContacts() {
      try {
        set({ contacts: await rpc.call('getContacts', {}) })
      } catch {
        /* önemsiz — otomatik-tamamlama boş kalır */
      }
    },

    setAccountFilter(ids) {
      set({ selectedAccountIds: ids, selectedMessageId: null, body: null, selectedFolderId: null, folders: [], checkedIds: [] })
      if (get().offlineMode) return void get().refreshList(true)
      void rpc.call('setViewed', { accountIds: ids }).catch(() => {})
      if (ids?.length === 1) {
        void rpc
          .call('getFoldersOf', { accountId: ids[0] })
          .then((folders) => set({ folders }))
          .catch(() => {})
      }
      void get().refreshList(true)
    },

    toggleAccountInFilter(id) {
      const cur = get().selectedAccountIds
      const s = new Set(cur ?? [])
      if (s.has(id)) s.delete(id)
      else s.add(id)
      get().setAccountFilter(s.size ? [...s] : null)
    },

    setFolder(kind) {
      set({ folderKind: kind, smartView: null, selectedMessageId: null, body: null, selectedFolderId: null, checkedIds: [] })
      void get().refreshList(true)
    },

    selectFolder(id) {
      set({ selectedFolderId: id, smartView: id != null ? null : get().smartView, selectedMessageId: null, body: null, checkedIds: [] })
      if (id != null && !get().offlineMode) void rpc.call('syncFolder', { folderId: id }).catch(() => {})
      void get().refreshList(true)
    },

    moveMessages(ids, targetFolderId) {
      const { selectedMessageId, checkedIds } = get()
      // sürüklenen satır açık olan ya da seçili olanlardan ayrı olabilir: taşınmayanlara dokunulmaz
      const left = selectedMessageId != null && ids.includes(selectedMessageId)
      set({
        messages: get().messages.filter((m) => !ids.includes(m.id)),
        checkedIds: checkedIds.filter((c) => !ids.includes(c)),
        ...(left ? { selectedMessageId: null, body: null } : {})
      })
      void rpc
        .call('moveMessages', { messageIds: ids, targetFolderId })
        .then((r) => {
          const { undoToken } = r
          const undo = undoToken == null ? undefined : {
            label: t('mail.toast.undo'),
            fn: () => {
              void rpc
                .call('undoMove', { undoToken })
                .then(() => {
                  void get().refreshList(false)
                  get().toast(t('mail.toast.moveUndone'), 'info')
                })
                .catch((e) => {
                  void get().refreshList(false) // kısmi geri alma: dönenler görünsün
                  get().toast(String((e as Error).message))
                })
            }
          }
          if (r.skipped > 0) {
            // başka hesabın mesajları taşınamaz: iyimser olarak kaldırılanlar listeye geri gelsin
            void get().refreshList(false)
            get().toast(t('mail.toast.movedPartial', { moved: r.moved, skipped: r.skipped }), 'info', undo)
          } else {
            get().toast(t('mail.toast.moved', { count: r.moved }), 'info', undo)
          }
        })
        .catch((e) => {
          void get().refreshList(false) // reddedildi (yetki, bağlantı): iyimser kaldırılanlar geri gelsin
          get().toast(String((e as Error).message))
        })
    },

    async moveRows(rows, targetFolderId) {
      try {
        const { folderKind, folders } = get()
        const lists = await Promise.all(
          rows.map(async (r) => {
            if (!isThreadRow(r)) return [r.id]
            // özel klasör görünümünde sekme türü satırın türü değildir
            const kind = folders.find((f) => f.id === r.folderId)?.kind ?? folderKind
            return threadMemberIds(r, await rpc.call('getThreadMembers', { threadRoot: r.threadRoot, folderKind: kind }))
          })
        )
        get().moveMessages([...new Set(lists.flat())], targetFolderId)
      } catch (e) {
        get().toast(String((e as Error).message))
      }
    },

    moveSpecial(ids, special) {
      set({ messages: get().messages.filter((m) => !ids.includes(m.id)), checkedIds: [], selectedMessageId: null, body: null })
      void rpc
        .call('moveSpecial', { messageIds: ids, special })
        .then(() => get().toast(special === 'archive' ? t('mail.toast.archived') : t('mail.toast.movedToSpam'), 'info'))
        .catch((e) => get().toast(String((e as Error).message)))
    },

    snooze(ids, until) {
      set({ messages: get().messages.filter((m) => !ids.includes(m.id)), checkedIds: [], selectedMessageId: null, body: null })
      if (until === 0) {
        // ertelemeyi kaldır (Ertelenen görünümünden): mail hemen gelen kutusuna döner
        void rpc
          .call('snoozeMessages', { messageIds: ids, until: 0 })
          .then(() => get().toast(t('mail.toast.unsnoozed', { count: ids.length }), 'info'))
          .catch((e) => get().toast(String((e as Error).message)))
        return
      }
      const when = fmtDateTime(until, { dateStyle: 'short', timeStyle: 'short' })
      void rpc
        .call('snoozeMessages', { messageIds: ids, until })
        .then(() =>
          get().toast(t('mail.toast.snoozed', { count: ids.length, when }), 'info', {
            label: t('mail.toast.undo'),
            fn: () => void rpc.call('snoozeMessages', { messageIds: ids, until: 0 }).then(() => get().refreshList(false))
          })
        )
        .catch((e) => get().toast(String((e as Error).message)))
    },

    setUnreadOnly(v) {
      set({ unreadOnly: v })
      void get().refreshList(true)
    },

    setThreadView(v) {
      set({ threadView: v })
      localStorage.setItem('gecko-threads', v ? '1' : '0')
      void get().refreshList(true)
    },

    setSearch(q) {
      set({ searchQuery: q })
      void get().refreshList(true)
    },

    setSearchSort(v) {
      set({ searchSort: v })
      try {
        localStorage.setItem('gecko-search-sort', v)
      } catch {
        /* tercih yalnız bu oturumda kalır */
      }
      if (get().searchQuery.trim()) void get().refreshList(true)
    },

    saveCurrentSearch(name) {
      const query = get().searchQuery.trim()
      const nm = name.trim()
      if (!query || !nm) return
      // aynı isim varsa üzerine yaz (upsert)
      const next = [...get().savedSearches.filter((s) => s.name !== nm), { name: nm, query }]
      writeSavedSearches(next, get().currentUser?.id)
      set({ savedSearches: next })
    },

    deleteSavedSearch(name) {
      const next = get().savedSearches.filter((s) => s.name !== name)
      writeSavedSearches(next, get().currentUser?.id)
      set({ savedSearches: next })
    },

    applySavedSearch(query) {
      get().setSearch(query)
    },

    async refreshList(reset) {
      const nonce = ++listNonce
      const { selectedAccountIds, folderKind, selectedFolderId, unreadOnly, threadView, searchQuery, messages } = get()
      set({ listLoading: true })
      try {
        let rows: ListRow[]
        let hasMore = false
        const smartView = get().smartView
        if (get().offlineMode) {
          // akıllı görünümler sunucu sorgusu: yerel kopyada karşılığı yok
          rows = smartView
            ? []
            : await readOfflineList({ folderKind, folderId: selectedFolderId ?? undefined, accountIds: selectedAccountIds, unreadOnly, query: searchQuery })
        } else if (searchQuery.trim()) {
          rows = await rpc.call('search', { query: searchQuery.trim(), accountIds: selectedAccountIds, sort: get().searchSort })
        } else if (smartView) {
          // akıllı posta kutusu: tek sayfa (en fazla 500), sayfalama yok
          rows = await rpc.call('listSmart', { view: smartView, accountIds: selectedAccountIds, unreadOnly })
        } else {
          // R25: arka plan tazelemesinde (reset=false) yalnız ilk sayfa çekilir ve listenin başına birleşir;
          // kaydırılmış kuyruğun tamamı en fazla 30 sn'de bir tazelenir. Önceden her olayda yüklü tüm
          // satırlar (2000'e kadar, kasa hesabında satır başı AES) IPC'den geçiyordu.
          const tail = !reset && messages.length > PAGE
          const fullDue = !tail || Date.now() - lastFullListRefresh > 30_000
          const limit = reset || !fullDue ? PAGE : Math.max(messages.length, PAGE)
          const listParams = {
            accountIds: selectedAccountIds,
            folderKind,
            folderId: selectedFolderId ?? undefined,
            cursor: null,
            limit,
            unreadOnly
          }
          const fresh: ListRow[] = threadView ? await rpc.call('listThreads', listParams) : await rpc.call('listMessages', listParams)
          if (tail && !fullDue) {
            rows = mergeFirstPage(fresh, messages)
            hasMore = get().hasMore
          } else {
            rows = fresh
            hasMore = fresh.length >= limit
            lastFullListRefresh = Date.now()
          }
        }
        if (nonce !== listNonce) return // eski istek — at
        set({ messages: rows, hasMore, listLoading: false })
      } catch (e) {
        if (nonce === listNonce) set({ listLoading: false })
        if (get().connected) get().toast(String((e as Error).message), 'error')
      }
    },

    async loadMore() {
      const { messages, hasMore, listLoading, selectedAccountIds, folderKind, selectedFolderId, unreadOnly, threadView, searchQuery } = get()
      if (!hasMore || listLoading || searchQuery.trim() || !messages.length) return
      const nonce = ++listNonce
      set({ listLoading: true })
      try {
        const last = messages[messages.length - 1]
        const listParams = {
          accountIds: selectedAccountIds,
          folderKind,
          folderId: selectedFolderId ?? undefined,
          cursor: { date: last.date, id: last.id },
          limit: PAGE,
          unreadOnly
        }
        const rows: ListRow[] = threadView ? await rpc.call('listThreads', listParams) : await rpc.call('listMessages', listParams)
        if (nonce !== listNonce) return
        set({ messages: [...messages, ...rows], hasMore: rows.length >= PAGE, listLoading: false })
      } catch {
        if (nonce === listNonce) set({ listLoading: false })
      }
    },

    toggleChecked(id) {
      const s = new Set(get().checkedIds)
      if (s.has(id)) s.delete(id)
      else s.add(id)
      set({ checkedIds: [...s] })
    },

    rangeCheck(id) {
      const { messages, selectedMessageId, checkedIds } = get()
      const anchor = checkedIds.length ? checkedIds[checkedIds.length - 1] : selectedMessageId
      const a = messages.findIndex((m) => m.id === anchor)
      const b = messages.findIndex((m) => m.id === id)
      if (a === -1 || b === -1) return get().toggleChecked(id)
      const range = messages.slice(Math.min(a, b), Math.max(a, b) + 1).map((m) => m.id)
      set({ checkedIds: [...new Set([...checkedIds, ...range])] })
    },

    clearChecked() {
      set({ checkedIds: [] })
    },

    startSelect(id) {
      set({ selectMode: true, checkedIds: [...new Set([...get().checkedIds, id])] })
    },

    endSelect() {
      set({ selectMode: false })
    },

    async markAllSeen() {
      const { selectedAccountIds, folderKind, accounts } = get()
      // tek onay noktası (liste düğmesi, hesap menüsü, komut paleti): kapsamı açıkça söyle (UX-P1-13)
      const KNOWN = ['inbox', 'sent', 'archive', 'junk', 'trash']
      const folderLabel = KNOWN.includes(folderKind) ? t(`mail.folderLong.${folderKind}`) : folderKind
      const scopeAccounts = selectedAccountIds ? accounts.filter((a) => selectedAccountIds.includes(a.id)) : accounts
      const scope = !selectedAccountIds
        ? t('mail.scope.allInboxes')
        : scopeAccounts.length === 1
          ? scopeAccounts[0].email
          : t('mail.scope.accounts', { count: scopeAccounts.length })
      const unread = folderKind === 'inbox' ? scopeAccounts.reduce((n, a) => n + a.unread, 0) : null
      const what = `${scope} — ${folderLabel}${unread != null ? ` (${t('mail.markAll.unreadCount', { n: unread })})` : ''}`
      if (!window.confirm(t('mail.markAll.confirm', { what }))) return
      try {
        await rpc.call('markAllSeen', { accountIds: selectedAccountIds, folderKind })
        get().toast(t('mail.toast.allMarkedRead'), 'info')
      } catch (e) {
        get().toast(String((e as Error).message))
      }
    },

    async select(id) {
      set({ selectedMessageId: id, body: id ? { state: 'fetching' } : null, allowRemoteImages: false })
      if (id == null) return
      const msg = get().messages.find((m) => m.id === id)
      if (msg?.locked) {
        set({ body: null }) // kilitli kasa maili: gövde çekme, okundu işaretleme (MessageView placeholder gösterir)
        return
      }
      if (msg && !msg.seen && !get().offlineMode) get().markSeen([id], true)
      await get().refreshBody()
    },

    async openMessage(messageId, accountId) {
      if (!get().messages.some((m) => m.id === messageId)) {
        set({ folderKind: 'inbox', smartView: null, searchQuery: '' })
        if (accountId != null) get().setAccountFilter([accountId])
        else set({ selectedFolderId: null })
        await get().refreshList(true)
        if (!get().messages.some((m) => m.id === messageId)) return // silinmiş ya da taşınmış: hesapta kal
      }
      await get().select(messageId)
    },

    selectNextUnread() {
      // ListRow her zaman gerçek bir mesaj satırıdır (kümeleme yalnızca ListPane'de) — ayrı süzme gerekmez
      const { messages, selectedMessageId } = get()
      // Bu tarama yalnızca O AN YÜKLÜ sayfada çalışır — sunucudaki tüm okunmamış
      // kümesini kapsamaz; sonraki sayfalar loadMore ile gelmediyse oradaki okunmamışlar atlanır.
      const cur = messages.findIndex((m) => m.id === selectedMessageId)
      const next = messages.find((m, i) => i > cur && !m.seen) ?? messages.find((m) => !m.seen)
      if (!next) {
        get().toast(t('mail.toast.noUnread'), 'info')
        return
      }
      void get().select(next.id)
    },

    async refreshBody() {
      const id = get().selectedMessageId
      if (id == null) return
      try {
        const body = get().offlineMode
          ? ((await readOfflineBody(id)) ?? { state: 'error' as const, error: t('common.offlineNoBody') })
          : await rpc.call('getBody', { messageId: id })
        if (get().selectedMessageId === id) set({ body })
      } catch (e) {
        if (get().selectedMessageId === id) set({ body: { state: 'error', error: String((e as Error).message) } })
      }
    },

    setAllowRemoteImages(v) {
      set({ allowRemoteImages: v })
    },

    markSeen(ids, seen) {
      // iyimser: yerel liste + rozetler anında güncellenir
      set({
        messages: get().messages.map((m) => (ids.includes(m.id) ? { ...m, seen } : m)),
        accounts: get().accounts.map((a) => {
          const delta = get().messages.filter((m) => ids.includes(m.id) && m.accountId === a.id && m.seen !== seen).length
          return delta ? { ...a, unread: Math.max(0, a.unread + (seen ? -delta : delta)) } : a
        })
      })
      void rpc.call('markSeen', { messageIds: ids, seen }).catch((e) => get().toast(String(e.message), 'error'))
    },

    setFlagged(ids, flagged) {
      set({ messages: get().messages.map((m) => (ids.includes(m.id) ? { ...m, flagged } : m)) })
      void rpc.call('markFlagged', { messageIds: ids, flagged }).catch((e) => get().toast(String(e.message), 'error'))
    },

    setSmartView(v) {
      set({ smartView: v, selectedFolderId: null, selectedMessageId: null, body: null, checkedIds: [] })
      void get().refreshList(true)
    },

    selectBySender(fromAddr) {
      if (!fromAddr) return
      const ids = get().messages.filter((m) => m.fromAddr === fromAddr).map((m) => m.id)
      set({ checkedIds: ids })
    },

    selectByDomain(fromAddr) {
      const domain = fromAddr?.split('@')[1]
      if (!domain) return
      const ids = get().messages.filter((m) => m.fromAddr?.split('@')[1] === domain).map((m) => m.id)
      set({ checkedIds: ids })
    },

    async quickSpamRule(fromAddr) {
      if (!fromAddr) return
      try {
        await rpc.call('createRule', {
          name: t('mail.rule.autoSpamName', { addr: fromAddr }),
          accountId: null,
          groupId: null,
          conditions: { senderContains: fromAddr },
          actions: [{ type: 'spam' }]
        })
        get().toast(t('mail.toast.alwaysSpam', { addr: fromAddr }), 'info')
      } catch (e) {
        get().toast(String((e as Error).message), 'error')
      }
    },

    deleteMessages(ids) {
      const { messages, selectedMessageId } = get()
      const idx = messages.findIndex((m) => m.id === selectedMessageId)
      const remaining = messages.filter((m) => !ids.includes(m.id))
      // silinen seçiliyse: listede sıradakine geç
      let nextSelected: number | null = selectedMessageId
      if (selectedMessageId != null && ids.includes(selectedMessageId)) {
        nextSelected = remaining[Math.min(idx, remaining.length - 1)]?.id ?? null
      }
      set({ messages: remaining, checkedIds: get().checkedIds.filter((c) => !ids.includes(c)) })
      void rpc
        .call('deleteMessages', { messageIds: ids })
        .then(({ undoToken }) => {
          get().toast(t('mail.toast.deleted', { count: ids.length }), 'info', {
            label: t('mail.toast.undo'),
            fn: () => {
              void rpc
                .call('undoDelete', { undoToken })
                .then(() => {
                  void get().refreshList(false)
                  get().toast(t('mail.toast.deleteUndone'), 'info')
                })
                .catch((e) => get().toast(String((e as Error).message)))
            }
          })
        })
        .catch((e) => get().toast(String(e.message), 'error'))
      if (nextSelected !== selectedMessageId) void get().select(nextSelected)
    },

    toggleStar(accountId) {
      const a = get().accounts.find((x) => x.id === accountId)
      if (!a) return
      set({ accounts: get().accounts.map((x) => (x.id === accountId ? { ...x, starred: !x.starred } : x)) })
      void rpc.call('setAccountStarred', { accountId, starred: !a.starred }).catch(() => {})
    }
  }) satisfies Partial<State>
