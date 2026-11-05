// Sunucu süreci yapılandırması: yalnız ortam değişkenlerinden. Geçersiz değer açılışta hata kodu fırlatır
// (değişken adıyla; değerin kendisi yazılmaz).
import { join } from 'path'
import { fileURLToPath } from 'url'

export interface ServerConfig {
  dataDir: string
  listenHost: string
  listenPort: number
  keyFile: string
  /** Tarayıcının gördüğü köken (ör. https://posta.example.com); Origin denetimi buna göre */
  publicOrigin: string
  /** Güvenilen ters vekil sayısı: X-Forwarded-For'un sağdan kaçıncı girdisi istemci IP'si. 0'dan büyükse
   *  dinlenen port yalnız vekilden erişilebilir olmalı (yoksa X-Forwarded-For uydurulabilir). */
  trustedProxyDepth: number
  /** Web istemcisinin derlenmiş dosyaları (vite.web.config.ts çıktısı) */
  webDir: string
  /** IMAP IDLE sıcak kümesinin üst sınırı: bildirim alan hesaplar bu kadarına dek anlık algılanır (kalanı 120 sn yoklama) */
  idleMax?: number
  /** İç ağdaki DAV sunucuları (GECKO_DAV_PRIVATE_HOSTS): `ad:port`, çıplak ad 80, 443, 8443 demek; SSRF engeli yalnız bunlar için kalkar */
  davPrivateHosts?: string[]
  /** Mobil uygulama yolu (Bearer, CORS, WS bileti); GECKO_MOBILE=0 kapatır. Verilmezse açık */
  mobileEnabled?: boolean
  /** geckomail-relay kökeni (APNs/FCM iletimi); GECKO_RELAY_URL=off ise null. Verilmezse DEFAULT_RELAY */
  relayUrl?: string | null
}

const DEFAULT_RELAY = 'https://relay.kodviva.com'

const invalid = (name: string): Error => new Error(`gecko.config.invalid: ${name}`)

/** Açılıştaki yapılandırma hatası iletisi; köken ipucu yalnız hata GECKO_PUBLIC_ORIGIN ile ilgiliyse */
export function configErrorText(message: string): string {
  const hint = message.includes('GECKO_PUBLIC_ORIGIN')
    ? ' (GECKO_PUBLIC_ORIGIN zorunlu: https://posta.example.com gibi; düz http yalnız localhost için)'
    : ''
  return `gecko: geçersiz yapılandırma — ${message}${hint}\n`
}

export function configFromEnv(env: NodeJS.ProcessEnv): ServerConfig {
  const dataDir = env.GECKO_DATA_DIR || '/data'

  // host:port; IPv6 köşeli parantezle ([::]:8080)
  const listen = env.GECKO_LISTEN || '0.0.0.0:8080'
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(listen)
  const listenPort = m ? Number(m[3]) : NaN
  if (!m || !(listenPort >= 1 && listenPort <= 65535)) throw invalid('GECKO_LISTEN')
  const listenHost = m[1] ?? m[2]

  // yalnız köken: şema + ana makine (+ port); yol, sorgu ya da kimlik bilgisi kabul edilmez
  const raw = env.GECKO_PUBLIC_ORIGIN
  if (!raw) throw invalid('GECKO_PUBLIC_ORIGIN')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw invalid('GECKO_PUBLIC_ORIGIN')
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password ||
    (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash
  ) throw invalid('GECKO_PUBLIC_ORIGIN')
  // https kökeninde çerez Secure; düz http yalnız yerel denemede, geri döngüde (tarayıcılar güvenli bağlam sayar)
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw invalid('GECKO_PUBLIC_ORIGIN')

  const depthRaw = env.GECKO_TRUSTED_PROXY_DEPTH ?? '0'
  if (!/^\d{1,2}$/.test(depthRaw)) throw invalid('GECKO_TRUSTED_PROXY_DEPTH')

  const idleRaw = env.GECKO_IDLE_MAX ?? '40'
  if (!/^\d{1,4}$/.test(idleRaw) || Number(idleRaw) < 1) throw invalid('GECKO_IDLE_MAX')

  const davPrivateHosts = (env.GECKO_DAV_PRIVATE_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
  for (const h of davPrivateHosts) {
    const m = /^[a-z0-9][a-z0-9.-]*(?::(\d{1,5}))?$/.exec(h)
    if (!m || (m[1] && !(Number(m[1]) >= 1 && Number(m[1]) <= 65535))) throw invalid('GECKO_DAV_PRIVATE_HOSTS')
  }

  const mobileRaw = env.GECKO_MOBILE ?? '1'
  if (!/^[01]$/.test(mobileRaw)) throw invalid('GECKO_MOBILE')

  const relayRaw = env.GECKO_RELAY_URL || DEFAULT_RELAY
  let relayUrl: string | null = null
  if (relayRaw !== 'off') {
    let relay: URL
    try {
      relay = new URL(relayRaw)
    } catch {
      throw invalid('GECKO_RELAY_URL')
    }
    if (relay.protocol !== 'https:' || relay.username || relay.password || relay.pathname !== '/' || relay.search || relay.hash) throw invalid('GECKO_RELAY_URL')
    relayUrl = relay.origin
  }

  return {
    dataDir,
    listenHost,
    listenPort,
    keyFile: env.GECKO_KEY_FILE || join(dataDir, 'master.key'),
    publicOrigin: url.origin,
    trustedProxyDepth: Number(depthRaw),
    idleMax: Number(idleRaw),
    davPrivateHosts,
    mobileEnabled: mobileRaw === '1',
    relayUrl,
    // paketli sunucu out/server/index.mjs (imajda /app/server) → web dosyaları yanındaki ../web
    webDir: env.GECKO_WEB_DIR || fileURLToPath(new URL('../web', import.meta.url))
  }
}
