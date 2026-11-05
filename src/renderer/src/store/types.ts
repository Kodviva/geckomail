import type { PimRpcMethods } from '../../../shared/pimRpc'
// Mağaza türleri: durum arayüzü ve dilim (slice) imzası.
import type { StoreApi } from 'zustand'
import type {
  AccountInfo, BodyResult, ConnectionStats, Contact, FolderInfo, FolderKind, GroupInfo, HourlyVolumePoint,
  IncidentInfo, MessageRow, RuleBuilderPrefill, RuleInfo, RuleLogInfo, ScheduledTriggerInfo, SessionUser, SmartView,
  ThreadRow, UserInfo, VaultStatus, WebhookInfo
} from '../../../shared/rpc'
import type { PimCollectionInfo, WriteResult } from '../../../shared/pim'
import type { RulePlacementInfo } from '../../../shared/sieve'
import type { MoveDrag, MoveRow } from '../moveDrag'
import type { AppView } from '../layout/appView'


export type ListRow = MessageRow & Partial<Pick<ThreadRow, 'threadCount' | 'threadUnread'>> & { snoozeUntil?: number }

/** Takvimde seçili örnek */
export interface SelectedEvent {
  objectId: number
  recurrenceId: string | null
}

export interface ComposerAttachment {
  filename: string
  mime: string
  size: number
  /** masaüstü: içerik sendMail ile gider */
  data?: Uint8Array
  /** web: önceden HTTP ile yüklendi (POST /api/upload) */
  uploadId?: string
}

export interface ComposerState {
  fromAccountId: number
  to: string
  cc: string
  bcc: string
  subject: string
  text: string
  rich: boolean
  html: string
  inReplyTo?: string
  references?: string
  attachments: ComposerAttachment[]
  restored?: boolean
  mode?: 'new' | 'reply' | 'replyAll' | 'forward' // başlık için (QW16)
  /** R30: yanıt gelmezse N gün sonra hatırlat (0/yok = kapalı) */
  followupDays?: number
  /** takip panelinden açılan hatırlatma: gönderilince bu takip kapanır */
  closeFollowupId?: number
  /** ilk gönderim denemesinde üretilir, yeniden denemelerde aynı kalır (sunucu ikinci kez kuyruğa almaz) */
  clientSendId?: string
  /** "1 saat sonra" gibi göreli hazır seçenek ilk denemede hesaplanan zamanla saklanır; yeniden denemede aynı kalır */
  sendAtAttempt?: { preset: string; at: number }
  /** eski kayıtlı taslaklarda yoktur; yok = kapalı */
  smimeSign?: boolean
  smimeEncrypt?: boolean
  /** şifreli iletiden alıntı taşıyor: şifre kapatılsa da düz metin cihaza yazılmaz */
  smimeSensitive?: boolean
}

export interface Toast {
  id: number
  text: string
  kind: 'error' | 'info'
  action?: { label: string; fn: () => void }
}

export interface State {
  currentUser: SessionUser | null
  needsBootstrap: boolean
  accountCount: number
  users: UserInfo[]
  groups: GroupInfo[]
  usersOpen: boolean
  groupsOpen: boolean
  editUserId: number | 'new' | null
  editGroupId: number | 'new' | null

  rules: RuleInfo[]
  rulePlacements: RulePlacementInfo[]
  webhooks: WebhookInfo[]
  scheduledTriggers: ScheduledTriggerInfo[]
  ruleLog: RuleLogInfo[]
  automationOpen: boolean
  automationTab: 'rules' | 'webhooks' | 'triggers' | 'log'
  editRuleId: number | 'new' | null
  editWebhookId: number | 'new' | null
  editTriggerId: number | 'new' | null
  ruleDraft: RuleBuilderPrefill | null

