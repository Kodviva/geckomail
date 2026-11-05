// Mobil yığının rölesi: gerçek imza, kayıt ve oran sınırı, ama APNs ve FCM yerine yakalayan sahte gönderici. Sağlayıcıya gidecek
// gövde stdout'a tek satır JSON yazılır, gerçek ağa çıkılmaz. Üretim imajına girmez.
import { join } from 'node:path'
import { apnsBody } from '../src/relay/apns'
import { relayConfigFromEnv } from '../src/relay/config'
import { fcmBody } from '../src/relay/fcm'
import { createRelayServer, type RelaySender } from '../src/relay/server'
import { RelayStore } from '../src/relay/store'

const capture = (provider: 'apns' | 'fcm'): RelaySender => async (d, c) => {
  const body = provider === 'apns' ? apnsBody(c) : fcmBody(d.token, c)
  process.stdout.write(`${JSON.stringify({ provider, body })}\n`)
  return 'ok'
}

const cfg = relayConfigFromEnv(process.env)
const store = new RelayStore(join(cfg.dataDir, 'relay.db'))
const server = createRelayServer({ cfg, store, apns: capture('apns'), fcm: capture('fcm') })
server.listen(cfg.listenPort, cfg.listenHost)
process.once('SIGTERM', () => process.exit(0))
