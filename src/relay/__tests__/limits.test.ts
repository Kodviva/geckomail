import { describe, expect, it } from 'vitest'
import { GLOBAL_NEW_ENGINES_PER_HOUR, IP_PER_MINUTE, ipRateKey, Limits, NEW_ENGINES_PER_HOUR, PUSH_PER_MINUTE, REGISTER_PER_HOUR } from '../limits'

describe('oran sınırları', () => {
  const exhaust = (hit: () => number, n: number): void => {
    for (let i = 0; i < n; i++) expect(hit(), `#${i}`).toBe(0)
  }

  it('sınırlar plandaki değerlerde', () => {
    expect([IP_PER_MINUTE, NEW_ENGINES_PER_HOUR, PUSH_PER_MINUTE, REGISTER_PER_HOUR]).toEqual([300, 20, 120, 60])
  })

  it('IP penceresi dolar, Retry-After kalan süre, pencere bitince açılır', () => {
    let t = 1000
    const l = new Limits(() => t)
    exhaust(() => l.ip('1.2.3.4'), IP_PER_MINUTE)
    expect(l.ip('1.2.3.4')).toBe(60)
    expect(l.ip('5.6.7.8')).toBe(0) // başka IP etkilenmez
    t += 59_500
    expect(l.ip('1.2.3.4')).toBe(1)
    t += 500
    expect(l.ip('1.2.3.4')).toBe(0)
  })

  it('IPv6 /64 tek anahtar; IPv4 ve eşlenmiş adresler olduğu gibi', () => {
    expect(ipRateKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(ipRateKey('2001:0DB8:0001:0002::1'))
    expect(ipRateKey('2001:db8:1:2::1')).not.toBe(ipRateKey('2001:db8:1:3::1'))
    expect(ipRateKey('fe80::1%eth0')).toBe(ipRateKey('fe80::2'))
    expect(ipRateKey('2001:db8:1:2:3:4:1.2.3.4')).toBe(ipRateKey('2001:db8:1:2::9'))
    expect(ipRateKey('203.0.113.7')).toBe('203.0.113.7')
    expect(ipRateKey('::FFFF:1.2.3.4')).not.toBe(ipRateKey('::ffff:1.2.3.5'))
  })

  it('aynı /64 içinde adres değiştirmek IP sınırını aşmaz', () => {
    const l = new Limits(() => 0)
    for (let i = 0; i < IP_PER_MINUTE; i++) expect(l.ip(`2001:db8:1:2::${(i + 1).toString(16)}`)).toBe(0)
    expect(l.ip('2001:db8:1:2:ffff::1')).toBeGreaterThan(0)
    expect(l.ip('2001:db8:1:3::1')).toBe(0)
    for (let i = 0; i < NEW_ENGINES_PER_HOUR; i++) expect(l.newEngine(`2001:db8:9:9::${(i + 1).toString(16)}`)).toBe(0)
    expect(l.newEngine('2001:db8:9:9:1::1')).toBeGreaterThan(0)
  })

  it('yeni motor için genel saatlik tavan: IP dağıtmak aşamaz, reddedilen IP tavanı tüketmez', () => {
    let t = 0
    const l = new Limits(() => t)
    for (let i = 0; i < NEW_ENGINES_PER_HOUR * 3; i++) l.newEngine('9.9.9.9')
    for (let i = 0; i < GLOBAL_NEW_ENGINES_PER_HOUR - NEW_ENGINES_PER_HOUR; i++) {
      expect(l.newEngine(`2001:db8:${(i + 1).toString(16)}::1`), `#${i}`).toBe(0)
    }
    expect(l.newEngine('2001:db9::1')).toBeGreaterThan(0)
    t += 3600_000
    expect(l.newEngine('2001:db9::1')).toBe(0)
  })

  it('motor sayaçları ayrı', () => {
    const l = new Limits(() => 0)
    exhaust(() => l.push('a'), PUSH_PER_MINUTE)
    expect(l.push('a')).toBeGreaterThan(0)
    expect(l.push('b')).toBe(0)
    expect(l.register('a')).toBe(0)
    exhaust(() => l.newEngine('9.9.9.9'), NEW_ENGINES_PER_HOUR)
    expect(l.newEngine('9.9.9.9')).toBeGreaterThan(0)
  })

  it('IP bellekte düz hâliyle durmaz, tuz süreç başına', () => {
    const a = new Limits(() => 0)
    const b = new Limits(() => 0)
    a.ip('203.0.113.7')
    b.ip('203.0.113.7')
    expect(a.keys().join()).not.toContain('203.0.113.7')
    expect(a.keys()).not.toEqual(b.keys())
  })

  it('süresi dolan sayaçlar temizlenir', () => {
    let t = 0
    const l = new Limits(() => t)
    l.ip('1.1.1.1')
    t += 120_000
    l.ip('2.2.2.2')
    expect(l.keys()).toHaveLength(1)
  })
})
