// Giriş öncesi ekranlarda (giriş, ilk kurulum) dil seçimi: karşılamada yanlış dil seçilirse ya da
// başka biri oturum açacaksa ayarlara girmeden dil değiştirilebilsin. Küre simgesi her dilde tanınır.
import { isLocale, LOCALES, t } from '../../../shared/i18n'
import { applyLocale, getLocale } from '../locale'

export default function LanguagePicker() {
  const cur = LOCALES.find((l) => l.id === getLocale())
  return (
    <label className="lang-picker" title={t('settings.language')}>
      <svg className="icon" aria-hidden="true">
        <use href="#i-globe" />
      </svg>
      <span className="lang-picker-cur" aria-hidden="true">
        {cur?.name}
      </span>
      <select
        value={getLocale()}
        onChange={(e) => {
          if (isLocale(e.target.value)) void applyLocale(e.target.value)
        }}
        aria-label={t('settings.language')}
      >
        {LOCALES.map((l) => (
          <option key={l.id} value={l.id}>
            {l.flag} {l.name}
          </option>
        ))}
      </select>
    </label>
  )
}
