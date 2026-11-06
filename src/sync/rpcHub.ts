import { unlinkSync } from 'fs'
import { clearVaultOpen } from './bodyFetch'
import type { DraftOut, RpcEventName, RpcEvents, SessionUser } from '../shared/rpc'
import type { Queries } from './db/queries'
import type { Scheduler } from './scheduler'
import type { OpQueue } from './opQueue'
import type { SieveManager } from './sieve/manager'
import { getVaultStatus, lockVault } from './vault/manager'
import { onVaultLock } from './vault/state'
import { mergeAccount, mergeRule } from './configMerge'
import { actionsToPortable, decodeSyncBlob, encodeSyncBlob, pullBlobFromImap, pushBlobToImap, SYNC_VERSION, type SyncConfig } from './deviceSync'
import { safeFetch } from './net/safeFetch'
import { t } from '../shared/i18n'
import type { Handler } from './rpc/common'
import type { RpcPort } from './rpc/transport'
import type { HostNotification } from './host'
import type { OAuthClient, OAuthProviderId, TokenSet } from './oauth'
import { NotifyBacklog } from './notifyBacklog'
import type { ServerNotify } from '../shared/pushTypes'
import type { PimConnectStatus } from '../shared/pim'
import { pimNetPolicy } from './pim/davClient'
import { sessionUserFromRow } from './auth/sessionUser'
import type { PimDeps } from './pim/backend'
import type { DiscoverInput } from './pim/discovery'
import { PimScheduler } from './pim/pimScheduler'
import { emitPimChanged } from './rpc/pimAuth'
import type { NetPolicy } from './net/safeFetch'
import { RpcSession } from './rpcSession'

import { accountsHandlers } from './rpc/accounts'
import { authHandlers } from './rpc/auth'
import { automationHandlers } from './rpc/automation'
import { composeHandlers } from './rpc/compose'
import { mailHandlers } from './rpc/mail'
import { notifyRulesHandlers } from './rpc/notifyRules'
import { calendarHandlers } from './rpc/calendar'
import { contactsHandlers } from './rpc/contacts'
import { invitesHandlers } from './rpc/invites'
import { oauthHandlers } from './rpc/oauth'
import { pimSourcesHandlers } from './rpc/pimSources'
import { serverAdminHandlers } from './rpc/serverAdmin'
import { sieveHandlers } from './rpc/sieve'
import { smimeHandlers } from './rpc/smime'
import { systemHandlers } from './rpc/system'
import { importHandlers, type ImportRun } from './rpc/import'
import { twoFactorHandlers } from './rpc/twoFactor'
import { DecryptedCache } from './smime/decryptCache'
import { SignedVerdicts } from './smime/receive'
import type { CrlCache } from './smime/revocation'
import type { TrustStore } from './smime/trust'

/** Yöntem adı → handler (R24: 1600 satırlık switch alan dosyalarına bölündü) */
const HANDLERS: Record<string, Handler> = {
  ...authHandlers, ...automationHandlers, ...mailHandlers, ...composeHandlers, ...accountsHandlers, ...systemHandlers, ...serverAdminHandlers, ...oauthHandlers,
  ...twoFactorHandlers, ...notifyRulesHandlers, ...importHandlers, ...sieveHandlers, ...pimSourcesHandlers, ...contactsHandlers, ...calendarHandlers, ...invitesHandlers, ...smimeHandlers
}


export interface RpcServerDeps {
  q: Queries
  scheduler: Scheduler
  opq: OpQueue
  creds: Map<number, string>
  attachDir: string
  encrypt(values: string[]): Promise<Uint8Array[]>
  decrypt(blobs: Uint8Array[]): Promise<string[]>
  userData: string
  dbSchemaVersion(): number
  /** Motor kurar. Testlerdeki hub'larda yoktur: kural ve hesap işleri Sieve'siz de çalışır */
  sieve?: SieveManager
  /** Kişi ve takvim isteklerinin ağ politikası; verilmezse iç ağ istisnası yok (sunucu), kullanıcı adresi serbest (masaüstü) */
  pimNet?(o: { ics: boolean }): NetPolicy
  /** yalnız testler: derlenmiş alım kapısı worker'ı */
  pimGateWorker?: string
  /** yalnız testler: Graph kökü */
  pimGraphBase?: string
  /** S/MIME güven deposu ve CRL önbelleği; motor kurar */
  smimeTrust?: TrustStore
  smimeCrl?: CrlCache
}

