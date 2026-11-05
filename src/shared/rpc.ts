// Renderer ↔ sync süreci RPC sözleşmesi. İki taraf da yalnızca buna karşı derlenir.
import type { ImportBlock, Sealed } from './importTypes'
import type { NotifyRule } from './notifyRules'
import type { PimChangedEvent, PimConnectStatus } from './pim'
import type { PimRpcMethods } from './pimRpc'
import type { ServerNotify } from './pushTypes'
import type { RecipientStatus, SmimeContactCertInfo, SmimeIdentityInfo, SmimeInfo, SmimeKind } from './smime'
import type { RulePlacementInfo, SieveAccountInfo, SieveVacation } from './sieve'

export type FolderKind = 'inbox' | 'sent' | 'trash' | 'junk' | 'archive' | 'other'

export interface FolderInfo {
  id: number
  path: string
  kind: FolderKind
  display: string
}
export type AccountStatus = 'unknown' | 'ok' | 'degraded' | 'auth_failed' | 'unreachable' | 'disabled'

export interface AccountInfo {
  id: number
  email: string
  displayName: string | null
  color: string
  starred: boolean
  enabled: boolean
  status: AccountStatus
  statusDetail: string | null
  lastSuccessAt: number | null
  unread: number
  signature: string | null // hesabın varsayılan imzası (hesap düzenleme bunu yazar)
  mySignature: string | null // oturumdaki kullanıcının etkin imzası: kişisel varsa o, yoksa varsayılan (yeni mailde)
  groupId: number | null
  groupName: string | null
  secure: boolean
  /** şifre ya da OAuth2 (Gmail / Microsoft 365) */
  authType: 'password' | 'oauth:google' | 'oauth:microsoft'
}

// ---- kasa modu (hesap-bazlı at-rest şifreleme) ----
export type VaultStatus = 'none' | 'locked' | 'unlocked'

// ---- v2.0: çoklu kullanıcı / RBAC ----
export type UserRole = 'admin' | 'member'

export interface SessionUser {
  id: number
  username: string
  role: UserRole
  permittedGroupIds: number[] // role==='admin' için anlamsız (her kontrolü bypass eder)
  manageableGroupIds: number[]
}

export interface UserInfo {
  id: number
  username: string
  role: UserRole
  enabled: boolean
  createdAt: number
  lastLoginAt: number | null
  permissions: { groupId: number; groupName: string; canView: boolean; canManage: boolean }[]
  twoFactorEnabled: boolean
}

export interface GroupInfo {
  id: number
  name: string
  color: string
  accountCount: number
}

// ---- v2.0: otomasyon (kurallar / webhook / zamanlanmış görev) ----
export interface RuleCondition {
  senderContains?: string
  domainEquals?: string
  subjectContains?: string
  hasAttachment?: boolean
}

export type RuleAction =
  | { type: 'move'; folderName: string }
  | { type: 'archive' }
  | { type: 'spam' }
  | { type: 'markRead' }
  | { type: 'markUnread' }
  | { type: 'flag' }
  | { type: 'forward'; to: string }
  | { type: 'webhook'; webhookId: number }
  | { type: 'notify'; urgent?: boolean }

export interface RuleInfo {
  id: number
  name: string
  enabled: boolean
  accountId: number | null
  groupId: number | null
  conditions: RuleCondition
  actions: RuleAction[]
  createdAt: number
  lastTriggeredAt: number | null
  triggerCount: number
  runOnServer: boolean
}

export interface WebhookInfo {
  id: number
  name: string
  url: string
  hasSecret: boolean
  enabled: boolean
  lastDeliveredAt: number | null
  lastError: string | null
}

export type ScheduleType = 'daily' | 'interval'
export type TriggerActionType = 'digest_email' | 'webhook_ping' | 'mute_notifications'

export interface ScheduledTriggerInfo {
  id: number
  name: string
  enabled: boolean
  scheduleType: ScheduleType
  scheduleValue: string
  actionType: TriggerActionType
  actionPayload: Record<string, unknown>
  nextRunAt: number
  lastRunAt: number | null
}

export interface IncidentInfo {
  key: string
  subjectSample: string
  accountIds: number[]
  messageCount: number
  firstDate: number
  lastDate: number
}

/** Akıllı posta kutusu (P2-3): klasör değil, filtre */
export type SmartView = 'starred' | 'snoozed' | 'attachments'

