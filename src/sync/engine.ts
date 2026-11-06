// Motor çekirdeği: DB + IMAP zamanlayıcı + kurallar + bildirim + RPC sunucusu.
// Electron'dan bağımsız; dış dünya yalnızca EngineHost üzerinden (şifreleme, bildirim, rozet, ölümcül hata).
import { clearVaultOpen, fetchBody, fetchNotifyBodyText } from './bodyFetch'
import { isLocale, setLocale, t, tFor } from '../shared/i18n'
import { encryptAccountPassword } from './vault/manager'
import { initOAuth, oauthClientsFrom, TokenCache } from './oauth'
import { join } from 'path'
import { DbTooNewError, openDb } from './db'
import { makeQueries, type Queries } from './db/queries'
import { Scheduler } from './scheduler'
import { OpQueue } from './opQueue'
import { setMailNetPolicy } from './net/mailNet'
import { pimNetPolicy } from './pim/davClient'
import { deliverDueReminders } from './pim/reminders'
import { RpcHub } from './rpcHub'
import { SieveManager } from './sieve/manager'
import { evictCaches, trimRuleLog } from './evict'
import { notifyNewMail } from './newMailNotify'
import { buildImportPlan, importStaying, sealImportBatch } from './importExport'
import { applyNotifyAction, hostActor, notifyActionsFor } from './notifyActions'
import { hostSink, NotifyPipeline, type NotifySink } from './notifyPipeline'
import { runDueScheduledTriggers } from './scheduledTriggers'
import { checkAnomalies } from './anomalyRunner'
import { syncLog as log } from './log'
import { makeEvaluator } from './smime/receive'
import { CrlCache } from './smime/revocation'
import { createTrustStore } from './smime/trust'
import { mkdirSync, readdirSync, rmSync } from 'fs'
import type { EngineHost, HostSignal } from './host'

export type EngineOptions = {
  userData: string
  host: EngineHost
  /** sunucu: IDLE sıcak küme üst sınırı (GECKO_IDLE_MAX) */
  idleMax?: number
  /** sunucu: iç ağdaki DAV sunucuları (GECKO_DAV_PRIVATE_HOSTS) */
  davPrivateHosts?: string[]
  /** sunucu: iç ağdaki IMAP/SMTP sunucuları (GECKO_MAIL_PRIVATE_HOSTS) */
  mailPrivateHosts?: string[]
} & (
  /** os: safeStorage arızasının anlamı işletim sistemine bağlı (loadCredentials); yoksa macOS davranışı */
  | { mode: 'desktop'; os?: NodeJS.Platform }
  /** notifySink: bildirim hattının alıcısı; motor açılırken kurulur (sync, server'a bağımlı değil) */
  | { mode: 'server'; notifySink(q: Queries, hub: RpcHub): NotifySink }
)
export interface Engine { hub: RpcHub; signal(s: HostSignal): void; stop(): Promise<void> }