/** Sunucu modunda HTTP ile yüklenmiş geçici ek (POST /api/upload) */
export interface UploadedFile {
  path: string
  size: number
  /** X-Filename'den, ayıklanmış görünen ad */
  filename: string
}

/** Yüklenen eklerin kaydı (sunucu kurar; masaüstünde yok): yalnız yükleyen web oturumu kullanabilir */
export interface UploadRegistry {
  /** Oturumun süresi dolmamış yüklemesi; başkasınınki, süresi dolan ya da bilinmeyen için null */
  get(id: string, owner: string): UploadedFile | null
  /** Kullanıldı: kayıttan düşer (dosya artık çağıranın) */
  consume(id: string): void
}

export interface OAuthFlowResult {
  email: string
  added: boolean
  pimStatus?: PimConnectStatus
}

/** Web OAuth akışları (sunucu kurar; masaüstünde yok): akış onu başlatan web oturumuna (çerez oturumu)
 *  bağlıdır; dönüş sunucunun /oauth/callback adresine gelir, sonuç o oturuma 'oauth:done' olayıyla gider. */
export interface WebOAuthFlows {
  start(o: {
    owner: string
    provider: OAuthProviderId
    client: OAuthClient
    loginHint?: string
    /** Posta kapsamlarından sonra istenenler (kişi ve takvim) */
    extraScopes?: string[]
    /** Belirteçler alındıktan sonra hesabı ekler/günceller (masaüstündeki oauthFinish ile aynı iş) */
    finish(tok: TokenSet & { email: string }): Promise<OAuthFlowResult>
  }): { flowId: string; url: string }
  /** Yalnız sahibinin akışı; başkasınınki ya da bilinmeyen sessizce yok sayılır */
  cancel(owner: string, flowId: string): void
  wait(owner: string, flowId: string): Promise<OAuthFlowResult>
}

/** Bağlantı açılışında oturumun hazır bilgisi (sunucu modunda web girişi önceden doğrulamıştır) */
export interface SessionInit {
  user?: SessionUser
  webSessionId?: string
  ip?: string
  /** Mobil biletli soket: taşınabilir belirteçle açıldı, yeniden doğrulama olmadan hassas yöntemlere giremez */
  ticket?: boolean
}

