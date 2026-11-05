// pkijs küresel kripto motoru. Sync ve sunucu sürecinde bir kez kurulur; WebCrypto Node'unkidir.
import { webcrypto } from 'node:crypto'
import { CryptoEngine, setEngine } from 'pkijs'

let ready = false

export function ensurePkiEngine(): void {
  if (ready) return
  setEngine('node', new CryptoEngine({ name: 'node', crypto: webcrypto as unknown as Crypto }))
  ready = true
}