  accounts: AccountInfo[]
  contacts: Contact[]
  appView: AppView
  selectedContactId: number | null
  selectedEvent: SelectedEvent | null
  pimCollections: { addressbook: PimCollectionInfo[]; calendar: PimCollectionInfo[] }
  selectedAccountIds: number[] | null
  folderKind: FolderKind
  folders: FolderInfo[]
  selectedFolderId: number | null
  unreadOnly: boolean
  threadView: boolean
  searchQuery: string
  searchSort: 'relevance' | 'date'
  setSearchSort: (v: 'relevance' | 'date') => void
  savedSearches: { name: string; query: string }[]
  messages: ListRow[]
  hasMore: boolean
  listLoading: boolean
  selectedMessageId: number | null
  checkedIds: number[]
  /** dokunmatik seçim modu: dokunuş iletiyi açmaz, seçimi değiştirir */
  selectMode: boolean
  moveDialog: { rows: MoveRow[] } | null
  moveDrag: MoveDrag | null
  body: BodyResult | null
  allowRemoteImages: boolean
  composer: ComposerState | null
  /** gönderim sürerken oluşturucu alanları kilitli (düzenleme gönderilen içerikten ayrışmasın) */
  sending: boolean
  importOpen: boolean
  problemsOpen: boolean
  settingsOpen: boolean
  settingsSection: string | null // açılışta gösterilecek Ayarlar sekmesi
  connectionStats: ConnectionStats | null
  refreshConnectionStats(): Promise<void>
  editAccountId: number | null
  theme: 'auto' | 'light' | 'dark'
  themePack: string
  customAccent: { light: string; dark: string } | null
  idleLockMin: number
  compact: boolean
  uiScale: number
  toasts: Toast[]
  connected: boolean
  /** web: sunucuya ulaşılamıyor, kutu bu cihazdaki şifreli kopyadan salt okunur gösteriliyor */
  offlineMode: boolean
  /** web: yönetici sunucuyu yeniden başlattı ('server:restarting'); yeniden bağlanınca (sync:hello) kalkar */
  serverRestarting: boolean
  /** web: çıkış sürüyor; silmeler bitince sayfa yenilenir, arada giriş ekranı gösterilmez (yazılan silinirdi) */
  signingOut: boolean
  contextMenu: { x: number; y: number; messageId: number; source: 'list' | 'view' } | null
  accountMenu: { x: number; y: number; accountId: number | 'all' } | null
  accountViewFilter: 'all' | 'starred' | 'problems' | 'unread'
  accountSort: 'starred' | 'unread' | 'name'
  viewSourceMessageId: number | null
  healthBoardOpen: boolean
  /** akıllı posta kutusu (P2-3): klasör yerine filtre görünümü */
  smartView: SmartView | null
  attachmentsOpen: boolean
  outboxOpen: boolean
  subscriptionsOpen: boolean
  followupsOpen: boolean
  followupDue: number
  /** cihazın interneti (sync bildirir); false iken bağlantı denenmez */
  netOnline: boolean
  commandPaletteOpen: boolean
  shortcutsOpen: boolean
  incidents: IncidentInfo[]
  hourlyVolume: HourlyVolumePoint[]
  vaultState: VaultStatus
  vaultPromptOpen: boolean
  vaultBiometricEnabled: boolean
  touchIdAvailable: boolean