const PUBLIC_METHODS = new Set(['login', 'logout', 'bootstrapAdmin', 'getLoginBiometric', 'loginBiometric'])
const ADMIN_ONLY_METHODS = new Set([
  'discoverMailServers', 'importPreview', 'importAccounts', 'oauthGetClients', 'oauthSetClients', 'oauthStart', 'oauthCancel',
  'oauthFinish', 'setPrefs', 'syncPush', 'syncPull', 'setSyncAuto',
  'getUsers', 'createUser', 'updateUser', 'deleteUser', 'resetUserPassword', 'resetUserTwoFactor',
  'getGroups', 'createGroup', 'updateGroup', 'deleteGroup', 'setAccountGroup', 'setGroupPermission',
  'getRules', 'createRule', 'updateRule', 'deleteRule', 'testRule',
  'getWebhooks', 'createWebhook', 'updateWebhook', 'deleteWebhook', 'testWebhook',
  'getScheduledTriggers', 'createScheduledTrigger', 'updateScheduledTrigger', 'deleteScheduledTrigger',
  'getRuleLog', 'getRulePlacements', 'sieveSetEndpoint',
  // kasa kurulumu ve biyometrik anahtarları: cihaz genelini etkiler (açma/kilitleme herkese açık)
  'createVault', 'enableVaultBiometric', 'disableVaultBiometric', 'clearVaultPassphraseFails', 'exportDiagnostics', 'updateAccountsServer',
  'backupToFile', 'stageRestore',
  'serverAdminGetConfig', 'serverAdminSetConfig', 'serverAdminClearKey', 'serverAdminTest', 'serverAdminBlocked',
  'serverAdminUnblock', 'serverAdminAllowed', 'serverAdminAllow', 'serverAdminRemoveAllowed', 'serverAdminAccountDiff',
  'importBegin', 'importItem', 'importFinish',
  // güven kökleri kurulum geneli: aynı ileti her kullanıcıda aynı rozeti alır
  'smimeAddAnchor', 'smimeRemoveAnchor'
])
// Biletli mobil sokette yalnız bunlar açık: gündelik posta işi ve kişinin kendi görünüm ve bildirim tercihleri. Liste izin listesidir:
// yeni yöntem burada değilse kapalıdır. 15 dakikalık belirteç belirtecin ömrünü aşan iz bırakamaz: Sieve yazımı ve tatil yanıtı,
// otomasyon kuralı ve webhook (yönlendirme kalıcı sızıntıdır), hesabın durumu, sunucusu ve kasa koruması, kişi ve takvim kaynağı,
// OAuth, cihaz senkronu, parola, 2FA, S/MIME özel anahtarı ve kişi sertifikası tarayıcıda yapılır. updateAccount içinde bağlantı alanları ayrıca reddedilir.
// Sınıflandırma rbacMatrix.test.ts'te yöntem yöntem yazılıdır: sınıfsız yöntem testi düşürür.
const TICKET_ALLOWED_METHODS = new Set([
  // hesap: görünüm ve bağlantı durumu
  'getAccounts', 'getAccountServer', 'getAccountStatusHistory', 'getConnectionStats', 'retryAccount', 'retryAccounts',
  'setAccountStarred', 'setMySignature', 'updateAccount',
  // posta
  'getIncidents', 'listSmart', 'getAttachments', 'getContacts', 'getHourlyVolume', 'listMessages', 'listThreads', 'getThread', 'getThreadMembers',
  'getBody', 'getSmimeAttachment', 'getAttachment', 'getAttachmentData', 'getRawHeaders', 'getRawSource', 'listSubscriptions', 'unsubscribeSenders',
  'unsubscribe', 'search', 'fetchRemoteImages', 'markSeen', 'markFlagged', 'snoozeMessages', 'deleteMessages', 'undoDelete', 'markAllSeen',
  'getFoldersOf', 'syncFolder', 'moveMessages', 'undoMove', 'moveSpecial', 'setViewed', 'pollNow',
  // gönderim, taslak, takip, şablon
  'sendMail', 'listFollowups', 'closeFollowup', 'snoozeFollowup', 'listTemplates', 'saveTemplate', 'deleteTemplate', 'listOutbox', 'cancelOp',
  'retryOp', 'getOpDraft',
  // kişi, takvim, davet
  'listContacts', 'getContact', 'saveContact', 'deleteContact', 'importContacts', 'exportContacts', 'promoteCollected', 'mergeContacts',
  'listEvents', 'getEvent', 'saveEvent', 'deleteEvent', 'getInvite', 'respondInvite', 'applyInviteUpdate', 'applyInviteCancel',
  'listPimSources', 'listPimCollections', 'setPimCollectionPref', 'syncPimSource',
  // kişinin bildirim tercihleri: kuralların yönlendirme eylemi yok, yalnız bildirimi süzerler
  'listNotifyRules', 'saveNotifyRule', 'deleteNotifyRule', 'reorderNotifyRules', 'getNotifyAccountPrefs', 'setNotifyAccountPref', 'setMyPrefs',
  // salt okunur süzgeç ekranı (yoklama durumu dışında yazmaz)
  'listSieveAccounts', 'getSieveAccount', 'sieveDetect', 'sieveListScripts', 'sieveGetScript', 'sieveCheckScript', 'getSieveVacation',
  // S/MIME: yalnız okuma. Kayıtlı kişi sertifikası ileride şifreli postayı kimin okuyacağını belirler, değiştirilmesi tarayıcıda
  'smimeListIdentities', 'smimeListContactCerts', 'smimeCheckRecipients', 'smimeTrustInfo',
  // oturum
  'getPrefs', 'setSessionLocale', 'getSecurityNotice', 'getVaultState', 'unlockVault', 'lockVault'
])

// Sunucu modunda kapalı: giriş web katmanında (çerezli oturum), Touch ID ve safeStorage blob'ları
// yalnız Electron'da anlamlı (renderer'daki biyometrik doğrulamaya güvenir). Yedek/geri yükleme sunucunun
// dosya sistemindeki yola yazar/okur (tarayıcının dosyası değil). OAuth yöntemleri sunucu modunda açık ama
// yalnız web akışıyla (hub.webOAuth; 127.0.0.1 geri döngüsü sunucuda hiç açılmaz).
const DESKTOP_ONLY_METHODS = new Set([
  'login', 'logout', 'bootstrapAdmin', 'getLoginBiometric', 'loginBiometric', 'enableLoginBiometric', 'disableLoginBiometric',
  'enableVaultBiometric', 'disableVaultBiometric', 'unlockVaultBiometric',
  'backupToFile', 'stageRestore'
])

