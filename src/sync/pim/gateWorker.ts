// Alım kapısının worker girişi: nesneler sırayla denenir, takılan nesnede ana taraf worker'ı öldürür.
import { parentPort } from 'worker_threads'
import { trialObject } from './gateTrial'
import { splitIcsObjects } from './ical'

const port = parentPort!
port.on('message', (m: { seq: number; raw: string; viewerTz: string; now: number; split?: boolean }) => {
  if (m.split) return port.postMessage({ seq: m.seq, split: splitIcsObjects(m.raw) })
  let result = null
  try {
    result = trialObject(m.raw, m.viewerTz, m.now)
  } catch {
    /* bozuk nesne: null */
  }
  port.postMessage({ seq: m.seq, result })
})
port.postMessage({ ready: true })
