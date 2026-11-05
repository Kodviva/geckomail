// Yerel push yükü: sabit boy doldurma, kısaltma ve Görev 8–9'un okuduğu ortak test vektörleri.
import { createECDH } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { encodeNative, NATIVE_PAD_TO, type NativePayload } from '../../shared/nativePush'
import { encryptPayload } from '../webPush'
import { decryptPush } from './pushTestUtil'

const base: NativePayload = {
  v: 1, title: 'Ali', body: 'Selam', accountId: 3, messageId: 42, level: 'normal', tag: '0123456789abcdef', count: 1, ts: 1_800_000_000_000, actions: ['read', 'archive', 'reply']
}
const parse = (b: Buffer): NativePayload => JSON.parse(b.toString('utf-8')) as NativePayload

interface Vector {
  name: string; plaintext: string; uaPrivate: string; uaPublic: string; auth: string; salt: string; asPrivate: string; asPublic: string; body: string
}

describe('encodeNative', () => {
  it('kısa yük sabit boya boşlukla doldurulur, içerik aynen okunur', () => {
    const b = encodeNative(base)
    expect(b.length).toBe(NATIVE_PAD_TO)
    expect(b[b.length - 1]).toBe(0x20)
    expect(parse(b)).toEqual(base)
  })

  it('tam sığan yük kısalmaz', () => {
    const empty = Buffer.byteLength(JSON.stringify({ ...base, body: '' }))
    const p = { ...base, body: 'x'.repeat(NATIVE_PAD_TO - empty) }
    expect(parse(encodeNative(p)).body).toBe(p.body)
  })

  it('sığmayan yükte önce gövde kısalır, başlık kalır', () => {
    const out = parse(encodeNative({ ...base, title: 'Önemli konu', body: 'ğ'.repeat(5000) }))
    expect(out.title).toBe('Önemli konu')
    expect(out.body.endsWith('…')).toBe(true)
    expect(out.body.length).toBeGreaterThan(1000)
  })

  it('gövde bitince başlık da kısalır', () => {
    const b = encodeNative({ ...base, title: 'ş'.repeat(5000), body: 'ğ'.repeat(5000) })
    expect(b.length).toBe(NATIVE_PAD_TO)
    const out = parse(b)
    expect(out.body).toBe('')
    expect(out.title.endsWith('…')).toBe(true)
  })

  it('vekil çifti bölünmez, JSON kaçışı olan metin de sınırı aşmaz', () => {
    for (const unit of ['😀', '"', '\u0001', '\\']) {
      const b = encodeNative({ ...base, title: unit.repeat(3000), body: unit.repeat(3000) })
      expect(b.length).toBe(NATIVE_PAD_TO)
      const out = parse(b)
      for (const text of [out.title, out.body]) expect(text).not.toMatch(/\p{Cs}/u)
    }
  })
})

describe('push-vectors.json', () => {
  const vectors = JSON.parse(readFileSync(join(__dirname, '../../../mobile/testdata/push-vectors.json'), 'utf-8')) as { vectors: Vector[] }
  const b = (v: string): Buffer => Buffer.from(v, 'base64url')

  it('RFC 8291 Ek A ve iki yerel vektör var; yereller doldurulmuş, Türkçe ve emoji içerir', () => {
    expect(vectors.vectors).toHaveLength(3)
    expect(vectors.vectors[0].name).toBe('rfc8291-appendix-a')
    for (const v of vectors.vectors.slice(1)) {
      const plain = b(v.plaintext)
      expect(plain.length).toBe(NATIVE_PAD_TO)
      expect(plain.toString('utf-8')).toMatch(/[ğüşıöçĞÜŞİÖÇ]/)
      expect(plain.toString('utf-8')).toMatch(/\p{Extended_Pictographic}/u)
      expect(() => parse(plain)).not.toThrow()
    }
  })

  it('vectors file matches encryptPayload', () => {
    for (const v of vectors.vectors) {
      const serverKeys = createECDH('prime256v1')
      serverKeys.setPrivateKey(b(v.asPrivate))
      expect(serverKeys.getPublicKey().toString('base64url')).toBe(v.asPublic)
      const body = encryptPayload(b(v.plaintext), v.uaPublic, v.auth, { salt: b(v.salt), serverKeys })
      expect(body.toString('base64url'), v.name).toBe(v.body)
      const ua = createECDH('prime256v1')
      ua.setPrivateKey(b(v.uaPrivate))
      expect(ua.getPublicKey().toString('base64url')).toBe(v.uaPublic)
      expect(decryptPush(body, ua, b(v.auth)).toString('base64url'), v.name).toBe(v.plaintext)
    }
  })
})