// Masaüstü ajanının sunucudaki yüzü: yerel kurulumda karşılığı yok, bilinmeyen yöntem gibi reddedilir
const SERVER_ONLY_METHODS = new Set(['registerDesktopAgent', 'notifyAction', 'notifyBacklog', 'importBegin', 'importItem', 'importFinish', 'listSessions', 'revokeSession', 'revokeOtherSessions'])

// Masaüstünde girişsiz oturum (giriş ekranı) yalnız hesaptan bağımsız olayları alır: ağ, kasa, host sağlığı.
// Posta/hesap içeriği taşıyan olaylar (sayaçlar, durum, kural, bildirim…) girişten önce sızmasın.
const ANON_DESKTOP_EVENTS = new Set<RpcEventName>(['network:state', 'vault:state', 'host:health'])

/** Motorun paylaşılan RPC merkezi: bağlantı başına RpcSession; yayın, kasa ve senkron çekirdeği burada */
export class RpcHub {
  bodyInflight = new Map<number, 'fetching' | string>() // messageId → durum ya da hata
  /** Çözülmüş S/MIME içeriği: yalnız RAM, kullanıcı + ileti */
  readonly smimeCache = new DecryptedCache()
  smimeInflight = new Map<string, 'fetching' | string>() // "userId:messageId" → durum ya da hata
  readonly smimeVerdicts = new SignedVerdicts()
  /** Şifreli gönderim özet anahtarının yüklemesi (rpc/compose.ts); süreç başına bir kez */
  sendHashKeyLoad?: Promise<Buffer>
  // giriş kilidi hub genelinde: yeni bağlantı (pencere yenileme) 5 hatalık beklemeyi sıfırlamasın
  loginFailures = 0
  loginLockedUntil = 0
  // 2FA onay/kapatma kodu denemeleri kullanıcı başına (ele geçirilmiş oturum kodu kaba kuvvetle bulamasın)
  totpFailures = new Map<number, number[]>()
  /** Saat (testler sahte saat verir) */
  now: () => number = Date.now
  /** motor kurar: kullanıcıya bildirim hattından güvenlik uyarısı */
  securityAlert?: (userId: number, title: string, body: string) => void
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly live = new Set<RpcSession>()
  /** Kullanıcı devre dışı bırakılınca/silinince, rolü/parolası değişince ya da 2FA'sı kaldırılınca auth
   *  handler'larından çağrılır; sunucu WebAuth.revokeUser + açık soketleri kapatmaya bağlar */
  onUserRevoked?: (userId: number, keepWebSessionId?: string) => void
  /** Sunucu kurar: verilen oturumlar biter, soketleri kapanır, push satırları ve röle kayıtları gider */
  endWebSessions?: (ids: string[]) => void
  /** Sunucu modunda HTTP yüklemeleri (sendMail'de { uploadId } eki); masaüstünde null */
  uploads: UploadRegistry | null = null
  private pimRunner: PimScheduler | null = null
  /** yalnız testler: hesap keşfinin sahte DNS'i ve şeması */
  pimDiscoverOptions: Pick<DiscoverInput, 'resolveSrv' | 'scheme'> = {}

  /** Sunucu modunda web OAuth akışları; masaüstünde null (geri döngü akışı) */
  webOAuth: WebOAuthFlows | null = null
  /** Kullanıcı başına son bildirimler: masaüstü ajanı kopuştan sonra kaçırdığını buradan alır */
  readonly notifyBacklog = new NotifyBacklog(() => this.now())
  /** Süren taşımalar: anahtar yalnız bellekte, başlatan oturuma bağlı */
  readonly imports = new Map<string, ImportRun>()

  /** Testler için: kayıtlı tüm RPC yöntem adları */
  static methodNames(): string[] {
    return Object.keys(HANDLERS)
  }

  /** Testler için: yetki kümelerindeki her ad gerçekten bir RPC yöntemi mi (yazım hatası = sessizce açık yöntem) */
  static permissionSets(): { publicMethods: string[]; adminOnly: string[]; desktopOnly: string[]; serverOnly: string[]; ticketAllowed: string[] } {
    return { publicMethods: [...PUBLIC_METHODS], adminOnly: [...ADMIN_ONLY_METHODS], desktopOnly: [...DESKTOP_ONLY_METHODS], serverOnly: [...SERVER_ONLY_METHODS], ticketAllowed: [...TICKET_ALLOWED_METHODS] }
  }

