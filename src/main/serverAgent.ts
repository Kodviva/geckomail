// Sunucu modunda arka plan ajanı: ServerLink'i pencere oturumunun çereziyle başlatır, çerez değişince yeniler, olayları gösterir.
// Çerez değeri yalnız bu modülün belleğinde ve Electron çerez deposunda durur.
import { app, BrowserWindow, net, powerMonitor, session } from 'electron'
import { join } from 'path'
import { t } from '../shared/i18n'
import type { ServerNotify } from '../shared/pushTypes'
import type { AccountInfo } from '../shared/rpc'
import { showNative } from './notifications'
import { presentBadge, shouldShow, shouldTellSignedOut } from './notifyPresenter'
import type { Os } from './os'
import { ServerLink } from './serverLink'
import { SERVER_PARTITION, serverWindow } from './serverWindow'
import { setAgentState, trayIconPath } from './tray'

const COOKIE = 'gm_session'
const NET_POLL_MS = 3000
const COUNT_DEBOUNCE_MS = 500
const COOKIE_DEBOUNCE_MS = 500

let link: ServerLink | null = null

export const serverLink = (): ServerLink | null => link

/** Eylem sunucuda, görünen kullanıcının yetkisiyle */
export async function execServerAction(a: { action: 'read' | 'archive'; messageId: number }): Promise<boolean> {
  return !!link && (await link.call<{ ok: boolean }>('notifyAction', a)).ok
}

/** Yalnız pencereyi açan bilgilendirme */
const inform = (title: string, body: string, tag: string): void =>
  showNative({ title, body, accountId: null, messageId: null, actions: [], level: 'normal', tag })

const focused = (): boolean => !!BrowserWindow.getFocusedWindow()

export function startServerAgent(o: { origin: string; os: Os; deviceId: string; resources: string }): void {
  const ses = session.fromPartition(SERVER_PARTITION)
  const cookie = async (): Promise<string | null> => (await ses.cookies.get({ url: o.origin, name: COOKIE }))[0]?.value ?? null
  let signedOutTold = false
  let everOnline = false
  let countTimer: ReturnType<typeof setTimeout> | null = null

  const refreshCount = (): void => {
    if (countTimer) clearTimeout(countTimer)
    countTimer = setTimeout(() => {
      void link?.call<AccountInfo[]>('getAccounts', {}).then((accounts) => {
        const count = accounts.reduce((n, a) => n + a.unread, 0)
        if (!Number.isSafeInteger(count) || count < 0) return
        presentBadge({ os: o.os, count, window: serverWindow(), overlay: trayIconPath('win32', o.resources), label: t('main.tray.unread', { count }) })
      }).catch(() => {})
    }, COUNT_DEBOUNCE_MS)
  }

  const onNotify = (n: ServerNotify): void => {
    if (!shouldShow({ focused: focused(), level: n.level })) return
    // kasa hesabının kuyruktaki ögesi metin taşımaz
    showNative({ ...n, title: n.title || t('main.agent.secureTitle'), body: n.body || t('main.agent.secureBody') })
  }

  link = new ServerLink({
    origin: o.origin,
    cookie,
    userAgent: `GeckoMail/${app.getVersion()}`,
    deviceId: o.deviceId,
    label: `GeckoMail · ${o.os === 'darwin' ? 'macOS' : o.os === 'win32' ? 'Windows' : 'Linux'}`,
    onState(s) {
      setAgentState({ link: s })
      if (s === 'online') {
        signedOutTold = false
        everOnline = true
      }
      if (s === 'signedOut' && !signedOutTold && shouldTellSignedOut({ focused: focused(), everOnline, hasWindow: !!serverWindow() })) {
        signedOutTold = true
        inform(t('main.agent.signedOutTitle'), t('main.agent.signedOutBody'), 'agent:signedOut')
      }
    },
    onEvent(event, data) {
      if (event === 'server:notify') return onNotify(data as ServerNotify)
      if (event === 'agent:summary') {
        const { count, truncated, flood } = data as { count: number; truncated: boolean; flood?: boolean }
        return inform('GeckoMail', t(flood ? 'main.agent.flood' : truncated ? 'main.agent.missedTruncated' : 'main.agent.missed', { count }), 'agent:missed')
      }
      if (event === 'agent:ready' || event === 'counts:changed' || event === 'messages:changed') refreshCount()
    }
  })
  link.start()

  // oturum uzayınca aynı değer yeniden yazılır: yalnız değer değişince bağlantı yenilenir
  let last: string | null | undefined
  void cookie().then((v) => { last ??= v })
  let cookieTimer: ReturnType<typeof setTimeout> | null = null
  ses.cookies.on('changed', (_e, c) => {
    if (c.name !== COOKIE) return
    if (cookieTimer) clearTimeout(cookieTimer)
    cookieTimer = setTimeout(() => {
      void cookie().then((v) => {
        if (v === last) return
        last = v
        link?.stop()
        if (v) link?.start()
        else setAgentState({ link: 'signedOut' })
      })
    }, COOKIE_DEBOUNCE_MS)
  })

  powerMonitor.on('resume', () => link?.nudge())
  let online = net.isOnline()
  setInterval(() => {
    const now = net.isOnline()
    if (now && !online) link?.nudge()
    online = now
  }, NET_POLL_MS)
}

/** Tepsi ve rozet kaynakları */
export const resourcesDir = (): string => (app.isPackaged ? process.resourcesPath : join(__dirname, '../../build'))
