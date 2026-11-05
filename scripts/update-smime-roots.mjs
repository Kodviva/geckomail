#!/usr/bin/env node
// Mozilla/CCADB "Email trust bit" kök listesini src/sync/smime/roots altına yazar. Her sürüm öncesi elle
// çalıştırılır ve commit edilir; çalışma anında indirme yoktur. Süresi dolanlar atılır. Liste şüpheli kısaysa
// (0 ya da 50'den az sertifika) dosya yazılmaz, mevcut liste korunur.
import { X509Certificate, createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const URL_ROOTS = 'https://ccadb.my.salesforce-sites.com/mozilla/IncludedRootsPEMTxt?TrustBitsInclude=Email'
const MIN_ROOTS = 50
const dir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src', 'sync', 'smime', 'roots')

const res = await fetch(URL_ROOTS, { signal: AbortSignal.timeout(60_000) })
if (!res.ok) throw new Error(`CCADB yanıtı: ${res.status}`)
// CCADB raporunda satır sonları karışıktır
const text = (await res.text()).replace(/\r\n?/g, '\n').replace(/^\s+/gm, '')
const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []

const now = Date.now()
const certs = new Map()
for (const block of blocks) {
  const x = new X509Certificate(block) // ayrışmayan sertifika betiği durdurur: liste bozuksa yazılmaz
  if (Date.parse(x.validTo) <= now) continue
  certs.set(x.fingerprint256, x.toString().trim())
}
if (certs.size < MIN_ROOTS) throw new Error(`Yalnız ${certs.size} sertifika çıktı (en az ${MIN_ROOTS}); dosya yazılmadı`)

const pem = `${[...certs.keys()].sort().map((k) => certs.get(k)).join('\n')}\n`
writeFileSync(join(dir, 'mozilla-email-roots.pem'), pem)
const meta = { fetchedAt: new Date(now).toISOString(), sha256: createHash('sha256').update(pem).digest('hex'), count: certs.size }
writeFileSync(join(dir, 'roots-meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
console.log(`${certs.size} kök yazıldı (${blocks.length} kayıttan)`)
