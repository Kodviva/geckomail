// Arayüz dili renderer'ın localStorage'ında; main açılış iletişim kutuları (geri yükleme hatası, ölümcül
// sync hatası) renderer yüklenmeden çıkabilir → son seçim userData/locale dosyasında da tutulur.
// Kayıt yoksa renderer'ın karşılamadaki gibi sistem dili.
import { app, systemPreferences } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { detectLocale, isLocale, setLocale } from '../shared/i18n'

const localeFile = (): string => join(app.getPath('userData'), 'locale')
/** kullanıcının seçtiği dil (dosyada kayıtlı); pencereye açılış argümanıyla geçer: renderer'ın yerel
 *  deposu boşsa (silinmiş, farklı köken) dil yeniden sorulmasın */
let savedLocale: string | null = null
export const localeArgs = (): string[] => (savedLocale ? [`--gecko-locale=${savedLocale}`] : [])

export function loadLocale(): void {
  try {
    const saved = readFileSync(localeFile(), 'utf-8').trim()
    if (isLocale(saved)) {
      savedLocale = saved
      setLocale(saved)
      return syncAppleLanguages(saved)
    }
  } catch {
    /* ilk açılış */
  }
  setLocale(detectLocale(app.getPreferredSystemLanguages()))
}

export function saveLocale(l: string): void {
  try {
    writeFileSync(localeFile(), l)
    savedLocale = l
  } catch {
    /* bir sonraki açılışta sistem diline düşer */
  }
  syncAppleLanguages(l)
}

// macOS'un menülere kendi eklediği öğeler (Dikte, Emoji ve Semboller, Otomatik Doldur, pencere
// yerleşimi…) ve sistem iletişim kutularının düğmeleri uygulamanın AppleLanguages ayarını izler.
// Uygulama diliyle eşitlenir; AppKit bunu açılışta okuduğundan etkisi bir sonraki açılışta görünür.
// Yalnız paketli sürümde: dev'de alan adı ortak "Electron" uygulamasınınkidir.
const APPLE_LANG: Record<string, string> = { zh: 'zh-Hans', pt: 'pt-BR' }
function syncAppleLanguages(l: string): void {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  try {
    const want = APPLE_LANG[l] ?? l
    const cur = systemPreferences.getUserDefault('AppleLanguages', 'array') as string[] | undefined
    if (cur?.[0] !== want) systemPreferences.setUserDefault('AppleLanguages', 'array', [want])
  } catch {
    /* sistem öğeleri sistem dilinde kalır */
  }
}
