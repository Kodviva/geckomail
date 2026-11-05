#!/usr/bin/env node
// Paketlenmiş Windows çıktısını denetler: doğru better-sqlite3 ön derlemesi, başka platform yok, tepsi simgesi,
// sunucu dosyası yok. Kullanım: node scripts/check-win-package.mjs [x64] [arm64]  (varsayılan ikisi)
import { listPackage } from '@electron/asar'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Sorun listesi; boşsa paket doğru. listAsar: asar içindeki yollar ('/' ayraçlı ya da Windows ayraçlı) */
export function problems(dir, arch, listAsar) {
  const out = []
  const resources = join(dir, 'resources')
  const prebuilds = join(resources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'prebuilds')
  const found = existsSync(prebuilds) ? readdirSync(prebuilds) : []
  if (!found.includes(`win32-${arch}.node`)) out.push(`eksik: prebuilds/win32-${arch}.node`)
  for (const f of found) if (!f.startsWith('win32-')) out.push(`başka platform: prebuilds/${f}`)
  if (!existsSync(join(resources, 'tray.ico'))) out.push('eksik: resources/tray.ico')
  for (const f of listAsar(join(resources, 'app.asar'))) {
    if (/^[\\/]out[\\/](server|web|e2e-server)[\\/]/.test(f)) out.push(`sunucu dosyası pakette: ${f}`)
  }
  return out
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arches = process.argv.slice(2)
  let failed = false
  for (const arch of arches.length ? arches : ['x64', 'arm64']) {
    const dir = join(root, 'release', arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`)
    const list = existsSync(dir) ? problems(dir, arch, (p) => listPackage(p)) : [`paket yok: ${dir}`]
    for (const p of list) console.error(`${arch}: ${p}`)
    failed ||= list.length > 0
    if (!list.length) console.log(`${arch}: paket doğru`)
  }
  process.exit(failed ? 1 : 0)
}
