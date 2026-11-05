// OTOMATİK ÜRETİLDİ — node scripts/i18n-index.mjs
import type { Locale } from './meta'
import tr from './tr.bundle'
import en from './en.bundle'

/** yüklü kataloglar; diğer diller ensureLocale() ile eklenir */
export const CATALOGS: Partial<Record<Locale, Record<string, string>>> = { tr, en }

/** her dil ayrı parça: yalnız seçilen dil indirilir */
export const LOADERS: Partial<Record<Locale, () => Promise<Record<string, string>>>> = {
  ar: () => import('./ar.bundle').then((m) => m.default),
  de: () => import('./de.bundle').then((m) => m.default),
  es: () => import('./es.bundle').then((m) => m.default),
  fr: () => import('./fr.bundle').then((m) => m.default),
  hi: () => import('./hi.bundle').then((m) => m.default),
  ja: () => import('./ja.bundle').then((m) => m.default),
  pt: () => import('./pt.bundle').then((m) => m.default),
  ru: () => import('./ru.bundle').then((m) => m.default),
  zh: () => import('./zh.bundle').then((m) => m.default)
}

/** dil yüklenmeden de tanınması gereken şablonların tüm dillerdeki hâli */
export const CROSS_LOCALE: Record<string, readonly string[]> = {
  "sync.status.authPaused": [
    "رُفضت كلمة المرور — ستُعاد المحاولة مرة واحدة عند {time}",
    "Passwort abgelehnt – einmaliger neuer Versuch um {time}",
    "Password rejected — will retry once at {time}",
    "Contraseña rechazada — se volverá a intentar una vez a las {time}",
    "Mot de passe refusé — nouvel essai unique à {time}",
    "पासवर्ड अस्वीकार हुआ — {time} पर एक बार फिर कोशिश की जाएगी",
    "パスワードが拒否されました — {time} にもう一度だけ再試行します",
    "Senha recusada — mais uma tentativa às {time}",
    "Пароль отклонён — ещё одна попытка в {time}",
    "Şifre reddedildi — {time}'de bir kez daha denenecek",
    "密码被拒绝 — 将于 {time} 再重试一次"
  ]
}
