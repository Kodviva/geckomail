// APNs/FCM yükü: Web Push ile aynı RFC 8291 şifrelemeden geçer. Düz metin yalnız cihazda çözülür; sabit boya doldurulur,
// böylece kutunun uzunluğu röleye içerik boyutunu ya da seviyeyi söylemez. Eylem metinleri cihazda yerelleştirilir.
import type { PushActionId } from './pushTypes'

/** Şifreleme başlığı ve etiketle birlikte RELAY_MAX_CIPHERTEXT ve 4096 baytlık zarf sınırının altında kalır */
export const NATIVE_PAD_TO = 2600

export interface NativePayload {
  v: 1
  title: string
  body: string
  accountId: number | null
  messageId: number | null
  level: 'normal' | 'urgent'
  tag: string
  count: number
  ts: number
  actions: PushActionId[]
}

const fits = (p: NativePayload): boolean => Buffer.byteLength(JSON.stringify(p)) <= NATIVE_PAD_TO

/** Alanı sığan en uzun öneke indirir. Kod noktasıyla keser: vekil çifti bölünmez */
function shorten(p: NativePayload, field: 'title' | 'body'): NativePayload {
  const chars = Array.from(p[field])
  const cut = (n: number): NativePayload => ({ ...p, [field]: n ? `${chars.slice(0, n).join('')}…` : '' })
  let lo = 0
  let hi = chars.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(cut(mid))) lo = mid
    else hi = mid - 1
  }
  return cut(lo)
}

/** JSON + boşlukla NATIVE_PAD_TO; sığmazsa önce gövde, sonra başlık kısalır */
export function encodeNative(p: NativePayload): Buffer {
  let fitted = p
  if (!fits(fitted)) fitted = shorten(fitted, 'body')
  if (!fits(fitted)) fitted = shorten(fitted, 'title')
  const out = Buffer.alloc(NATIVE_PAD_TO, 0x20)
  out.write(JSON.stringify(fitted), 'utf-8')
  return out
}
