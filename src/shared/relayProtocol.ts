// Motor ile geckomail-relay arasındaki protokol. Röle yalnız opak kutuyu APNs/FCM'e iletir: içerik, seviye ve boyut ondan
// gizlidir. Her istek motorun Ed25519 anahtarıyla imzalıdır; imza gövdeyi, yolu, zamanı ve tek kullanımlık nonce'u kapsar.
import { createHash } from 'crypto'

/** base64url karakter: aes128gcm başlığı + NATIVE_PAD_TO baytlık yük, zarf 4096 baytı aşmasın */
export const RELAY_MAX_CIPHERTEXT = 3700
export const RELAY_SKEW_MS = 300_000
export const DEFAULT_RELAY_HOST = 'relay.kodviva.com'
export const RELAY_SIGNATURE_LABEL = 'gecko-relay-v1'

export const HEADER_ENGINE = 'x-gecko-engine'
export const HEADER_TIME = 'x-gecko-time'
export const HEADER_NONCE = 'x-gecko-nonce'
export const HEADER_SIGNATURE = 'x-gecko-signature'

export type RelayPlatform = 'ios' | 'android'
export type RelayEnv = 'production' | 'sandbox'
export type RelayResult = 'ok' | 'gone' | 'retry'

/** "gecko-relay-v1\n{relayHost}\n{method}\n{path}\n{ts}\n{nonce}\n{sha256(body) hex}"; relayHost hedeftir: bir röleye imzalanan
 *  istek başka röleye aktarılamaz. Röle kendi yapılandırdığı adla doğrular, istekteki Host'a bakmaz */
export function signingString(method: string, relayHost: string, path: string, ts: number, nonce: string, body: Buffer): string {
  const digest = createHash('sha256').update(body).digest('hex')
  return `${RELAY_SIGNATURE_LABEL}\n${relayHost}\n${method}\n${path}\n${ts}\n${nonce}\n${digest}`
}

/** Motor kimliği: açık anahtarın sha256 özeti, base64url */
export function engineId(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest('base64url')
}

const DEVICE_TOKEN: Record<RelayPlatform, RegExp> = {
  ios: /^[0-9a-fA-F]{64,400}$/,
  android: /^[A-Za-z0-9_:-]{32,4096}$/
}

/** Adres yalnız sabit taban + bu denetimden geçen belirteçle kurulur: yol enjeksiyonu yok */
export const validDeviceToken = (platform: RelayPlatform, token: string): boolean => DEVICE_TOKEN[platform].test(token)

// Web Push izinli servisleri (SSRF koruması); webPush.ts aynı listeyi kullanır
export const WEB_PUSH_HOSTS: readonly string[] = ['fcm.googleapis.com', 'updates.push.services.mozilla.com']
export const WEB_PUSH_SUFFIXES: readonly string[] = ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com']

/** Rölenin ve motorun push için çıkabileceği ana makineler; "." ile başlayan girdi sonektir */
export const OUTBOUND_HOSTS: readonly string[] = [
  ...new Set(['api.push.apple.com', 'api.sandbox.push.apple.com', 'fcm.googleapis.com', 'oauth2.googleapis.com', ...WEB_PUSH_HOSTS, ...WEB_PUSH_SUFFIXES])
]
