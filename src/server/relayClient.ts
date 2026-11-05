// Motorun geckomail-relay istemcisi. Cihaz jetonu motorda saklanmaz: yalnız kayıtta röleye iletilir, motorda `relay:<kimlik>`
// kalır. Her istek motorun Ed25519 anahtarıyla imzalıdır; özel anahtar prefs'te host.encrypt ile şifreli durur.
import { createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'crypto'
import {
  HEADER_ENGINE, HEADER_NONCE, HEADER_SIGNATURE, HEADER_TIME, signingString, type RelayEnv, type RelayPlatform, type RelayResult
} from '../shared/relayProtocol'
import type { Queries } from '../sync/db/queries'
import type { EngineHost } from '../sync/host'

const KEY_PREF = 'relay_engine_key'
const REQUEST_MS = 15_000
const ENDPOINT_PREFIX = 'relay:'
/** Yol bu kimlikle kurulur: rölenin yanıtına da güvenilmez */
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface RelayKeys { publicKey: Buffer; privateKey: KeyObject }
type KeyHost = Pick<EngineHost, 'encrypt' | 'decrypt'>

export const relayEndpoint = (deviceId: string): string => ENDPOINT_PREFIX + deviceId
export const relayDeviceId = (endpoint: string): string => endpoint.slice(ENDPOINT_PREFIX.length)

function newRelayKey(): RelayKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url'), privateKey }
}

/** Çözülemezse (ana anahtar değişti) yenisi üretilir: motor kimliği değişir, eski anahtara bağlı röle cihazları silinir. */
export async function loadOrCreateRelayKey(q: Queries, host: KeyHost): Promise<RelayKeys> {
  const saved = q.prefGet(KEY_PREF)
  if (saved) {
    const s = JSON.parse(saved) as { publicKey: string; enc: string }
    const [plain] = await host.decrypt([new Uint8Array(Buffer.from(s.enc, 'base64'))])
    if (plain?.length) {
      const der = Buffer.from(Buffer.from(plain).toString('utf-8'), 'base64')
      return { publicKey: Buffer.from(s.publicKey, 'base64url'), privateKey: createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }) }
    }
    console.error('gecko: röle anahtarı çözülemedi; yenisi üretiliyor, mobil cihazlar yeniden kaydolmalı')
    q.deleteRelayPushDevices()
  }
  const keys = newRelayKey()
  const [enc] = await host.encrypt([keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')])
  // await sırasında eşzamanlı başka çağrı yazdıysa onunki geçerli
  const cur = q.prefGet(KEY_PREF)
  if (cur !== saved) return loadOrCreateRelayKey(q, host)
  q.prefSet(KEY_PREF, JSON.stringify({ publicKey: keys.publicKey.toString('base64url'), enc: Buffer.from(enc).toString('base64') }))
  return keys
}

/** Anahtar ilk gerektiğinde yüklenir, sonra bellekten; başarısız yükleme önbelleğe alınmaz */
export function relayKeyLoader(q: Queries, host: KeyHost): () => Promise<RelayKeys> {
  let p: Promise<RelayKeys> | null = null
  return () => (p ??= loadOrCreateRelayKey(q, host).catch((e) => {
    p = null
    throw e
  }))
}

export class RelayClient {
  constructor(private readonly o: { url: string; keys(): Promise<RelayKeys>; fetch?: typeof fetch; now?: () => number }) {}

  private async request(method: string, path: string, payload?: object, signal?: AbortSignal): Promise<Response> {
    const { publicKey, privateKey } = await this.o.keys()
    const body = payload === undefined ? '' : JSON.stringify(payload)
    const ts = (this.o.now ?? Date.now)()
    const nonce = randomBytes(16).toString('base64url')
    const signature = sign(null, Buffer.from(signingString(method, new URL(this.o.url).host, path, ts, nonce, Buffer.from(body))), privateKey).toString('base64url')
    const timeout = AbortSignal.timeout(REQUEST_MS)
    return (this.o.fetch ?? fetch)(this.o.url + path, {
      method,
      headers: {
        'Content-Type': 'application/json', [HEADER_ENGINE]: publicKey.toString('base64url'), [HEADER_TIME]: String(ts),
        [HEADER_NONCE]: nonce, [HEADER_SIGNATURE]: signature
      },
      body: body || undefined,
      redirect: 'error',
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout
    })
  }

  /** Cihaz kimliği; röleye ulaşılamaz ya da yanıt bozuksa fırlatır */
  async register(d: { platform: RelayPlatform; env: RelayEnv; token: string }): Promise<string> {
    const res = await this.request('POST', '/v1/devices', d).catch(() => null)
    const id = res?.ok ? ((await res.json().catch(() => null)) as { deviceId?: unknown } | null)?.deviceId : null
    if (typeof id !== 'string' || !DEVICE_ID.test(id)) throw new Error('relay.unavailable')
    return id
  }

  /** En iyi çaba: hata yutulur, kalan satırı röle 90 günde süpürür */
  async unregister(deviceId: string): Promise<void> {
    if (!DEVICE_ID.test(deviceId)) return
    const res = await this.request('DELETE', `/v1/devices/${deviceId}`).catch(() => null)
    await res?.body?.cancel().catch(() => {})
  }

  /** Röle cihazı tanımıyorsa gone (motorda `relay:` satırı silinir, uygulama sonraki açılışta yeniden kaydolur); kalan her hata retry (bir kez yeniden denenir) */
  async push(deviceId: string, c: string, signal?: AbortSignal): Promise<RelayResult> {
    try {
      const res = await this.request('POST', '/v1/push', { deviceId, c }, signal)
      // yalnız rölenin kendi yanıtı: ara vekilin 404'ü bütün mobil cihazları sildirmesin
      if (res.status === 404) return ((await res.json().catch(() => null)) as { reason?: unknown } | null)?.reason === 'notFound' ? 'gone' : 'retry'
      const status = res.ok ? ((await res.json()) as { status?: unknown }).status : null
      return status === 'ok' || status === 'gone' ? status : 'retry'
    } catch {
      return 'retry' // hata metni adres içerebilir: yukarı taşınmaz
    }
  }
}
