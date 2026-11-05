// RC2-CBC çözücü (RFC 2268). Yalnız okuma içindir: eski ileti ve .p12 açılır, üretim yolunda RC2 yoktur.
// OpenSSL 3'te legacy sağlayıcı ister, BoringSSL'de rc2-40-cbc yoktur; üç çalışma zamanında tek kod yolu burasıdır.
const BLOCK = 8

const PITABLE = Buffer.from(
  'd978f9c419ddb5ed28e9fd794aa0d89dc67e37832b76538e624c6488448bfba2' +
    '179a59f587b34f1361456d8d09817d32bd8f40eb86b77b0bf09521225c6b4e82' +
    '54d66593ce60b21c7356c014a78cf1dc1275ca1f3bbee4d1423dd430a33cb626' +
    '6fbf0eda4669075727f21d9bbc944303f811c7f690ef3ee706c3d52fc8661ed7' +
    '08e8eade8052eef784aa72ac354d6a2a961ad2715a1549744b9fd05e0418a4ec' +
    'c2e0416e0f51cbcc2491af50a1f47039997c3a8523b8b47afc02365b25559731' +
    '2d5dfa98e38a92ae05df2910676cbac9d300e6cfe19ea82c6316013f58e289a9' +
    '0d38341bab33ffb0bb480c5fb9b1cd2ec5f3db47e5a59c770aa62068fe7fc1ad',
  'hex'
)

function expandKey(key: Buffer, effectiveBits: number): Uint16Array {
  const t = key.length
  if (t < 1 || t > 128 || effectiveBits < 1 || effectiveBits > 1024) throw new RangeError('rc2_key')
  const l = new Uint8Array(128)
  l.set(key)
  for (let i = t; i < 128; i++) l[i] = PITABLE[(l[i - 1] + l[i - t]) & 0xff]
  const t8 = Math.ceil(effectiveBits / 8)
  const tm = 0xff >> (8 * t8 - effectiveBits)
  l[128 - t8] = PITABLE[l[128 - t8] & tm]
  for (let i = 127 - t8; i >= 0; i--) l[i] = PITABLE[l[i + 1] ^ l[i + t8]]
  const k = new Uint16Array(64)
  for (let i = 0; i < 64; i++) k[i] = l[2 * i] | (l[2 * i + 1] << 8)
  return k
}

const rotr = (x: number, s: number): number => ((x >>> s) | (x << (16 - s))) & 0xffff

function decryptBlock(k: Uint16Array, c: Buffer, at: number, out: Buffer): void {
  const r = [c.readUInt16LE(at), c.readUInt16LE(at + 2), c.readUInt16LE(at + 4), c.readUInt16LE(at + 6)]
  let j = 63
  const mix = (): void => {
    r[3] = (rotr(r[3], 5) - k[j--] - (r[2] & r[1]) - (~r[2] & r[0])) & 0xffff
    r[2] = (rotr(r[2], 3) - k[j--] - (r[1] & r[0]) - (~r[1] & r[3])) & 0xffff
    r[1] = (rotr(r[1], 2) - k[j--] - (r[0] & r[3]) - (~r[0] & r[2])) & 0xffff
    r[0] = (rotr(r[0], 1) - k[j--] - (r[3] & r[2]) - (~r[3] & r[1])) & 0xffff
  }
  const mash = (): void => {
    r[3] = (r[3] - k[r[2] & 63]) & 0xffff
    r[2] = (r[2] - k[r[1] & 63]) & 0xffff
    r[1] = (r[1] - k[r[0] & 63]) & 0xffff
    r[0] = (r[0] - k[r[3] & 63]) & 0xffff
  }
  for (let i = 0; i < 16; i++) {
    mix()
    if (i === 4 || i === 10) mash()
  }
  r.forEach((w, i) => out.writeUInt16LE(w, i * 2))
}

/** Ham CBC çözümü: dolgu soyulmaz (bkz. pkcs7Unpad). */
export function rc2CbcDecrypt(key: Buffer, effectiveBits: number, iv: Buffer, ct: Buffer): Buffer {
  if (iv.length !== BLOCK || ct.length % BLOCK !== 0) throw new RangeError('rc2_length')
  const k = expandKey(key, effectiveBits)
  const out = Buffer.alloc(ct.length)
  const block = Buffer.alloc(BLOCK)
  let prev: Buffer = iv
  for (let at = 0; at < ct.length; at += BLOCK) {
    decryptBlock(k, ct, at, block)
    for (let i = 0; i < BLOCK; i++) out[at + i] = block[i] ^ prev[i]
    prev = ct.subarray(at, at + BLOCK)
  }
  k.fill(0)
  return out
}

export function pkcs7Unpad(b: Buffer, blockSize: number): Buffer {
  const n = b[b.length - 1]
  if (!b.length || b.length % blockSize !== 0 || !n || n > blockSize) throw new RangeError('padding')
  for (let i = b.length - n; i < b.length; i++) if (b[i] !== n) throw new RangeError('padding')
  return b.subarray(0, b.length - n)
}
