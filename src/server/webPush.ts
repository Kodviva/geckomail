// Web Push gönderimi: RFC 8291 (aes128gcm) yük şifreleme ve RFC 8292 VAPID, yalnız node:crypto ile.
// Push servisi uç noktayı, zamanı ve boyutu görür; içerik cihaz anahtarına şifrelidir. Uç nokta bir sırdır:
// hiçbir günlüğe yazılmaz. Hedefler izinli servis ana makineleriyle sınırlıdır (SSRF koruması).
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type ECDH } from 'crypto'
import { WEB_PUSH_HOSTS, WEB_PUSH_SUFFIXES } from '../shared/relayProtocol'
import type { PushDevice, Queries } from '../sync/db/queries'
import type { EngineHost } from '../sync/host'

export interface VapidKeys { publicKey: string; privateKey: string } // base64url: 65 baytlık nokta, 32 baytlık skaler

export type PushResult = 'ok' | 'gone' | 'retry'

const RECORD_SIZE = 4096
const VAPID_TTL_S = 12 * 3600
const SEND_TIMEOUT_MS = 15_000
const VAPID_PREF = 'push_vapid'

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, len: number): Buffer => Buffer.from(hkdfSync('sha256', ikm, salt, info, len))

/** RFC 8291: tek kayıt (rs 4096, yük kayda sığmalı). salt/serverKeys yalnız test vektörü için */
export function encryptPayload(plain: Uint8Array, p256dh: string, auth: string, opts: { salt?: Buffer; serverKeys?: ECDH } = {}): Buffer {
  const uaPublic = Buffer.from(p256dh, 'base64url')
  const salt = opts.salt ?? randomBytes(16)
  let keys = opts.serverKeys
  if (!keys) {
    keys = createECDH('prime256v1')
    keys.generateKeys()
  }
  const asPublic = keys.getPublicKey()
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = hkdf(keys.computeSecret(uaPublic), Buffer.from(auth, 'base64url'), keyInfo, 32)
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(plain), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()])
  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(RECORD_SIZE)
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body])
}

/** ES256 JWT (aud uç noktanın kökeni, en çok 12 saat geçerli) ile VAPID başlığı */
export function vapidHeaders(endpoint: string, keys: VapidKeys, subject: string, nowSec: number): { Authorization: string } {
  const enc = (v: object): string => Buffer.from(JSON.stringify(v)).toString('base64url')
  const data = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: nowSec + VAPID_TTL_S, sub: subject })}`
  const pub = Buffer.from(keys.publicKey, 'base64url')
  const key = createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }
  })
  const sig = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return { Authorization: `vapid t=${data}.${sig}, k=${keys.publicKey}` }
}

function newVapid(): VapidKeys {
  // createECDH değil: getPrivateKey baştaki sıfırı atabilir, JWK 32 bayt ister
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const j = publicKey.export({ format: 'jwk' })
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(j.x!, 'base64url'), Buffer.from(j.y!, 'base64url')])
  return { publicKey: point.toString('base64url'), privateKey: privateKey.export({ format: 'jwk' }).d! }
}

/** Sunucunun VAPID anahtarları: özel anahtar prefs'te host.encrypt ile şifreli, tek satırda (yarım yazım olmaz).
 *  Çözülemezse (ana anahtar değişti) yenisi üretilir: eski anahtara bağlı abonelikler geçersizdir, kayıtları silinir. */
export async function loadOrCreateVapid(q: Queries, host: Pick<EngineHost, 'encrypt' | 'decrypt'>): Promise<VapidKeys> {
  const saved = q.prefGet(VAPID_PREF)
  if (saved) {
    const s = JSON.parse(saved) as { publicKey: string; enc: string }
    const [plain] = await host.decrypt([new Uint8Array(Buffer.from(s.enc, 'base64'))])
    if (plain?.length) return { publicKey: s.publicKey, privateKey: Buffer.from(plain).toString('utf-8') }
    console.error('gecko: VAPID anahtarı çözülemedi; yenisi üretiliyor, push cihazları yeniden kaydolmalı')
    q.deleteAllPushDevices()
  }
  const keys = newVapid()
  const [enc] = await host.encrypt([keys.privateKey])
  // await sırasında eşzamanlı başka çağrı yazdıysa onunki geçerli
  const cur = q.prefGet(VAPID_PREF)
  if (cur !== saved) return loadOrCreateVapid(q, host)
  q.prefSet(VAPID_PREF, JSON.stringify({ publicKey: keys.publicKey, enc: Buffer.from(enc).toString('base64') }))
  return keys
}

/** Yalnız https, varsayılan port, kimlik bilgisi yok ve izinli servis. extra yalnız createHttpServer test seçeneğinden. */
export function isAllowedPushHost(endpoint: string, extra: string[] = []): boolean {
  let u: URL
  try {
    u = new URL(endpoint)
  } catch {
    return false
  }
  if (u.username || u.password) return false
  if (extra.includes(u.hostname)) return u.protocol === 'https:' || u.protocol === 'http:'
  if (u.protocol !== 'https:' || u.port) return false
  return WEB_PUSH_HOSTS.includes(u.hostname) || WEB_PUSH_SUFFIXES.some((s) => u.hostname.endsWith(s))
}

/** 2xx ok; 404/410 ya da izinsiz ana makine abonelik bitmiş (gone); kalan her şey retry: 429/5xx/ağ hatası, ayrıca saat kayması ya da anahtar
 *  yüzünden gelen 401/403 — cihaz kaydını silmeye değmez, bir deneme sonra bırakılır */
export async function sendPush(
  d: PushDevice, payload: object,
  o: { keys: VapidKeys; subject: string; urgency: 'normal' | 'high'; ttl: number; fetch?: typeof fetch; extraHosts?: string[]; signal?: AbortSignal }
): Promise<PushResult> {
  // kayıtta denetlendi; satır başka yoldan gelmiş olabilir (geri yükleme, eski sürüm). Kayıt silinir, istek gitmez
  if (!isAllowedPushHost(d.endpoint, o.extraHosts)) return 'gone'
  try {
    const timeout = AbortSignal.timeout(SEND_TIMEOUT_MS)
    const res = await (o.fetch ?? fetch)(d.endpoint, {
      method: 'POST',
      headers: {
        ...vapidHeaders(d.endpoint, o.keys, o.subject, Math.floor(Date.now() / 1000)),
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(o.ttl), Urgency: o.urgency
      },
      body: new Uint8Array(encryptPayload(Buffer.from(JSON.stringify(payload)), d.p256dh, d.auth)),
      // izinli ana makine başka adrese yönlendiremesin (SSRF)
      redirect: 'error',
      signal: o.signal ? AbortSignal.any([timeout, o.signal]) : timeout
    })
    await res.body?.cancel().catch(() => {})
    if (res.ok) return 'ok'
    return res.status === 404 || res.status === 410 ? 'gone' : 'retry'
  } catch {
    return 'retry' // hata metni uç noktayı içerebilir: yukarı taşınmaz
  }
}
