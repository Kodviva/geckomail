// Mağaza — Oturum: olay aboneliği (init), giriş/çıkış, biyometrik.

import { rpc } from '../rpcClient'
import { wsEndpoint } from '../apiFetch'
import { attention } from '../accountHealth'
import { getLocale, fmtDateTime, t } from '../../../shared/i18n'
import type { GetState, SetState, State } from './types'
import { runtime } from './runtime'
import { platform } from '../platform'
import { webSocketTransport } from '../transport'
import { webLogout, webMe } from '../webAuth'
import { closeServerNotifications, showServerNotification } from '../webNotify'
import { resyncPush, setPushUser, suspendPush } from '../webPushClient'
import { clearPendingLogout, LOGOUT_KEY, markPendingLogout, pendingLogout } from '../offline/settings'
import { deferRpcStart, isLocked, releaseLockAfterSignOut, whenUnlocked } from '../appLock'
import { wipeOffline } from '../offline/store'
import { clearDraft, newSendId } from './compose'
import { composerFromDraft } from '../smimeCompose'
import { initialState } from './initial'
import { invalidateListReads } from './mail'
import { dropUnscopedSavedSearches, readSavedSearches } from './savedSearches'
import {
  bootFromCopy, boundedWait, enterOffline, hasOfflineCopy, leaveOffline, offlineEnabled, offlineOnHello, offlinePimSourcesChanged, runOfflineSync
} from './offline'

const isWeb = (): boolean => platform.kind === 'web'

/** Yönetici parolanızı sıfırladıysa onaylanana dek her girişte söylenir */
async function showSecurityNotice(get: GetState): Promise<void> {
  try {
    const { passwordResetAt, mustChangePassword } = await rpc.call('getSecurityNotice', {})
    if (!passwordResetAt) return
    get().toast(t('smime.notice.passwordReset', { when: fmtDateTime(passwordResetAt) }), 'error', mustChangePassword
      ? { label: t('smime.notice.change'), fn: () => get().setSettingsOpen(true, 'kasa') }
      : { label: t('smime.notice.ack'), fn: () => void rpc.call('ackSecurityNotice', {}).catch(() => {}) })
  } catch {
    /* uyarı girişi durdurmaz */
  }
}

/** /rpc WebSocket'i (web: aynı köken, kimlik HttpOnly çerezde; mobil: sunucu kökeni, tek kullanımlık bilet). Açılamayan her
 *  denemede oturum sorulur: kimlik geçersizse (yükseltme 401) taşıma 'revoked' olur, boşuna denemez. Hiç açılamadan sunucu giderse
 *  kopuş olayı gelmez: yerel kopyaya geçiş burada denenir. */
function startWebRpc(set: SetState, get: GetState): void {
  if (isLocked()) return deferRpcStart() // soğuk açılışta kilit ayarı okunmadan belirteç ve soket açılmaz (T14)
  const wrap = platform.wrapTransport ?? ((t) => t)
  rpc.start(wrap(webSocketTransport(wsEndpoint, {
    isSessionGone: async () => {
      try {
        return (await boundedWait(webMe(), offlineEnabled())).user === null
      } catch (e) {
        void enterOffline(set, get)
        throw e
      }
    }
  })))
}

/** Çıkış nedeni: kullanıcıya gösterilecek bildirim. web: sayfa yenilenirken sessionStorage'da taşınır (kişisel veri yok) */
type SignOutReason = 'expired' | 'restarted' | 'twoFactorOff' | 'offline'
const SIGNOUT_REASON_KEY = 'gecko-signout-reason'
const SIGNOUT_TEXT: Record<SignOutReason, string> = {
  expired: 'acct.session.expired',
  restarted: 'set.backup.web.signInAgain',
  twoFactorOff: 'set.2fa.disabledRelogin',
  offline: 'common.offlineSignedOut'
}

