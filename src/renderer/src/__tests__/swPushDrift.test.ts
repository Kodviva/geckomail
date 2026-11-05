import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { deviceLabel } from '../swPush'

// SW paketi sayfayla modül paylaşamaz: dört yardımcı iki dosyada çoğaltılır. Kopyalar ayrışırsa (biri düzeltilir,
// öbürü unutulur) bu test düşer.
const read = (f: string): string => readFileSync(new URL(`../${f}`, import.meta.url), 'utf-8')

/** Üst düzey bildirim: ilk sütundaki `}` ile biter; yorumlar, `export` ve boşluk farkı yok sayılır */
function declaration(src: string, name: string): string {
  const m = new RegExp(`^(?:export )?(?:async )?(?:const|function) ${name}\\b[\\s\\S]*?\\n}`, 'm').exec(src)
  if (!m) throw new Error(`${name} bulunamadı`)
  return m[0]
    .replace(/^export /, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('SW ve sayfa kopyaları aynı kalır', () => {
  const sw = read('swPush.ts')
  const pairs: [string, string, string][] = [
    ['sameEvent', 'webNotify.ts', read('webNotify.ts')],
    ['withShowLock', 'webNotify.ts', read('webNotify.ts')],
    ['b64urlToBytes', 'webPushClient.ts', read('webPushClient.ts')],
    ['deviceLabel', 'webPushClient.ts', read('webPushClient.ts')]
  ]
  for (const [name, file, page] of pairs) {
    it(`${name}: swPush.ts = ${file}`, () => {
      expect(declaration(page, name)).toBe(declaration(sw, name))
    })
  }
})

describe('iPad etiketi', () => {
  const IPADOS = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
  const IPAD_OLD = 'Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 Mobile/15E148 Safari/604.1'

  it('iPadOS (Mac UA + dokunmatik) iOS, dokunmatiksiz Mac macOS', () => {
    expect(deviceLabel(IPADOS, 5)).toBe('Safari · iOS')
    expect(deviceLabel(IPADOS, 0)).toBe('Safari · macOS')
    expect(deviceLabel(IPADOS)).toBe('Safari · macOS')
    expect(deviceLabel(IPAD_OLD)).toBe('Safari · iOS')
  })
})