  init(): void
  login(username: string, password: string): Promise<void>
  /** web: giriş akışı (WebLogin) oturumu açtı — kullanıcı ayarlanır, WebSocket başlar */
  completeWebLogin(user: SessionUser): void
  /** Uygulama kilidi açıldı: durdurulan WebSocket yeni biletle döner */
  resumeAfterLock(): void
  /** Açılamayan kilit: oturum ve push anahtarı silinir, kilit kapanır. false: yerel çıkış başarısız, kilit kalır */
  logoutFromLock(): Promise<boolean>
  /** web: 2FA'yı kapatır; sunucu ardından bütün oturumları kapatır (yeniden giriş) */
  disableTwoFactor(code: string): Promise<boolean>
  loginBiometric(): Promise<void>
  enableLoginBiometric(password: string): Promise<boolean>
  disableLoginBiometric(): Promise<void>
  bootstrapAdmin(username: string, password: string): Promise<void>
  logout(): Promise<void>
  refreshUsers(): Promise<void>
  refreshGroups(): Promise<void>
  setUsersOpen(v: boolean): void
  setGroupsOpen(v: boolean): void
  setEditUser(id: number | 'new' | null): void
  setEditGroup(id: number | 'new' | null): void
  refreshRules(): Promise<void>
  refreshWebhooks(): Promise<void>
  refreshScheduledTriggers(): Promise<void>
  refreshRuleLog(): Promise<void>
  setAutomationOpen(v: boolean): void
  setAutomationTab(t: 'rules' | 'webhooks' | 'triggers' | 'log'): void
  setEditRule(id: number | 'new' | null): void
  setEditWebhook(id: number | 'new' | null): void
  setEditTrigger(id: number | 'new' | null): void
  openRuleBuilder(prefill: RuleBuilderPrefill): void
  toggleChecked(id: number): void
  rangeCheck(id: number): void
  clearChecked(): void
  startSelect(id: number): void
  endSelect(): void
  openMoveDialog(rows: MoveRow[]): void
  closeMoveDialog(): void
  startMoveDrag(rowId: number, rows: MoveRow[]): void
  endMoveDrag(): void
  markAllSeen(): Promise<void>
  refreshAccounts(): Promise<void>
  refreshContacts(): Promise<void>
  setAppView(v: AppView): void
  setSelectedContact(id: number | null): void
  setSelectedEvent(e: SelectedEvent | null): void
  clearPimDetail(): void
  refreshPimCollections(): Promise<void>
  saveEventDraft(params: PimRpcMethods['saveEvent'] extends (p: infer P) => unknown ? P : never): Promise<WriteResult<{ objectId: number; etag: string | null }> | undefined>
  removeEvent(params: PimRpcMethods['deleteEvent'] extends (p: infer P) => unknown ? P : never): Promise<WriteResult<object> | undefined>
  saveContactDraft(params: PimRpcMethods['saveContact'] extends (p: infer P) => unknown ? P : never): Promise<WriteResult<{ id: number; etag: string | null }> | undefined>
  removeContact(params: PimRpcMethods['deleteContact'] extends (p: infer P) => unknown ? P : never): Promise<WriteResult<object> | undefined>
  setAccountFilter(ids: number[] | null): void
  toggleAccountInFilter(id: number): void
  setFolder(kind: FolderKind): void
  selectFolder(id: number | null): void
  moveMessages(ids: number[], targetFolderId: number): void
  /** Taşı penceresi ve sürükle bırak: konu satırları iletilerine açılır */
  moveRows(rows: MoveRow[], targetFolderId: number): Promise<void>
  moveSpecial(ids: number[], special: 'archive' | 'junk'): void
  snooze(ids: number[], until: number): void
  setUnreadOnly(v: boolean): void
  setThreadView(v: boolean): void
  setSearch(q: string): void
  saveCurrentSearch(name: string): void
  deleteSavedSearch(name: string): void
  applySavedSearch(query: string): void
  refreshList(reset: boolean): Promise<void>
  loadMore(): Promise<void>
  select(id: number | null): Promise<void>
  /** Bildirim tıklaması: ileti listede yoksa hesabın gelen kutusuna geçip seçer */
  openMessage(messageId: number, accountId: number | null): Promise<void>
  selectNextUnread(): void
  refreshBody(): Promise<void>
  setAllowRemoteImages(v: boolean): void
  markSeen(ids: number[], seen: boolean): void
  setFlagged(ids: number[], flagged: boolean): void
  deleteMessages(ids: number[]): void
  openContextMenu(x: number, y: number, messageId: number, source: 'list' | 'view'): void
  closeContextMenu(): void
  openAccountMenu(x: number, y: number, accountId: number | 'all'): void
  closeAccountMenu(): void
  setAccountViewFilter(v: 'all' | 'starred' | 'problems' | 'unread'): void
  setAccountSort(v: 'starred' | 'unread' | 'name'): void
  setViewSource(id: number | null): void
  setHealthBoardOpen(v: boolean): void
  setSmartView(v: SmartView | null): void
  setAttachmentsOpen(v: boolean): void
  setOutboxOpen(v: boolean): void
  setSubscriptionsOpen(v: boolean): void
  setFollowupsOpen(v: boolean): void
  refreshFollowupDue(): Promise<void>
  setCommandPaletteOpen(v: boolean): void
  setShortcutsOpen(v: boolean): void
  refreshIncidents(): Promise<void>
  refreshHourlyVolume(): Promise<void>
  pushWallboardSnapshot(): void
  openWallboard(): void
  refreshVaultState(): Promise<void>
  setVaultPromptOpen(v: boolean): void
  unlockVault(password: string): Promise<boolean>
  lockVault(): Promise<void>
  createVault(password: string): Promise<boolean>
  setAccountSecure(accountId: number, secure: boolean): Promise<void>
  enableVaultBiometric(passphrase: string): Promise<boolean>
  disableVaultBiometric(): Promise<void>
  unlockVaultBiometric(): Promise<boolean>
  selectBySender(fromAddr: string | null): void
  selectByDomain(fromAddr: string | null): void
  quickSpamRule(fromAddr: string | null): Promise<void>
  openComposer(mode: 'new' | 'reply' | 'replyAll' | 'forward'): void
  setComposer(c: ComposerState | null): void
  // Esc/dışarı tıklama: taslak korunur. discard=true (İptal): silinir ama Geri al ile döner
  closeComposer(discard?: boolean): void
  /** preset: hazır "sonra gönder" seçeneğinin anahtarı; yeniden denemede ilk hesaplanan sendAt korunur */
  send(sendAt?: number, preset?: string): Promise<void>
  setImportOpen(v: boolean): void
  setProblemsOpen(v: boolean): void
  setSettingsOpen(v: boolean, section?: string): void
  setEditAccount(id: number | null): void
  setTheme(t: 'auto' | 'light' | 'dark'): void
  setThemePack(id: string): void
  setCustomAccent(light: string, dark: string): void
  setIdleLockMin(min: number): void
  setCompact(v: boolean): void
  setUiScale(n: number): void
  toast(text: string, kind?: 'error' | 'info', action?: { label: string; fn: () => void }): void
  dismissToast(id: number): void
  toggleStar(accountId: number): void
  addAttachments(files: FileList | File[]): Promise<void>
  removeAttachment(index: number): void
}

export type SetState = StoreApi<State>['setState']
export type GetState = () => State
