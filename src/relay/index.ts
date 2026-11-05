// geckomail-relay süreci. Sağlayıcı anahtarı yoksa o platforma 'retry' döner, süreç yine açılır. Günlük yalnız başlatma ve hata türü.
import { createPrivateKey } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { RelayResult } from '../shared/relayProtocol'
import { createApns } from './apns'
import { relayConfigFromEnv } from './config'
import { createFcm, parseServiceAccount } from './fcm'
import { createRelayServer, type RelaySender } from './server'
import { RelayStore } from './store'

const unavailable: RelaySender = async (): Promise<RelayResult> => 'retry'

function main(): void {
  const cfg = relayConfigFromEnv(process.env)
  const store = new RelayStore(join(cfg.dataDir, 'relay.db'))
  const { apnsKeyFile, apnsKeyId, apnsTeamId, apnsTopic, fcmServiceAccountFile } = cfg
  const apns = apnsKeyFile && apnsKeyId && apnsTeamId && apnsTopic
    ? createApns({ key: createPrivateKey(readFileSync(apnsKeyFile)), keyId: apnsKeyId, teamId: apnsTeamId, topic: apnsTopic })
    : null
  const fcm = fcmServiceAccountFile ? createFcm({ account: parseServiceAccount(readFileSync(fcmServiceAccountFile, 'utf-8')) }) : null
  const server = createRelayServer({ cfg, store, apns: apns ?? unavailable, fcm: fcm ?? unavailable })
  server.listen(cfg.listenPort, cfg.listenHost, () => {
    console.log(`geckomail-relay: açık (apns: ${apns ? 'var' : 'yok'}, fcm: ${fcm ? 'var' : 'yok'})`)
  })
  const stop = (): void => {
    apns?.close()
    server.close(() => {
      store.close()
      process.exit(0)
    })
    server.closeAllConnections()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

try {
  main()
} catch (e) {
  // yalnız hata türü: dosya içeriği ya da yol yazılmaz
  const kind = (e as NodeJS.ErrnoException | null)?.code
  const code = e instanceof Error && e.message.startsWith('gecko.relay.') ? e.message : `gecko.relay.start${typeof kind === 'string' ? `:${kind}` : ''}`
  console.error(`geckomail-relay: açılamadı (${code})`)
  process.exit(1)
}
