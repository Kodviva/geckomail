// Hesap durum ayrıntısının (accounts.status_detail) dilden bağımsız yorumu.
// Ayrıntı metni üretildiği andaki arayüz dilinde DB'ye yazılır; dil sonradan değişebilir. Bu yüzden
// "1. şifre reddi — HH:MM'de bir kez daha denenecek" duraklaması metnin kendisiyle değil, kataloğun
// TÜM dillerdeki şablonunun sabit öneki ({time} öncesi) ile tanınır. Scheduler (açılışta duraklamayı
// geri yükleme) ve arayüz (hesap sağlığı rozeti) aynı işlevi kullanır. Renderer yalnız seçili dili
// yüklediğinden şablonlar üretilmiş CROSS_LOCALE listesinden okunur.
import { CROSS_LOCALE } from './i18n/locales'

/** scheduler onAuthFailure'ın 1. şifre reddi iletisi: t(AUTH_PAUSED_KEY, { time }) */
export const AUTH_PAUSED_KEY = 'sync.status.authPaused'

let prefixes: string[] | null = null

function authPausedPrefixes(): string[] {
  if (prefixes) return prefixes
  const out = new Set<string>()
  for (const tpl of CROSS_LOCALE[AUTH_PAUSED_KEY] ?? []) {
    const i = tpl.indexOf('{')
    const p = (i < 0 ? tpl : tpl.slice(0, i)).trimEnd()
    if (p.length >= 4) out.add(p) // çok kısa önek her şeyi eşlemesin
  }
  return (prefixes = [...out])
}

/** Ayrıntı, 1. şifre reddi sonrası geçici duraklama mı (hangi dilde yazılmış olursa olsun)? */
export function isAuthPausedDetail(detail: string | null | undefined): boolean {
  if (!detail) return false
  return authPausedPrefixes().some((p) => detail.startsWith(p))
}
