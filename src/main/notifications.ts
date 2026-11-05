// Yerel ve sunucu modunun ortak bildirimi: macOS eylem düğmeleri, Windows toast'ı, eylem ve tıklama yönlendirmesi.
// Bildirimden satır içi yanıt yok (K3): yanıtla yazma penceresini açar.
import { Notification } from 'electron'
import { t } from '../shared/i18n'
import type { NotifyLevel } from '../shared/notifyRules'
import type { PushActionId } from '../shared/pushTypes'
import type { OpenLink } from './openQueue'
import type { Os } from './os'
import { buildToastXml, parseToastArgs } from './toastXml'
import { openLink } from './windows'

export type NotifyExec = (a: { action: 'read' | 'archive'; messageId: number }) => Promise<boolean>
type Activation = { action: 'open' | PushActionId; messageId: number | null; accountId: number | null }

export interface NativeNotification {
  title: string
  body: string
  accountId: number | null
  messageId: number | null
  actions: PushActionId[]
  level: NotifyLevel
  tag: string
}

/** Windows'ta süreç bildirimle başladıysa bu süre içindeki etkinleştirme soğuk sayılır */
const COLD_START_MS = 3000

export function macActions(actions: PushActionId[], labels: Record<PushActionId, string>): Electron.NotificationAction[] {
  return actions.map((a) => ({ type: 'button', text: labels[a] ?? '' }))
}

/** Eylem yapılamazsa (kilitli kasa, yetki, bağlantı) kullanıcı iletiyi görür */
export async function routeActivation(a: Activation, d: { exec: NotifyExec; open(link: OpenLink): void }): Promise<void> {
  const open = (reply: boolean): void => d.open({ messageId: a.messageId, accountId: a.accountId, reply })
  if (a.action === 'open' || a.action === 'reply' || a.messageId == null) return open(a.action === 'reply')
  const ok = await d.exec({ action: a.action, messageId: a.messageId }).catch(() => false)
  if (!ok) open(false)
}

/** Soğuk başlangıçta okundu/arşiv yazılmaz: kullanıcı görmeden işlem yapılmaz, yalnız ileti açılır */
export function routeToast(raw: string, cold: boolean, d: { exec: NotifyExec; open(link: OpenLink): void }): Promise<void> {
  const a = parseToastArgs(raw)
  if (!a) return Promise.resolve()
  return routeActivation(cold && a.action !== 'reply' ? { ...a, action: 'open' } : a, d)
}

let exec: NotifyExec = async () => false
let platform: Os = 'darwin'
let onFailed: (error: string) => void = () => {}
/** Gösterilen bildirimler: toplanırsa olay gelmez. Electron `close` olayını güvence etmez: uzun yaşayan ajanda sınırlı kalır */
const live = new Set<Notification>()
const MAX_LIVE = 50

export function keepBounded<T>(set: Set<T>, item: T, max: number): void {
  set.add(item)
  for (const old of set) {
    if (set.size <= max) break
    set.delete(old)
  }
}

const labels = (): Record<PushActionId, string> => ({
  read: t('sync.notify.action.read'), archive: t('sync.notify.action.archive'), reply: t('sync.notify.action.reply')
})

const deps = () => ({ exec, open: openLink })

/** Yerel mod motor sinyaliyle, sunucu modu ServerLink ile yapar */
export function configureNotifications(o: { os: Os; exec: NotifyExec; onFailed(error: string): void }): void {
  platform = o.os
  exec = o.exec
  onFailed = o.onFailed
}

/** win32: `whenReady` içinde. Etkinleştirme bildirim nesnesi toplanmış ya da uygulama kapalıyken de gelir */
export function startToastActivation(): void {
  let cold = true
  setTimeout(() => { cold = false }, COLD_START_MS)
  Notification.handleActivation((details) => void routeToast(details.arguments, cold, deps()))
}

export function showNative(n: NativeNotification): void {
  if (!Notification.isSupported()) return
  const a: Activation = { action: 'open', messageId: n.messageId, accountId: n.accountId }
  if (platform === 'win32') {
    const shown = new Notification({
      toastXml: buildToastXml({ ...n, labels: labels(), urgent: n.level === 'urgent', iconPath: null })
    })
    keep(shown)
    return shown.show()
  }
  const shown = new Notification({
    title: n.title,
    body: n.body,
    id: n.tag,
    ...(n.accountId != null ? { groupId: String(n.accountId) } : {}),
    actions: macActions(n.actions, labels())
  })
  keep(shown)
  shown.on('click', () => { live.delete(shown); void routeActivation(a, deps()) })
  shown.on('action', (details) => {
    live.delete(shown)
    const action = n.actions[details.actionIndex]
    if (action) void routeActivation({ ...a, action }, deps())
  })
  shown.on('failed', (_e, error) => onFailed(error)) // imzasız derlemede beklenir; içerik yazılmaz
  shown.show()
}

function keep(n: Notification): void {
  keepBounded(live, n, MAX_LIVE)
  n.on('close', () => live.delete(n))
}