/** Otomatik tamamlama: kart (contactId), grup (groupId + members, addr boş) ya da toplanan adres */
export interface Contact {
  addr: string
  name: string | null
  contactId?: number
  groupId?: number
  members?: string[]
}

export interface HourlyVolumePoint {
  hour: number
  count: number
}

export interface RuleLogInfo {
  id: number
  ts: number
  kind: 'rule' | 'webhook' | 'trigger' | 'vault'
  accountId: number | null
  messageId: number | null
  summary: string
  ok: boolean
  error: string | null
  /** yalnız 'vault': işlemi yapan kullanıcı */
  actor?: string | null
}

export interface RuleBuilderPrefill {
  senderAddr?: string
  domain?: string
  subject?: string
}

/** Konu üyesi: yalnız taşıma için gereken kimlikler */
export type ThreadMember = Pick<MessageRow, 'id' | 'accountId' | 'folderId'>

export interface MessageRow {
  id: number
  accountId: number
  folderId: number
  uid: number
  messageId: string | null
  subject: string | null
  fromName: string | null
  fromAddr: string | null
  toJson: string | null
  date: number
  size: number | null
  seen: boolean
  flagged: boolean
  answered: boolean
  hasAttachments: boolean
  preview: string | null
  threadRoot: string | null
  canUnsubscribe: boolean
  locked: boolean // kasa hesabı + vault kilitli → içerik gizli (UI placeholder gösterir)
  autoForwarded?: boolean // X-GeckoMail-Forwarded taşıyor (bizim otomatik ilettiğimiz) — forward kuralı çalışmaz
  smimeKind: SmimeKind | null // yalnız yapı; güven ifadesi değildir, doğrulama açılışta yapılır
}

export type ThreadRow = MessageRow & { threadCount: number; threadUnread: number }

export interface Cursor {
  date: number
  id: number
}

export interface AttachmentInfo {
  id: number
  filename: string | null
  mime: string | null
  size: number | null
  contentId: string | null
  diskPath: string | null
  /** yalnız çözülmüş ek: içerik RAM'dedir, `id` -1 - dizin */
  smimeIndex?: number
}

// Ekler tarayıcısı: tüm görünür gelen kutularındaki son ekler (mesaj bilgisiyle join'li)
export interface AttachmentRow {
  id: number
  messageId: number
  filename: string
  mime: string | null
  size: number | null
  subject: string | null
  fromName: string | null
  fromAddr: string | null
  accountId: number
  date: number
}

export type BodyResult =
  | { state: 'fetching' }
  | { state: 'error'; error: string }
  | {
      state: 'ready'
      textPlain: string | null
      html: string | null
      attachments: AttachmentInfo[]
      smime?: SmimeInfo
    }

export interface DraftAttachment {
  filename: string
  mime: string
  /** masaüstü: renderer → sync; sync diske yazar, kuyruk yolu saklar */
  data?: Uint8Array
  /** web: önce POST /api/upload ile yüklenen dosya; ad sunucudaki kayıttan (X-Filename) gelir */
  uploadId?: string
  /** bayt; gönderim içerik özeti için (yükleme ilk çağrıda tüketilir, yeniden denemede sunucu boyutu bilemez) */
  size?: number
}

export interface DraftOut {
  accountId: number
  to: string
  cc?: string
  bcc?: string
  subject: string
  text: string
  html?: string // zengin metin gövdesi (multipart/alternative)
  inReplyTo?: string
  references?: string
  attachments?: DraftAttachment[]
}

export interface SmimeRequest {
  sign: boolean
  encrypt: boolean
}

// Giden kutusu (R12): bekleyen/zamanlanmış/başarısız işlemler
/** OAuth2 istemci ayarları (gizli anahtar asla dönmez) */
export interface OAuthClientsInfo {
  googleClientId: string
  googleHasSecret: boolean
  microsoftClientId: string
  /** ayar ya da derleme ortamından kullanılabilir istemci var mı */
  googleReady: boolean
  microsoftReady: boolean
}
export type OAuthProvider = 'google' | 'microsoft'