  /** Biletli sokette kapalı mı: çalınan 15 dakikalık belirteç yetki yükseltemez, kalıcı iz bırakamaz */
  static ticketRefused(method: string): boolean {
    return !TICKET_ALLOWED_METHODS.has(method)
  }

  constructor(
    readonly deps: RpcServerDeps,
    readonly mode: 'desktop' | 'server'
  ) {
    onVaultLock(() => this.smimeCache.clear())
  }

  /** Oturumları düşürülen kullanıcı: çözülmüş içeriği de gider */
  revokeUser(userId: number, keepWebSessionId?: string): void {
    this.smimeCache.clearUser(userId)
    if (keepWebSessionId === undefined) this.onUserRevoked?.(userId)
    else this.onUserRevoked?.(userId, keepWebSessionId)
  }

  openSession(port: RpcPort, init: SessionInit = {}): RpcSession {
    if (this.mode === 'desktop') {
      // her yeni kanal kimliksiz başlar — sync süreci canlı kalırken pencere yeniden yüklenirse
      // (Cmd+R) eski oturumun miras alınmasını engelleyen gerçek bir kapatma. Kasa da kilitlenir:
      // taze kanal = taze oturum duruşuyla tutarlı, yeniden-login sonrası kasa da yeniden açılmalı.
      this.lockVaultNow()
      this.closeSessionsWhere(() => true)
    }
    // sunucu modunda oturumlar yan yana yaşar: yeni cihaz başkasının açık kasasını kilitlemez
    const s = new RpcSession(this, port, this.mode === 'desktop' ? {} : init, () => {
      this.live.delete(s)
      // özel anahtar oturumdan uzun yaşamaz
      for (const [id, run] of this.imports) if (run.session === s) this.imports.delete(id)
    })
    this.live.add(s)
    s.send({
      event: 'sync:hello',
      data: {
        accountCount: this.deps.q.getAccountRows().length,
        usersCount: this.deps.q.userCount(),
        // web istemcisi yeniden bağlanınca giriş ekranına düşmesin: oturum çerezle doğrulanmıştır
        user: this.mode === 'server' ? s.currentUser : null
      } satisfies RpcEvents['sync:hello']
    })
    return s
  }

  sessions(): RpcSession[] {
    return [...this.live]
  }

  /** Koşulu sağlayan oturumların portunu kapatır (çıkış, kullanıcı iptali); kapatılan sayısı */
  closeSessionsWhere(pred: (s: RpcSession) => boolean): number {
    let n = 0
    for (const s of this.live) { // Set yinelemesinde geçerli öğeyi silmek güvenli
      if (!pred(s)) continue
      s.close()
      n++
    }
    return n
  }

  /** Yetki kapısı + yöntem çağrısı; RpcSession.handle buradan geçer */
  async invoke(s: RpcSession, method: string, params: unknown): Promise<unknown> {
    if (this.mode === 'server' && DESKTOP_ONLY_METHODS.has(method)) throw new Error(t('sync.server.desktopOnly'))
    if (!PUBLIC_METHODS.has(method) && !s.currentUser) throw new Error(t('sync.perm.loginRequired'))
    if (this.mode === 'desktop' && SERVER_ONLY_METHODS.has(method)) throw new Error(t('sync.err.unknownMethod', { method }))
    if (s.ticket && RpcHub.ticketRefused(method)) throw new Error(t('sync.perm.browserRequired'))
    if (ADMIN_ONLY_METHODS.has(method) && s.currentUser!.role !== 'admin') throw new Error(t('sync.perm.adminRequired'))
    const h = HANDLERS[method]
    if (!h) throw new Error(t('sync.err.unknownMethod', { method }))
    return h(s, params)
  }

  // Sunucu modunda yalnız girişli oturumlara (masaüstünde giriş ekranı yalnız ANON_DESKTOP_EVENTS'i alır).
  // Hesaba bağlı olay (sayısal accountId) girişli oturumlarda yalnız o hesabı görebilenlere.
  pimDeps(): PimDeps {
    const { q, creds, decrypt, scheduler, pimNet, pimGateWorker, pimGraphBase } = this.deps
    return {
      q, creds, decrypt,
      net: pimNet ?? ((o) => pimNetPolicy(this.mode, null, o)),
      offline: () => scheduler.net?.state === 'offline',
      emit: (src, kind) => emitPimChanged(this, src, kind),
      now: () => this.now(),
      gateWorker: pimGateWorker,
      graphBase: pimGraphBase
    }
  }

