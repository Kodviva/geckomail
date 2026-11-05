import { describe, expect, it } from 'vitest'
import { pkcs7Unpad, rc2CbcDecrypt } from '../rc2'

// RFC 2268 §5: tek blokta, sıfır IV ile CBC çözme ECB çözmeye eşittir
const VECTORS: [string, number, string, string][] = [
  ['0000000000000000', 63, '0000000000000000', 'ebb773f993278eff'],
  ['ffffffffffffffff', 64, 'ffffffffffffffff', '278b27e42e2f0d49'],
  ['3000000000000000', 64, '1000000000000001', '30649edf9be7d2c2'],
  ['88', 64, '0000000000000000', '61a8a244adacccf0'],
  ['88bca90e90875a', 64, '0000000000000000', '6ccf4308974c267f'],
  ['88bca90e90875a7f0f79c384627bafb2', 64, '0000000000000000', '1a807d272bbe5db1'],
  ['88bca90e90875a7f0f79c384627bafb2', 128, '0000000000000000', '2269552ab0f85ca6'],
  ['88bca90e90875a7f0f79c384627bafb216f80a6f85920584c42fceb0be255daf1e', 129, '0000000000000000', '5b78d3a43dfff1f1']
]

describe('RC2', () => {
  it.each(VECTORS)('RFC 2268 anahtar %s, %i bit', (key, bits, plain, cipher) => {
    expect(rc2CbcDecrypt(Buffer.from(key, 'hex'), bits, Buffer.alloc(8), Buffer.from(cipher, 'hex')).toString('hex')).toBe(plain)
  })
  it('CBC zinciri', () => {
    const iv = Buffer.from('0102030405060708', 'hex')
    const c = Buffer.from('ebb773f993278eff', 'hex')
    const pt = rc2CbcDecrypt(Buffer.alloc(8), 63, iv, Buffer.concat([c, c]))
    expect(pt.subarray(0, 8).toString('hex')).toBe('0102030405060708')
    expect(pt.subarray(8).toString('hex')).toBe(c.toString('hex'))
  })
  it('blok katı olmayan girdi atar', () => {
    expect(() => rc2CbcDecrypt(Buffer.alloc(8), 64, Buffer.alloc(8), Buffer.alloc(7))).toThrow()
    expect(() => rc2CbcDecrypt(Buffer.alloc(8), 64, Buffer.alloc(7), Buffer.alloc(8))).toThrow()
  })
  it('PKCS#7 dolgu', () => {
    expect(pkcs7Unpad(Buffer.from('abc\x05\x05\x05\x05\x05', 'latin1'), 8).toString()).toBe('abc')
    expect(() => pkcs7Unpad(Buffer.from('abcdefg\x09', 'latin1'), 8)).toThrow()
    expect(() => pkcs7Unpad(Buffer.from('abcdef\x01\x02', 'latin1'), 8)).toThrow()
    expect(() => pkcs7Unpad(Buffer.alloc(0), 8)).toThrow()
  })
})
