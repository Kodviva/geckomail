// Oturum dili: sunucu modunda her RPC çağrısı istemcinin dilinde çalışır (hata iletileri, sunucunun ürettiği
// metinler). Tek süreçte birden çok dil olduğundan genel setLocale değil AsyncLocalStorage. Bu dosya yalnız
// sync/sunucu tarafında yüklenir: tarayıcı derlemesine node modülü girmez. Masaüstünde bağlam hiç açılmaz.
import { AsyncLocalStorage } from 'node:async_hooks'
import { setLocaleContextProvider, t, type Locale } from '../shared/i18n'

const context = new AsyncLocalStorage<{ locale: Locale | undefined }>()
setLocaleContextProvider(() => context.getStore()?.locale)

/** Herkesin gördüğü, kalıcı metinler (hesap durumu, kural günlüğü) o an hangi oturumun çağrısı sürüyor olursa olsun
 *  süreç dilinde üretilir. Yalnız eşzamanlı işler: bağlam fn dönene kadar kapalıdır. */
export function inProcessLocale<T>(fn: () => T): T {
  return context.run({ locale: undefined }, fn)
}

/** t() süreç dilinde */
export function tProcess(key: string, vars?: Record<string, string | number | null | undefined>): string {
  return inProcessLocale(() => t(key, vars))
}

/** fn oturum dilinde çalışır. Bağlam fn bitince kapanır: handler'ın başlatıp beklemediği iş (zamanlayıcı döngüsü,
 *  gecikmeli yayın) AsyncLocalStorage'ı miras alsa da o oturumun dilinde kalmaz, süreç diline döner. */
export async function runWithLocale<T>(locale: Locale | null, fn: () => Promise<T>): Promise<T> {
  if (!locale) return fn()
  const store: { locale: Locale | undefined } = { locale }
  try {
    return await context.run(store, fn)
  } finally {
    store.locale = undefined
  }
}
