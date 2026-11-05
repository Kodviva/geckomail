import { useSyncExternalStore } from 'react'
import { t } from '../../../shared/i18n'
import { acceptInstall, dismissInstall, installAvailable, subscribeInstall } from '../pwa'

/** Web: uygulamayı yükleme önerisi (tarayıcı beforeinstallprompt verdiyse) */
export default function InstallBanner() {
  const available = useSyncExternalStore(subscribeInstall, installAvailable)
  if (!available) return null
  return (
    <div className="install-banner" role="status">
      <span>{t('set.pwa.installText')}</span>
      <div className="install-banner-actions">
        <button className="primary" onClick={() => void acceptInstall()}>{t('set.pwa.install')}</button>
        <button onClick={() => dismissInstall('later')}>{t('set.pwa.notNow')}</button>
        <button onClick={() => dismissInstall('never')}>{t('set.pwa.never')}</button>
      </div>
    </div>
  )
}
