#!/usr/bin/env node
// 11 dilin kataloğundan yerel dizgileri üretir: iOS Localizable.strings (App, NotificationService, ShareExtension) ve InfoPlist.strings, Android
// values-*/strings.xml. Bildirim metinleri uygulama kapalıyken yerel katmandan gösterilir, JS kataloğu orada yoktur.
// Kullanım: node scripts/gen-native-strings.mjs [--check]   --check yazmaz, fark varsa çıkış kodu 1 (CI)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

process.removeAllListeners('warning') // .ts kataloglar doğrudan içe aktarılır
const mobile = join(dirname(fileURLToPath(import.meta.url)), '..')
const locales = join(mobile, '..', 'src', 'shared', 'i18n', 'locales')
const check = process.argv.includes('--check')
const HEAD = 'OTOMATİK ÜRETİLDİ — mobile/scripts/gen-native-strings.mjs'

/** [iOS anahtarı, katalog anahtarı, Android adı] */
const KEYS = [
  ['PUSH_FALLBACK', 'sync.notify.newMailFallback', 'push_fallback'],
  ['sync.notify.action.read', 'sync.notify.action.read', 'notify_action_read'],
  ['sync.notify.action.archive', 'sync.notify.action.archive', 'notify_action_archive'],
  ['sync.notify.action.reply', 'sync.notify.action.reply', 'notify_action_reply'],
  ['mobile.channel.normal', 'mobile.channel.normal', 'channel_normal'],
  ['mobile.channel.urgent', 'mobile.channel.urgent', 'channel_urgent'],
  ['mobile.faceid.reason', 'mobile.faceid.reason', 'faceid_reason'],
  ['mobile.push.relogin', 'mobile.push.relogin', 'push_relogin'],
  ['mobile.lock.title', 'mobile.lock.title', 'lock_title'],
  ['mobile.webview.update', 'mobile.webview.update', 'webview_update'],
  ['mobile.share.openApp', 'mobile.share.openApp', null] // yalnız iOS paylaşım eklentisi
]
/** Şablondan gelen, çevrilmeyen Android kaynakları: Capacitor bunlara başvurur */
const ANDROID_FIXED = {
  app_name: 'GeckoMail', title_activity_main: 'GeckoMail',
  package_name: 'com.kodviva.geckomail', custom_url_scheme: 'com.kodviva.geckomail'
}
const LANGS = ['ar', 'de', 'en', 'es', 'fr', 'hi', 'ja', 'pt', 'ru', 'tr', 'zh']
const LPROJ = { pt: 'pt-BR', zh: 'zh-Hans' }

const iosEscape = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
const iosFile = (pairs) => `/* ${HEAD} */\n${pairs.map(([k, v]) => `"${k}" = "${iosEscape(v)}";`).join('\n')}\n`
const xmlEscape = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"')
    .replace(/^([@?])/, '\\$1').replace(/\n/g, '\\n')
const xmlFile = (pairs) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<!-- ${HEAD} -->\n<resources>\n${pairs.map(([k, v]) => `    <string name="${k}">${xmlEscape(v)}</string>`).join('\n')}\n</resources>\n`

async function catalog(lang) {
  const load = async (n) => (await import(pathToFileURL(join(locales, lang, `${n}.ts`)).href)).default
  return { ...(await load('sync')), ...(await load('mobile')) }
}

const outputs = new Map()
for (const lang of LANGS) {
  const c = await catalog(lang)
  const value = (k) => {
    if (typeof c[k] !== 'string') throw new Error(`${lang}: ${k} yok`)
    return c[k]
  }
  const lproj = `${LPROJ[lang] ?? lang}.lproj`
  const strings = iosFile(KEYS.map(([ios, key]) => [ios, value(key)]))
  outputs.set(`ios/App/App/${lproj}/Localizable.strings`, strings)
  outputs.set(`ios/NotificationService/${lproj}/Localizable.strings`, strings)
  outputs.set(`ios/ShareExtension/${lproj}/Localizable.strings`, strings)
  outputs.set(`ios/App/App/${lproj}/InfoPlist.strings`, iosFile([['NSFaceIDUsageDescription', value('mobile.faceid.reason')]]))
  const android = KEYS.filter(([, , name]) => name).map(([, key, name]) => [name, value(key)])
  outputs.set(`android/app/src/main/res/values-${lang}/strings.xml`, xmlFile(android))
  if (lang === 'en') outputs.set('android/app/src/main/res/values/strings.xml', xmlFile([...Object.entries(ANDROID_FIXED), ...android]))
}

let stale = 0
for (const [rel, text] of outputs) {
  const file = join(mobile, rel)
  const cur = existsSync(file) ? readFileSync(file, 'utf-8') : null
  if (cur === text) continue
  stale++
  if (check) console.error(`eski: ${rel}`)
  else {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
}
if (check && stale) process.exit(1)
console.log(check ? 'yerel dizgiler güncel' : `${outputs.size} dosya, ${stale} güncellendi`)
