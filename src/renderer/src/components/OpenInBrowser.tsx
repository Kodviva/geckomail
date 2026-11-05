// Mobilde bulunmayan işler (S4: 2FA, passkey, yedek, yönetim): sunucu adresi sistem tarayıcısında açılır. Dokunma olayında çağrılır.
import { useState } from 'react'
import { t } from '../../../shared/i18n'
import { platform } from '../platform'

export function OpenInBrowser() {
  const [failed, setFailed] = useState(false)
  const open = async (): Promise<void> => {
    setFailed(!platform.serverOrigin || !(await platform.openOAuthUrl(platform.serverOrigin)))
  }
  return (
    <>
      <button type="button" onClick={() => void open()}>{t('mobile.browser.open')}</button>
      {failed && <span className="auth-error" role="alert">{t('mobile.browser.failed')}</span>}
    </>
  )
}

/** Ayarlar satırı: metin + düğme */
export function BrowserOnlyField({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="set-group" data-testid="browser-only">
      <div className="set-field">
        <div className="sf-l"><div className="sf-t">{title}</div><div className="sf-h">{hint}</div></div>
        <div className="sf-c"><OpenInBrowser /></div>
      </div>
    </div>
  )
}
