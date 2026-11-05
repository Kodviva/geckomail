// İlk açılış: dil seçimi (NetNazar karşılama ekranıyla aynı dil). Büyük selamlama desteklenen
// dillerde döner; seçili dil vurgulanır, "Devam" seçimi kaydeder. Görsel dil giriş ekranıyla aynı:
// arkada kırpan büyük maskot, ortada fareyi takip eden gözlü logo (eyeTracker DOM'dan bulur).
import { useEffect, useState } from 'react'
import { LOCALES, t, type Locale } from '../../../shared/i18n'
import { applyLocale, getLocale } from '../locale'
import LogoMark from './LogoMark'

export default function Welcome({ onDone }: { onDone: () => void }) {
  const [sel, setSel] = useState<Locale>(getLocale())
  const [hello, setHello] = useState(0)

  useEffect(() => {
    // seçilen dilin selamlamasıyla başla, sonra diller arasında dön (hareket azaltılmışsa sabit)
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const id = setInterval(() => setHello((i) => (i + 1) % LOCALES.length), 2200)
    return () => clearInterval(id)
  }, [])

  const pick = (l: Locale) => {
    setSel(l)
    void applyLocale(l, false) // önizleme: metinler hemen seçilen dile geçer
    setHello(LOCALES.findIndex((x) => x.id === l))
  }

  const cur = LOCALES[hello]
  return (
    <div className="welcome auth-screen" dir="ltr">
      <div className="dragbar" />
      <LogoMark className="logo-mark auth-bleed" />
      <div className="welcome-hero">
        <LogoMark className="logo-mark welcome-mark" />
        <h1 key={cur.id} className="welcome-hello" lang={cur.id} dir={cur.dir}>
          {cur.hello}
        </h1>
        <div className="auth-wordmark welcome-wordmark">
          Gecko<span>Mail</span>
        </div>
        <p className="welcome-tagline">{t('welcome.tagline')}</p>
      </div>
      <div className="welcome-pick">
        <div className="welcome-label">{t('welcome.chooseLanguage')}</div>
        <div className="welcome-langs" role="radiogroup" aria-label={t('welcome.chooseLanguage')}>
          {LOCALES.map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={sel === l.id}
              className={`welcome-lang ${sel === l.id ? 'on' : ''}`}
              onClick={() => pick(l.id)}
              lang={l.id}
              dir={l.dir}
            >
              <span className="welcome-flag" aria-hidden="true">
                {l.flag}
              </span>
              {l.name}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="primary welcome-go"
          onClick={() => {
            void applyLocale(sel).then(onDone)
          }}
        >
          {t('welcome.continue')}
        </button>
      </div>
    </div>
  )
}
