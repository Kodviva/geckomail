// Pencerelerin dış bağlantı kuralı: yalnız http/https/mailto, her zaman sistem tarayıcısında.
import { dialog, shell, type BrowserWindow } from 'electron'
import { t } from '../shared/i18n'

const WINDOW_MS = 10_000
const MAX_OPENS = 5

/** Punycode (xn--) alan adları oltalama klasiği: tek denetim noktası burası. Pencere isteği zaman uyumlu yanıtlanır, uyarı ana süreci
 *  bloklamaz. Sayfa başına sınır: düşman sayfa sistem tarayıcısını sekmeye boğamaz, uyarı yığamaz */
export function openExternalHandler(parent: () => BrowserWindow | null, now: () => number = Date.now): (d: { url: string }) => { action: 'deny' } {
  let opens: number[] = []
  let asking = false
  const open = (url: string): void => {
    const t0 = now()
    opens = opens.filter((at) => t0 - at < WINDOW_MS)
    if (opens.length >= MAX_OPENS) return
    opens.push(t0)
    void shell.openExternal(url)
  }
  const ask = async (url: string, host: string): Promise<void> => {
    if (asking) return
    asking = true
    const w = parent()
    const opts: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: [t('main.common.cancel'), t('main.common.openAnyway')],
      defaultId: 0,
      cancelId: 0,
      message: t('main.link.suspiciousTitle'),
      detail: t('main.link.suspiciousDetail', { host, url: url.slice(0, 200) })
    }
    try {
      if ((await (w ? dialog.showMessageBox(w, opts) : dialog.showMessageBox(opts))).response === 1) open(url)
    } finally {
      asking = false
    }
  }
  return ({ url }) => {
    if (!/^(https?|mailto):/i.test(url)) return { action: 'deny' }
    try {
      const host = url.startsWith('mailto:') ? '' : new URL(url).hostname
      if (host.split('.').some((p) => p.startsWith('xn--'))) void ask(url, host)
      else open(url)
    } catch {
      /* geçersiz adres açılmaz */
    }
    return { action: 'deny' }
  }
}