/** Otomatik sunucu keşfi sonucu */
export interface DiscoveredServers {
  imapHost: string
  imapPort: number
  imapTls: TlsMode
  smtpHost: string
  smtpPort: number
  smtpTls: TlsMode
  username: string
  /** nereden bulundu: "MX kaydı", "Thunderbird veritabanı" … */
  source: string
  label?: string
  appPassword?: boolean
  /** IMAP sunucusu karşılama verdi (giriş denenmeden) ya da bilinen sağlayıcı */
  verified: boolean
}

/** Mail sunucusu yönetimi (R17/R32) — sağlayıcıdan bağımsız; şu an Stalwart */
export interface ServerBlockedIp {
  id: string
  address: string
  reason: string | null
  createdAt: string | null
  expiresAt: string | null
}
export type ServerAllowedIp = ServerBlockedIp
export interface ServerAdminConfig {
  /** kayıtlı adres ya da (kayıt yoksa) hesaplardan önerilen */
  url: string
  suggested: boolean
  hasKey: boolean
  keyFileExists: boolean
  /** algılanan sunucu türü (ör. "Stalwart"); bağlanılmadıysa null */
  provider: string | null
}

/** Takip hatırlatıcısı (R30) */
export interface FollowupInfo {
  id: number
  accountId: number
  messageId: string
  subject: string | null
  to: string | null
  createdAt: number
  dueAt: number
  state: 'waiting' | 'due'
  /** gönderim hâlâ kuyrukta (zamanlanmış ya da bekliyor) */
  pendingSend: boolean
}

/** Abonelik gönderen özeti (R29) */
export interface SubscriptionSender {
  addr: string
  name: string | null
  count: number
  unread: number
  lastDate: number
  accounts: number
  oneClick: boolean
  /** iptal edildiyse zamanı; sonrasında gelen mail sayısı "devam ediyor" uyarısı için */
  unsubscribedAt: number | null
  unsubscribeError: string | null
  sinceUnsubscribed: number
}

/** Yanıt şablonu (R28). Gövde düz metin; {{ad}} gibi değişkenler eklenirken doldurulur. */
export interface TemplateRow {
  name: string
  subject: string | null
  body: string
  updatedAt: number
  shared: boolean // true: herkese açık (yalnız admin yazar); false: kullanıcının kendi şablonu
}

export interface SyncTemplate {
  name: string
  subject: string | null
  body: string
  updatedAt: number
  deleted: boolean
}

export interface OutboxItem {
  id: number
  accountId: number
  email: string | null
  kind: string
  kindLabel: string
  state: 'pending' | 'failed'
  to: string | null
  subject: string | null
  count: number | null // taşıma/silme/bayrak op'unda mesaj sayısı
  scheduledAt: number | null // gelecekte gönderilecekse
  attempts: number
  lastError: string | null
  createdAt: number
  locked: boolean // kasa kilitli: içerik gizli
}

// Bağlantı paneli: sunucu başına governor durumu ve son 24 saatin login sonuçları (auto-ban eşiğine yakınlık)
export interface HostConnectionStats {
  host: string
  state: 'ok' | 'cooldown' | 'probing'
  cooldownUntil: number | null
  reason: 'blocked' | 'limit'
  strikes: number
  sessions: number
  maxSessions: number
  loginsPerMin: number
  last24h: { ok: number; auth: number; preauth: number; limit: number; other: number }
}
export interface ConnectionStats {
  hosts: HostConnectionStats[]
  recentFailures: { ts: number; host: string; accountId: number | null; email: string | null; lane: string; result: string }[]
}

// hesap düzenleme ekranı için sunucu ayarları (hesap listesinde taşınmaz)
export type TlsMode = 'tls' | 'starttls'
export interface AccountServerSettings {
  imapHost: string
  imapPort: number
  imapTls: TlsMode
  smtpHost: string
  smtpPort: number
  smtpTls: TlsMode
  allowInvalidCerts: boolean
}

export interface ImportPreviewRow {
  email: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  hasPassword: boolean
  exists: boolean
}

export interface ListParams {
  accountIds: number[] | null // null = tüm hesaplar
  folderKind: FolderKind
  folderId?: number // verilirse kind/hesap filtresi yerine tek klasör
  cursor: Cursor | null
  limit: number
  unreadOnly?: boolean
}