  get pim(): PimScheduler {
    return (this.pimRunner ??= new PimScheduler(this.pimDeps()))
  }

  broadcast<E extends RpcEventName>(event: E, data: RpcEvents[E]): void {
    const accountId = (data as { accountId?: unknown }).accountId
    for (const s of this.live) {
      if (!s.currentUser) {
        if (this.mode === 'server' || !ANON_DESKTOP_EVENTS.has(event)) continue
      } else if (typeof accountId === 'number' && !s.canViewAccount(accountId)) continue
      s.send({ event, data })
    }
  }

  /** Hata hesabı görebilen herkese gider; taslak ve `own` yalnız gönderene. Görüntüleme yetkili üye taslağı görmez */
  broadcastOpFailed(data: Omit<RpcEvents['op:failed'], 'draft' | 'own'>, senderId?: number, draft?: DraftOut): void {
    for (const s of this.live) {
      if (!s.currentUser || !s.canViewAccount(data.accountId)) continue
      s.send({ event: 'op:failed', data: s.currentUser.id === senderId ? { ...data, own: true, ...(draft ? { draft } : {}) } : data })
    }
  }

  /** Yalnız verilen web oturumunun (çerez oturumu) açık bağlantılarına; aynı kullanıcının diğer oturumlarına değil */
  sendToWebSession<E extends RpcEventName>(webSessionId: string, event: E, data: RpcEvents[E]): void {
    for (const s of this.live) if (s.webSessionId === webSessionId && s.currentUser) s.send({ event, data })
  }

  /** Yetki değişti: açık oturumların grup listesi yenilenir, olay süzgeci ve hesap denetimleri bayat kalmaz */
  refreshUserSessions(userId?: number): void {
    for (const s of this.live) {
      const id = s.currentUser?.id
      if (id === undefined || (userId !== undefined && id !== userId)) continue
      const row = this.deps.q.getUserById(id)
      if (row) s.currentUser = sessionUserFromRow(this.deps.q, row)
    }
  }

  /** Yalnız verilen kullanıcının açık oturumlarına (kişisel kaynak olayları: başkası, yönetici dahil, almaz) */
  sendToUser<E extends RpcEventName>(userId: number, event: E, data: RpcEvents[E]): void {
    for (const s of this.live) if (s.currentUser?.id === userId) s.send({ event, data })
  }

  /** Kişiye göre bildirim (§10.1): `server:notify` yalnız girişli, hesabı görebilen ve `decide`'ın
   *  (o kullanıcının tercihleri) onayladığı oturumlara. Karar kullanıcı başına bir kez sorulur. */
  notifySessions(n: HostNotification, decide: (user: SessionUser) => boolean): void {
    const accountId = n.accountId ?? null
    const verdict = new Map<number, boolean>()
    const items = new Map<number, ServerNotify>()
    for (const s of this.live) {
      const u = s.currentUser
      if (!u) continue
      if (accountId != null && !s.canViewAccount(accountId)) continue
      let ok = verdict.get(u.id)
      if (ok === undefined) {
        ok = decide(u)
        verdict.set(u.id, ok)
      }
      if (ok) {
        // kullanıcının her oturumu aynı sıra numarasını görür
        const data = items.get(u.id) ?? this.notifyBacklog.push(u.id, {
          title: n.title, body: n.body, accountId, messageId: n.messageId ?? null, level: 'normal', count: 1,
          tag: `host:${accountId ?? ''}:${n.title}`, actions: []
        }, this.vaultAccount(accountId))
        items.set(u.id, data)
        s.send({ event: 'server:notify', data })
      }
    }
  }

  private vaultAccount(accountId: number | null): boolean {
    return accountId != null && this.deps.q.isAccountSecure(accountId)
  }

  /** Bildirim hattının teslimi: tek kullanıcının açık oturumlarına (hesabı görme yetkisi yine denetlenir) */
  notifyUser(userId: number, raw: Omit<ServerNotify, 'seq'>): void {
    const item = this.notifyBacklog.push(userId, raw, this.vaultAccount(raw.accountId)) // oturum yoksa da: ajan sonradan ister
    for (const s of this.live) {
      if (s.currentUser?.id !== userId) continue
      if (item.accountId != null && !s.canViewAccount(item.accountId)) continue
      s.send({ event: 'server:notify', data: item })
    }
  }

