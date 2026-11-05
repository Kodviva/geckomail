// Alım kapısı testleri: worker kaynağı TypeScript, gerçek paket gibi tek dosyaya derlenir. Sıra dışı worker davranışı için küçük betikler.
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'gecko-gate-'))

export function buildGateWorker(): string {
  const outfile = join(dir, 'pimGate.mjs')
  buildSync({ entryPoints: [resolve(__dirname, '../../pim/gateWorker.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
  return outfile
}

/** `HANG` içeren nesnede döner, `DIE` içerende süreçten çıkar */
export function scriptedWorker(): string {
  const path = join(dir, 'scripted.mjs')
  writeFileSync(path, `import { parentPort as port } from 'worker_threads'
port.on('message', (m) => {
  if (m.raw.includes('HANG')) for (;;);
  if (m.raw.includes('DIE')) process.exit(1)
  port.postMessage({ seq: m.seq, result: { fields: { uid: m.raw }, nextAlarmAt: null } })
})
port.postMessage({ ready: true })
`)
  return path
}

/** `HANG` içeren nesnede döner; ötekiler saklanabilir dizin alanı alır */
export function hangingWorker(): string {
  const path = join(dir, 'hanging.mjs')
  writeFileSync(path, `import { parentPort as port } from 'worker_threads'
port.on('message', (m) => {
  if (m.raw.includes('HANG')) for (;;);
  const uid = /UID:(.*)/.exec(m.raw)[1].trim()
  port.postMessage({ seq: m.seq, result: { fields: { uid, rangeStart: 1, rangeEnd: 2, recurring: false, sequence: 0, organizer: null }, nextAlarmAt: null } })
})
port.postMessage({ ready: true })
`)
  return path
}

export function brokenWorker(): string {
  const path = join(dir, 'broken.mjs')
  writeFileSync(path, `throw new Error('yüklenemedi')\n`)
  return path
}

export const removeGateWorkers = (): void => rmSync(dir, { recursive: true, force: true })