function rememberSignOutReason(reason: SignOutReason): void {
  try {
    sessionStorage.setItem(SIGNOUT_REASON_KEY, reason)
  } catch {
    /* depo kapalı: yalnız bildirim eksik kalır */
  }
}

/** Yeniden yüklemeden önce bırakılan neden (bir kez okunur) */
function takeSignOutReason(): SignOutReason | null {
  try {
    const v = sessionStorage.getItem(SIGNOUT_REASON_KEY)
    sessionStorage.removeItem(SIGNOUT_REASON_KEY)
    return v && v in SIGNOUT_TEXT ? (v as SignOutReason) : null
  } catch {
    return null
  }
}

// web çıkışında sıfırlanmayan cihaz tercihleri (geri kalan her şey kullanıcıya ait ya da geçici ekran durumu)
const DEVICE_PREFS = new Set(['theme', 'themePack', 'customAccent', 'idleLockMin', 'compact', 'uiScale', 'threadView', 'searchSort', 'accountSort'])
const signedOutState = Object.fromEntries(Object.entries(initialState).filter(([k]) => !DEVICE_PREFS.has(k)))

let webSignOut: Promise<void> | null = null

/** Web çıkışı: oturum bağı kesilir, cihazdaki kullanıcı verisi silinir (taslak, çevrimdışı kopya, push aboneliği), ekran
 *  hemen boşalır; silmeler bitince sayfa yeniden yüklenir: hiçbir dilim ya da modül durumu sonraki kullanıcıya kalmaz. Sunucuya
 *  ulaşılamıyorsa yenileme hata sayfası açardı (kabuk önbelleği de silindi): sıfırlanan mağazayla giriş ekranında kalınır. */
function signOutWeb(set: SetState, get: GetState, reason: SignOutReason | undefined): Promise<void> {
  if (webSignOut) return webSignOut
  const unreachable = get().offlineMode
  rpc.stop()
  rpc.setFailFast(false)
  closeServerNotifications()
  clearDraft()
  runtime.offlineLastSync = 0
  runtime.offlineVisible = null
  runtime.offlinePimScope = null
  invalidateListReads() // sürmekte olan kopya okuması sıfırlanan listeye önceki kullanıcının satırlarını yazmasın
  const wiped = wipeOffline() // silme isteği ilk adımda verilir
  const pushOff = suspendPush() // yenileme aboneliğin iptalini yarıda kesmesin
  set({ ...signedOutState, signingOut: true })
  webSignOut = Promise.all([wiped.catch(() => {}), pushOff])
    .then(() => {
      if (!unreachable) {
        if (reason) rememberSignOutReason(reason)
        window.location.replace('/')
        return
      }
      set({ signingOut: false })
      if (reason) get().toast(t(SIGNOUT_TEXT[reason]), 'info')
    })
    .finally(() => {
      webSignOut = null
    })
  return webSignOut
}

/** Bütün çıkış yolları (çıkış, oturum iptali, kopuşta geçersiz çerez) buradan: kullanıcıya ait ekran verisi
 *  temizlenir. web: signOutWeb. reason: kullanıcı kendisi çıkmadı → bildirim. */
function signOut(set: SetState, get: GetState, o: { reason?: SignOutReason } = {}): Promise<void> {
  runtime.followupPrimed = false
  runtime.helloUserId = null
  runtime.twoFactorOff = false
  // yeniden başlatma sonrası oturum düştüyse (geri yüklenen DB'de eski oturumlar yok) "süre doldu" değil
  const restarted = get().serverRestarting
  const reason = restarted ? 'restarted' : o.reason
  if (isWeb()) return signOutWeb(set, get, reason)
  if (restarted) set({ serverRestarting: false })
  set({
    currentUser: null, accounts: [], messages: [], selectedAccountIds: null, selectedMessageId: null,
    body: null, checkedIds: [], selectMode: false, moveDialog: null, moveDrag: null, folders: [], selectedFolderId: null, followupDue: 0
  })
  if (reason) get().toast(t(SIGNOUT_TEXT[reason]), 'info')
  return Promise.resolve()
}

