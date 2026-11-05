// Paylaş menüsünden gelenler: yerel katman dosyayı kendi alanına kopyalar, burada aynı kökenden okunup oluşturucuya eklenir.
// Sınırlar yerelde uygulanır (kopyalama sırasında); `skipped` kaç dosyanın atıldığını söyler.
import { t } from '../../shared/i18n'
import { toNotificationLink } from './nativeLinks'
import type { GeckoNativePlugin, NativeOpen, NativeShare } from './platform/nativeBridge'
import { useStore } from './store'
import type { NotificationLink } from './webPushClient'

/** Capacitor'ın uygulama dosyası yolu; başka adres okunmaz */
const LOCAL_FILE_PREFIX = '/_capacitor_file_/'

export function mergeShares(shares: NativeShare[]): NativeShare | null {
  if (!shares.length) return null
  return {
    files: shares.flatMap((s) => s.files),
    text: shares.map((s) => s.text).filter(Boolean).join('\n') || null,
    skipped: shares.reduce((n, s) => n + (s.skipped ?? 0), 0)
  }
}

async function readShared(f: NativeShare['files'][number]): Promise<File | null> {
  if (!f.uploadPath.startsWith(LOCAL_FILE_PREFIX)) return null
  try {
    const r = await fetch(f.uploadPath)
    if (!r.ok) return null
    return new File([await r.blob()], f.name, { type: f.mime ?? '' })
  } catch {
    return null
  }
}

/** Dosyalar POST /api/upload ile gider (addAttachments), oluşturucu açılır. Kurtarılan taslak varsa paylaşılan onun üstüne eklenir */
export async function shareToComposer(s: NativeShare): Promise<void> {
  const store = useStore.getState()
  store.openComposer('new')
  const c = useStore.getState().composer
  if (!c) return
  if (s.text) useStore.setState({ composer: { ...c, text: c.text ? `${s.text}\n\n${c.text}` : s.text } })
  const read = await Promise.all(s.files.map(readShared))
  const files = read.filter((f): f is File => f !== null)
  if (s.skipped) store.toast(t('mobile.share.skipped'), 'error')
  if (files.length < read.length) store.toast(t('mobile.share.failed'), 'error')
  if (files.length) await useStore.getState().addAttachments(files)
}

/** Oturum açık, hesaplar yüklü ve kilit kapalıyken çağrılır: o zamana dek her şey yerelde bekler */
export async function drainPending(plugin: GeckoNativePlugin, open: (link: NotificationLink) => void): Promise<void> {
  const { opens, shares } = await plugin.takePending()
  opens.forEach((o: NativeOpen) => {
    const link = toNotificationLink(o)
    if (link) open(link)
  })
  const merged = mergeShares(shares)
  if (!merged) return
  try {
    await shareToComposer(merged)
  } finally {
    await plugin.sharesDone().catch(() => {})
  }
}
