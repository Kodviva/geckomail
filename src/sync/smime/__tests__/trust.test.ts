import { describe, expect, it, vi } from 'vitest'
import { nameAllowed, parseCert, sameAddress } from '../certInfo'
import { CrlCache } from '../revocation'
import { evaluateChain, type ChainInput, type TrustStore } from '../trust'
import { SmimeFormatError } from '../errors'
import { AT, certDer, pemCerts } from './fx'
import type { Queries } from '../../db/queries'

const store = (...extra: Uint8Array[]): TrustStore => {
  const anchors = [certDer('root'), ...extra].map(parseCert)
  return { anchors: () => anchors, bundle: () => ({ count: anchors.length, fetchedAt: '2030-01-01', sha256: 'x' }) }
}
const noCrl = (): CrlCache => new CrlCache({ q: {} as Queries, mode: () => 'off', fetchUrl: vi.fn(), now: () => AT })
const INT = certDer('int')
const run = (leaf: string, o: Partial<ChainInput> = {}, s: TrustStore = store(), now = AT) =>
  evaluateChain({ leaf: certDer(leaf), extra: [INT], at: AT, purpose: 'sign', ...o }, s, noCrl(), () => now)

describe('zincir', () => {
  it('chain to fixture root is ok', async () => {
    const v = await run('alice')
    expect(v).toMatchObject({ state: 'ok', selfSigned: false, expiredSince: false, revocation: 'unknown' })
    expect(v.chain).toHaveLength(3)
    expect(v.chain[0]).toBe(parseCert(certDer('alice')).fingerprint)
  })

  it('eksik ara sertifikayla zincir kurulamaz (AIA indirilmez)', async () => {
    expect((await run('alice', { extra: [] })).state).toBe('untrusted')
  })

  it('self-signed never ok', async () => {
    expect(await run('self-signed', { extra: [] })).toMatchObject({ state: 'untrusted', selfSigned: true })
  })

  it('user cannot make self-signed leaf verified by adding it as anchor', async () => {
    const v = await run('self-signed', { extra: [] }, store(certDer('self-signed')))
    expect(v).toMatchObject({ state: 'untrusted', selfSigned: true })
  })

  it('leaf acting as CA rejected', async () => {
    expect((await run('fake-child', { extra: [INT, certDer('alice')] })).state).toBe('untrusted')
  })

  it('yaprağın kopyası ek listede başka sertifikayı doğrulatamaz', async () => {
    const leaf = certDer('fake-child')
    expect((await run('fake-child', { extra: [leaf, certDer('alice'), INT] })).state).toBe('untrusted')
    expect((await run('fake-child', { extra: [leaf, leaf, INT, certDer('alice')] })).state).toBe('untrusted')
  })

  it('CA olmayan sertifika güven köküne eklense de yayımcı olamaz', async () => {
    expect((await run('fake-child', { extra: [INT] }, store(certDer('alice')))).state).toBe('untrusted')
  })

  it('missing emailProtection EKU rejected', async () => {
    expect((await run('server-eku')).state).toBe('untrusted')
  })

  it('EKU hiç yoksa kabul', async () => {
    expect((await run('no-eku')).state).toBe('ok')
  })

  it('tls-only intermediate rejected', async () => {
    expect((await run('under-tls', { extra: [certDer('int-tls')] })).state).toBe('untrusted')
  })

  it('sign-only cert cannot encrypt', async () => {
    expect((await run('sign-only')).state).toBe('ok')
    expect((await run('sign-only', { purpose: 'encrypt' })).state).toBe('untrusted')
    expect((await run('alice', { purpose: 'encrypt' })).state).toBe('ok')
  })

  it('EC anahtar şifrelemeye uygun sayılmaz, imzalayabilir', async () => {
    expect((await run('ec-p256')).state).toBe('ok')
    expect((await run('ec-p256', { purpose: 'encrypt' })).state).toBe('untrusted')
  })

  it('expired at T', async () => {
    expect((await run('expired')).state).toBe('expired')
  })

  it('valid at T, expired now', async () => {
    const v = await run('expired', { at: Date.UTC(2020, 5, 1) })
    expect(v).toMatchObject({ state: 'ok', expiredSince: true })
  })

  it('henüz geçerli olmayan T expired sayılır', async () => {
    expect((await run('expired', { at: Date.UTC(2019, 5, 1) })).state).toBe('expired')
  })

  it('sha1 in chain', async () => {
    expect((await run('sha1')).state).toBe('weak')
    expect((await run('under-sha1', { extra: [certDer('int-sha1')] })).state).toBe('weak')
  })

  it('RSA-PSS imzalı yaprak kabul', async () => {
    expect((await run('pss')).state).toBe('ok')
  })

  it('rsa1024 leaf', async () => {
    expect((await run('rsa1024')).state).toBe('weak')
  })

  it('path over 8 rejected', async () => {
    expect((await run('deep-leaf', { extra: pemCerts('deep-chain.pem') })).state).toBe('untrusted')
  })

  it('pathLenConstraint aşılırsa reddedilir', async () => {
    expect((await run('pathlen-leaf', { extra: [certDer('pathlen-int'), certDer('pathlen-sub')] })).state).toBe('untrusted')
  })

  it('tanınmayan kritik uzantı untrusted', async () => {
    expect((await run('critical-ext')).state).toBe('untrusted')
  })

  it('birbirini imzalayan sertifikalar zincir kurucuyu döndürmez', async () => {
    const v = await run('cycle-a', { extra: [certDer('cycle-b')] })
    expect(v.state).toBe('untrusted')
  }, 5000)
})

