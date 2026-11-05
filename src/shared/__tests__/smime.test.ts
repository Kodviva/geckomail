import { describe, expect, it } from 'vitest'
import { SMIME_MAX_BCC, SMIME_P12_MAX_BYTES, smimeBadges, worstSig, type SmimeEncState, type SmimeInfo, type SmimeNote, type SmimeSigState } from '../smime'

const info = (o: Partial<SmimeInfo>): SmimeInfo => ({ sig: 'none', enc: 'none', notes: [], signer: null, canSaveCert: false, ...o })

describe('worstSig', () => {
  it('geçersiz imza her şeyi ezer', () => {
    expect(worstSig(['verified', 'invalid'])).toBe('invalid')
  })
  it('öncelik sırası', () => {
    const order: SmimeSigState[] = ['invalid', 'unsupported', 'revoked', 'untrusted', 'expired', 'address_mismatch', 'weak_algorithm', 'verified', 'none']
    for (let i = 0; i < order.length; i++) expect(worstSig(order.slice(i))).toBe(order[i])
  })
  it('boş liste none', () => {
    expect(worstSig([])).toBe('none')
  })
})

describe('smimeBadges', () => {
  const rows: [Partial<SmimeInfo>, string, string][] = [
    [{ enc: 'decrypted' }, 'ok', 'smime.enc.decrypted'],
    [{ enc: 'decrypted', notes: ['weak_cipher'] }, 'warn', 'smime.enc.weakCipher'],
    [{ enc: 'decrypted', notes: ['unauthenticated'] }, 'warn', 'smime.enc.unauthenticated'],
    [{ enc: 'locked' }, 'muted', 'smime.enc.locked'],
    [{ enc: 'no_key' }, 'muted', 'smime.enc.noKey'],
    [{ enc: 'failed' }, 'bad', 'smime.enc.failed'],
    [{ enc: 'unsupported' }, 'muted', 'smime.enc.unsupported'],
    [{ sig: 'verified' }, 'ok', 'smime.sig.verified'],
    [{ sig: 'untrusted' }, 'warn', 'smime.sig.untrusted'],
    [{ sig: 'untrusted', notes: ['self_signed'] }, 'warn', 'smime.sig.selfSigned'],
    [{ sig: 'expired' }, 'warn', 'smime.sig.expired'],
    [{ sig: 'address_mismatch' }, 'bad', 'smime.sig.addressMismatch'],
    [{ sig: 'weak_algorithm' }, 'warn', 'smime.sig.weakAlgorithm'],
    [{ sig: 'revoked' }, 'bad', 'smime.sig.revoked'],
    [{ sig: 'invalid' }, 'bad', 'smime.sig.invalid'],
    [{ sig: 'unsupported' }, 'muted', 'smime.sig.unsupported']
  ]

  it('16 durumun her biri rozet tablosuna eşlenir', () => {
    expect(rows).toHaveLength(16)
    expect(new Set(rows.map((r) => r[2])).size).toBe(16)
    for (const [i, tone, labelKey] of rows) {
      const b = smimeBadges(info(i))
      expect(b).toHaveLength(1)
      expect(b[0]).toMatchObject({ tone, labelKey })
      expect(b[0].detailKey).toBeTruthy()
    }
  })

  it('yalnız doğrulandı ve çözüldü yeşildir', () => {
    expect(rows.filter((r) => r[1] === 'ok').map((r) => r[2])).toEqual(['smime.enc.decrypted', 'smime.sig.verified'])
  })

  it('unauthenticated tonu warn, weak_cipher ile birlikte de', () => {
    expect(smimeBadges(info({ enc: 'decrypted', notes: ['unauthenticated'] }))[0].tone).toBe('warn')
    expect(smimeBadges(info({ enc: 'decrypted', notes: ['weak_cipher', 'unauthenticated'] }))[0].labelKey).toBe('smime.enc.unauthenticated')
  })

  it('self_signed notu verified üretmez', () => {
    const b = smimeBadges(info({ sig: 'verified', notes: ['self_signed'] }))
    expect(b.map((x) => x.labelKey)).toEqual(['smime.sig.selfSigned'])
    expect(b[0].tone).toBe('warn')
  })

  it('önce şifre, sonra imza; en çok 2 rozet', () => {
    expect(smimeBadges(info({ enc: 'decrypted', sig: 'verified' })).map((b) => b.labelKey)).toEqual(['smime.enc.decrypted', 'smime.sig.verified'])
  })

  it('S/MIME değilse rozet yok', () => {
    expect(smimeBadges(info({}))).toEqual([])
  })

  it('tüm durum/not birleşimlerinde 0–2 rozet, sınırsız not rozet üretmez', () => {
    const encs: SmimeEncState[] = ['none', 'decrypted', 'locked', 'no_key', 'failed', 'unsupported']
    const notes: SmimeNote[] = ['self_signed', 'cert_expired_since', 'revocation_unknown', 'weak_cipher', 'unauthenticated', 'header_mismatch', 'too_large']
    for (const enc of encs) expect(smimeBadges(info({ enc, sig: 'verified', notes })).length).toBeLessThanOrEqual(2)
  })
})

describe('sabitler', () => {
  it('plan değerleri', () => {
    expect(SMIME_MAX_BCC).toBe(20)
    expect(SMIME_P12_MAX_BYTES).toBe(262_144)
  })
})
