#!/usr/bin/env node
// src/shared/i18n/locales/<dil>/<alan>.ts dosyalarından şunları üretir:
//   locales/<dil>.bundle.ts  — dilin tüm alanları tek nesnede (her dil ayrı parça olarak paketlenir)
//   locales/index.ts         — tr + en her zaman yüklü (geri düşüş); diğer diller LOADERS ile istenince
//   locales/all.ts           — tüm dilleri eşzamanlı kaydeder (main, sync ve testler; boyut orada önemsiz)
// CROSS_LOCALE: dil yüklenmemiş olsa da her dilde tanınması gereken birkaç şablon (ör. şifre reddi
// duraklaması, DB'deki eski dilde yazılmış durum metni için). Her alanın anahtarları zaten "alan.anahtar"
// biçiminde yazılır; burada yalnız birleştirilir.
// Kullanım: node scripts/i18n-index.mjs   (i18n testi üretilen dosyaların güncel olduğunu denetler)
import { readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

process.removeAllListeners('warning') // .ts kataloglar doğrudan içe aktarılır; tür belirsizliği uyarısı gereksiz
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'shared', 'i18n', 'locales')
const EAGER = ['tr', 'en']
const CROSS_KEYS = ['sync.status.authPaused']
const HEAD = '// OTOMATİK ÜRETİLDİ — node scripts/i18n-index.mjs'

const langs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
const ns = (lang) => readdirSync(join(root, lang)).filter((f) => f.endsWith('.ts')).sort().map((f) => f.replace(/\.ts$/, ''))
const ident = (s) => s.replace(/[^a-z0-9]/gi, '_')
const write = (file, lines) => writeFileSync(join(root, file), lines.join('\n') + '\n')

const cross = Object.fromEntries(CROSS_KEYS.map((k) => [k, []]))
for (const lang of langs) {
  const names = ns(lang)
  write(`${lang}.bundle.ts`, [
    HEAD,
    ...names.map((n) => `import ${ident(n)} from './${lang}/${n}'`),
    '',
    `export default { ${names.map((n) => `...${ident(n)}`).join(', ')} } as Record<string, string>`
  ])
  for (const n of names) {
    const mod = await import(pathToFileURL(join(root, lang, `${n}.ts`)).href)
    for (const k of CROSS_KEYS) if (mod.default[k] !== undefined) cross[k].push(mod.default[k])
  }
}

const lazy = langs.filter((l) => !EAGER.includes(l))
write('index.ts', [
  HEAD,
  "import type { Locale } from './meta'",
  ...EAGER.filter((l) => langs.includes(l)).map((l) => `import ${ident(l)} from './${l}.bundle'`),
  '',
  '/** yüklü kataloglar; diğer diller ensureLocale() ile eklenir */',
  `export const CATALOGS: Partial<Record<Locale, Record<string, string>>> = { ${EAGER.filter((l) => langs.includes(l)).join(', ')} }`,
  '',
  '/** her dil ayrı parça: yalnız seçilen dil indirilir */',
  'export const LOADERS: Partial<Record<Locale, () => Promise<Record<string, string>>>> = {',
  lazy.map((l) => `  ${l}: () => import('./${l}.bundle').then((m) => m.default)`).join(',\n'),
  '}',
  '',
  '/** dil yüklenmeden de tanınması gereken şablonların tüm dillerdeki hâli */',
  `export const CROSS_LOCALE: Record<string, readonly string[]> = ${JSON.stringify(cross, null, 2)}`
])
write('all.ts', [
  HEAD,
  '// Yan etkili: tüm dilleri eşzamanlı kaydeder. main ve sync bunu içe aktarır; renderer aktarmaz.',
  "import { CATALOGS } from './index'",
  ...lazy.map((l) => `import ${ident(l)} from './${l}.bundle'`),
  '',
  `Object.assign(CATALOGS, { ${lazy.join(', ')} })`
])
console.log(`i18n dizini: ${langs.length} dil (${lazy.length} istenince yüklenir)`, existsSync(join(root, 'tr')) ? '' : '(tr yok!)')
