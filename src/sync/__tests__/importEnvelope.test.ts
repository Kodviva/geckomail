import { describe, expect, it } from 'vitest'
import { newImportKeys, sealItem } from '../importEnvelope'

const IMPORT = 'imp-1'
const KEY = 'account:a@t.co'
const plain = Buffer.from('gizli parola')

describe('taşıma zarfı', () => {
  it('roundtrip', () => {
    const k = newImportKeys()
    expect(k.open(sealItem(k.publicKey, IMPORT, KEY, plain), IMPORT).toString()).toBe('gizli parola')
  })

  it('her ögede ayrı geçici anahtar ve iv', () => {
    const k = newImportKeys()
    const a = sealItem(k.publicKey, IMPORT, KEY, plain)
    const b = sealItem(k.publicKey, IMPORT, KEY, plain)
    expect(a.pub).not.toBe(b.pub)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
  })

  it('wrong aad fails', () => {
    const k = newImportKeys()
    const s = sealItem(k.publicKey, IMPORT, KEY, plain)
    expect(() => k.open(s, 'imp-2')).toThrow()
    expect(() => k.open({ ...s, key: 'account:b@t.co' }, IMPORT)).toThrow()
  })

  it('tampered ct fails', () => {
    const k = newImportKeys()
    const s = sealItem(k.publicKey, IMPORT, KEY, plain)
    const ct = Buffer.from(s.ct, 'base64')
    ct[0] ^= 1
    expect(() => k.open({ ...s, ct: ct.toString('base64') }, IMPORT)).toThrow()
  })

  it('other import key fails', () => {
    const s = sealItem(newImportKeys().publicKey, IMPORT, KEY, plain)
    expect(() => newImportKeys().open(s, IMPORT)).toThrow()
  })

  it('geçersiz sunucu anahtarı mühürletmez', () => {
    expect(() => sealItem('AAAA', IMPORT, KEY, plain)).toThrow()
  })

  it('kısa etiket ve kısa iv reddedilir', () => {
    const k = newImportKeys()
    const s = sealItem(k.publicKey, IMPORT, KEY, plain)
    expect(() => k.open({ ...s, ct: Buffer.from(s.ct, 'base64').subarray(0, 8).toString('base64') }, IMPORT)).toThrow()
    expect(() => k.open({ ...s, iv: Buffer.alloc(4).toString('base64') }, IMPORT)).toThrow()
  })

  it('zarfta düz metin yok', () => {
    const k = newImportKeys()
    expect(JSON.stringify(sealItem(k.publicKey, IMPORT, KEY, plain))).not.toContain('gizli')
  })
})
