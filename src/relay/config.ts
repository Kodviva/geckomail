// Röle yapılandırması: yalnız ortam değişkenlerinden. Geçersiz değer açılışta hata kodu fırlatır (değişken adıyla; değerin
// kendisi yazılmaz). Sağlayıcı anahtarı isteğe bağlıdır: yoksa o platforma 'retry' döner, süreç yine açılır.
import { DEFAULT_RELAY_HOST } from '../shared/relayProtocol'

export interface RelayConfig {
  listenHost: string
  listenPort: number
  dataDir: string
  /** Güvenilen ters vekil sayısı: oran sınırındaki IP X-Forwarded-For'un sağdan bu girdisinden. 0'dan büyükse port yalnız vekilden
   *  erişilebilir olmalı: doğrudan erişen istemci başlığı uydurup IP sınırlarını aşar */
  trustedProxyDepth: number
  /** Motorların imzaladığı hedef: GECKO_RELAY_URL'deki ana makine (+ port) ile aynı olmalı */
  publicHost: string
  apnsKeyFile?: string
  apnsKeyId?: string
  apnsTeamId?: string
  apnsTopic?: string
  fcmServiceAccountFile?: string
}

const invalid = (name: string): Error => new Error(`gecko.relay.config.invalid: ${name}`)

export function relayConfigFromEnv(env: NodeJS.ProcessEnv): RelayConfig {
  const publicHost = (env.RELAY_PUBLIC_HOST || DEFAULT_RELAY_HOST).toLowerCase()
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(publicHost)) throw invalid('RELAY_PUBLIC_HOST')
  const listen = env.RELAY_LISTEN || '0.0.0.0:8090'
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(listen)
  const listenPort = m ? Number(m[3]) : NaN
  if (!m || !(listenPort >= 1 && listenPort <= 65535)) throw invalid('RELAY_LISTEN')
  const depth = env.RELAY_TRUSTED_PROXY_DEPTH ?? '0'
  if (!/^\d{1,2}$/.test(depth)) throw invalid('RELAY_TRUSTED_PROXY_DEPTH')
  return {
    listenHost: m[1] ?? m[2],
    listenPort,
    dataDir: env.RELAY_DATA_DIR || '/data',
    trustedProxyDepth: Number(depth),
    publicHost,
    apnsKeyFile: env.RELAY_APNS_KEY_FILE || undefined,
    apnsKeyId: env.RELAY_APNS_KEY_ID || undefined,
    apnsTeamId: env.RELAY_APNS_TEAM_ID || undefined,
    apnsTopic: env.RELAY_APNS_TOPIC || undefined,
    fcmServiceAccountFile: env.RELAY_FCM_SERVICE_ACCOUNT_FILE || undefined
  }
}