export function startEngine(opts: EngineOptions): Engine {
  const { userData, host } = opts
  setMailNetPolicy(opts.mode === 'server' ? new Set(opts.mailPrivateHosts ?? []) : null)
  let db: ReturnType<typeof openDb>
  try {
    db = openDb(userData)
  } catch (e) {
    // sürüm düşürme: yeniden başlatmak aynı hatayı üretir — ev sahibine ölümcül olarak bildir
    if (e instanceof DbTooNewError) host.fatal(e.message)
    throw e
  }
  const q = makeQueries(db)
  const creds = new Map<number, string>()
  {
    const saved = q.prefGet('locale')
    if (isLocale(saved)) setLocale(saved)
  }
  const attachDir = join(userData, 'attachments')
  clearVaultOpen(attachDir) // önceki süreç kilitlemeden kapandıysa açılan ek kopyaları kalmasın

  // ---- ev sahibiyle şifreleme köprüsü (masaüstünde safeStorage yalnızca main'de) ----
  const encrypt = (values: string[]): Promise<Uint8Array[]> => host.encrypt(values)
  const decryptToStrings = async (blobs: Uint8Array[]): Promise<string[]> =>
    (await host.decrypt(blobs)).map((u) => Buffer.from(u).toString('utf-8'))

  // ---- OAuth2: erişim belirteci önbelleği; sağlayıcı yenileme belirtecini döndürürse şifreli kaydedilir ----
  initOAuth(
    new TokenCache(oauthClientsFrom((k) => q.prefGet(k)), (accountId, refreshToken) => {
      creds.set(accountId, refreshToken)
      const row = q.getAccountRow(accountId)
      if (!row) return
      const store = (enc: Buffer) => q.updateAccountPassword(row.email, enc)
      try {
        if (row.secure) store(encryptAccountPassword(refreshToken))
        else void encrypt([refreshToken]).then(([b]) => store(Buffer.from(b)))
      } catch (e) {
        // kasa kilitli: eski belirteç süresi dolana dek geçerli kalır, bir sonraki yenilemede yeniden denenir
        log.warn('yenilenen OAuth belirteci kaydedilemedi', { accountId, error: (e as Error).message })
      }
    }, fetch, Date.now, (accountId) => q.mailScopeExplicit(accountId))
  )

  // ---- bileşenler (döngüsel bağımlılık: closure ile geç bağlama) ----
  let server: RpcHub
  let notifications: NotifyPipeline

  const prefetchFailed = new Set<number>() // bu oturumda gövdesi çekilemeyenler
  const scheduler = new Scheduler(q, creds, {
    emitStatus(accountId, status, detail) {
      server?.broadcast('account:status', { accountId, status, detail })
    },
    emitChanged() {
      server?.broadcastDebounced('messages:changed', { accountId: null })
      server?.broadcastDebounced('counts:changed', {})
    },
    onNewMail(accountId) {
      // kişiye ait tercihlerle (§10.1): masaüstünde ev sahibine, sunucuda kullanıcının oturumlarına ve push cihazlarına
      void notifyNewMail({ q, opq, hub: server, pipeline: notifications }, accountId)
    },
    onHostAlert(hostName, message) {
      // soğumaya ilk geçişte tek bildirim (kademeler tekrar bildirmez)
      host.notify({ title: t('sync.notify.hostPaused', { host: hostName }), body: message })
      log.warn('host soğumaya girdi', { host: hostName, message })
    },
    onHostHealth(host, state, until, message) {
      server?.broadcast('host:health', { host, state, until, message })
    },
    onNetwork(state) {
      server?.broadcast('network:state', { online: state === 'online' })
      if (state === 'offline') log.warn('internet bağlantısı yok — yoklama bekletiliyor')
      else log.info('internet bağlantısı geri geldi')
    },
    async prefetchBodies(row, client) {
      const PREFETCH_DAYS = 14
      const PREFETCH_MAX_BYTES = 64 * 1024
      const list = q
        .bodyPrefetchCandidates(row.id, Date.now() - PREFETCH_DAYS * 86_400_000, PREFETCH_MAX_BYTES, 8 + Math.min(prefetchFailed.size, 50))
        .filter((m) => !prefetchFailed.has(m.id))
        .slice(0, 8)
      let fetched = 0
      for (const m of list) {
        try {
          await fetchBody(q, row, m, client, attachDir, smimeEvaluate)
          fetched++
        } catch (e) {
          // sunucuda silinmiş/bozuk mail her turda yeniden denenmesin; bağlantı hatasıysa turu bırak
          prefetchFailed.add(m.id)
          throw e
        }
      }
      return fetched > 0
    }
  }, undefined, opts.mode === 'server' ? { max: opts.idleMax ?? 40, eligible: () => q.notifyEligibleAccounts() } : undefined)

  const smimeTrust = createTrustStore(q)
  const smimeCrl = new CrlCache({ q, mode: () => (q.prefGet('smimeRevocation') === 'off' ? 'off' : 'crl') })
  const smimeEvaluate = makeEvaluator({ store: smimeTrust, crl: smimeCrl })

  const opq = new OpQueue(q, scheduler, creds, attachDir, {
    smimeEvaluate,
    emitOpFailed(accountId, kind, error, draft, id, partial, senderId) {
      server?.broadcastOpFailed({ accountId, kind, error, id, ...(partial ? { partial } : {}) }, senderId, draft)
    },
    emitChanged() {
      server?.broadcastDebounced('messages:changed', { accountId: null })
      server?.broadcastDebounced('counts:changed', {}) // başarısız taşıma satırı geri gösterir
    },
    emitAutomationLogged() {
      server?.broadcastDebounced('automation:logged', {})
    }
  }, opts.mode)

  const sieve = new SieveManager({
    q, creds, scheduler,
    onState(accountId) {
      server?.broadcast('sieve:state', { accountId })
    }
  })

  server = new RpcHub({
    q, scheduler, opq, creds, sieve, attachDir, encrypt, decrypt: decryptToStrings, userData, smimeTrust, smimeCrl,
    dbSchemaVersion: () => db.pragma('user_version', { simple: true }) as number,
    pimNet: (o) => pimNetPolicy(opts.mode, { davPrivateHosts: opts.davPrivateHosts }, o)
  }, opts.mode)

  const sink = opts.mode === 'desktop'
    ? hostSink(host, (item) => {
        const actor = hostActor(server)
        return actor ? notifyActionsFor(q, actor, item) : []
      })
    : opts.notifySink(q, server)
  server.securityAlert = (userId, title, body) => sink.deliver(userId, [{ title, body, accountId: null, messageId: null, level: 'urgent', tag: 'security', count: 1 }])
  notifications = new NotifyPipeline({
    q,
    hub: server,
    mode: opts.mode,
    sink,
    fetchBodyText: (messageId) =>
      fetchNotifyBodyText(q, messageId, (msg) => scheduler.enqueueInteractive(msg.accountId, (client, row) => fetchBody(q, row, msg, client, attachDir, smimeEvaluate)))
  })

  function signal(s: HostSignal): void {
    if (s.type === 'vault-lock') {
      server.lockFromSignal() // main: uyku/ekran kilidi sinyali
    } else if (s.type === 'network') {
      // işletim sisteminin ağ durumu ve uykudan uyanış (kesintiyi sunucu reddi sanmamak için)
      scheduler.net.setOsOnline(s.online)
    } else if (s.type === 'locale') {
      // arayüz dili: bildirimler ve sunucu/hesap mesajları bu dilde üretilir; açılışta da kullanılsın
      if (isLocale(s.locale)) {
        setLocale(s.locale)
        q.prefSet('locale', s.locale)
      }
    } else if (s.type === 'notify-action') {
      const actor = hostActor(server)
      host.notifyActionResult?.(s.id, !!actor && applyNotifyAction(server, actor, { messageId: s.messageId, action: s.action }))
    } else if (s.type === 'import-plan') {
      respondImport(s.id, () => ({ items: buildImportPlan(server), staying: importStaying(server) }))
    } else if (s.type === 'import-seal') {
      respondImport(s.id, () => sealImportBatch(server, s))
    } else if (s.type === 'resume') {
      scheduler.net.onResume()
    }
  }

  function respondImport(id: number, work: () => unknown): void {
    try {
      host.importResult?.(id, { ok: true, value: work() })
    } catch {
      host.importResult?.(id, { ok: false })
    }
  }

  // ---- şifreleri Keychain'den (safeStorage) çöz ----
  // Hepsi birden çözülemiyorsa sebep neredeyse her zaman macOS Keychain izni: imzası değişen bir
  // Electron binary'si (dev'de sürüm yükseltme) ilk erişimde onay penceresi açar, yanıtlanana kadar
  // çözme başarısız/zaman aşımı olur. Veri bozuk değildir → yanlış "yeniden içe aktar" demeyelim ve
  // izin verilince kendiliğinden toparlanalım: 60 sn'de bir, yalnız eksik hesaplar için yeniden dene.
  // Windows'ta DPAPI izin sormaz: tümü çözülemiyorsa kullanıcı anahtarı değişmiştir (parola sıfırlama, profil
  // taşıma), bekleyince gelmez. Açılışta bir kez söylenir, yeniden deneme kurulmaz.
  const storeLost = opts.mode === 'desktop' && opts.os === 'win32'
  const allFailedText = (): string => t(storeLost ? 'sync.status.credentialStoreLost' : 'sync.status.keychainWait')
  let credRetry: ReturnType<typeof setTimeout> | null = null

  async function loadCredentials(ids: number[], initial: boolean): Promise<void> {
    if (!ids.length) return
    const rows = ids.map((id) => q.getAccountRow(id)).filter((r): r is NonNullable<typeof r> => !!r && !r.secure)
    let plains: string[] = []
    try {
      plains = await decryptToStrings(rows.map((r) => new Uint8Array(r.password_enc)))
    } catch (e) {
      console.error('sync: şifre çözme isteği başarısız', (e as Error).message)
    }
    const missing: number[] = []
    rows.forEach((r, i) => {
      if (plains[i]) {
        creds.set(r.id, plains[i])
        if (!initial) {
          scheduler.retryAccount(r.id) // geç gelen izin: bekleme/backoff'u sıfırla
          sieve.onCredentialsChanged(r.id)
        }
      } else {
        missing.push(r.id)
      }
    })
    if (!missing.length) {
      if (!initial) console.warn(`sync: Keychain erişimi geldi — ${rows.length} hesabın şifresi yüklendi`)
      return
    }
    if (opts.mode === 'server') {
      // sunucuda safeStorage yok: masaüstünden gelen şifreli parola çözülemez; beklemenin anlamı yok →
      // "parola gerekli" (auth_failed, IMAP denenmez); kullanıcı hesabı düzenleyip parolayı yeniden girer
      const detail = t('sync.server.passwordNeeded')
      for (const id of missing) {
        q.updateAccountStatus(id, 'auth_failed', detail, false)
        server?.broadcast('account:status', { accountId: id, status: 'auth_failed', detail })
      }
      return
    }
    const allFailed = missing.length === rows.length
    for (const id of missing) {
      q.updateAccountStatus(id, 'degraded', allFailed ? allFailedText() : t('sync.status.decryptFailed'), false)
    }
    if (allFailed) {
      if (initial) host.notify({ title: 'GeckoMail', body: allFailedText() })
      if (credRetry) clearTimeout(credRetry)
      if (!storeLost) credRetry = setTimeout(() => void loadCredentials(missing, false), 60_000)
    }
    server?.broadcast('account:status', { accountId: missing[0], status: 'degraded', detail: allFailed ? allFailedText() : null })
  }

  // ---- açılış: şifreleri çöz, motorları başlat ----
  const timers: ReturnType<typeof setTimeout>[] = []
  const after = (fn: () => void, ms: number): void => void timers.push(setTimeout(fn, ms))
  const every = (fn: () => void, ms: number): void => void timers.push(setInterval(fn, ms))
  let stopped = false

  async function boot(): Promise<void> {
    // tek seferlik: hesap renklerini eski rastgele paletten yeni kürasyonlu aileye taşı
    if (!q.prefGet('recolored_v2')) {
      q.recolorAllAccounts()
      q.prefSet('recolored_v2', '1')
    }

    // kasa hesapları hariç: onların password_enc'i safeStorage değil vault-anahtarı ile şifreli;
    // vault açılınca (unlockVault) creds'e eklenirler. safeStorage ile çözmeye çalışmak çöp üretir.
    const rows = q.getAccountRows().filter((r) => !r.secure)
    await loadCredentials(rows.map((r) => r.id), true)
    if (stopped) return
    scheduler.start()
    opq.start()
    sieve.schedulePending()
    // haftalık otomatik yerel yedek (R18): userData/backups, son 4 saklanır; Ayarlar'dan kapatılabilir
    const autoBackup = async (): Promise<void> => {
      if (q.prefGet('autoBackup') === '0') return
      if (Date.now() - Number(q.prefGet('auto_backup_last') ?? 0) < 7 * 86_400_000) return
      try {
        const dir = join(userData, 'backups')
        mkdirSync(dir, { recursive: true })
        await q.backupTo(join(dir, `geckomail-otomatik-${new Date().toISOString().slice(0, 10)}.sqlite`))
        q.prefSet('auto_backup_last', String(Date.now()))
        const old = readdirSync(dir).filter((f) => /^geckomail-otomatik-.+\.sqlite$/.test(f)).sort().reverse().slice(4)
        for (const f of old) rmSync(join(dir, f), { force: true })
        log.info('otomatik yedek alındı', { dir })
      } catch (e) {
        console.error('sync: otomatik yedek başarısız', (e as Error).message)
      }
    }
    after(() => void autoBackup(), 5 * 60_000)

    // takip hatırlatıcısı (R30): yanıt gelenleri kapat, süresi dolanları bildir. Yerel sorgu, sunucuya gitmez.
    const followupTick = () => {
      try {
        const replied = q.resolveRepliedFollowups()
        const due = q.markDueFollowups()
        notifications.deliverDueFollowups()
        if (replied || due.length) server?.broadcast('followups:changed', {})
      } catch (e) {
        log.warn('takip kontrolü başarısız', { error: (e as Error).message })
      }
    }
    after(followupTick, 30_000)
    every(followupTick, 120_000)

    // FTS yeniden indeksleme (R27): ı katlaması + HTML gövde metni. Parça başına 500 mesaj, aralarda olay
    // döngüsü serbest (sync takılmasın); nerede kalındığı pref'te, yeniden başlatmada devam eder.
    const FTS_VERSION = '2'
    if (q.prefGet('fts_version') !== FTS_VERSION) {
      let cursor = Number(q.prefGet('fts_reindex_cursor') ?? 0)
      const step = () => {
        try {
          const next = q.ftsReindexBatch(cursor, 500)
          if (next === null) {
            q.prefSet('fts_version', FTS_VERSION)
            q.prefSet('fts_reindex_cursor', '0')
            log.info('arama indeksi yenilendi')
            return
          }
          cursor = next
          q.prefSet('fts_reindex_cursor', String(cursor))
          after(step, 50)
        } catch (e) {
          log.warn('arama indeksi yenilenemedi', { error: (e as Error).message })
        }
      }
      after(step, 20_000)
    }
    every(() => void autoBackup(), 3600_000)
    every(() => void smimeCrl.drain(), 60_000)

    every(() => {
      try {
        evictCaches(db, q)
        q.pruneObservability(Date.now() - 30 * 86_400_000)
        opq.pruneFailedOps(Date.now() - 30 * 86_400_000) // başarısız op'lar (ör. 33 MB'lık append_sent) sınırsız birikmesin
        trimRuleLog(db)
        checkAnomalies(q, (ev) => {
          server?.broadcast('account:anomaly', ev)
          const row = q.getAccountRow(ev.accountId)
          if (!row) return
          notifications.notice({
            title: row.email,
            body: (loc) => tFor(loc, ev.kind === 'silence' ? 'sync.notify.anomalySilence' : 'sync.notify.anomalyBurst', { current: ev.current, baseline: ev.baseline }),
            accountId: ev.accountId
          })
        })
      } catch (e) {
        console.error('sync: önbellek tahliyesi başarısız', e)
      }
    }, 3600_000)

    // Zamanlanmış görevler: dakika hassasiyeti yeterli (HH:MM), op_queue'nun sweep+kick
    // deseniyle aynı şekilde, ayrı bir cron kütüphanesi olmadan.
    every(() => {
      try {
        runDueScheduledTriggers(q, opq)
        // ertelenmiş mailler: zamanı gelenleri gelen kutusuna geri getir
        if (q.resurfaceSnoozed(Date.now()) > 0) server?.broadcast('messages:changed', { accountId: null })
      } catch (e) {
        console.error('sync: zamanlanmış görev çalıştırılamadı', e)
      }
    }, 60_000)

    // Otomatik senkron: boot'ta bir kez pull (uzak config'i benimse), sonra 20 dk'da bir push (yereli yayınla).
    after(() => void server?.autoSyncBootPull(), 8_000)
    every(() => void server?.autoSyncPush(), 20 * 60_000)

    // Kişi ve takvim kaynakları: vakti gelenler sınırlı eşzamanlılıkla eşitlenir
    const pimTick = (): void => {
      try {
        server.pim.tick()
      } catch (e) {
        log.warn('kişi ve takvim turu başlatılamadı', { error: (e as Error).message })
      }
    }
    after(pimTick, 20_000)
    every(pimTick, 30_000)

    // Takvim hatırlatmaları: dakika hassasiyeti, yerel sorgu
    every(() => {
      try {
        deliverDueReminders(q, notifications, Date.now())
      } catch (e) {
        log.warn('takvim hatırlatmaları işlenemedi', { error: (e as Error).message })
      }
    }, 60_000)

    // Dock rozeti: okunmamış toplamı değiştikçe main'e bildir
    let lastBadge = -1
    every(() => {
      try {
        const r = db
          .prepare(`SELECT COUNT(*) AS n FROM messages WHERE seen = 0 AND folder_kind = 'inbox' AND hidden = 0 AND snooze_until = 0`)
          .get() as { n: number }
        if (r.n !== lastBadge) {
          lastBadge = r.n
          host.badge(r.n)
        }
      } catch {
        /* rozet kritik değil */
      }
    }, 10_000)
    console.log(`sync: hazır — ${rows.length} hesap`)
    log.info('sync hazır', { accounts: rows.length })
  }

  void boot()

  return {
    hub: server,
    signal,
    async stop() {
      stopped = true
      notifications.stop()
      server.pim.stop()
      smimeCrl.stop()
      for (const h of timers) {
      clearTimeout(h)
      clearInterval(h)
    }
      if (credRetry) clearTimeout(credRetry)
      sieve.stop()
      await opq.stop() // bağlantı ve DB açıkken: gönderilmekte olan ileti yarım kalmasın
      scheduler.stop()
      db.close()
    }
  }
}
