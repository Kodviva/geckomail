// Vurgu-odaklı tema motoru. Seçilen renk hem vurgu (--accent/--ok) olur hem de nötr
// zemini hafifçe kendine çeker (color-mix ile). Nötrlerin PARLAKLIK rampası korunur,
// yalnız ton kayar → kontrast asla bozulmaz. Böylece tüm temalar tek küçük tablodan türer.
import { t } from '../../shared/i18n'

export interface ThemePack {
  id: string // görünen ad: themePackName(id) → set.theme.<id>
  light: string // açık tema vurgusu (koyu bg üstünde okunur)
  dark: string // koyu tema vurgusu
  tint: number // nötrleri vurguya çekme yüzdesi (0 = dokunma)
}

export const THEME_PACKS: ThemePack[] = [
  // açık tema vurguları beyaz yazıyla WCAG AA (≥4.5) geçer — bkz. themes.test (30 Eyl: gecko/kor koyulaştırıldı)
  { id: 'gecko', light: '#4d7519', dark: '#b2d552', tint: 0 },
  { id: 'ocean', light: '#0e7490', dark: '#45c7d8', tint: 8 },
  { id: 'grape', light: '#7c3aed', dark: '#b794f6', tint: 8 },
  { id: 'ember', light: '#a8540a', dark: '#f0a83a', tint: 8 },
  { id: 'rose', light: '#be185d', dark: '#f27ba6', tint: 8 },
  { id: 'slate', light: '#3b6fb0', dark: '#7fa8dc', tint: 4 }
]

/** Paketin görünen adı (seçili dilde) */
export function themePackName(id: string): string {
  return t(`set.theme.${id}`)
}

// gecko nötr rampası = styles.css varsayılanı. color-mix taban değeri gerektiğinden burada
// tekrar edilir; styles.css'teki :root nötrleri değişirse burası da güncellenmeli.
const BASE = {
  light: { bg: '#f4f6f1', panel: '#ffffff', hover: '#eef1e9', active: '#e2e9d8', dim: '#667060', border: '#d6ddce' },
  dark: { bg: '#10140f', panel: '#171c15', hover: '#1e251b', active: '#262e22', dim: '#8d9a87', border: '#2a3325' }
}

const CUSTOM_TINT = 6

// zemine göre otomatik okunur mürekkep (WCAG bağıl parlaklık)
export function inkFor(hex: string): string {
  const n = hex.replace('#', '')
  if (n.length !== 6) return '#ffffff'
  const ch = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
  const lin = (v: number): number => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  const L = 0.2126 * lin(ch[0]) + 0.7152 * lin(ch[1]) + 0.0722 * lin(ch[2])
  // sabit eşik (L > 0.4) orta parlaklıkta yanılıyordu: #b794f6 üstünde beyaz 2.45:1 idi.
  // İki mürekkepten kontrastı yüksek olanı seç (koyu mürekkep #141a05, L ≈ 0.0085)
  const vsWhite = 1.05 / (L + 0.05)
  const vsDark = (L + 0.05) / (0.0085 + 0.05)
  return vsDark > vsWhite ? '#141a05' : '#ffffff'
}

function block(sel: string, base: typeof BASE.light, accent: string, tint: number): string {
  const mix = (c: string): string => (tint > 0 ? `color-mix(in srgb, ${c}, ${accent} ${tint}%)` : c)
  return (
    `${sel}{--accent:${accent};--ok:${accent};--accent-ink:${inkFor(accent)};` +
    `--bg:${mix(base.bg)};--bg-panel:${mix(base.panel)};--bg-hover:${mix(base.hover)};` +
    `--bg-active:${mix(base.active)};--text-dim:${mix(base.dim)};--border:${mix(base.border)};}`
  )
}

// açık + koyu + sistem-koyu bloklarını styles.css yapısını birebir aynalayarak üretir
function themeCss(light: string, dark: string, tint: number): string {
  return (
    block(':root', BASE.light, light, tint) +
    block(":root[data-theme='dark']", BASE.dark, dark, tint) +
    `@media (prefers-color-scheme: dark){${block(":root:not([data-theme='light'])", BASE.dark, dark, tint)}}`
  )
}

let styleEl: HTMLStyleElement | null = null

export function applyTheme(packId: string, custom: { light: string; dark: string } | null): void {
  let css = ''
  if (custom) css = themeCss(custom.light, custom.dark, CUSTOM_TINT)
  else {
    const p = THEME_PACKS.find((x) => x.id === packId)
    if (p && p.tint > 0) css = themeCss(p.light, p.dark, p.tint) // gecko (tint 0) → CSS varsayılanına bırak
  }
  if (!css) {
    styleEl?.remove()
    styleEl = null
    return
  }
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'gecko-theme'
    document.head.appendChild(styleEl)
  }
  styleEl.textContent = css
}

// açılışta senkron uygula (render'dan önce → flash yok)
export function applyStoredTheme(): void {
  if (typeof localStorage === 'undefined') return
  const pack = localStorage.getItem('gecko-theme-pack') || 'gecko'
  let custom: { light: string; dark: string } | null = null
  try {
    custom = JSON.parse(localStorage.getItem('gecko-accent') || 'null')
  } catch {
    custom = null
  }
  applyTheme(pack, pack === 'custom' ? custom : null)
}
