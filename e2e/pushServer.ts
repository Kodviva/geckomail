// Push testinin sunucu girişi: yerel sahte push servisine izin verir (yalnız seçenekle, ortam değişkeniyle değil) ve
// stdin'den satır satır { userId, item } alıp PushSink'e verir; gerçek IMAP ve yeni posta gerekmez.
import { createInterface } from 'node:readline'
import { runCli } from '../src/server/cli'
import { configFromEnv } from '../src/server/config'
import type { PushSink } from '../src/server/pushDevices'
import type { PushItem } from '../src/shared/pushTypes'

let sink: PushSink | undefined
createInterface({ input: process.stdin }).on('line', (line) => {
  const { userId, item } = JSON.parse(line) as { userId: number; item: PushItem }
  sink?.deliver(userId, [item])
})

runCli(process.argv.slice(2), process, configFromEnv(process.env), { pushHosts: ['127.0.0.1'], onPush: (p) => (sink = p) }).then(
  (code) => process.exit(code),
  (e: Error) => {
    process.stderr.write(`gecko: ${e.message}\n`)
    process.exit(1)
  }
)
