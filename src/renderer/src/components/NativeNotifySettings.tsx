// Ayarlar › Bildirimler (mobil uygulama): uygulama kapalıyken bildirim. İzin yalnız anahtar açılınca istenir; reddedildiyse uygulama
// izin isteyemez, sistem ayarına yönlendirilir. Cihaz listesi yenilensin diye değişiklik onPushChange'e duyurulur.
import { useEffect, useState } from 'react'
import { t } from '../../../shared/i18n'
import { nativeBridge } from '../platform/nativeBridge'
import { notifyPushChange } from '../webPushClient'

type Status = 'on' | 'off' | 'denied' | 'unavailable'

export default function NativeNotifySettings() {
  const [status, setStatus] = useState<Status | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    const host = nativeBridge()
    void host?.plugin.pushStatus().then((r) => r.status, () => 'unavailable' as const).then((s) => {
      if (live) setStatus(s)
    })
    return () => {
      live = false
    }
  }, [])

  const toggle = async (next: boolean): Promise<void> => {
    const host = nativeBridge()
    if (!host) return
    setBusy(true)
    setFailed(false)
    try {
      if (next) {
        const r = await host.plugin.registerPush()
        setFailed(r.status === 'failed')
        setStatus(r.status === 'failed' ? 'off' : r.status)
      } else {
        await host.plugin.unregisterPush()
        setStatus('off')
      }
      notifyPushChange()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const hint =
    status === 'denied' ? t('mobile.notify.denied')
    : status === 'unavailable' ? t('mobile.notify.unavailable')
    : failed ? t('mobile.notify.failed')
    : t('mobile.notify.hint')
  return (
    <div className="set-field" data-testid="native-notify">
      <div className="sf-l"><div className="sf-t">{t('set.notify.push')}</div><div className="sf-h">{hint}</div></div>
      <div className="sf-c">
        <input
          type="checkbox" aria-label={t('set.notify.pushToggle')} checked={status === 'on'}
          disabled={busy || status === null || status === 'denied' || status === 'unavailable'}
          onChange={(e) => void toggle(e.target.checked)}
        />
      </div>
    </div>
  )
}
