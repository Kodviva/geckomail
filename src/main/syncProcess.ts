// Sync süreci (utilityProcess): başlatma, çökme döngüsü, main ile mesajlaşma ve renderer kanalı.
import { app, dialog, MessageChannelMain, net, powerMonitor, safeStorage, shell, utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { getLocale, t } from '../shared/i18n'
import type { ImportStaying, PlanItem, Sealed, SealRequest } from '../shared/importTypes'
import type { NotifyLevel } from '../shared/notifyRules'
import type { PushActionId } from '../shared/pushTypes'
import type { JsonlLogger } from '../shared/jsonlLog'
import { showNative } from './notifications'
import { presentBadge } from './notifyPresenter'
import { encryptionPolicy, type Os } from './os'
import { mainWindow } from './windows'

const os = process.platform as Os

let sync: UtilityProcess | null = null
let syncRestartDelay = 1000
let syncFatal: string | null = null
let syncCrashes = 0
let syncCrashTimes: number[] = []
let syncSpawnedAt = 0
let mainLog: JsonlLogger | null = null
let quitting = false

export function setSyncLog(log: JsonlLogger): void {
  mainLog = log
}

let badgeOverlay: string | null = null

/** Windows görev çubuğu işareti için simge dosyası */
export function setBadgeOverlay(path: string): void {
  badgeOverlay = path
}

const ACTION_TIMEOUT_MS = 10_000
let actionSeq = 0
const actionPending = new Map<number, (ok: boolean) => void>()

/** Bildirim eylemi motorda yapılır. Süreç yoksa ya da yanıt gelmezse false: ileti açılır */
export function execLocalAction(a: { action: 'read' | 'archive'; messageId: number }): Promise<boolean> {
  if (!sync) return Promise.resolve(false)
  return new Promise((resolve) => {
    const id = ++actionSeq
    const timer = setTimeout(() => {
      actionPending.delete(id)
      resolve(false)
    }, ACTION_TIMEOUT_MS)
    actionPending.set(id, (ok) => {
      clearTimeout(timer)
      resolve(ok)
    })
    sync?.postMessage({ type: 'notify-action', id, ...a })
  })
}

const IMPORT_TIMEOUT_MS = 60_000
let importSeq = 0
const importPending = new Map<number, (r: { ok: boolean; value?: unknown }) => void>()

function importRequest<T>(msg: object): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!sync) return reject(new Error('motor çalışmıyor'))
    const id = ++importSeq
    const timer = setTimeout(() => {
      importPending.delete(id)
      reject(new Error('motor yanıt vermedi'))
    }, IMPORT_TIMEOUT_MS)
    importPending.set(id, (r) => {
      clearTimeout(timer)
      if (r.ok) resolve(r.value as T)
      else reject(new Error('motor reddetti'))
    })
    sync.postMessage({ ...msg, id })
  })
}

/** Taşıma planı ve mühürleme yalnız bu parentPort mesajıyla istenir: RPC kanalında karşılığı yoktur */
export const importPlan = (): Promise<{ items: PlanItem[]; staying: ImportStaying }> => importRequest({ type: 'import-plan' })
export const importSeal = (r: SealRequest): Promise<Sealed[]> => importRequest({ type: 'import-seal', ...r })

export function syncPost(msg: unknown): void {
  sync?.postMessage(msg)
}

/** Çıkış başladı: bundan sonraki süreç çıkışı çökme sayılmaz */
export function markQuitting(): void {
  quitting = true
}

export const isQuitting = (): boolean => quitting

export function stopSync(): void {
  quitting = true
  sync?.kill()
}

