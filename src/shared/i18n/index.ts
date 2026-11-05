// Çeviri çekirdeği — masaüstü (renderer + sync + main) ve ileride mobil aynı kataloğu kullanır.
// Bağımlılıksız: düz anahtar → metin. Kaynak dil Türkçe (locales/tr); eksik anahtar önce İngilizceye,
// sonra Türkçeye düşer, o da yoksa anahtarın kendisi görünür (testte yakalanır).
//
// Kullanım:  t('list.empty')  ·  t('toast.sent', { count: 3 })  ·  t('acct.added', { email })
// Değişken: {ad}. Çoğul: anahtar_one / anahtar_other (+ dile göre _few, _many …), vars.count ile seçilir.
import { CATALOGS, LOADERS } from './locales'
import { LOCALES, type Locale } from './locales/meta'
import { biometricName, platformText, type UiOs } from '../platformText'

export { LOCALES, type Locale } from './locales/meta'

let current: Locale = 'tr'
// Sunucuda bir bağlantının RPC'si sürerken o oturumun dili (AsyncLocalStorage src/sync/sessionLocale.ts'te:
// bu dosya tarayıcıya da gider, node modülü alamaz). Sağlayıcı yoksa ya da bağlam yoksa süreç dili.
let localeContext: (() => Locale | undefined) | null = null
const listeners = new Set<(l: Locale) => void>()
// Metnin göründüğü işletim sistemi. Bağlama noktaları: renderer main.tsx, main index.ts, sync index.ts.
let uiOs: UiOs = 'mac'

/** İlk render'dan önce bir kez; `{biometric}` ve ⌘ kısayolları `t` çıkışında buna göre çözülür */
export function setUiOs(os: UiOs): void {
  uiOs = os
}

export function getUiOs(): UiOs {
  return uiOs
}

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && LOCALES.some((l) => l.id === v)
}

/** Etkin dil: varsa oturum bağlamı, yoksa süreç/arayüz dili */
export function getLocale(): Locale {
  return localeContext?.() ?? current
}

/** Yalnız sunucu/sync tarafı bağlar (masaüstü renderer'ında ve tarayıcıda hiç çağrılmaz) */
export function setLocaleContextProvider(fn: (() => Locale | undefined) | null): void {
  localeContext = fn
}

export function setLocale(l: Locale): void {
  if (l === current) return
  current = l
  for (const cb of listeners) cb(l)
}

/** Dilin kataloğunu yükler (renderer'da her dil ayrı parça; main/sync'te locales/all hepsini baştan kaydeder).
 *  Yüklenemezse dil yine seçilebilir; eksik metinler İngilizceye düşer. */
export async function ensureLocale(l: Locale): Promise<void> {
  if (CATALOGS[l]) return
  const load = LOADERS[l]
  if (!load) return
  try {
    CATALOGS[l] = await load()
  } catch {
    /* geri düşüş: en → tr */
  }
}

export function onLocaleChange(cb: (l: Locale) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Sistem dilinden en yakın desteklenen dil (ör. "pt-PT" → pt, "zh-Hant" → zh); yoksa İngilizce */
export function detectLocale(preferred: readonly string[]): Locale {
  for (const p of preferred) {
    const base = p.toLowerCase().split(/[-_]/)[0]
    if (isLocale(base)) return base
  }
  return 'en'
}

/** Tarih/sayı biçimlemesi için BCP 47 etiketi (Intl, toLocaleString) */
export function intlTag(l: Locale = getLocale()): string {
  return LOCALES.find((x) => x.id === l)?.intl ?? 'en-US'
}

export function dirOf(l: Locale = getLocale()): 'ltr' | 'rtl' {
  return LOCALES.find((x) => x.id === l)?.dir ?? 'ltr'
}

const plural = new Map<string, Intl.PluralRules>()

function lookup(l: Locale, key: string): string | undefined {
  return CATALOGS[l]?.[key]
}

export function t(key: string, vars?: Record<string, string | number | null | undefined>): string {
  return tFor(getLocale(), key, vars)
}

/** Seçili dilden bağımsız, verilen dilde metin (ör. sunucunun Accept-Language'e göre verdiği sayfa) */
export function tFor(loc: Locale, key: string, vars?: Record<string, string | number | null | undefined>): string {
  // aday anahtarlar: çoğulda dile özgü kategori, sonra _other, sonra tekil anahtar
  let cands = [key]
  if (vars && typeof vars.count === 'number') {
    let pr = plural.get(loc)
    if (!pr) plural.set(loc, (pr = new Intl.PluralRules(intlTag(loc))))
    cands = [`${key}_${pr.select(vars.count)}`, `${key}_other`, key]
  }
  // önce seçili dilin kendi biçimleri (Türkçede _one olmayabilir → _other), sonra İngilizce, sonra Türkçe
  let raw: string | undefined
  for (const l of [loc, 'en', 'tr'] as Locale[]) {
    for (const c of cands) {
      raw = lookup(l, c)
      if (raw !== undefined) break
    }
    if (raw !== undefined) break
  }
  raw ??= key
  const filled = raw.replace(/\{(\w+)\}/g, (m, name: string) => {
    if (name === 'biometric') return biometricName(uiOs) ?? 'Touch ID'
    const v = vars?.[name]
    if (v === undefined || v === null) return m
    return typeof v === 'number' ? v.toLocaleString(intlTag(loc)) : v
  })
  return platformText(filled, uiOs)
}

// ---- biçimleme: 'tr-TR' sabitlerinin yerine ----

export function fmtDate(ts: number | Date, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(ts).toLocaleDateString(intlTag(), opts)
}

export function fmtTime(ts: number | Date, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(ts).toLocaleTimeString(intlTag(), opts ?? { hour: '2-digit', minute: '2-digit' })
}

export function fmtDateTime(ts: number | Date, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(ts).toLocaleString(intlTag(), opts)
}

export function fmtNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return n.toLocaleString(intlTag(), opts)
}

/** "3 dk önce" gibi göreli zaman */
export function fmtRelative(ts: number, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(intlTag(), { numeric: 'auto' })
  const s = Math.round((ts - now) / 1000)
  const a = Math.abs(s)
  if (a < 60) return rtf.format(s, 'second')
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute')
  if (a < 86_400) return rtf.format(Math.round(s / 3600), 'hour')
  return rtf.format(Math.round(s / 86_400), 'day')
}

/** Türkçe dışında büyük/küçük harf dönüşümü için (ı/İ sorunları) */
export function lower(s: string): string {
  return s.toLocaleLowerCase(intlTag())
}