describe('adres ve ayrıştırma', () => {
  it('büyük/küçük harf ve IDN eşleşir', () => {
    expect(sameAddress('A@Örnek.test', 'a@xn--rnek-4qa.test')).toBe(true)
  })
  it('+etiket soyulmaz', () => {
    expect(sameAddress('a+b@x.test', 'a@x.test')).toBe(false)
  })
  it('san wins over subject email', () => {
    expect(parseCert(certDer('san-wins')).emails).toEqual(['san@example.test'])
  })
  it('subject email used only without san', () => {
    expect(parseCert(certDer('subject-email')).emails).toEqual(['subject@example.test'])
  })
  it('alanlar', () => {
    const c = parseCert(certDer('alice'))
    expect(c).toMatchObject({ ca: false, selfSigned: false, canSign: true, canEncrypt: true, emailEku: true, rsaBits: 2048, curve: null, sigHash: 'sha256' })
    expect(c.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(c.subject).toContain('CN=Alice')
    expect(c.issuer).toContain('CN=Test Intermediate')
    expect(c.crlUrls).toEqual(['http://crl.example.test/int.crl'])
    expect(c.notAfter).toBe(Date.UTC(2100, 0, 1))
    expect(parseCert(certDer('ec-p256'))).toMatchObject({ rsaBits: null, curve: 'P-256', canEncrypt: false })
    expect(parseCert(certDer('sign-only'))).toMatchObject({ canSign: true, canEncrypt: false })
    expect(parseCert(certDer('sha1')).sigHash).toBe('sha1')
    expect(parseCert(certDer('pss')).sigHash).toBe('sha256')
    expect(parseCert(certDer('root'))).toMatchObject({ ca: true, selfSigned: true })
  })
  it('bozuk giriş SmimeFormatError', () => {
    expect(() => parseCert(Buffer.from('bozuk'))).toThrow(SmimeFormatError)
    expect(() => parseCert(new Uint8Array(0))).toThrow(SmimeFormatError)
  })
})

describe('ad kısıtları', () => {
  const NC = certDer('nc-int')
  const nc = (leaf: string, extra: Uint8Array[]) => run(leaf, { extra })

  it('izinli adres geçer, izinsiz denetim örneği düşer', async () => {
    expect((await nc('nc-ok', [NC])).state).toBe('ok')
    expect((await nc('nc-ctrl', [NC])).state).toBe('untrusted')
  })
  it('alt CA kısıtı genişletemez', async () => {
    expect((await nc('nc-widen', [certDer('nc-sub'), NC])).state).toBe('untrusted')
  })
  it('SAN içinde biri izinli diye diğeri geçmez', async () => {
    expect((await nc('nc-anyof', [NC])).state).toBe('untrusted')
  })
  it('yalnız DNS SAN olan sertifikada konu e-postası denetlenir', async () => {
    expect((await nc('nc-dns', [NC])).state).toBe('untrusted')
  })
  it('SAN yokken konu e-postası yasak alt ağaca takılır', async () => {
    expect((await nc('nc-ex-leaf', [certDer('nc-ex-int')])).state).toBe('untrusted')
  })
  it('değerlendirilemeyen kısıt untrusted', async () => {
    expect((await nc('nc-bad-leaf', [certDer('nc-bad-int')])).state).toBe('untrusted')
  })
  it('rfc822 eşleşme kuralları (RFC 5280)', () => {
    const allow = (a: string, ...permitted: string[]) => nameAllowed(a, { permitted, excluded: [] })
    expect(allow('a@example.test', 'example.test')).toBe(true)
    expect(allow('A@EXAMPLE.test', 'example.test')).toBe(true)
    expect(allow('a@sub.example.test', 'example.test')).toBe(false)
    expect(allow('a@sub.example.test', '.example.test')).toBe(true)
    expect(allow('a@example.test', '.example.test')).toBe(false)
    expect(allow('a@notexample.test', '.example.test')).toBe(false)
    expect(allow('a@example.test', 'b@example.test')).toBe(false)
    expect(allow('b@example.test', 'b@example.test')).toBe(true)
    expect(allow('adres-degil', 'example.test')).toBe(false)
    expect(nameAllowed('a@x.test', { permitted: [], excluded: [] })).toBe(true)
    expect(nameAllowed('a@x.test', { permitted: ['x.test'], excluded: ['a@x.test'] })).toBe(false)
  })
})

describe('sertifika sınırları', () => {
  it('9000 bit RSA yaprak reddedilir', async () => {
    expect((await run('rsa9000')).state).toBe('untrusted')
  })
  it('9000 bit RSA ek sertifika zincire katılmaz', async () => {
    expect((await run('alice', { extra: [INT, certDer('rsa9000')] })).state).toBe('ok')
  })
  it('çözülemeyen uzantılı sertifika zincirde kabul edilmez', async () => {
    expect(parseCert(certDer('alice')).malformedExt).toBe(false)
    const s: TrustStore = { anchors: () => [{ ...parseCert(certDer('root')), malformedExt: true }], bundle: () => ({ count: 1, fetchedAt: '', sha256: '' }) }
    expect((await run('alice', {}, s)).state).toBe('untrusted')
  })
  it('zayıf kök anahtarı weak olur', async () => {
    const s: TrustStore = { anchors: () => [{ ...parseCert(certDer('root')), rsaBits: 1024 }], bundle: () => ({ count: 1, fetchedAt: '', sha256: '' }) }
    expect((await run('alice', {}, s)).state).toBe('weak')
  })
})