// Hazırlanmış geri yükleme varsa sync başlamadan uygula: mevcut DB'nin kopyası db-snapshots'a,
// yedek geckomail.db olur (WAL/SHM dosyaları atılır — eski veritabanına ait)
export function applyPendingRestore(): void {
  const dir = app.getPath('userData')
  const pending = join(dir, 'restore-pending.db')
  if (!existsSync(pending)) return
  try {
    const dbPath = join(dir, 'geckomail.db')
    const snaps = join(dir, 'db-snapshots')
    mkdirSync(snaps, { recursive: true })
    if (existsSync(dbPath)) copyFileSync(dbPath, join(snaps, `geckomail-${new Date().toISOString().replace(/[:.]/g, '-')}-geri-yukleme-oncesi.db`))
    for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
    renameSync(pending, dbPath)
    mainLog?.info('yedekten geri yükleme uygulandı')
  } catch (e) {
    mainLog?.error('geri yükleme uygulanamadı', { error: (e as Error).message })
    dialog.showErrorBox(t('main.restore.failedTitle'), t('main.restore.failedDetail', { error: (e as Error).message }))
  }
}

async function promptSyncCrashLoop(): Promise<void> {
  const opts: Electron.MessageBoxOptions = {
    type: 'error',
    buttons: [t('main.crashLoop.retry'), t('main.crashLoop.openLogs'), t('main.crashLoop.close')],
    defaultId: 0,
    cancelId: 2,
    message: t('main.crashLoop.message'),
    detail: t('main.crashLoop.detail')
  }
  const win = mainWindow()
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  if (response === 0) {
    syncCrashTimes = []
    syncRestartDelay = 1000
    mainWindow()?.webContents.send('sync-restarted')
    spawnSync()
  } else if (response === 1) {
    void shell.openPath(join(app.getPath('userData'), 'logs'))
  }
}
export function spawnSync(): void {
  syncSpawnedAt = Date.now()
  sync = utilityProcess.fork(join(__dirname, 'sync.js'), [], {
    serviceName: 'geckomail-sync',
    env: {
      ...process.env,
      GECKO_USER_DATA: app.getPath('userData'),
      GECKO_PROD: app.isPackaged ? '1' : '',
      GECKO_APP_VERSION: app.getVersion(),
      // DB açılmadan (ör. sürüm düşürme hatası) da doğru dilde konuşsun; sonra DB'deki 'locale' tercihi geçerli
      GECKO_LOCALE: getLocale()
    }
  })
  sync.on('spawn', () => {
    syncRestartDelay = 1000
    plumbPorts()
  })
  sync.on('message', (msg: { type?: string; id?: number; values?: Uint8Array[]; title?: string; body?: string }) => {
    if (msg?.type === 'encrypt' && msg.id) {
      try {
        const policy = encryptionPolicy(os, safeStorage.isEncryptionAvailable())
        if (policy === 'refuse') {
          sync?.postMessage({ type: 'crypto:err', id: msg.id })
          return
        }
        const out = (msg.values ?? []).map((v) =>
          new Uint8Array(policy === 'encrypt'
            ? safeStorage.encryptString(Buffer.from(v as Uint8Array).toString('utf-8'))
            : Buffer.from(v as Uint8Array))
        )
        sync?.postMessage({ type: 'encrypt:res', id: msg.id, values: out })
      } catch {
        sync?.postMessage({ type: 'crypto:err', id: msg.id })
      }
      return
    }
    if (msg?.type === 'decrypt' && msg.id) {
      // hesap başına çöz: tek bozuk blob tüm filoyu düşürmesin (boş sonuç = çözülemedi)
      const policy = encryptionPolicy(os, safeStorage.isEncryptionAvailable())
      const out = (msg.values ?? []).map((v) => {
        if (policy === 'refuse') return new Uint8Array(0)
        try {
          const buf = Buffer.from(v as Uint8Array)
          const s = policy === 'encrypt' ? safeStorage.decryptString(buf) : buf.toString('utf-8')
          return new Uint8Array(Buffer.from(s, 'utf-8'))
        } catch {
          return new Uint8Array(0)
        }
      })
      sync?.postMessage({ type: 'decrypt:res', id: msg.id, values: out })
      return
    }
    if (msg?.type === 'fatal') {
      if (!syncFatal) {
        syncFatal = String((msg as { message?: string }).message ?? t('main.fatal.syncFailed'))
        dialog.showErrorBox(t('main.fatal.title'), syncFatal)
      }
      return
    }
    if (msg?.type === 'notify') {
      const n = msg as { accountId?: number; messageId?: number; actions?: PushActionId[]; level?: NotifyLevel; tag?: string }
      showNative({
        title: msg.title ?? 'GeckoMail', body: msg.body ?? '', accountId: n.accountId ?? null, messageId: n.messageId ?? null,
        actions: n.actions ?? [], level: n.level ?? 'normal', tag: n.tag ?? `host:${Date.now()}`
      })
      return
    }
    if (msg?.type === 'notify-action:res' && msg.id) {
      const done = actionPending.get(msg.id)
      actionPending.delete(msg.id)
      done?.(!!(msg as { ok?: boolean }).ok)
      return
    }
    if (msg?.type === 'import:res' && msg.id) {
      const done = importPending.get(msg.id)
      importPending.delete(msg.id)
      done?.(msg as { ok: boolean; value?: unknown })
      return
    }
    if (msg?.type === 'badge') {
      const count = (msg as { count?: number }).count ?? 0
      presentBadge({ os, count, window: mainWindow(), overlay: badgeOverlay, label: t('main.tray.unread', { count }) })
    }
  })
  sync.on('exit', (code) => {
    sync = null
    if (!quitting) {
      syncCrashes++
      mainLog?.error('sync süreci beklenmedik şekilde çıktı', { code, crashesThisSession: syncCrashes, fatal: !!syncFatal })
    }
    if (quitting) return
    if (syncFatal) return // ölümcül (ör. sürüm düşürme): yeniden başlatma döngüsüne girme
    // uzun süre sağlam çalıştıysa tek çökme 30 sn beklemesin
    if (Date.now() - syncSpawnedAt > 5 * 60_000) syncRestartDelay = 1000
    // çökme döngüsü: her yeniden başlatma oturumu sıfırlar ve kasayı kilitler — 10 dk'da 3'ten
    // fazlaysa durdur, kullanıcıya sor (sonsuz döngü yerine)
    const now = Date.now()
    syncCrashTimes = [...syncCrashTimes.filter((ts) => now - ts < 10 * 60_000), now]
    if (syncCrashTimes.length > 3) {
      mainLog?.error('sync çökme döngüsü — otomatik yeniden başlatma durduruldu', { crashes: syncCrashTimes.length })
      void promptSyncCrashLoop()
      return
    }
    // çökme: backoff ile yeniden başlat, arayüze haber ver
    mainWindow()?.webContents.send('sync-restarted')
    setTimeout(() => {
      if (!quitting) spawnSync()
    }, syncRestartDelay)
    syncRestartDelay = Math.min(syncRestartDelay * 2, 30_000)
  })
}

// Renderer ↔ sync doğrudan kanalı: main yalnızca kablolamayı yapar
export function plumbPorts(): void {
  const win = mainWindow()
  if (!win || !sync) return
  const { port1, port2 } = new MessageChannelMain()
  sync.postMessage({ type: 'port' }, [port2])
  win.webContents.postMessage('sync-port', null, [port1])
}

export function bridgeSystemSignals(): void {
  // güvenlik: cihaz uykuya girince / ekran kilitlenince kasayı kilitle (sync ayara göre karar verir)
  // ağ durumu: işletim sisteminin bildirdiği değişiklik sync'e iletilir (kesinti ≠ sunucu reddi)
  let lastOnline: boolean | null = null
  const pushNetwork = () => {
    const online = net.isOnline()
    if (online === lastOnline) return
    lastOnline = online
    syncPost({ type: 'network', online })
  }
  setInterval(pushNetwork, 3000)
  powerMonitor.on('resume', () => {
    lastOnline = null // uyanışta durumu yeniden bildir
    syncPost({ type: 'resume' })
    pushNetwork()
  })
  powerMonitor.on('suspend', () => syncPost({ type: 'vault-lock' }))
  powerMonitor.on('lock-screen', () => syncPost({ type: 'vault-lock' }))
}