// İstek yüzeyi — sync tarafında uygulanır, renderer'da proxy'lenir
export interface RpcMethods extends PimRpcMethods {
  login(params: { username: string; password: string }): { user: SessionUser }
  logout(params: Record<string, never>): void
  bootstrapAdmin(params: { username: string; password: string }): { user: SessionUser }
  getLoginBiometric(params: Record<string, never>): { username: string | null }
  loginBiometric(params: Record<string, never>): { user: SessionUser }
  enableLoginBiometric(params: { password: string }): { ok: boolean }
  disableLoginBiometric(params: Record<string, never>): void
  getUsers(params: Record<string, never>): UserInfo[]
  createUser(params: { username: string; password: string; role: UserRole }): UserInfo
  updateUser(params: { userId: number; patch: { role?: UserRole; enabled?: boolean } }): void
  deleteUser(params: { userId: number }): void
  resetUserPassword(params: { userId: number; newPassword: string }): { passkeysRemoved: number }
  // iki aşamalı doğrulama (TOTP): girişli kullanıcı kendi hesabı için; sır yalnız Begin yanıtında
  twoFactorStatus(params: Record<string, never>): { enabled: boolean; required: boolean }
  twoFactorBegin(params: Record<string, never>): { otpauthUri: string; secretBase32: string }
  twoFactorConfirm(params: { code: string }): null
  // require2fa açıksa reddedilir
  twoFactorDisable(params: { code: string }): null
  // yönetici: kullanıcının 2FA'sını kaldırır (kayıp cihaz)
  resetUserTwoFactor(params: { userId: number }): { passkeysRemoved: number }
  getGroups(params: Record<string, never>): GroupInfo[]
  createGroup(params: { name: string; color: string }): GroupInfo
  updateGroup(params: { groupId: number; patch: { name?: string; color?: string } }): void
  deleteGroup(params: { groupId: number }): void
  setAccountGroup(params: { accountId: number; groupId: number | null }): void
  setGroupPermission(params: { userId: number; groupId: number; canView: boolean; canManage: boolean }): void

  getRules(params: Record<string, never>): RuleInfo[]
  createRule(params: {
    name: string; accountId: number | null; groupId: number | null; conditions: RuleCondition; actions: RuleAction[]; runOnServer?: boolean
  }): RuleInfo
  updateRule(params: {
    id: number
    patch: Partial<{
      name: string; enabled: boolean; accountId: number | null; groupId: number | null
      conditions: RuleCondition; actions: RuleAction[]; runOnServer: boolean
    }>
  }): void
  deleteRule(params: { id: number }): void

  /** Kişiye ait bildirim kuralları (§10.1): yalnız çağıranın kayıtları; saveNotifyRule id yoksa ekler */
  listNotifyRules(params: Record<string, never>): NotifyRule[]
  saveNotifyRule(params: { rule: NotifyRule | Omit<NotifyRule, 'id' | 'position'> }): NotifyRule
  deleteNotifyRule(params: { id: number }): void
  reorderNotifyRules(params: { ids: number[] }): void
  // masaüstü ajanı (yalnız sunucu modu)
  registerDesktopAgent(params: { deviceId: string; label: string }): { id: number }
  notifyAction(params: { messageId: number; action: 'read' | 'archive' }): { ok: boolean }
  notifyBacklog(params: { afterSeq: number }): { items: ServerNotify[]; lastSeq: number; truncated: boolean }
  importBegin(params: { sourceId: string }): { importId: string; serverKey: string; done: string[] }
  importItem(params: { importId: string; item: Sealed }): { status: 'added' | 'updated' | 'kept' | 'blocked'; detail?: ImportBlock }
  importFinish(params: { importId: string }): { accounts: number }
  getNotifyAccountPrefs(params: Record<string, never>): { accountId: number; mode: 'on' | 'off' }[]
  setNotifyAccountPref(params: { accountId: number; mode: 'on' | 'off' | 'default' }): void
  testRule(params: { conditions: RuleCondition; accountId: number | null; sampleCount?: number }): {
    matchedCount: number
    samples: MessageRow[]
  }

  getWebhooks(params: Record<string, never>): WebhookInfo[]
  createWebhook(params: { name: string; url: string; secret: string | null }): WebhookInfo
  updateWebhook(params: { id: number; patch: Partial<{ name: string; url: string; secret: string | null; enabled: boolean }> }): void
  deleteWebhook(params: { id: number }): void
  testWebhook(params: { id: number }): { ok: boolean; status?: number; error?: string }

