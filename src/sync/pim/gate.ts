// Takvim alım kapısı. Dışarıdan gelen her nesne (DAV, Graph, ICS, posta daveti) önce worker'da ayrıştırılıp açılır: ical.js
// tek `next()` içinde sonsuza dönebilir, bu ana iş parçacığında durdurulamaz. Takılan nesnede worker öldürülür, nesne geçemez.
// Kapıdan geçemeyen nesne saklanmaz ve sayılır. Yığın başına tek worker: büyük eşitleme nesne başına süreç açmaz.
// Takılma sınırına gelen yığının kalanı reddedilmez, ertelenir: çağıran eşitleme durumunu ilerletmez, sonraki tur yeniden getirir.
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { Worker } from 'worker_threads'
import { t } from '../../shared/i18n'
import type { GatedEvent } from './gateTrial'

const OBJECT_TIMEOUT_MS = 1000
const START_TIMEOUT_MS = 15_000
/** Bu kadar takılmadan sonra yığının kalanı denenmez: düşmanca akış nesne başına 1 sn yedirmesin */
const MAX_HANGS = 5
const MAX_HUNG_MEMO = 10_000
const WORKER_MEMORY_MB = 256
const SPLIT_TIMEOUT_MS = 15_000

export interface GateOptions {
  viewerTz: string
  now: number
  /** yalnız testler: derlenmiş worker dosyası */
  workerPath?: string
  /** Takıldığı bilinen içeriklerin özeti: turlar arası taşınır, ilk nesneler takılma sınırını her turda yiyip kalanı aç bırakmasın */
  hung?: Set<string>
}

export const DEFERRED = 'deferred'
/** Geçen nesnenin alanları; null reddedildi; `DEFERRED` denenmedi, sonraki turda yeniden gelmeli */
export type GateVerdict = GatedEvent | null | typeof DEFERRED

const digest = (raw: string): string => createHash('sha256').update(raw).digest('base64')

/** Paket dizini: dosya `out/main`, `out/main/chunks` ya da `out/server/chunks` altında olabilir; asar içinden worker yüklenmez */
function bundledWorker(): string | null {
  const here = dirname(fileURLToPath(import.meta.url)).replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')
  for (const dir of [here, dirname(here)]) {
    for (const name of ['pimGate.mjs', 'pimGate.js']) {
      const path = join(dir, name)
      if (existsSync(path)) return path
    }
  }
  return null
}

function startWorker(path: string): Promise<Worker> {
  return new Promise((resolve, reject) => {
    const w = new Worker(path, { resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB } })
    const fail = (): void => {
      clearTimeout(timer)
      void w.terminate()
      reject(new Error(t('pim.err.gateUnavailable')))
    }
    const timer = setTimeout(fail, START_TIMEOUT_MS)
    w.once('error', fail)
    w.once('exit', fail)
    w.once('message', () => {
      clearTimeout(timer)
      w.removeListener('error', fail)
      w.removeListener('exit', fail)
      resolve(w)
    })
  })
}

/** `from`dan başlayarak bekleyen nesneleri sırayla dener; worker takılır ya da düşerse o nesnenin indisini döner */
function pump(w: Worker, raws: string[], from: number, o: GateOptions, results: GateVerdict[]): Promise<number | null> {
  return new Promise((resolve) => {
    let i = from
    let timer: ReturnType<typeof setTimeout>
    const finish = (stuck: number | null): void => {
      clearTimeout(timer)
      w.removeAllListeners()
      // öldürülürken gelen geç hata süreci düşürmesin
      w.on('error', () => {})
      resolve(stuck)
    }
    const next = (): void => {
      while (i < raws.length && results[i] !== DEFERRED) i++
      if (i >= raws.length) return finish(null)
      timer = setTimeout(() => finish(i), OBJECT_TIMEOUT_MS)
      w.postMessage({ seq: i, raw: raws[i], viewerTz: o.viewerTz, now: o.now })
    }
    w.on('message', (m: { seq: number; result: GatedEvent | null }) => {
      clearTimeout(timer)
      results[m.seq] = m.result
      i = m.seq + 1
      next()
    })
    w.once('error', () => finish(i))
    w.once('exit', () => finish(i))
    next()
  })
}

/** Takılan içerik iki kez sayılır: ilk takılma CPU kıtlığı olabilir, nesne ertelenir; aynı içerik yeniden takılırsa reddedilir */
const rejectedKey = (d: string): string => `${d}!`

/** Girdiyle aynı sırada sonuç. Worker hiç başlatılamazsa fırlatır: nesne suçlu değil, tur sonra yinelenir. */
export async function gateCalendars(raws: string[], o: GateOptions): Promise<GateVerdict[]> {
  const known = o.hung
  const digests = known ? raws.map(digest) : []
  const results: GateVerdict[] = raws.map((_, i) => (known?.has(rejectedKey(digests[i])) ? null : DEFERRED))
  if (!results.includes(DEFERRED)) return results
  const path = o.workerPath ?? bundledWorker()
  if (!path) throw new Error(t('pim.err.gateUnavailable'))
  let from = 0
  for (let hangs = 0; from < raws.length && hangs < MAX_HANGS; hangs++) {
    const w = await startWorker(path)
    const stuck = await pump(w, raws, from, o, results)
    await w.terminate()
    if (stuck === null) break
    if (known) {
      if (known.size >= MAX_HUNG_MEMO) known.clear()
      if (known.has(digests[stuck])) {
        known.add(rejectedKey(digests[stuck]))
        results[stuck] = null
      } else known.add(digests[stuck])
    } else results[stuck] = null
    from = stuck + 1
  }
  return results
}

/** Akışı worker'da böler: ayrıştırma ana iş parçacığını tutmaz, süre aşılırsa worker öldürülür */
export async function splitFeedInWorker(raw: string, workerPath?: string): Promise<{ uid: string; data: string }[] | 'tooLarge'> {
  const path = workerPath ?? bundledWorker()
  if (!path) throw new Error(t('pim.err.gateUnavailable'))
  const w = await startWorker(path)
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(t('pim.err.feedTooLarge'))), SPLIT_TIMEOUT_MS)
      w.once('message', (m: { split: { uid: string; data: string }[] | 'tooLarge' }) => {
        clearTimeout(timer)
        resolve(m.split)
      })
      w.once('error', () => {
        clearTimeout(timer)
        reject(new Error(t('pim.err.feedTooLarge')))
      })
      w.postMessage({ seq: 0, raw, split: true })
    })
  } finally {
    w.removeAllListeners()
    w.on('error', () => {})
    await w.terminate()
  }
}
