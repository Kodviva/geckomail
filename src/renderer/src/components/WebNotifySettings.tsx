import { useEffect, useState } from 'react'
import { t } from '../../../shared/i18n'
import { disableWebNotify, enableWebNotify, webNotifyState } from '../webNotify'
import { disablePush, enablePush, onPushChange, pushEnabled, pushSupport } from '../webPushClient'

/** Sekme kapalıyken bildirim. İzin yalnız anahtar açılınca istenir; iOS'ta sekmede yok, ana ekrana eklemek gerekir */
function PushSetting({ onPermission }: { onPermission(): void }) {
  const support = pushSupport()
  const [on, setOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [denied, setDenied] = useState(() => support === 'ok' && Notification.permission === 'denied')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    const read = (): void => {
      void pushEnabled().then((v) => {
        if (live) setOn(v)
      })
    }
    read()
    const off = onPushChange(read) // cihaz listesinden "bu cihaz" kaldırılabilir
    return () => {
      live = false
      off()
    }
  }, [])
  const toggle = async (next: boolean): Promise<void> => {
    setBusy(true)
    setFailed(false)
    try {
      if (!next) {
        await disablePush()
        setOn(false)
        return
      }
      const r = await enablePush()
      setOn(r === 'on')
      setDenied(r === 'denied')
      setFailed(r === 'failed')
      onPermission()
    } finally {
      setBusy(false)
    }
  }
  const hint =
    support === 'needsInstall' ? t('set.notify.pushNeedsInstall')
    : support === 'unsupported' ? t('set.notify.pushUnsupported')
    : denied ? t('set.notify.pushDenied')
    : failed ? t('set.notify.pushFailed')
    : t('set.notify.pushHint')
  return (
    <div className="set-field">
      <div className="sf-l"><div className="sf-t">{t('set.notify.push')}</div><div className="sf-h">{hint}</div></div>
      <div className="sf-c">
        <input
          type="checkbox"
          aria-label={t('set.notify.pushToggle')}
          checked={on}
          disabled={busy || denied || support !== 'ok'}
          onChange={(e) => void toggle(e.target.checked)}
        />
      </div>
    </div>
  )
}

/** Web: tarayıcı bildirimi. İzin yalnız bu anahtar açılınca istenir */
export default function WebNotifySettings() {
  const [state, setState] = useState(webNotifyState)
  const [busy, setBusy] = useState(false)
  const toggle = async (on: boolean): Promise<void> => {
    if (!on) {
      disableWebNotify()
      setState(webNotifyState())
      return
    }
    setBusy(true)
    try {
      setState(await enableWebNotify())
    } finally {
      setBusy(false)
    }
  }
  const hint = state === 'denied' ? t('set.notify.webDenied') : state === 'unsupported' ? t('set.notify.webUnsupported') : t('set.notify.webHint')
  return (
    <>
      <div className="set-field">
        <div className="sf-l"><div className="sf-t">{t('set.notify.web')}</div><div className="sf-h">{hint}</div></div>
        <div className="sf-c">
          <input
            type="checkbox"
            aria-label={t('set.notify.webToggle')}
            checked={state === 'on'}
            disabled={busy || state === 'denied' || state === 'unsupported'}
            onChange={(e) => void toggle(e.target.checked)}
          />
        </div>
      </div>
      <PushSetting onPermission={() => setState(webNotifyState())} />
    </>
  )
}