  // gürültülü olaylar için kuyruklu debounce: 300ms sessizlikten sonra tek olay. Anahtar olay + hesap:
  // farklı hesapların olayı birbirini ezmesin (yayın süzgecinde A'yı gören üye B'nin olayıyla kalmasın)
  broadcastDebounced<E extends RpcEventName>(event: E, data: RpcEvents[E], ms = 300): void {
    const accountId = (data as { accountId?: unknown }).accountId
    const key = typeof accountId === 'number' ? `${event}:${accountId}` : event
    const prev = this.debounceTimers.get(key)
    if (prev) clearTimeout(prev)
    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key)
        this.broadcast(event, data)
      }, ms)
    )
  }

  /** RFC 8058 tek-tık POST'u: her zaman sync sürecinden; URL renderer'a asla gitmez. URL mailin
   *  göndereninden gelir: yalnız genel internet (safeFetch, iç ağa SSRF yok). */
  async oneClickUnsubscribe(messageId: number): Promise<{ ok: boolean; error?: string }> {
    const url = this.deps.q.getUnsubscribeUrl(messageId)
    if (!url) return { ok: false, error: t('sync.unsub.notSupported') }
    try {
      const res = await safeFetch(url, {
        method: 'POST',
        timeoutMs: 15_000,
        maxBytes: 256_000,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click'
      })
      return res.ok ? { ok: true } : { ok: false, error: t('sync.err.httpStatus', { status: String(res.status) }) }
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e) }
    }
  }

  // Senkron push/pull çekirdeği — hem RPC hem otomatik senkron kullanır.
  async doSyncPush(anchorAccountId: number, passphrase: string): Promise<{ pushed: number; skipped: number }> {
    const q = this.deps.q
    const exp = q.getSyncExport()
    const accounts: SyncConfig['accounts'] = []
    let skipped = 0
    for (const a of exp.accounts) {
      const pw = this.deps.creds.get(a.id) // kasa+kilitli veya cred yoksa atla
      if (!pw) {
        skipped++
        continue
      }
      accounts.push({
        email: a.email, displayName: a.displayName, imapHost: a.imapHost, imapPort: a.imapPort, imapTls: a.imapTls,
        smtpHost: a.smtpHost, smtpPort: a.smtpPort, smtpTls: a.smtpTls, color: a.color, signature: a.signature,
        allowInvalidCerts: !!a.allowInvalidCerts, groupName: a.groupName, password: pw,
        passwordChangedAt: a.passwordChangedAt || undefined,
        authType: a.authType !== 'password' ? a.authType : undefined
      })
    }
    const webhooks = q.allWebhooks()
    const idToName = new Map(webhooks.map((w) => [w.id, w.name]))
    const config: SyncConfig = {
      version: SYNC_VERSION, exportedAt: Date.now(), accounts, groups: exp.groups,
      rules: exp.rules.map((r) => ({
        name: r.name, enabled: !!r.enabled, accountEmail: r.accountEmail, groupName: r.groupName,
        conditions: JSON.parse(r.conditions_json), actions: actionsToPortable(JSON.parse(r.actions_json), idToName),
        runOnServer: r.run_on_server !== 0
      })),
      webhooks: webhooks.map((w) => ({ name: w.name, url: w.url, secret: w.secret, enabled: !!w.enabled })),
      deletedRules: q.deletedRuleTombstones(),
      templates: q.templatesForSync()
    }
    const blob = encodeSyncBlob(config, passphrase)
    await this.deps.scheduler.enqueueInteractive(anchorAccountId, (client) => pushBlobToImap(client, blob))
    q.prefSet('sync_anchor_account', String(anchorAccountId))
    q.prefSet('sync_last_push', String(Date.now()))
    return { pushed: accounts.length, skipped }
  }

  async doSyncPull(anchorAccountId: number, passphrase: string): Promise<{ imported: number; updated: number; skippedSecure: number; passwordKept: number }> {
    const q = this.deps.q
    const blob = await this.deps.scheduler.enqueueInteractive(anchorAccountId, (client) => pullBlobFromImap(client))
    if (!blob) throw new Error(t('sync.deviceSync.noBlob'))
    const config = decodeSyncBlob(blob, passphrase) // yanlış parola → hata
    let imported = 0
    let updated = 0
    let skippedSecure = 0
    let passwordKept = 0
    for (const g of config.groups) q.ensureGroupByName(g.name, g.color)
    for (const sa of config.accounts) {
      const r = await mergeAccount(this.deps, sa)
      if (r.skippedSecure) {
        skippedSecure++
        continue
      }
      if (!r.isNew && !r.passwordTaken) passwordKept++
      if (r.isNew) imported++
      else updated++
    }
    // webhook'lar adıyla; kural eylemleri yerel id'ye çevrilir (id cihazlar arası farklı — R36)
    for (const w of config.webhooks ?? []) q.upsertWebhookByName(w)
    const nameToId = new Map(q.allWebhooks().map((w) => [w.name, w.id]))
    // mezar taşları: uzakta silinen kural burada da silinir; burada silinmiş olan uzaktan geri gelmez
    for (const t of config.deletedRules ?? []) q.deleteRuleByName(t.name)
    const deletedHere = new Set(q.deletedRuleTombstones().map((t) => t.name))
    for (const r of config.rules) {
      if (!deletedHere.has(r.name)) mergeRule(q, r, nameToId)
    }
    if (config.templates) q.mergeSyncTemplates(config.templates)
    q.prefSet('sync_last_pull', String(Date.now()))
    this.deps.scheduler.reloadAccounts()
    this.deps.scheduler.pollAllSoon()
    this.deps.sieve?.scheduleAll()
    this.broadcast('messages:changed', { accountId: null })
    this.broadcast('counts:changed', {})
    return { imported, updated, skippedSecure, passwordKept }
  }

  // Otomatik senkron: saklı (safeStorage) parolayı çözüp sessizce push/pull. Timer + boot'tan çağrılır.
  async autoSyncCreds(): Promise<{ anchorAccountId: number; passphrase: string } | null> {
    const q = this.deps.q
    if (q.prefGet('sync_auto') !== '1') return null
    const anchor = Number(q.prefGet('sync_anchor_account') ?? 0)
    const blobB64 = q.prefGet('sync_passphrase_blob')
    if (!anchor || !blobB64) return null
    const [passphrase] = await this.deps.decrypt([new Uint8Array(Buffer.from(blobB64, 'base64'))])
    if (!passphrase) return null
    return { anchorAccountId: anchor, passphrase }
  }

  async autoSyncPush(): Promise<void> {
    try {
      const c = await this.autoSyncCreds()
      if (c) await this.doSyncPush(c.anchorAccountId, c.passphrase)
    } catch (e) {
      console.error('otomatik senkron push başarısız', (e as Error).message)
    }
  }

  async autoSyncBootPull(): Promise<void> {
    try {
      const c = await this.autoSyncCreds()
      if (c) await this.doSyncPull(c.anchorAccountId, c.passphrase)
    } catch (e) {
      console.error('otomatik senkron boot-pull başarısız', (e as Error).message)
    }
  }

  // Kasayı kilitle + kasa hesaplarının düz ek kopyalarını sil (kilitli cihazda düz ek kalmasın); mühürlü önbellek kalır.
  lockVaultNow(): void {
    lockVault(this.deps.q, this.deps.creds)
    // kilitliyken arka planda yenilenmez: açık (doğrulanmış) oturumları da kapat
    for (const id of this.deps.q.getSecureAccountIds()) this.deps.scheduler.dropSession(id)
    for (const p of this.deps.q.takeSecureAttachmentPaths()) {
      try {
        if (p.startsWith(this.deps.attachDir)) unlinkSync(p)
      } catch {
        /* dosya zaten yoksa/erişilemezse geç */
      }
    }
    clearVaultOpen(this.deps.attachDir)
  }

  // dış sinyalle (uyku / ekran kilidi) kasayı kilitle — açıksa ve ayar kapalı değilse.
  // Cihaz gözetimsiz kalınca kritik hesap içeriği tekrar şifreli/erişilemez olur.
  lockFromSignal(): void {
    if (getVaultStatus(this.deps.q) !== 'unlocked') return
    if (this.deps.q.prefGet('vault_autolock') === '0') return // kullanıcı kapatmışsa dokunma
    this.lockVaultNow()
    this.broadcast('vault:state', { state: getVaultStatus(this.deps.q) })
  }
}
