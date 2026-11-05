// Arayüz dili: seçim bu cihazda saklanır (giriş öncesi de gerekir), sync'e ve main'e bildirilir.
// İlk açılışta kayıtlı seçim yoksa karşılama ekranı dili sorar. tr/en dışındaki diller ayrı parça:
// uygulamadan önce kataloğu yüklenir (yerel dosya, anında).
import { detectLocale, dirOf, ensureLocale, getLocale, isLocale, setLocale, type Locale } from '../../shared/i18n'
import { platform } from './platform'

const KEY = 'gecko-locale'

function read(): Locale | null {
  try {
    const v = localStorage.getItem(KEY)
    return isLocale(v) ? v : null
  } catch {
    return null
  }
}

/** render'dan önce: kayıtlı dili uygula; yoksa sistem dilini geçici uygula ve karşılamayı iste */
export async function bootLocale(): Promise<{ needsWelcome: boolean }> {
  // yerel depo boşsa main'in kayıtlı seçimi (paketli/dev farklı köken, depo temizlenmiş…)
  const main = platform.savedLocale()
  const fromMain = isLocale(main) ? main : null
  const saved = read() ?? fromMain
  if (saved && !read()) {
    await applyLocale(saved) // yerel depoya da yaz
    return { needsWelcome: false }
  }
  await applyLocale(saved ?? detectLocale(navigator.languages ?? [navigator.language]), false)
  if (saved) platform.setLocale(saved) // main/sync açılışta da aynı dilde olsun
  return { needsWelcome: !saved }
}

let seq = 0

export async function applyLocale(l: Locale, persist = true): Promise<void> {
  const my = ++seq
  await ensureLocale(l)
  if (my !== seq) return // arka arkaya seçimde yalnız sonuncusu uygulanır
  setLocale(l)
  document.documentElement.lang = l
  document.documentElement.dir = dirOf(l)
  if (!persist) return
  try {
    localStorage.setItem(KEY, l)
  } catch {
    /* yalnız bu oturum */
  }
  // sync (bildirimler, sunucu mesajları) ve main (menüler) aynı dili kullansın
  platform.setLocale(l)
}

export { getLocale }