  getScheduledTriggers(params: Record<string, never>): ScheduledTriggerInfo[]
  createScheduledTrigger(params: {
    name: string; scheduleType: ScheduleType; scheduleValue: string
    actionType: TriggerActionType; actionPayload: Record<string, unknown>
  }): ScheduledTriggerInfo
  updateScheduledTrigger(params: {
    id: number
    patch: Partial<{
      name: string; enabled: boolean; scheduleType: ScheduleType; scheduleValue: string
      actionType: TriggerActionType; actionPayload: Record<string, unknown>
    }>
  }): void
  deleteScheduledTrigger(params: { id: number }): void

  getRuleLog(params: { limit: number }): RuleLogInfo[]
  getIncidents(params: Record<string, never>): IncidentInfo[]
  listSmart(params: { view: SmartView; accountIds: number[] | null; unreadOnly?: boolean }): (MessageRow & { snoozeUntil?: number })[]
  getAttachments(params: Record<string, never>): AttachmentRow[]
  getContacts(params: Record<string, never>): Contact[]
  getHourlyVolume(params: Record<string, never>): HourlyVolumePoint[]

  listMessages(params: ListParams): MessageRow[]
  listThreads(params: ListParams): ThreadRow[]
  getThread(params: { threadRoot: string; folderKind: FolderKind }): MessageRow[]
  getThreadMembers(params: { threadRoot: string; folderKind: FolderKind }): ThreadMember[]
  getBody(params: { messageId: number }): BodyResult
  /** masaüstü; web 8 MB üstünde /api/smime-attachment */
  getSmimeAttachment(params: { messageId: number; index: number }): { filename: string; mime: string; base64: string }
  smimeSaveContactCert(params: { messageId: number; fingerprint: string }): { ok: true }
  getAttachment(params: { messageId: number; attachmentId: number }): { diskPath: string }
  getAttachmentData(params: { messageId?: number; attachmentId: number }): { base64: string; mime: string | null }
  search(params: { query: string; accountIds: number[] | null; sort?: 'relevance' | 'date' }): MessageRow[]
  fetchRemoteImages(params: { messageId: number }): { images: Record<string, string> }
  markSeen(params: { messageIds: number[]; seen: boolean }): void
  markFlagged(params: { messageIds: number[]; flagged: boolean }): void
  snoozeMessages(params: { messageIds: number[]; until: number }): void
  markAllSeen(params: { accountIds: number[] | null; folderKind: FolderKind }): void
  getRawHeaders(params: { messageId: number }): { raw: string }
  getRawSource(params: { messageId: number }): { filename: string; data: Uint8Array }
  unsubscribe(params: { messageId: number }): { ok: boolean; error?: string }
  listSubscriptions(params: { accountIds: number[] | null; days?: number }): SubscriptionSender[]
  unsubscribeSenders(params: { accountIds: number[] | null; addrs: string[] }): { addr: string; ok: boolean; error?: string }[]
  deleteMessages(params: { messageIds: number[] }): { undoToken: number }
  undoDelete(params: { undoToken: number }): void
  /** clientSendId: ileti başına istemci kimliği; aynı kimlikle yeniden deneme ikinci kez kuyruğa girmez (24 saat) */
  sendMail(params: { draft: DraftOut; sendAt?: number; followupDays?: number; closeFollowupId?: number; clientSendId?: string; smime?: SmimeRequest }): void
  listFollowups(params: Record<string, never>): FollowupInfo[]
  serverAdminGetConfig(params: Record<string, never>): ServerAdminConfig
  serverAdminSetConfig(params: { url: string; key?: string; importKeyFile?: boolean }): ServerAdminConfig
  serverAdminClearKey(params: Record<string, never>): ServerAdminConfig
  serverAdminTest(params: Record<string, never>): { username: string; principals: number; provider: string }
  serverAdminBlocked(params: { address?: string; position?: number }): { total: number; items: ServerBlockedIp[] }
  serverAdminUnblock(params: { ids: string[] }): { removed: number }
  // S/MIME: ikili veri base64 taşınır (sunucuda parametre JSON'dur)
  smimeListIdentities(params: Record<string, never>): SmimeIdentityInfo[]
  smimeImportIdentity(params: { accountId: number; p12Base64: string; password: string }): SmimeIdentityInfo
  smimeExportIdentity(params: { id: number; vaultPassphrase: string; exportPassword: string }): { filename: string; base64: string }
  smimeRemoveIdentity(params: { id: number; confirmEmail: string }): { ok: true }
  smimeListContactCerts(params: Record<string, never>): SmimeContactCertInfo[]
  smimeRemoveContactCert(params: { id: number }): { ok: true }
  smimeCheckRecipients(params: { accountId: number; addresses: string[] }): {
    canSign: boolean
    canEncrypt: boolean
    blocked: 'vault_none' | 'vault_locked' | 'no_identity' | 'own_cert_missing' | null
    recipients: { address: string; status: RecipientStatus }[]
  }
  smimeTrustInfo(params: Record<string, never>): {
    count: number
    fetchedAt: string
    sha256: string
    anchors: { fingerprint: string; label: string; subject: string; notAfter: number }[]
  }
  smimeAddAnchor(params: { pemOrDerBase64: string; label: string }): { ok: true }
  smimeRemoveAnchor(params: { fingerprint: string }): { ok: true }
  serverAdminAllowed(params: Record<string, never>): ServerAllowedIp[]
  serverAdminAllow(params: { address: string; hours: number; reason: string }): { ok: true }
  serverAdminRemoveAllowed(params: { ids: string[] }): { removed: number }
  serverAdminAccountDiff(params: Record<string, never>): { onServerNotInApp: string[]; inAppNotOnServer: string[]; serverTotal: number }
  closeFollowup(params: { id: number }): { ok: true }
  snoozeFollowup(params: { id: number; days: number }): { ok: true }
  getFoldersOf(params: { accountId: number }): FolderInfo[]
  syncFolder(params: { folderId: number }): void
  // undoToken: en az bir ileti taşındıysa (Geri Al penceresi)
  moveMessages(params: { messageIds: number[]; targetFolderId: number }): { moved: number; skipped: number; undoToken?: number }
  undoMove(params: { undoToken: number }): void
  moveSpecial(params: { messageIds: number[]; special: 'archive' | 'junk' }): void
  discoverMailServers(params: { email: string }): DiscoveredServers
  oauthGetClients(params: Record<string, never>): OAuthClientsInfo
  oauthSetClients(params: { googleClientId?: string; googleClientSecret?: string; microsoftClientId?: string }): OAuthClientsInfo
  // sunucu modunda (web) accountId/email dönüşte hesabı doğrulamak için akışla saklanır; sonuç 'oauth:done' olayıyla
  oauthStart(params: { provider: OAuthProvider; email?: string; accountId?: number; pim?: boolean }): { flowId: string; url: string }
  oauthCancel(params: { flowId: string }): void
  oauthFinish(params: { flowId: string; provider: OAuthProvider; expectedEmail?: string; accountId?: number; pim?: boolean }): { email: string; added: boolean; pimStatus?: PimConnectStatus }
  importPreview(params: { kind: 'mobileconfig' | 'csv'; content: string }): ImportPreviewRow[]
  importAccounts(params: { kind: 'mobileconfig' | 'csv'; content: string }): { added: number; updated: number; skipped: number }
  getAccounts(params: Record<string, never>): AccountInfo[]
  setAccountEnabled(params: { accountId: number; enabled: boolean }): void
  setAccountStarred(params: { accountId: number; starred: boolean }): void
  updateAccount(params: {
    accountId: number
    patch: {
      displayName?: string | null
      color?: string
      signature?: string | null
      imapHost?: string
      imapPort?: number
      smtpHost?: string
      smtpPort?: number
      imapTls?: TlsMode
      smtpTls?: TlsMode
      allowInvalidCerts?: boolean
      password?: string
    }
    // yalnız yönetici: eski Sieve sunucusuna ulaşılamıyorsa adres yine değişir, betik orada kalır
    abandonSieve?: boolean
  }): { sieveLeft: true } | null
  // kişinin bu hesap için imzası (null = hesabın varsayılanına dön); görebilen her kullanıcı
  setMySignature(params: { accountId: number; signature: string | null }): null
  getAccountServer(params: { accountId: number }): AccountServerSettings
  // toplu: seçili hesaplara aynı sunucu ayarı (boş alan = değişmez); hatalı olanlar ayrı listelenir
  updateAccountsServer(params: { accountIds: number[]; patch: Partial<AccountServerSettings> }): { updated: number; failed: { accountId: number; error: string }[] }
  retryAccounts(params: { accountIds: number[] }): { retried: number; skippedAuthFailed: number }
  getAccountStatusHistory(params: { accountId: number }): { ts: number; status: AccountStatus; detail: string | null }[]
  getConnectionStats(params: Record<string, never>): ConnectionStats
  exportDiagnostics(params: Record<string, never>): { filename: string; data: Uint8Array }
  listOutbox(params: Record<string, never>): OutboxItem[]
  listTemplates(params: Record<string, never>): TemplateRow[]
  saveTemplate(params: { name: string; subject: string | null; body: string; shared?: boolean }): { ok: true }
  // shared verilmezse önce kişisel kopya silinir, yoksa paylaşılan (admin)
  deleteTemplate(params: { name: string; shared?: boolean }): { ok: true }
  // yedek (R18): sync doğrudan dosyaya yazar (DB belleğe/renderer'a taşınmaz); parola → .geckobak
  backupToFile(params: { path: string; passphrase?: string }): { bytes: number }
  // geri yükleme: dosyayı doğrula, bir sonraki açılışta uygulanmak üzere hazırla
  stageRestore(params: { path: string; passphrase?: string }): { accounts: number; schemaVersion: number }
  cancelOp(params: { id: number }): void
  retryOp(params: { id: number }): void
  getOpDraft(params: { id: number }): (DraftOut & { smime?: SmimeRequest }) | null
  deleteAccount(params: { accountId: number }): void
  getPrefs(params: Record<string, never>): Record<string, string>
  setPrefs(params: { values: Record<string, string> }): void
  // kişisel bildirim tercihleri (her girişli kullanıcı; yalnız USER_PREF_KEYS)
  setMyPrefs(params: Record<string, string>): null
  /** Oturum dili (yalnız sunucu modunda etkili): sunucunun ürettiği metinler bu oturuma bu dilde */
  setSessionLocale(params: { locale: string }): null
  getVaultState(params: Record<string, never>): { state: VaultStatus; biometricEnabled: boolean }
  createVault(params: { password: string }): { state: VaultStatus }
  unlockVault(params: { password: string }): { ok: boolean; state: VaultStatus }
  /** yönetici: yanlış parola sayaçlarını sıfırlar */
  clearVaultPassphraseFails(params: Record<string, never>): { ok: true }
  /** yönetici parolanızı sıfırladıysa: anahtarlarınız o andan sonra onun erişimine açık olabilir */
  getSecurityNotice(params: Record<string, never>): { passwordResetAt: number | null; mustChangePassword: boolean }
  /** parola yöneticinin koyduğu değerdeyse reddedilir */
  ackSecurityNotice(params: Record<string, never>): { ok: true }
  /** Yalnız sunucuda, çerezli oturumdan; `id` belirteç özeti değil, kısaltılmış tutamaktır */
  listSessions(params: Record<string, never>): { id: string; kind: 'web' | 'mobile'; label: string; lastSeenAt: number; current: boolean }[]
  revokeSession(params: { id: string }): { ok: boolean }
  revokeOtherSessions(params: Record<string, never>): { count: number }
  changeOwnPassword(params: { currentPassword: string; newPassword: string }): { ok: true }
  lockVault(params: Record<string, never>): { state: VaultStatus }
  enableVaultBiometric(params: { passphrase: string }): { ok: boolean }
  disableVaultBiometric(params: Record<string, never>): void
  unlockVaultBiometric(params: Record<string, never>): { ok: boolean; state: VaultStatus }
  setAccountSecure(params: { accountId: number; secure: boolean }): void
  syncPush(params: { anchorAccountId: number; passphrase: string }): { pushed: number; skipped: number }
  syncPull(params: { anchorAccountId: number; passphrase: string }): { imported: number; updated: number; skippedSecure: number; passwordKept: number }
  setSyncAuto(params: { enabled: boolean; anchorAccountId: number; passphrase: string }): void
  retryAccount(params: { accountId: number }): void
  setViewed(params: { accountIds: number[] | null }): void
  pollNow(params: { accountIds: number[] | null }): void
  // ---- sunucu tarafı filtreler ----
  listSieveAccounts(params: Record<string, never>): SieveAccountInfo[]
  getSieveAccount(params: { accountId: number }): SieveAccountInfo
  sieveDetect(params: { accountId: number; force?: boolean }): SieveAccountInfo
  sieveSetEnabled(params: { accountId: number; enabled: boolean }): SieveAccountInfo
  sieveSetEndpoint(params: { accountId: number; host: string | null; port: number | null; abandon?: boolean }): SieveAccountInfo & { left: boolean }
  sieveConsent(params: { accountId: number; scriptName: string }): SieveAccountInfo
  sieveDeployNow(params: { accountId: number }): SieveAccountInfo
  sieveRollback(params: { accountId: number }): SieveAccountInfo
  sieveListScripts(params: { accountId: number }): { name: string; active: boolean; managed: boolean }[]
  sieveGetScript(params: { accountId: number; name: string }): { content: string; sha: string; managed: boolean }
  sieveCheckScript(params: { accountId: number; content: string }): { ok: boolean; error?: string; warning?: string }
  sieveSaveScript(params: { accountId: number; name: string; content: string; baseSha: string }): { ok: boolean; conflict?: boolean; error?: string; content?: string; sha?: string; scripts?: { name: string; active: boolean; managed: boolean }[]; backupName?: string }
  getSieveVacation(params: { accountId: number }): { vacation: SieveVacation; supported: boolean; dateRange: boolean; conflict: boolean }
  setSieveVacation(params: { accountId: number; vacation: SieveVacation }): SieveAccountInfo
  getRulePlacements(params: Record<string, never>): RulePlacementInfo[]
}

