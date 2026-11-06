import type Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { t } from '../../shared/i18n'
import type { SessionUser } from '../../shared/rpc'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import type { OpQueue } from '../opQueue'
import { RpcHub } from '../rpcHub'
import type { Scheduler } from '../scheduler'

// R23 RBAC matrisi: (girişsiz · üye · yönetici) × yöntem. Yetki kontrolü handle()'ın başında ve hesap
// düzeyinde (assertCanView/Manage, resolveAccountIds); bir yöntem eklenip kontrol unutulursa burada düşer.
type Handle = { handle(method: string, params: unknown): Promise<unknown>; currentUser: SessionUser | null }

const ALL_METHODS = RpcHub.methodNames()
const { publicMethods, adminOnly } = RpcHub.permissionSets()

describe('RBAC matrisi', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let srv: Handle
  let accA: number
  let accB: number
  let msgA: number
  let msgB: number
  let groupA: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-rbac-'))
    db = openDb(dir)
    q = makeQueries(db)
    const mk = (email: string) =>
      q.insertAccount({ email, displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    accA = mk('a@t.co')
    accB = mk('b@t.co')
    const gA = q.insertGroup('Görünen', '#111111')
    groupA = gA
    const gB = q.insertGroup('Gizli', '#222222')
    q.setAccountGroup(accA, gA)
    q.setAccountGroup(accB, gB)
    const add = (acc: number) => {
      const f = q.upsertFolder(acc, 'INBOX', 'inbox')
      return Number(
        db.prepare(`INSERT INTO messages (folder_id, account_id, folder_kind, uid, date, subject, flagged, thread_root) VALUES (?,?,?,?,?,?,1,?)`)
          .run(f, acc, 'inbox', 1, 1000, 'gizli konu', `<r${acc}>`).lastInsertRowid
      )
    }
    msgA = add(accA)
    msgB = add(accB)
    q.ftsUpsert(msgA, 'gizli konu', 'x', '', null)
    q.ftsUpsert(msgB, 'gizli konu', 'x', '', null)
    const stub = new Proxy({}, { get: () => () => undefined })
    const fakePort = { send() {}, onMessage() {}, onClose() {}, close() {} }
    srv = new RpcHub({
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: async (v) => v.map((s) => new TextEncoder().encode(s)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)),
      userData: dir, dbSchemaVersion: () => 0
    }, 'desktop').openSession(fakePort) as unknown as Handle
    srv.currentUser = null
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const member = (): SessionUser => ({ id: 2, username: 'uye', role: 'member', permittedGroupIds: [groupA], manageableGroupIds: [groupA] })

  it('yöntem listesi handler haritasından okundu', () => {
    expect(ALL_METHODS.length).toBeGreaterThan(80)
  })

  it('girişsiz: herkese açık olanlar dışında her yöntem reddedilir', async () => {
    for (const m of ALL_METHODS.filter((m) => !publicMethods.includes(m))) {
      await expect(srv.handle(m, {}), m).rejects.toThrow('Giriş yapmanız gerekiyor')
    }
  })

  it('üye: yönetici yöntemlerinin hepsi reddedilir', async () => {
    srv.currentUser = member()
    // yalnız sunucu yöntemleri masaüstünde önce bilinmeyen yöntem olur; sunucu tarafı importRpc'de
    const { serverOnly } = RpcHub.permissionSets()
    for (const m of adminOnly.filter((x) => !serverOnly.includes(x))) await expect(srv.handle(m, {}), m).rejects.toThrow('yönetici yetkisi')
  })

  it('üye: yalnız izinli grubun hesaplarını görür', async () => {
    srv.currentUser = member()
    const ids = (rows: unknown) => (rows as { id: number }[]).map((r) => r.id)
    expect(ids(await srv.handle('getAccounts', {}))).toEqual([accA])
    const list = { accountIds: null, folderKind: 'inbox', cursor: null, limit: 50, unreadOnly: false }
    expect(ids(await srv.handle('listMessages', list))).toEqual([msgA])
    expect(ids(await srv.handle('listMessages', { ...list, accountIds: [accB] }))).toEqual([])
    expect(ids(await srv.handle('listThreads', list))).toEqual([msgA])
    expect(ids(await srv.handle('search', { query: 'gizli', accountIds: null }))).toEqual([msgA])
    expect(ids(await srv.handle('search', { query: 'gizli', accountIds: [accB] }))).toEqual([])
    expect(ids(await srv.handle('listSmart', { view: 'starred', accountIds: null }))).toEqual([msgA])
    expect(ids(await srv.handle('listSmart', { view: 'starred', accountIds: [accB] }))).toEqual([])
  })

  it('üye: klasör süzgeci geçersiz kimlikle atlanamaz', async () => {
    srv.currentUser = member()
    const list = { accountIds: null, folderKind: 'inbox', cursor: null, limit: 50, unreadOnly: false }
    for (const m of ['listMessages', 'listThreads']) {
      for (const folderId of [0, -1, 1.5, '1', true]) await expect(srv.handle(m, { ...list, folderId }), `${m} ${folderId}`).rejects.toThrow('folderId')
      expect(await srv.handle(m, { ...list, folderId: 999_999 }), m).toEqual([])
      const hidden = q.getFolders(accB)[0].id
      await expect(srv.handle(m, { ...list, folderId: hidden }), m).rejects.toThrow('yetkiniz yok')
      const mine = q.getFolders(accA)[0].id
      expect(((await srv.handle(m, { ...list, folderId: mine })) as { id: number }[]).map((r) => r.id), m).toEqual([msgA])
    }
  })

  it('sorgu katmanı folderId 0 için tüm posta kutusuna düşmez', () => {
    const base = { accountIds: null, folderKind: 'inbox', cursor: null, limit: 50, unreadOnly: false, folderId: 0 } as Parameters<typeof q.listMessages>[0]
    expect(q.listMessages(base)).toEqual([])
    expect(q.listThreads(base)).toEqual([])
  })

  it('görebildiği hesap olmayan üye boş saatlik seri alır', async () => {
    db.prepare('UPDATE messages SET date = ?').run(Date.now() - 3600_000)
    srv.currentUser = { ...member(), permittedGroupIds: [], manageableGroupIds: [] }
    const series = (await srv.handle('getHourlyVolume', {})) as number[] | { count: number }[]
    expect(series.length).toBeGreaterThan(0)
    expect(series.every((v) => (typeof v === 'number' ? v : v.count) === 0)).toBe(true)
    expect(q.getHourlyMessageCounts(0, [])).toEqual([])
    expect(q.getHourlyMessageCounts(0, null).length).toBeGreaterThan(0)
  })

  describe('üye oturumu: hesap bağlantı alanları', () => {
    const update = (patch: Record<string, unknown>) => srv.handle('updateAccount', { accountId: accA, patch })
    const admin = (): SessionUser => ({ id: 1, username: 'admin', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] })
    const connection = () => {
      const r = q.getAccountRow(accA)!
      return [r.imap_host, r.imap_port, r.imap_tls, r.smtp_host, r.smtp_port, r.smtp_tls, r.allow_invalid_certs]
    }

    it('yönetme izni olan üye bağlantı alanını değiştiremez', async () => {
      srv.currentUser = member()
      const before = connection()
      for (const patch of [
        { imapHost: 'kotu.example.com' }, { imapPort: 143 }, { imapTls: 'starttls' }, { smtpHost: 'kotu.example.com' },
        { smtpPort: 587 }, { smtpTls: 'starttls' }, { allowInvalidCerts: true }
      ]) await expect(update(patch), JSON.stringify(patch)).rejects.toThrow('yönetici yetkisi')
      expect(connection()).toEqual(before)
    })

    it('yeni parolayla birlikte sunucu değişimi de reddedilir, parola yazılmaz', async () => {
      srv.currentUser = member()
      const creds = (srv as unknown as { deps: { creds: Map<number, string> } }).deps.creds
      const enc = q.getAccountRow(accA)!.password_enc
      await expect(update({ imapHost: 'yeni.example.com', password: 'yeni' })).rejects.toThrow('yönetici yetkisi')
      expect(creds.has(accA)).toBe(false)
      expect(q.getAccountRow(accA)!.password_enc).toEqual(enc)
    })

    it('kurtarma: parola tek başına ve değişmeyen alanlar üyeye açık', async () => {
      srv.currentUser = member()
      const before = connection()
      await update({ imapHost: 'M.T.CO', imapPort: 993, password: 'yeni', displayName: 'Ops' })
      const row = q.getAccountRow(accA)!
      expect(row.display_name).toBe('Ops')
      expect(Buffer.from(row.password_enc!).toString()).toBe('yeni')
      expect(connection()).toEqual(before)
    })

    it('izinsiz hesapta üye yine yönetim hatası alır', async () => {
      srv.currentUser = member()
      await expect(srv.handle('updateAccount', { accountId: accB, patch: { imapHost: 'x.example.com' } })).rejects.toThrow('yönetim yetkiniz yok')
    })

    it('yönetici bağlantıyı değiştirir', async () => {
      srv.currentUser = admin()
      await update({ imapHost: 'yeni.example.com', allowInvalidCerts: true, password: 'p' })
      expect(q.getAccountRow(accA)).toMatchObject({ imap_host: 'yeni.example.com', allow_invalid_certs: 1 })
    })
  })

  it('üye: izinsiz hesabın mesajına/hesabına dokunamaz', async () => {
    srv.currentUser = member()
    await expect(srv.handle('getBody', { messageId: msgB })).rejects.toThrow('yetkiniz yok')
    await expect(srv.handle('markSeen', { messageIds: [msgB], seen: true })).rejects.toThrow('yetkiniz yok')
    await expect(srv.handle('deleteMessages', { messageIds: [msgB] })).rejects.toThrow('yetkiniz yok')
    await expect(srv.handle('sendMail', { draft: { accountId: accB, to: 'x@y.co', subject: '', text: '' } })).rejects.toThrow('yetkiniz yok')
    const fB = q.addFollowup({ accountId: accB, opId: null, messageId: '<z@t>', subject: null, to: null, dueAt: 0 })
    expect(await srv.handle('listFollowups', {})).toEqual([])
    await expect(srv.handle('snoozeFollowup', { id: fB, days: 1 })).rejects.toThrow('yetkiniz yok')
  })

  it('üye: görebildiği iletinin kimliğiyle başka hesabın eki okunamaz (IDOR)', async () => {
    mkdirSync(join(dir, 'att'), { recursive: true })
    const file = (n: string) => {
      const p = join(dir, 'att', n)
      writeFileSync(p, `icerik-${n}`)
      return p
    }
    const ek = (messageId: number, n: string) =>
      q.insertAttachment({ messageId, partId: '2', filename: n, mime: 'text/plain', size: 10, contentId: null, diskPath: file(n) })
    const attA = ek(msgA, 'a.txt')
    const attB = ek(msgB, 'b.txt')
    srv.currentUser = member()
    // kendi eki çalışır
    expect(await srv.handle('getAttachment', { messageId: msgA, attachmentId: attA })).toEqual({ diskPath: join(dir, 'att', 'a.txt') })
    expect(await srv.handle('getAttachmentData', { messageId: msgA, attachmentId: attA })).toMatchObject({ base64: Buffer.from('icerik-a.txt').toString('base64') })
    // görünen ileti + başka hesabın ek kimliği
    await expect(srv.handle('getAttachment', { messageId: msgA, attachmentId: attB })).rejects.toThrow('Ek bulunamadı')
    await expect(srv.handle('getAttachmentData', { messageId: msgA, attachmentId: attB })).rejects.toThrow('Ek bulunamadı')
    // ileti verilmeden: yetki ekin gerçek iletisinin hesabında
    await expect(srv.handle('getAttachmentData', { attachmentId: attB })).rejects.toThrow('yetkiniz yok')
    // önbellek zehirlenmez: B'nin ekinin yolu değişmedi
    expect(q.getAttachment(attB)?.disk_path).toBe(join(dir, 'att', 'b.txt'))
  })

  it('yönetici: tüm hesaplar', async () => {
    srv.currentUser = { id: 1, username: 'admin', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] }
    const ids = (rows: unknown) => (rows as { id: number }[]).map((r) => r.id).sort()
    expect(ids(await srv.handle('getAccounts', {}))).toEqual([accA, accB].sort())
    expect(ids(await srv.handle('listSmart', { view: 'starred', accountIds: null }))).toEqual([msgA, msgB].sort())
  })

  describe('biletli mobil oturum (T8)', () => {
    const admin: SessionUser = { id: 1, username: 'kok', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] }
    const session = (ticket: boolean): Handle => {
      const stub = new Proxy({}, { get: () => () => undefined })
      const fakePort = { send() {}, onMessage() {}, onClose() {}, close() {} }
      return new RpcHub({
        q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
        encrypt: async (v) => v.map((s) => new TextEncoder().encode(s)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)),
        userData: dir, dbSchemaVersion: () => 0
      }, 'server').openSession(fakePort, { user: admin, webSessionId: 's', ticket }) as unknown as Handle
    }

    it('yönetici yöntemleri, twoFactor* ve parola yöntemleri kapalı', async () => {
      const refused = ALL_METHODS.filter(RpcHub.ticketRefused)
      expect(refused).toEqual(expect.arrayContaining([...adminOnly, 'twoFactorStatus', 'twoFactorBegin', 'twoFactorConfirm', 'twoFactorDisable']))
      expect(ALL_METHODS.filter((m) => /password/i.test(m)).every(RpcHub.ticketRefused)).toBe(true)
      const s = session(true)
      const { desktopOnly } = RpcHub.permissionSets() // sunucu modunda zaten kapalı, önceki kapıda düşer
      for (const m of refused.filter((x) => !desktopOnly.includes(x))) await expect(s.handle(m, {}), m).rejects.toThrow(t('sync.perm.browserRequired'))
    })

    // Her yöntem burada sınıflandırılır: yeni yöntem iki listeye de yazılmazsa test düşer, karar verilmeden geçemez.
    const TICKET_CLASSES = {
      // belirtecin ömrünü aşan etki bırakmaz; gündelik posta işi ve kişinin kendi tercihleri
      allowed: {
        account: ['getAccounts', 'getAccountServer', 'getAccountStatusHistory', 'getConnectionStats', 'retryAccount', 'retryAccounts', 'setAccountStarred', 'setMySignature', 'updateAccount'],
        mail: [
          'getIncidents', 'listSmart', 'getAttachments', 'getContacts', 'getHourlyVolume', 'listMessages', 'listThreads', 'getThread', 'getThreadMembers', 'getBody',
          'getSmimeAttachment', 'getAttachment', 'getAttachmentData', 'getRawHeaders', 'getRawSource', 'listSubscriptions', 'unsubscribeSenders', 'unsubscribe', 'search',
          'fetchRemoteImages', 'markSeen', 'markFlagged', 'snoozeMessages', 'deleteMessages', 'undoDelete', 'markAllSeen', 'getFoldersOf', 'syncFolder', 'moveMessages',
          'undoMove', 'moveSpecial', 'setViewed', 'pollNow'
        ],
        compose: ['sendMail', 'listFollowups', 'closeFollowup', 'snoozeFollowup', 'listTemplates', 'saveTemplate', 'deleteTemplate', 'listOutbox', 'cancelOp', 'retryOp', 'getOpDraft'],
        pim: [
          'listContacts', 'getContact', 'saveContact', 'deleteContact', 'importContacts', 'exportContacts', 'promoteCollected', 'mergeContacts', 'listEvents', 'getEvent', 'saveEvent',
          'deleteEvent', 'getInvite', 'respondInvite', 'applyInviteUpdate', 'applyInviteCancel', 'listPimSources', 'listPimCollections', 'setPimCollectionPref', 'syncPimSource'
        ],
        ownNotifications: ['listNotifyRules', 'saveNotifyRule', 'deleteNotifyRule', 'reorderNotifyRules', 'getNotifyAccountPrefs', 'setNotifyAccountPref', 'setMyPrefs'],
        sieveRead: ['listSieveAccounts', 'getSieveAccount', 'sieveDetect', 'sieveListScripts', 'sieveGetScript', 'sieveCheckScript', 'getSieveVacation'],
        smime: ['smimeListIdentities', 'smimeListContactCerts', 'smimeCheckRecipients', 'smimeTrustInfo'],
        session: ['getPrefs', 'setSessionLocale', 'getSecurityNotice', 'getVaultState', 'unlockVault', 'lockVault']
      },
      // kalıcı iz bırakır ya da yönetim yüzeyidir
      refused: {
        accountLifecycle: ['setAccountEnabled', 'deleteAccount', 'setAccountSecure', 'updateAccountsServer', 'discoverMailServers', 'importPreview', 'importAccounts', 'exportDiagnostics'],
        sieveWrite: ['sieveSetEnabled', 'sieveSetEndpoint', 'sieveConsent', 'sieveDeployNow', 'sieveRollback', 'sieveSaveScript', 'setSieveVacation', 'getRulePlacements'],
        automation: [
          'getRules', 'createRule', 'updateRule', 'deleteRule', 'testRule', 'getWebhooks', 'createWebhook', 'updateWebhook', 'deleteWebhook', 'testWebhook',
          'getScheduledTriggers', 'createScheduledTrigger', 'updateScheduledTrigger', 'deleteScheduledTrigger', 'getRuleLog'
        ],
        pimSources: ['addIcsSubscription', 'connectAccountPim', 'addPersonalDav', 'updatePersonalDavPassword', 'removePimSource'],
        oauth: ['oauthGetClients', 'oauthSetClients', 'oauthStart', 'oauthCancel', 'oauthFinish'],
        deviceSync: ['syncPush', 'syncPull', 'setSyncAuto'],
        credentials: [
          'changeOwnPassword', 'resetUserPassword', 'ackSecurityNotice', 'twoFactorStatus', 'twoFactorBegin', 'twoFactorConfirm', 'twoFactorDisable', 'resetUserTwoFactor',
          'smimeImportIdentity', 'smimeExportIdentity', 'smimeRemoveIdentity', 'smimeAddAnchor', 'smimeRemoveAnchor',
          // kayıtlı sertifika ileride şifreli postayı kimin okuyacağını belirler
          'smimeSaveContactCert', 'smimeRemoveContactCert'
        ],
        vaultAdmin: ['createVault', 'enableVaultBiometric', 'disableVaultBiometric', 'unlockVaultBiometric', 'clearVaultPassphraseFails'],
        admin: [
          'setPrefs', 'getUsers', 'createUser', 'updateUser', 'deleteUser', 'getGroups', 'createGroup', 'updateGroup', 'deleteGroup', 'setAccountGroup', 'setGroupPermission',
          'backupToFile', 'stageRestore', 'importBegin', 'importItem', 'importFinish', 'serverAdminGetConfig', 'serverAdminSetConfig', 'serverAdminClearKey', 'serverAdminTest',
          'serverAdminBlocked', 'serverAdminUnblock', 'serverAdminAllowed', 'serverAdminAllow', 'serverAdminRemoveAllowed', 'serverAdminAccountDiff'
        ],
        // oturum kapatma yalnız çerezli oturumdan: telefon başka oturumları kapatamaz
        sessions: ['listSessions', 'revokeSession', 'revokeOtherSessions'],
        desktopAgent: ['registerDesktopAgent', 'notifyAction', 'notifyBacklog'],
        desktopLogin: ['login', 'logout', 'bootstrapAdmin', 'getLoginBiometric', 'loginBiometric', 'enableLoginBiometric', 'disableLoginBiometric']
      }
    }

    it('her RPC yöntemi tam bir sınıfta, sınıf kapıyla aynı', () => {
      const allowed = Object.values(TICKET_CLASSES.allowed).flat()
      const refused = Object.values(TICKET_CLASSES.refused).flat()
      const classified = [...allowed, ...refused]
      expect(ALL_METHODS.filter((m) => !classified.includes(m)), 'sınıfsız yöntem').toEqual([])
      expect(classified.filter((m) => !ALL_METHODS.includes(m)), 'olmayan yöntem').toEqual([])
      expect(classified.filter((m, i) => classified.indexOf(m) !== i), 'iki kez yazılmış').toEqual([])
      expect(allowed.filter(RpcHub.ticketRefused), 'açık olması gerekirken kapalı').toEqual([])
      expect(refused.filter((m) => !RpcHub.ticketRefused(m)), 'kapalı olması gerekirken açık').toEqual([])
    })

    it('izin listesi varsayılan kapalıdır, listedeki her ad gerçek yöntemdir', () => {
      expect(RpcHub.ticketRefused('yeniYontem')).toBe(true)
      const { ticketAllowed } = RpcHub.permissionSets()
      expect(ticketAllowed.filter((m) => !ALL_METHODS.includes(m))).toEqual([])
    })

    it('Sieve yazımı, otomasyon, kaynak ve cihaz senkronu biletli oturumda çalışmaz', async () => {
      const s = session(true)
      for (const m of ['sieveSetEnabled', 'sieveConsent', 'sieveDeployNow', 'setSieveVacation', 'setAccountEnabled', 'createRule', 'createWebhook', 'addPersonalDav', 'removePimSource', 'addIcsSubscription', 'setSyncAuto', 'oauthStart', 'smimeSaveContactCert', 'smimeRemoveContactCert']) {
        await expect(s.handle(m, { accountId: accA, enabled: false }), m).rejects.toThrow(t('sync.perm.browserRequired'))
      }
      expect(q.getAccountRow(accA)?.enabled).toBe(1)
    })

    it('Parça 6, 7, 8 hassas yöntemleri kapalı', () => {
      for (const m of [
        'sieveSetEndpoint', 'sieveSaveScript', 'sieveRollback', 'smimeExportIdentity', 'smimeImportIdentity', 'smimeRemoveIdentity',
        'smimeAddAnchor', 'smimeRemoveAnchor', 'clearVaultPassphraseFails', 'updatePersonalDavPassword', 'changeOwnPassword', 'registerDesktopAgent'
      ]) {
        expect(ALL_METHODS, m).toContain(m)
        expect(RpcHub.ticketRefused(m), m).toBe(true)
      }
      // gündelik okuma ve PIM yazımı mobilde sürer
      for (const m of ['smimeListIdentities', 'smimeCheckRecipients', 'listSieveAccounts', 'sieveListScripts', 'listPimSources']) expect(RpcHub.ticketRefused(m), m).toBe(false)
    })

    it('hesabın kasa korumasını kaldıran ya da hesabı silen yöntemler kapalı', async () => {
      const s = session(true)
      for (const m of ['setAccountSecure', 'deleteAccount']) {
        expect(RpcHub.ticketRefused(m), m).toBe(true)
        await expect(s.handle(m, { accountId: accA, secure: false }), m).rejects.toThrow(t('sync.perm.browserRequired'))
      }
      expect(q.getAccountRow(accA)).toBeDefined()
    })

    it('updateAccount: bağlantı alanına ya da parolaya dokunan yama reddedilir, satır değişmez', async () => {
      const before = q.getAccountRow(accA)
      const patches: Record<string, unknown>[] = [
        { imapHost: 'evil.example.test' }, { imapPort: 143 }, { imapTls: 'starttls' },
        { smtpHost: 'evil.example.test' }, { smtpPort: 25 }, { smtpTls: 'starttls' },
        { allowInvalidCerts: true }, { allowInvalidCerts: false }, { password: 'yeni' },
        { color: '#123456', imapHost: 'evil.example.test' }
      ]
      const s = session(true)
      for (const patch of patches) {
        await expect(s.handle('updateAccount', { accountId: accA, patch }), JSON.stringify(patch)).rejects.toThrow(t('sync.perm.browserRequired'))
      }
      expect(q.getAccountRow(accA)).toEqual(before)
    })

    it('updateAccount: renk, imza ve görünen ad mobilde değişir', async () => {
      await session(true).handle('updateAccount', { accountId: accA, patch: { displayName: 'Ad', color: '#123456', signature: 'İmza' } })
      const row = q.getAccountRow(accA)
      expect([row?.display_name, row?.color, row?.signature]).toEqual(['Ad', '#123456', 'İmza'])
    })

    it('updateAccount: biletsiz oturumda bağlantı alanı değişir', async () => {
      await session(false).handle('updateAccount', { accountId: accA, patch: { smtpPort: 587 } })
      expect(q.getAccountRow(accA)?.smtp_port).toBe(587)
    })

    it('posta yöntemleri açık kalır; bilet yoksa kapı yok', async () => {
      await expect(session(true).handle('getAccounts', {})).resolves.toBeDefined()
      await expect(session(false).handle('getUsers', {})).resolves.toBeDefined()
    })
  })
})
