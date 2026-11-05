// Taşımanın Electron bağlaması. Sıra: adres yoklanır, köken main'in kutusunda onaylanır, sunucu partition'ında web girişi (parola, TOTP,
// passkey), bağlantı kurulunca pencere kapanır, koşucu çalışır. Renderer'dan yalnız adres gelir; hedef kökeni main normalleştirir,
// çerez ve zarf renderer'a gitmez. Pencere `createServerWindow` ile aynı sertleştirmeden geçer.
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import type { ProbeResult } from '../shared/desktopMode'
import { t } from '../shared/i18n'
import type { ImportStaying, MigrationEvent, MigrationFailure } from '../shared/importTypes'
import { readMode, updateMode } from './desktopMode'
import { MigrationRunner, recordImport } from './migration'
import type { Os } from './os'
import { ServerLink } from './serverLink'
import { createServerWindow, probe, SERVER_PARTITION, singleFlight } from './serverWindow'
import { importPlan, importSeal } from './syncProcess'

const COOKIE = 'gm_session'
const SIGN_IN_TIMEOUT_MS = 10 * 60_000
const COOKIE_DEBOUNCE_MS = 500
const os = process.platform as Os

type Ready = 'ready' | 'notAdmin' | 'failed'

interface Deps {
  localWindow(): BrowserWindow | null
}

const ask = async (parent: BrowserWindow | null, opts: Electron.MessageBoxOptions): Promise<boolean> =>
  (await (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts))).response === 1

const question = (buttonKey: string, message: string, detail: string): Electron.MessageBoxOptions => ({
  type: 'question', buttons: [t('main.common.cancel'), t(buttonKey)], defaultId: 0, cancelId: 0, message, detail
})

/** Sunucudan gelen karşılama: kimin adına gönderileceği onay kutusunda yazılır */
export function helloUser(data: unknown): { admin: boolean; username: string } {
  const user = (data as { user?: { role?: unknown; username?: unknown } | null } | null)?.user
  return { admin: user?.role === 'admin', username: typeof user?.username === 'string' ? user.username : '' }
}

/** Oturum varsa pencere açılmaz. Çerez değişince bağlantı yenilenir; pencereyi kullanıcı kapatırsa vazgeçilmiş sayılır */
export function signIn(link: ServerLink, ses: Electron.Session, origin: string, events: { onReady(cb: (r: Ready) => void): void; onSignedOut(cb: () => void): void; onOffline(cb: () => void): void }): Promise<Ready> {
  return new Promise((resolve) => {
    let win: BrowserWindow | null = null
    let debounce: ReturnType<typeof setTimeout> | null = null
    let over = false
    const onCookie = (_e: unknown, c: Electron.Cookie): void => {
      if (c.name !== COOKIE) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        link.stop()
        link.start()
      }, COOKIE_DEBOUNCE_MS)
    }
    const timer = setTimeout(() => finish('failed'), SIGN_IN_TIMEOUT_MS)
    const finish = (r: Ready): void => {
      over = true
      clearTimeout(timer)
      if (debounce) clearTimeout(debounce)
      ses.cookies.removeListener('changed', onCookie)
      const w = win
      win = null
      if (w && !w.isDestroyed()) w.close()
      resolve(r)
    }
    ses.cookies.on('changed', onCookie)
    events.onReady(finish)
    events.onOffline(() => {
      if (!win && !over) finish('failed') // pencere açıkken kullanıcı TOTP giriyor olabilir
    })
    events.onSignedOut(() => {
      if (win || over) return // taşıma sürerken kopan oturum koşucuda duraklamaya döner: pencereyi kapatacak kimse kalmadı
      win = createServerWindow({ origin })
      win.once('closed', () => {
        if (win) {
          win = null
          finish('failed')
        }
      })
    })
    link.start()
  })
}

async function run(d: Deps, url: unknown): Promise<ProbeResult> {
  const r = await probe(url)
  if (!r.ok) return r
  const { origin } = r
  const send = (e: MigrationEvent): void => d.localWindow()?.webContents.send('gecko:migration-event', e)
  const fail = (reason: MigrationFailure): void => send({ phase: 'paused', done: 0, total: 0, blocked: [], failed: [], reason, origin })
  // posta XSS'i uygulamayı saldırgan sunucusunun giriş sayfasına götüremesin
  if (!(await ask(d.localWindow(), question('main.migration.signIn', t('main.migration.signInTitle'), t('main.migration.signInDetail', { origin }))))) return r
  const userData = app.getPath('userData')
  const sourceId = updateMode(userData, {}).sourceId // yerel modda dosya yoktur: sürdürme aynı kimliği ister

  const ses = session.fromPartition(SERVER_PARTITION)
  let ready: (r: Ready) => void = () => {}
  let signedOut: () => void = () => {}
  let offline: () => void = () => {}
  let hello = helloUser(null)
  const link = new ServerLink({
    origin,
    cookie: async () => (await ses.cookies.get({ url: origin, name: COOKIE }))[0]?.value ?? null,
    userAgent: `GeckoMail/${app.getVersion()}`,
    deviceId: sourceId,
    label: `GeckoMail · ${os === 'darwin' ? 'macOS' : os === 'win32' ? 'Windows' : 'Linux'}`,
    registerAgent: false,
    onState(s) {
      if (s === 'signedOut') signedOut()
      else if (s === 'offline') offline()
    },
    onEvent(event, data) {
      if (event === 'sync:hello') hello = helloUser(data)
      if (event === 'agent:ready') ready(hello.admin ? 'ready' : 'notAdmin')
    }
  })
  try {
    const state = await signIn(link, ses, origin, {
      onReady: (cb) => { ready = cb },
      onSignedOut: (cb) => { signedOut = cb },
      onOffline: (cb) => { offline = cb }
    })
    if (state !== 'ready') {
      fail(state === 'notAdmin' ? 'notAdmin' : 'connection')
      return r
    }
    let staying: ImportStaying | undefined
    await new MigrationRunner({
      link,
      engine: {
        plan: async () => {
          const p = await importPlan()
          staying = p.staying
          return p.items
        },
        seal: importSeal
      },
      confirm: ({ origin: target, accounts }) => ask(d.localWindow(), question('main.migration.send', t('main.migration.confirmTitle'), t('main.migration.confirmDetail', { origin: target, accounts, user: hello.username }))),
      onEvent(e) {
        if (e.phase === 'done') recordImport(userData, origin)
        send({ ...e, staying, origin })
      }
    }).run(sourceId, origin)
  } finally {
    link.stop()
  }
  return r
}

export function registerMigrationIpc(o: Deps & { fromLocalMain(e: Electron.IpcMainInvokeEvent): boolean }): void {
  const once = singleFlight((url: unknown) => run(o, url), { ok: false, reason: 'unreachable' } as ProbeResult)
  ipcMain.handle('gecko:migration-start', (e, url: unknown): Promise<ProbeResult> | ProbeResult => (o.fromLocalMain(e) ? once(url) : { ok: false, reason: 'invalid' }))
  ipcMain.handle('gecko:migration-state', (e) => (o.fromLocalMain(e) ? { importedTo: readMode(app.getPath('userData')).importedTo } : { importedTo: null }))
}