export type RpcMethodName = keyof RpcMethods

// Sync → renderer olayları: kaba geçersiz kılmalar, asla satır diff'i değil
export interface RpcEvents {
  'messages:changed': { accountId: number | null }
  'counts:changed': Record<string, never>
  'account:status': { accountId: number; status: AccountStatus; detail: string | null }
  'body:ready': { messageId: number; accountId: number }
  /** partial: ana parça teslim edildi, yalnız Bcc parçası gitmedi; taslak gönderilmemiş sayılmaz */
  'op:failed': { kind: string; error: string; accountId: number; draft?: DraftOut; id?: number; partial?: boolean; own?: boolean }
  // user: sunucu modunda bağlantı çerezle önceden doğrulanmış oturumun kullanıcısı; masaüstünde null (giriş RPC ile)
  'sync:hello': { accountCount: number; usersCount: number; user: SessionUser | null }
  'rule:matched': { ruleId: number; ruleName: string; accountId: number; messageId: number }
  'automation:logged': Record<string, never>
  'account:anomaly': { accountId: number; kind: 'silence' | 'burst'; baseline: number; current: number }
  'sieve:state': { accountId: number }
  'vault:state': { state: VaultStatus }
  // sunucu soğumaya girdi/çıktı (olası IP engeli) — arayüz bağlantı şeridini tazeler
  'followups:changed': Record<string, never>
  'network:state': { online: boolean }
  'host:health': { host: string; state: 'ok' | 'cooldown' | 'probing'; until: number | null; message: string | null }
  // sunucu modu: tarayıcı bildirimi (masaüstünde ev sahibi bildirimi kullanılır); messageId varsa tıklama iletiyi açar
  'server:notify': ServerNotify
  // sunucu modu: web OAuth akışı bitti (yalnız akışı başlatan web oturumuna); başarıda hesap bilgisi
  'oauth:done': { ok: boolean; error?: string; flowId?: string; email?: string; added?: boolean; pimStatus?: PimConnectStatus }
  // sunucu modu: sağlayıcı kodu döndürdü; uygulama sayfası POST /oauth/complete ile tamamlar (açılır pencere çerezsizdir)
  'oauth:returned': { flowId: string }
  // sunucu modu: yönetici yeniden başlattı (geri yükleme sonrası); web istemcisi yeniden bağlanma bildirimi gösterir
  'server:restarting': Record<string, never>
  // kişiler/takvim değişti: hesaba bağlı kaynakta hesabı görenlere, kişisel kaynakta yalnız sahibine
  'pim:changed': PimChangedEvent
}

export type RpcEventName = keyof RpcEvents

// Tel formatı
export interface RpcRequest {
  id: number
  method: RpcMethodName
  params: unknown
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

export interface RpcEventMsg {
  event: RpcEventName
  data: unknown
}

export type RpcWireDown = RpcResponse | RpcEventMsg
