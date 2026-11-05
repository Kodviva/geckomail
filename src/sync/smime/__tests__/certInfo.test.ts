import { OctetString } from 'asn1js'
import { Certificate } from 'pkijs'
import { describe, expect, it } from 'vitest'
import { parseCert, duplicateNameExt, validRfc822Base } from '../certInfo'
import { ensurePkiEngine } from '../engine'
import { certDer } from './fx'

/** Uzantı değerini bozar: openssl böyle bir sertifika üretmez. İmza geçersiz kalır, parseCert imzaya bakmaz. */
function malform(oid: string): Uint8Array {
  ensurePkiEngine()
  const c = Certificate.fromBER(new Uint8Array(certDer('alice')))
  const e = c.extensions!.find((x) => x.extnID === oid)!
  e.extnValue = new OctetString({ valueHex: new Uint8Array([5, 0]).buffer })
  e.parsedValue = undefined
  return new Uint8Array(c.toSchema(true).toBER(false))
}

describe('bozuk uzantılar', () => {
  it('bozuk EKU yok sayılmaz', () => {
    const c = parseCert(malform('2.5.29.37'))
    expect(c.emailEku).toBe(false)
    expect(c.ekus).not.toEqual([])
  })
  it('bozuk KU yok sayılmaz', () => {
    const c = parseCert(malform('2.5.29.15'))
    expect(c.canSign).toBe(false)
    expect(c.canEncrypt).toBe(false)
  })
  it('bütün SAN ve konu e-postaları toplanır', () => {
    expect(parseCert(certDer('nc-anyof')).rfc822Names.sort()).toEqual(['ceo@victim.test', 'ok@example.test'])
    expect(parseCert(certDer('nc-dns')).rfc822Names).toEqual(['ceo@victim.test'])
  })
})

describe('ad kısıtı tabanı', () => {
  it('hiç eşleşmeyecek biçimler kısıtı geçersiz yapar', () => {
    for (const v of ['@victim.test', 'victim.test.', '.victim.test.', 'a@', '', '.']) expect(validRfc822Base(v)).toBe(false)
    for (const v of ['victim.test', '.victim.test', 'a@victim.test']) expect(validRfc822Base(v)).toBe(true)
  })
  it('yinelenen SAN ya da ad kısıtı uzantısı bozuktur', () => {
    expect(duplicateNameExt([{ extnID: '2.5.29.17' }, { extnID: '2.5.29.17' }])).toBe(true)
    expect(duplicateNameExt([{ extnID: '2.5.29.30' }, { extnID: '2.5.29.30' }])).toBe(true)
    expect(duplicateNameExt([{ extnID: '2.5.29.17' }, { extnID: '2.5.29.30' }])).toBe(false)
  })
})
