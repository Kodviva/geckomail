// "GeckoMail · Kodviva" atfı ve kaynak bağlantısı: giriş ekranlarında ve Ayarlar › Genel'de. Değiştirilmiş sürümde de kalır (NOTICE).
import { ATTRIBUTION, SOURCE_URL } from '../../../shared/brand'
import { t } from '../../../shared/i18n'

export default function Attribution({ version }: { version?: string }) {
  return (
    <span data-testid="attribution">
      {ATTRIBUTION}{version ? ` ${version}` : ''} · <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">{t('set.about.source')}</a>
    </span>
  )
}
