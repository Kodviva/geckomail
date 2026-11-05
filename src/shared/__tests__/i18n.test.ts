import { execFileSync } from 'child_process'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectLocale, ensureLocale, fmtNumber, LOCALES, setLocale, t } from '../i18n'
import { CATALOGS, CROSS_LOCALE, LOADERS } from '../i18n/locales'
import '../i18n/locales/all'

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
const base = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, '')

describe('çeviri kataloğu', () => {
  afterEach(() => setLocale('tr'))
  const tr = CATALOGS.tr!

  it('üretilen dosyalar güncel (node scripts/i18n-index.mjs)', () => {
    const dir = join(__dirname, '..', 'i18n', 'locales')
    const generated = () =>
      Object.fromEntries(readdirSync(dir).filter((f) => f === 'index.ts' || f === 'all.ts' || f.endsWith('.bundle.ts')).map((f) => [f, readFileSync(join(dir, f), 'utf-8')]))
    const before = generated()
    execFileSync('node', [join(__dirname, '..', '..', '..', 'scripts', 'i18n-index.mjs')])
    expect(generated()).toEqual(before)
  })

  it('tr/en hep yüklü, diğer diller ayrı parça ve istenince yüklenir; dil ötesi şablonlar tam', async () => {
    for (const l of LOCALES) expect(l.id === 'tr' || l.id === 'en' || typeof LOADERS[l.id] === 'function').toBe(true)
    const ja = CATALOGS.ja
    delete CATALOGS.ja
    await ensureLocale('ja')
    expect(CATALOGS.ja).toEqual(ja)
    expect(CROSS_LOCALE['sync.status.authPaused']).toHaveLength(LOCALES.length)
  })

  it('her dilde Türkçe anahtarların tamamı var, fazlası yok', () => {
    const trBases = new Set(Object.keys(tr).map(base))
    for (const l of LOCALES) {
      const cat = CATALOGS[l.id]
      if (!cat) continue // henüz çevrilmemiş dil: İngilizceye düşer
      const missing = [...trBases].filter((k) => !Object.keys(cat).some((x) => base(x) === k))
      const extra = Object.keys(cat).filter((k) => !trBases.has(base(k)))
      expect({ lang: l.id, missing: missing.slice(0, 20) }).toEqual({ lang: l.id, missing: [] })
      expect({ lang: l.id, extra: extra.slice(0, 20) }).toEqual({ lang: l.id, extra: [] })
    }
  })

  it('değişkenler çeviride korunur', () => {
    for (const l of LOCALES) {
      const cat = CATALOGS[l.id]
      if (!cat || l.id === 'tr') continue
      for (const [k, v] of Object.entries(cat)) {
        const src = tr[k] ?? tr[`${base(k)}_other`] ?? tr[base(k)]
        if (src === undefined) continue
        // çoğul biçimlerde {count} isteğe bağlı: Rusçada _one 21'i de kapsar, sayıyı yazmak gerekir
        const strip = (xs: string[]) => (k !== base(k) ? xs.filter((x) => x !== 'count') : xs)
        expect({ lang: l.id, k, vars: strip(vars(v)) }).toEqual({ lang: l.id, k, vars: strip(vars(src)) })
      }
    }
  })

  it('geri düşüş: eksik dil → İngilizce → Türkçe → anahtar; değişken ve çoğul', () => {
    setLocale('de')
    expect(t('welcome.continue')).toBe(CATALOGS.de?.['welcome.continue'] ?? CATALOGS.en!['welcome.continue'])
    expect(t('yok.boyle.bir.anahtar')).toBe('yok.boyle.bir.anahtar')
    setLocale('tr')
    expect(fmtNumber(1234.5)).toBe('1.234,5')
  })

  it('çoğul: seçili dilin _other biçimi başka dilin _one biçiminden önce gelir', async () => {
    const { CATALOGS: C } = await import('../i18n/locales')
    C.tr!['test.items_other'] = '{count} öğe'
    C.en!['test.items_one'] = '{count} item'
    C.en!['test.items_other'] = '{count} items'
    setLocale('tr')
    expect(t('test.items', { count: 1 })).toBe('1 öğe')
    setLocale('en')
    expect(t('test.items', { count: 1 })).toBe('1 item')
    expect(t('test.items', { count: 2 })).toBe('2 items')
    for (const k of ['test.items_other', 'test.items_one']) {
      delete C.tr![k]
      delete C.en![k]
    }
  })

  it('sistem dilinden seçim', () => {
    expect(detectLocale(['pt-PT', 'en-US'])).toBe('pt')
    expect(detectLocale(['zh-Hant-TW'])).toBe('zh')
    expect(detectLocale(['ko-KR'])).toBe('en')
  })
})
