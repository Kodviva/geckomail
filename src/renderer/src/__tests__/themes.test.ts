import { describe, expect, it } from 'vitest'
import { inkFor, THEME_PACKS } from '../themes'

// Kritik yol: vurgu üstündeki yazı her zaman okunur olmalı (koyu vurgu→beyaz, açık vurgu→koyu).
describe('inkFor', () => {
  it('koyu/doygun vurgularda beyaz mürekkep seçer', () => {
    expect(inkFor('#4d7519')).toBe('#ffffff') // olive (açık tema vurgusu)
    expect(inkFor('#0e7490')).toBe('#ffffff') // teal
    expect(inkFor('#7c3aed')).toBe('#ffffff') // mor
    expect(inkFor('#be185d')).toBe('#ffffff') // magenta
  })
  it('açık/parlak vurgularda koyu mürekkep seçer', () => {
    expect(inkFor('#b2d552')).toBe('#141a05') // lime (koyu tema vurgusu)
    expect(inkFor('#f0a83a')).toBe('#141a05') // amber
    expect(inkFor('#45c7d8')).toBe('#141a05') // camgöbeği
  })
  it('bozuk girişte güvenli varsayılan döner', () => {
    expect(inkFor('#xyz')).toBe('#ffffff')
  })
})

function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const c = [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

describe('tema kontrastı (WCAG AA)', () => {
  it('her paketin açık ve koyu vurgusu kendi mürekkebiyle ≥ 4.5:1', () => {
    for (const p of THEME_PACKS) {
      expect(contrast(p.light, inkFor(p.light)), `${p.id} açık`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.dark, inkFor(p.dark)), `${p.id} koyu`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
