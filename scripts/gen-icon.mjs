#!/usr/bin/env node
// Marka SVG'sinden (LogoMark.tsx "dolu gözler" varyantı) macOS app ikonu üretir.
// LogoMark değişirse: `node scripts/gen-icon.mjs` → build/icon.icns + build/icon_1024.png + PWA ikonları
// (src/renderer/public/icons), build/icon.ico, tepsi simgeleri (build/trayTemplate*.png, build/tray.ico).
// `--web` yalnız PWA ikonlarını üretir.
// Gerekli: rsvg-convert (brew install librsvg), iconutil (macOS yerleşik).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BG = '#12170f' // koyu zemin = kesik göz bebekleri de bu renk (delik izlenimi)
const LIME = '#b2d552'

const MARK = `<g fill="none" stroke="${LIME}" stroke-width="40" stroke-linecap="round" stroke-linejoin="round">
    <path d="M424,486 C456,542 568,542 600,486"/>
    <rect x="292" y="606" width="440" height="250" rx="26"/>
    <path d="M292,620 L512,736 L732,620"/>
  </g>
  <circle fill="${LIME}" cx="340" cy="322" r="126"/>
  <circle fill="${LIME}" cx="684" cy="322" r="126"/>
  <circle fill="${BG}" cx="368" cy="352" r="44"/>
  <circle fill="${BG}" cx="656" cy="352" r="44"/>`

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect x="0" y="0" width="1024" height="1024" rx="224" fill="${BG}"/>
  ${MARK}
</svg>`

// maskable: zemin kenara taşar, simge ortadaki güvenli alanda (%80 çap) kalır; işletim sistemi kendi maskesini keser
const MASKABLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect x="0" y="0" width="1024" height="1024" fill="${BG}"/>
  <g transform="translate(153.6 153.6) scale(0.7)">${MARK}</g>
</svg>`

// Tepsi: tek renk, göz bebekleri saydam delik. macOS şablon görselinde rengi sistem verir; Windows'ta koyu zemin yuvarlağı
// açık ve koyu görev çubuğunda okunur
const TRAY_MARK = (ink, hole) => `<g fill="none" stroke="${ink}" stroke-width="72" stroke-linecap="round" stroke-linejoin="round">
    <rect x="212" y="580" width="600" height="340" rx="40"/>
    <path d="M212,600 L512,760 L812,600"/>
  </g>
  <mask id="m"><rect width="1024" height="1024" fill="#fff"/><circle cx="356" cy="282" r="${hole}" fill="#000"/><circle cx="668" cy="282" r="${hole}" fill="#000"/></mask>
  <g mask="url(#m)"><circle fill="${ink}" cx="316" cy="250" r="170"/><circle fill="${ink}" cx="708" cy="250" r="170"/></g>`
const TRAY_TEMPLATE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${TRAY_MARK('#000', 64)}</svg>`
const TRAY_WIN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="224" fill="${BG}"/><g transform="translate(102 102) scale(0.8)">${TRAY_MARK(LIME, 64)}</g>
</svg>`

/** PNG gömülü ICO: 6 bayt başlık, öge başına 16 bayt dizin, ardından PNG'ler. Bağımlılık gerekmez */
function ico(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length)
  head.writeUInt16LE(1, 2) // tür: simge
  head.writeUInt16LE(entries.length, 4)
  let offset = head.length
  entries.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i
    head[at] = size >= 256 ? 0 : size // 0 = 256
    head[at + 1] = size >= 256 ? 0 : size
    head.writeUInt16LE(1, at + 4) // düzlem
    head.writeUInt16LE(32, at + 6) // bit derinliği
    head.writeUInt32LE(data.length, at + 8)
    head.writeUInt32LE(offset, at + 12)
    offset += data.length
  })
  return Buffer.concat([head, ...entries.map((e) => e.data)])
}

// iconset boyutları: (dosya adı, piksel)
const SIZES = [
  ['icon_16x16', 16], ['icon_16x16@2x', 32],
  ['icon_32x32', 32], ['icon_32x32@2x', 64],
  ['icon_128x128', 128], ['icon_128x128@2x', 256],
  ['icon_256x256', 256], ['icon_256x256@2x', 512],
  ['icon_512x512', 512], ['icon_512x512@2x', 1024]
]

const root = process.cwd()
const tmp = mkdtempSync(join(tmpdir(), 'geckoicon-'))
const svgPath = join(tmp, 'icon.svg')
const maskablePath = join(tmp, 'maskable.svg')
const iconset = join(tmp, 'icon.iconset')
const webIcons = join(root, 'src', 'renderer', 'public', 'icons')
const webOnly = process.argv.includes('--web')
writeFileSync(svgPath, SVG)
writeFileSync(maskablePath, MASKABLE)
mkdirSync(iconset)
mkdirSync(webIcons, { recursive: true })

const png = (size, out, src = svgPath) =>
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), src, '-o', out])

// PWA ikonları (manifest.webmanifest)
png(192, join(webIcons, 'icon-192.png'))
png(512, join(webIcons, 'icon-512.png'))
png(512, join(webIcons, 'icon-maskable-512.png'), maskablePath)
console.log('✓ src/renderer/public/icons üretildi')

if (!webOnly) {
  for (const [name, size] of SIZES) png(size, join(iconset, `${name}.png`))

  // 1024 kaynak PNG (electron-builder yedeği + README görseli)
  const png1024 = join(root, 'build', 'icon_1024.png')
  copyFileSync(join(iconset, 'icon_512x512@2x.png'), png1024)

  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(root, 'build', 'icon.icns')])
  console.log('✓ build/icon.icns + build/icon_1024.png üretildi')

  const pngBytes = (size, src) => {
    const out = join(tmp, `p${size}.png`)
    png(size, out, src)
    return readFileSync(out)
  }
  const trayTemplate = join(tmp, 'tray-template.svg')
  const trayWin = join(tmp, 'tray-win.svg')
  writeFileSync(trayTemplate, TRAY_TEMPLATE)
  writeFileSync(trayWin, TRAY_WIN)
  png(18, join(root, 'build', 'trayTemplate.png'), trayTemplate)
  png(36, join(root, 'build', 'trayTemplate@2x.png'), trayTemplate)
  const icoOf = (sizes, src) => ico(sizes.map((size) => ({ size, data: pngBytes(size, src) })))
  writeFileSync(join(root, 'build', 'tray.ico'), icoOf([16, 20, 24, 32, 48], trayWin))
  writeFileSync(join(root, 'build', 'icon.ico'), icoOf([16, 24, 32, 48, 64, 128, 256], svgPath))
  console.log('✓ build/icon.ico + tepsi simgeleri üretildi')
}
rmSync(tmp, { recursive: true, force: true })