/** Başka sekme çevrimdışıyken çıktı (ya da bu sekme o an kapalıydı): bu sekme de hemen çıkar, oturum sunucuda kapanır.
 *  İstek yenilemeyle yarıda kalırsa bekleyen çıkış açılışta tamamlanır. */
function honorPendingLogout(set: SetState, get: GetState): void {
  void signOut(set, get, { reason: 'expired' })
  void webLogout().then((ok) => {
    if (ok) clearPendingLogout()
  })
}

export const sessionSlice = (set: SetState, get: GetState) =>
  ({
    init() {
      if (!isWeb()) rpc.init()
      const theme = get().theme
      if (theme !== 'auto') document.documentElement.dataset.theme = theme
      rpc.on('local:open-account', ({ accountId }) => {
        get().setAccountFilter([accountId])
      })
      rpc.on('local:open-message', ({ messageId, accountId }) => {
        void get().openMessage(messageId, accountId)
      })
      rpc.on('local:connected', () => {
        // hesap/mesaj yenilemesi login/bootstrapAdmin başarısına ertelendi — kimliksizken
        // çağrılırsa sunucu reddeder ve kullanıcı Login ekranını görmeden hata toast'u alır
        set({ connected: true })
        if (!isWeb()) return
        // taşıma burada durursa sync:hello da işlenmez: çıkılmış oturum ekrana dönmez
        if (pendingLogout()) {
          set({ offlineMode: false }) // sunucu geldi: çıkış yenilemeyle bitebilir
          return honorPendingLogout(set, get)
        }
        leaveOffline(set, get)
      })
      rpc.on('local:restarted', () => {
        get().toast(t('acct.session.syncRestarting'), 'info')
      })
      rpc.on('sync:hello', ({ accountCount, usersCount, user }) => {
        // masaüstü: her yeni kanal (ilk açılış, Cmd+R, sync çökme sonrası) oturumu sıfırlar — sunucuyla eşleş.
        // web: kanal çerezle doğrulanmış oturumu taşır; yeniden bağlanışta kullanıcı aynı ekranda kalır
        const reconnect = !!user && runtime.helloUserId === user.id
        runtime.helloUserId = user?.id ?? null
        // kopyayla açılmıştı ama çerez başka kullanıcının: önceki kullanıcının ekran verisi bir an bile kalmasın
        const shown = get().currentUser
        if (shown && user && shown.id !== user.id) {
          set({
            accounts: [], messages: [], selectedMessageId: null, body: null, checkedIds: [], selectMode: false, moveDialog: null, moveDrag: null,
            selectedAccountIds: null, selectedFolderId: null, folders: [],
            ...(isWeb() ? { contacts: [], composer: null, appView: 'mail' as const, selectedContactId: null, selectedEvent: null, pimCollections: { addressbook: [], calendar: [] } } : {})
          })
          if (isWeb()) clearDraft()
        }
        set({ currentUser: user ?? null, needsBootstrap: usersCount === 0, accountCount, serverRestarting: false })
        if (isWeb() && user) set({ savedSearches: readSavedSearches(user.id) })
        if (accountCount === 0 && !reconnect) set({ importOpen: true })
        if (user) {
          // oturum dili bağlantıya bağlı: her yeni kanalda, ilk çağrılardan önce
          if (isWeb()) platform.setLocale(getLocale())
          // ilk bağlantıda tam yükleme; yeniden bağlanışta kaçan değişiklikler tazelenir (seçim korunur)
          void get().refreshAccounts()
          void get().refreshList(!reconnect)
          void get().refreshVaultState()
          void showSecurityNotice(get)
          if (isWeb()) offlineOnHello(user, get)
          if (isWeb() && !reconnect && !platform.nativeNotifications) {
            // cihaz kaydı oturuma bağlı: yeni oturumda abonelik yeniden kaydedilir
            setPushUser(user.id)
            void resyncPush()
          }
        }
      })
      rpc.on('server:notify', (n) => {
        if (platform.nativeNotifications) return // masaüstünde bildirim main süreçten
        // bildirim kapatılamadan başka kullanıcı girdiyse tıklama onun oturumunda iş yapmasın
        const userId = get().currentUser?.id
        showServerNotification(n, {
          focused: document.visibilityState === 'visible' && document.hasFocus(),
          onOpen: (accountId, messageId) => {
            if (userId == null || get().currentUser?.id !== userId) return
            if (messageId != null) void get().openMessage(messageId, accountId)
            else get().setAccountFilter([accountId])
          }
        })
      })
      // yönetici sunucuyu yeniden başlatıyor (geri yükleme): bağlantı kopacak, taşıma yeniden dener
      rpc.on('server:restarting', () => set({ serverRestarting: true }))
      rpc.on('local:disconnected', () => {
        set({ connected: false })
        if (!isWeb() || isLocked()) return // kilit soketi kendisi kapatır, kimlik açılınca sorulur
        // çerezin süresi dolduysa sunucu yükseltmeyi 401'le reddeder (4401 gelmez): oturumu sor
        void boundedWait(webMe(), offlineEnabled())
          .then((r) => {
            if (!r.user && get().currentUser) void signOut(set, get, { reason: 'expired' })
          })
          .catch(() => {
            // sunucuya ulaşılamıyor: taşıma yeniden denemeyi sürdürür, bu arada varsa yerel kopya gösterilir
            void enterOffline(set, get)
          })
      })
      rpc.on('local:revoked', () => {
        // sunucu oturumu iptal etti (süre, kullanıcı devre dışı, başka sekmede çıkış): giriş ekranı.
        // Kendi çıkışımızda sunucu da 4401 ile kapatır — o zaman "oturum sona erdi" denmez
        if (runtime.twoFactorOff) {
          // 2FA kapatıldı: sunucu kullanıcının bütün oturumlarını kapattı (bu kapanış beklenen sonuç)
          void signOut(set, get, { reason: 'twoFactorOff' })
          return
        }
        void signOut(set, get, { reason: runtime.loggingOut ? undefined : 'expired' })
      })
      if (isWeb()) {
        dropUnscopedSavedSearches()
        // önceki sayfa çıkışta yenilendi: nedeni burada söylenir
        const signedOut = takeSignOutReason()
        if (signedOut) get().toast(t(SIGNOUT_TEXT[signedOut]), 'info')
        // web açılışı: çerez geçerliyse WebSocket başlar (kullanıcı sync:hello ile gelir), yoksa giriş ekranı
        window.addEventListener('storage', (e) => {
          if (e.key === LOGOUT_KEY && e.newValue === '1' && get().currentUser) honorPendingLogout(set, get)
        })
        // çevrimdışı çıkılan sekme giriş ekranında kaldıysa bağlantı gelince oturum sunucuda da kapanır
        window.addEventListener('online', () => {
          if (!pendingLogout() || get().currentUser) return
          void webLogout().then((ok) => {
            if (ok) clearPendingLogout()
          })
        })
        void (async () => {
          await whenUnlocked() // soğuk açılışta kilit çözülmeden belirteç istenmez (T14)
          const bounded = await hasOfflineCopy()
          // çevrimdışıyken çıkılmıştı: oturum sunucuda da kapanır
          if (pendingLogout() && (await boundedWait(webLogout(), bounded).catch(() => false))) clearPendingLogout()
          try {
            const r = await boundedWait(webMe(), bounded)
            // hiç kullanıcı yoksa giriş yerine create-admin bilgisi (BootstrapAdmin web görünümü)
            // bekleyen çıkış sunucuda kapanamadıysa da oturuma girilmez
            if (!r.user || pendingLogout()) {
              void wipeOffline() // süresi dolan oturumun kopyası da gider
              clearDraft()
              void resyncPush() // kullanıcı yok: kalan abonelik ve görünen bildirimler temizlenir (hello gelmez)
              set({ needsBootstrap: !r.user && r.setupRequired })
              return
            }
            // giriş ekranı yanıp sönmesin; çağrılar bağlantı açılınca gider. Kayıtlı aramalar hello'yu beklemez: boş liste kaydedilmesin
            set({ currentUser: r.user, savedSearches: readSavedSearches(r.user.id) })
            startWebRpc(set, get)
          } catch {
            // sunucuya ulaşılamadı: yerel kopya varsa o açılır (taşıma arkada dener), yoksa giriş ekranı kalır
            if (!pendingLogout() && (await bootFromCopy(set, get))) startWebRpc(set, get)
          }
        })()
      }
      rpc.on('messages:changed', () => {
        void get().refreshList(false)
        void get().refreshAccounts()
        if (isWeb()) void runOfflineSync(get)
      })
      rpc.on('counts:changed', () => void get().refreshAccounts())
      rpc.on('body:ready', ({ messageId }) => {
        if (get().selectedMessageId === messageId) void get().refreshBody()
      })
      rpc.on('op:failed', ({ kind, error, draft, id, partial, own }) => {
        const labels: Record<string, string> = {
          store_flags: t('acct.op.storeFlags'),
          trash: t('acct.op.trash'),
          smtp_send: t('acct.op.smtpSend'),
          append_sent: t('acct.op.appendSent'),
          mark_all_seen: t('acct.op.markAllSeen'),
          move_named: t('acct.op.moveNamed'),
          forward: t('acct.op.forward'),
          call_webhook: t('acct.op.callWebhook')
        }
        get().toast(t('acct.session.opFailed', { op: labels[kind] ?? kind, error }), 'error')
        // açık oluşturucudaki kimlik başarısız gönderime ait olabilir: yeniden deneme yeni gönderimdir
        const open = get().composer
        if (kind === 'smtp_send' && open?.clientSendId) get().setComposer({ ...open, clientSendId: newSendId(), sendAtAttempt: undefined })
        // gönderilemeyen mail kaybolmasın: taslağı compose'a geri koy
        if (partial) return // ana parça teslim edildi: taslağı geri vermek ikinci gönderime götürür
        if (kind === 'smtp_send' && draft && !get().composer) set({ composer: composerFromDraft(draft, true) })
        // şifreli op'un taslağı olaya girmez: yalnız gönderen getOpDraft ile alır
        if (kind === 'smtp_send' && !draft && id != null && own) {
          void rpc.call('getOpDraft', { id }).then(
            (d) => {
              if (d && !get().composer) set({ composer: composerFromDraft(d, true) })
            },
            () => {}
          )
        }
      })
      rpc.on('account:status', ({ accountId }) => {
        const before = get().accounts.find((a) => a.id === accountId)
        const wasAuth = before ? attention(before) === 'auth' : false
        void get()
          .refreshAccounts()
          .then(() => {
            // şifre sorununa ilk düşüşte eylemli uyarı: sunucu banından önce düzeltme fırsatı
            const now = get().accounts.find((a) => a.id === accountId)
            if (now && !wasAuth && attention(now) === 'auth') {
              get().toast(t('acct.session.passwordRejected', { email: now.email }), 'error', {
                label: t('acct.health.updatePassword'),
                fn: () => get().setEditAccount(accountId)
              })
            }
          })
      })
      rpc.on('host:health', ({ host, state, until, message }) => {
        void get().refreshConnectionStats()
        if (state === 'cooldown' && message) {
          get().toast(message, 'error', { label: t('acct.common.details'), fn: () => get().setSettingsOpen(true, 'baglanti') })
        } else if (state === 'ok') {
          get().toast(t('acct.session.hostRecovered', { host }), 'info')
        }
        void until
      })
      rpc.on('local:menu', ({ action }) => {
        if (action === 'settings') get().setSettingsOpen(true)
        else if (action === 'accounts') get().setSettingsOpen(true, 'hesaplar')
      })
      // 68 hesapta kural toast seli olmasın: 2 sn içinde gelenler tek bildirimde toplanır (UX-P2-14)
      let ruleBatch: { names: Set<string>; count: number; timer: ReturnType<typeof setTimeout> | null } = { names: new Set(), count: 0, timer: null }
      rpc.on('rule:matched', ({ ruleName, accountId }) => {
        if (get().automationOpen && get().automationTab === 'log') void get().refreshRuleLog()
        ruleBatch.names.add(ruleName)
        ruleBatch.count++
        if (ruleBatch.timer) return
        ruleBatch.timer = setTimeout(() => {
          const { names, count } = ruleBatch
          ruleBatch = { names: new Set(), count: 0, timer: null }
          const acc = count === 1 ? get().accounts.find((a) => a.id === accountId) : undefined
          const text =
            count === 1
              ? acc
                ? t('acct.session.ruleFiredAccount', { rule: [...names][0], email: acc.email })
                : t('acct.session.ruleFired', { rule: [...names][0] })
              : t('acct.session.rulesFired', { count, names: `${[...names].slice(0, 3).join(', ')}${names.size > 3 ? '…' : ''}` })
          get().toast(text, 'info', {
            label: t('acct.session.viewActivity'),
            fn: () => {
              get().setAutomationOpen(true)
              get().setAutomationTab('log')
            }
          })
        }, 2000)
      })
      rpc.on('pim:changed', ({ kind }) => {
        if (kind === 'contacts') void get().refreshContacts()
        if (kind === 'sources') void get().refreshPimCollections().then(() => (isWeb() ? offlinePimSourcesChanged(get) : undefined))
      })
      rpc.on('followups:changed', () => void get().refreshFollowupDue())
    rpc.on('network:state', ({ online }) => {
      set({ netOnline: online })
      if (online) void get().refreshConnectionStats()
    })
      rpc.on('automation:logged', () => {
        if (get().automationOpen && get().automationTab === 'log') void get().refreshRuleLog()
      })
      rpc.on('vault:state', ({ state }) => {
        set({ vaultState: state })
        if (state !== 'locked') set({ vaultPromptOpen: false })
        // kilitte çözülmüş içerik ekranda kalmaz; açılışta yeniden çözülür
        const open = get().messages.find((m) => m.id === get().selectedMessageId)
        if (open?.smimeKind === 'encrypted') {
          if (state === 'locked') set({ body: null })
          void get().refreshBody()
        }
        void get().refreshList(false)
        void get().refreshAccounts()
      })
      rpc.on('account:anomaly', ({ accountId, kind, baseline, current }) => {
        const acc = get().accounts.find((a) => a.id === accountId)
        const label = kind === 'silence' ? t('acct.session.anomalySilence') : t('acct.session.anomalyBurst')
        get().toast(
          acc
            ? t('acct.session.anomalyAccount', { kind: label, email: acc.email, count: current, baseline })
            : t('acct.session.anomaly', { kind: label, count: current, baseline }),
          'error',
          { label: t('acct.session.goToAccount'), fn: () => get().setAccountFilter([accountId]) } // UX-P2-15
        )
      })
    },

    async login(username, password) {
      if (isWeb()) return // web: giriş WebLogin akışında (webLoginFlow), sonucu completeWebLogin'e gelir
      try {
        const { user } = await rpc.call('login', { username, password })
        set({ currentUser: user })
        void get().refreshAccounts()
        void get().refreshList(true)
        void get().refreshVaultState()
      } catch (e) {
        get().toast(String((e as Error).message))
      }
    },

    resumeAfterLock() {
      startWebRpc(set, get)
    },

    async logoutFromLock() {
      if (!(await webLogout())) return false
      // ekran boşaltıldıktan sonra kilit kalkar: posta görünmez. Silmeler sırasında bekleyen istekler kilide takılmasın
      const done = signOut(set, get)
      releaseLockAfterSignOut()
      await done
      return true
    },

    completeWebLogin(user) {
      if (!isWeb()) return
      clearPendingLogout() // yeni giriş yeni oturum: bekleyen çıkış artık onu kapatmamalı
      clearDraft() // giriş ekranına kapanan bir oturumdan gelindi: taslağı sonraki kullanıcıya kalmaz
      set({ currentUser: user, savedSearches: readSavedSearches(user.id) })
      startWebRpc(set, get) // listeler sync:hello'da tazelenir
    },

    async disableTwoFactor(code) {
      runtime.twoFactorOff = true
      try {
        await rpc.call('twoFactorDisable', { code })
        // başarı: sunucu ardından oturumları kapatır; local:revoked bildirimi gösterir
        return true
      } catch (e) {
        // yanıt gelmeden soket kapandıysa (revoked işlendi, çıkış yapıldı) kapatma gerçekleşmiştir
        if (!get().currentUser) return true
        runtime.twoFactorOff = false
        get().toast(String((e as Error).message))
        return false
      }
    },

    async loginBiometric() {
      try {
        const ok = await platform.promptBiometric(t('acct.login.touchIdPrompt'))
        if (!ok) return // iptal / başarısız
        const { user } = await rpc.call('loginBiometric', {})
        set({ currentUser: user })
        void get().refreshAccounts()
        void get().refreshList(true)
        void get().refreshVaultState()
      } catch (e) {
        get().toast(String((e as Error).message))
      }
    },

    async enableLoginBiometric(password) {
      try {
        await rpc.call('enableLoginBiometric', { password })
        get().toast(t('acct.session.loginBiometricEnabled'), 'info')
        return true
      } catch (e) {
        get().toast(String((e as Error).message))
        return false
      }
    },

    async disableLoginBiometric() {
      try {
        await rpc.call('disableLoginBiometric', {})
        get().toast(t('acct.session.loginBiometricDisabled'), 'info')
      } catch (e) {
        get().toast(String((e as Error).message))
      }
    },

    async bootstrapAdmin(username, password) {
      if (isWeb()) return // web: ilk yönetici CLI ile (create-admin); RPC sunucu modunda kapalı
      try {
        const { user } = await rpc.call('bootstrapAdmin', { username, password })
        set({ currentUser: user, needsBootstrap: false })
        void get().refreshAccounts()
        void get().refreshList(true)
      } catch (e) {
        get().toast(String((e as Error).message))
      }
    },

    async logout() {
      if (isWeb()) {
        // web: oturum çerezde; RPC logout sunucu modunda kapalı. Sunucu oturumu kapatamadıysa kullanıcı
        // içeride kalır (çerez hâlâ geçerli — "çıktım" sanıp ortak makineyi bırakmasın)
        runtime.loggingOut = true
        let ok: boolean
        try {
          ok = await webLogout()
        } finally {
          runtime.loggingOut = false
        }
        if (!ok) {
          if (!get().currentUser) return // yanıt kayboldu ama sunucu 4401 ile kapattı: zaten çıkıldı
          if (get().offlineMode) {
            // sunucuya ulaşılamıyor ama kullanıcı çıkmak istiyor: yerel kopya şimdi silinir, çerez bağlantı gelince
            markPendingLogout()
            await signOut(set, get, { reason: 'offline' })
            return
          }
          get().toast(t('acct.session.logoutFailed'), 'error', { label: t('action.retry'), fn: () => void get().logout() })
          return
        }
        await signOut(set, get)
        return
      }
      try {
        await rpc.call('logout', {})
      } catch {
        /* en kötü ihtimalle sunucu tarafı zaten sıfırlanmıştır */
      }
      await signOut(set, get)
    }
  }) satisfies Partial<State>
