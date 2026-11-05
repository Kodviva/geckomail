// Çevrimdışı önbellek şifrelemesi: AES-GCM 256, anahtar dışa aktarılamaz (extractable:false) CryptoKey olarak
// IndexedDB'de. Kayıt biçimi: 12 bayt rastgele nonce + şifreli metin (etiket dahil).
import { metaGet, metaPutIfAbsent } from './store'

const NONCE_BYTES = 12
const enc = new TextEncoder()
const dec = new TextDecoder()

/** Yoksa üretir; iki sekme aynı anda üretse de yazımı atomik olduğundan tek anahtar kalır */
export async function getCacheKey(): Promise<CryptoKey> {
  const existing = await metaGet<CryptoKey>('key')
  if (existing) return existing
  const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  return metaPutIfAbsent('key', fresh)
}

export async function sealJson(key: CryptoKey, v: unknown): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(v)))
  const out = new Uint8Array(NONCE_BYTES + ct.byteLength)
  out.set(iv)
  out.set(new Uint8Array(ct), NONCE_BYTES)
  return out.buffer
}

export async function openJson<T>(key: CryptoKey, b: ArrayBuffer): Promise<T> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, NONCE_BYTES) }, key, b.slice(NONCE_BYTES))
  return JSON.parse(dec.decode(plain)) as T
}
