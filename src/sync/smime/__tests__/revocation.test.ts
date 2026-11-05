import { createPrivateKey, sign } from 'node:crypto'
import { fromBER, type Sequence } from 'asn1js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../../db'
import { makeQueries } from '../../db/queries'
import { parseCert } from '../certInfo'
import { CrlCache, storedRevocation } from '../revocation'
import { evaluateChain, type TrustStore } from '../trust'
import { AT, certDer, fxBytes } from './fx'

const anchors = [parseCert(certDer('root'))]
const store: TrustStore = { anchors: () => anchors, bundle: () => ({ count: 1, fetchedAt: '', sha256: '' }) }
const CRL_URL = 'http://crl.example.test/int.crl'
const HOUR = 3_600_000

describe('CRL', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let q: ReturnType<typeof makeQueries>
  let now: number
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-crl-'))
    db = openDb(dir)
    q = makeQueries(db)
    now = AT
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const cache = (fetchUrl: (u: string) => Promise<Buffer>, mode: 'crl' | 'off' = 'crl') => new CrlCache({ q, fetchUrl, mode: () => mode, now: () => now })
  const evalLeaf = (c: CrlCache, leaf: string, extra = [certDer('int')]) =>
    evaluateChain({ leaf: certDer(leaf), extra, at: AT, purpose: 'sign' }, store, c, () => now)

  it('revoked leaf', async () => {
    const c = cache(async () => fxBytes('int-revoked.crl.der'))
    expect((await evalLeaf(c, 'revoked')).revocation).toBe('unknown')
    await c.drain()
    expect((await evalLeaf(c, 'revoked')).state).toBe('revoked')
  })

  it('iptal, T tarihinden bağımsızdır: süresi dolmuş sertifika da iptal görünür', async () => {
    const c = cache(async () => fxBytes('int-revoked.crl.der'))
    await evalLeaf(c, 'revoked')
    await c.drain()
    const v = await evaluateChain({ leaf: certDer('revoked'), extra: [certDer('int')], at: Date.UTC(2019, 1, 1), purpose: 'sign' }, store, c, () => now)
    expect(v.state).toBe('revoked')
  })

  it('imzası tutmayan yeni liste bilinen iptali silemez', async () => {
    let served = fxBytes('int-revoked.crl.der')
    const c = cache(async () => served)
    await evalLeaf(c, 'revoked')
    await c.drain()
    const good = q.getCrl(CRL_URL)
    served = fxBytes('int-badsig.crl.der')
    now += 7 * HOUR
    q.putCrl({ url: CRL_URL, der: good!.der, thisUpdate: good!.this_update, nextUpdate: now - 1, fetchedAt: now - 7 * HOUR, lastErrorAt: null })
    await evalLeaf(c, 'revoked')
    await c.drain()
    expect(q.getCrl(CRL_URL)?.der).toEqual(good!.der)
    expect(q.getCrl(CRL_URL)?.last_error_at).toBe(now)
    expect((await evalLeaf(c, 'revoked')).state).toBe('revoked')
  })

  it('daha eski geçerli liste yenisinin yerine geçemez', async () => {
    const c = cache(async () => fxBytes('int-revoked.crl.der'))
    await evalLeaf(c, 'revoked')
    await c.drain()
    const row = q.getCrl(CRL_URL)!
    q.putCrl({ url: CRL_URL, der: fxBytes('int-empty.crl.der'), thisUpdate: row.this_update! + 1000, nextUpdate: now - 1, fetchedAt: now - 7 * HOUR, lastErrorAt: null })
    await evalLeaf(c, 'revoked')
    await c.drain()
    expect(q.getCrl(CRL_URL)?.der).toEqual(fxBytes('int-empty.crl.der'))
    expect(q.getCrl(CRL_URL)?.last_error_at).toBe(now)
  })

  it('iptal edilmemiş sertifika aynı listede good', async () => {
    const c = cache(async () => fxBytes('int-revoked.crl.der'))
    await evalLeaf(c, 'alice')
    await c.drain()
    expect(await evalLeaf(c, 'alice')).toMatchObject({ state: 'ok', revocation: 'good' })
  })

  it('crl missing returns unknown and schedules', async () => {
    const fetchUrl = vi.fn(async () => fxBytes('int-empty.crl.der'))
    const c = cache(fetchUrl)
    const leaf = parseCert(certDer('alice'))
    expect(c.missing(leaf)).toBe(true)
    expect(await evalLeaf(c, 'alice')).toMatchObject({ state: 'ok', revocation: 'unknown' })
    expect(fetchUrl).not.toHaveBeenCalled() // açılış beklemez
    await c.drain()
    expect(fetchUrl).toHaveBeenCalledWith(CRL_URL)
    expect(c.missing(leaf)).toBe(true) // imzası görülmeden taze sayılmaz
    expect((await evalLeaf(c, 'alice')).revocation).toBe('good')
    expect(c.missing(leaf)).toBe(false)
  })

  it('crl fetched only for chained cert', async () => {
    const fetchUrl = vi.fn(async () => fxBytes('int-empty.crl.der'))
    const c = cache(fetchUrl)
    expect((await evalLeaf(c, 'alice', [])).state).toBe('untrusted')
    await c.drain()
    expect(fetchUrl).not.toHaveBeenCalled()
  })

  it('ldap url ignored', async () => {
    const fetchUrl = vi.fn(async () => fxBytes('int-empty.crl.der'))
    const c = cache(fetchUrl)
    expect(parseCert(certDer('ldap-only')).crlUrls).toEqual([])
    expect((await evalLeaf(c, 'ldap-only')).revocation).toBe('unknown')
    await c.drain()
    expect(fetchUrl).not.toHaveBeenCalled()
  })

  it('mode off never fetches', async () => {
    const fetchUrl = vi.fn(async () => fxBytes('int-empty.crl.der'))
    const c = cache(fetchUrl, 'off')
    expect(await evalLeaf(c, 'alice')).toMatchObject({ state: 'ok', revocation: 'unknown' })
    await c.drain()
    expect(fetchUrl).not.toHaveBeenCalled()
  })

  it('bad crl signature ignored', async () => {
    const c = cache(async () => fxBytes('int-badsig.crl.der'))
    await evalLeaf(c, 'revoked')
    await c.drain()
    expect(await evalLeaf(c, 'revoked')).toMatchObject({ state: 'ok', revocation: 'unknown' })
  })

  it('failed fetch not retried within 6 hours', async () => {
    const fetchUrl = vi.fn(async (): Promise<Buffer> => {
      throw new Error('ağ')
    })
    const c = cache(fetchUrl)
    await evalLeaf(c, 'alice')
    await c.drain()
    expect(fetchUrl).toHaveBeenCalledTimes(1)
    expect(q.getCrl(CRL_URL)?.last_error_at).toBe(now)
    now += 5 * HOUR
    await evalLeaf(c, 'alice')
    await c.drain()
    expect(fetchUrl).toHaveBeenCalledTimes(1)
    now += 2 * HOUR
    await evalLeaf(c, 'alice')
    await c.drain()
    expect(fetchUrl).toHaveBeenCalledTimes(2)
  })

  it('bozuk liste hata sayılır, eski kayıt silinmez', async () => {
    let body = fxBytes('int-empty.crl.der')
    const c = cache(async () => body)
    await evalLeaf(c, 'alice')
    await c.drain()
    const der = q.getCrl(CRL_URL)?.der
    q.putCrl({ url: CRL_URL, der: null, thisUpdate: null, nextUpdate: now - 1, fetchedAt: now - 7 * HOUR, lastErrorAt: null })
    body = Buffer.from('bozuk')
    await evalLeaf(c, 'alice')
    await c.drain()
    expect(q.getCrl(CRL_URL)?.der).toEqual(der)
    expect(q.getCrl(CRL_URL)?.last_error_at).toBe(now)
  })

  it('fetch not triggered per open', async () => {
    const fetchUrl = vi.fn(async () => fxBytes('int-empty.crl.der'))
    const c = cache(fetchUrl)
    await evalLeaf(c, 'alice')
    await evalLeaf(c, 'alice')
    await c.drain()
    await evalLeaf(c, 'alice')
    await c.drain()
    expect(fetchUrl).toHaveBeenCalledTimes(1)
  })

  it('stop sonrası drain çekmez', async () => {
    const fetchUrl = vi.fn(async () => fxBytes('int-empty.crl.der'))
    const c = cache(fetchUrl)
    await evalLeaf(c, 'alice')
    c.stop()
    await c.drain()
    expect(fetchUrl).not.toHaveBeenCalled()
  })

  it('süresi geçmiş liste taze sayılmaz, yenisi kuyruğa girer', async () => {
    const fetchUrl = vi.fn(async () => fxBytes('int-empty.crl.der'))
    const c = cache(fetchUrl)
    await evalLeaf(c, 'alice')
    await c.drain()
    q.putCrl({ url: CRL_URL, der: null, thisUpdate: 1, nextUpdate: now - 1, fetchedAt: now - 7 * HOUR, lastErrorAt: null })
    expect((await evalLeaf(c, 'alice')).revocation).toBe('unknown')
    await c.drain()
    expect(fetchUrl).toHaveBeenCalledTimes(2)
  })

  const putCrlDer = (der: Buffer, o: { fetchedAt?: number; nextUpdate?: number | null; thisUpdate?: number } = {}): void =>
    q.putCrl({ url: CRL_URL, der, thisUpdate: o.thisUpdate ?? 1, nextUpdate: o.nextUpdate === undefined ? now + 86_400_000 : o.nextUpdate, fetchedAt: o.fetchedAt ?? now, lastErrorAt: null })

  it('imzası doğrulanmamış satır taze sayılmaz, süresi gelince yeniden çekilir', async () => {
    const fetchUrl = vi.fn(async () => fxBytes('int-revoked.crl.der'))
    const c = cache(fetchUrl)
    putCrlDer(fxBytes('int-badsig.crl.der'), { nextUpdate: Date.UTC(2098, 0, 1) })
    const leaf = parseCert(certDer('revoked'))
    expect((await evalLeaf(c, 'revoked')).revocation).toBe('unknown')
    expect(c.missing(leaf)).toBe(true)
    await c.drain()
    expect(fetchUrl).toHaveBeenCalledTimes(0) // henüz 6 saat dolmadı
    now += 7 * HOUR
    await evalLeaf(c, 'revoked')
    await c.drain()
    expect(fetchUrl).toHaveBeenCalledTimes(1)
    expect((await evalLeaf(c, 'revoked')).state).toBe('revoked')
    expect(c.missing(leaf)).toBe(false)
  })

  it('bayat liste sertifikayı listeliyorsa yine revoked', async () => {
    const c = cache(vi.fn(async () => { throw new Error('ağ yok') }))
    putCrlDer(fxBytes('int-revoked.crl.der'), { nextUpdate: now - 1000 })
    expect((await evalLeaf(c, 'revoked')).state).toBe('revoked')
  })

  it('bayat liste sertifikayı içermiyorsa unknown', async () => {
    const c = cache(vi.fn(async () => { throw new Error('ağ yok') }))
    putCrlDer(fxBytes('int-empty.crl.der'), { nextUpdate: now - 1000 })
    expect(await evalLeaf(c, 'alice')).toMatchObject({ state: 'ok', revocation: 'unknown' })
  })

  it('gelecek tarihli thisUpdate taze sayılmaz', async () => {
    const c = cache(vi.fn(async () => { throw new Error('ağ yok') }))
    putCrlDer(fxBytes('int-empty.crl.der'), { thisUpdate: now + 86_400_000 })
    expect((await evalLeaf(c, 'alice')).revocation).toBe('unknown')
  })

  describe('IDP ve delta', () => {
    const verdict = async (file: string, leaf = 'revoked') => {
      const c = cache(vi.fn(async () => Buffer.alloc(0)))
      putCrlDer(fxBytes(file))
      return evalLeaf(c, leaf)
    }
    it('eşleşen IDP tam liste sayılır', async () => {
      expect((await verdict('crl-idp-match.der')).state).toBe('revoked')
      expect((await verdict('crl-idp-user.der')).state).toBe('revoked')
    })
    for (const f of ['crl-idp-ca.der', 'crl-idp-reasons.der', 'crl-idp-indirect.der', 'crl-idp-attr.der', 'crl-idp-other.der', 'crl-delta.der']) {
      it(`${f} kullanılmaz, sonuç good olamaz`, async () => {
        expect(await verdict(f)).toMatchObject({ state: 'ok', revocation: 'unknown' })
        expect(await verdict(f, 'alice')).toMatchObject({ state: 'ok', revocation: 'unknown' })
      })
    }
    it('nedenli CDP good vermez', async () => {
      const leaf = parseCert(certDer('reasons-cdp'))
      expect(leaf.crlUrls).toEqual([])
      expect(await verdict('int-empty.crl.der', 'reasons-cdp')).toMatchObject({ state: 'ok', revocation: 'unknown' })
    })
  })

  describe('büyük CRL', () => {
    /** int-empty listesine N kayıt ekleyip int.key ile imzalar */
    const bigCrl = (n: number, revoked: Buffer): Buffer => {
      const len = (l: number): Buffer => {
        if (l < 128) return Buffer.from([l])
        const b: number[] = []
        for (let v = l; v > 0; v = Math.floor(v / 256)) b.unshift(v % 256)
        return Buffer.from([0x80 | b.length, ...b])
      }
      const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), len(body.length), body])
      const asn = fromBER(new Uint8Array(fxBytes('int-empty.crl.der'))).result as Sequence
      const tbsItems = (asn.valueBlock.value[0] as Sequence).valueBlock.value
      const raw = (b: { valueBeforeDecodeView: Uint8Array }): Buffer => Buffer.from(b.valueBeforeDecodeView)
      const time = Buffer.concat([Buffer.from([0x17, 13]), Buffer.from('300101000000Z')])
      const reason = tlv(0x30, tlv(0x30, Buffer.concat([Buffer.from('0603551d15', 'hex'), tlv(0x04, Buffer.from('0a0101', 'hex'))])))
      const entries: Buffer[] = []
      for (let i = 0; i < n; i++) entries.push(tlv(0x30, Buffer.concat([tlv(0x02, Buffer.from([0x10, i >> 16, (i >> 8) & 255, i & 255])), time, reason])))
      entries.push(tlv(0x30, Buffer.concat([tlv(0x02, revoked), time, reason])))
      const at = tbsItems.findIndex((b) => b.idBlock.tagNumber === 23 || b.idBlock.tagNumber === 24) + 2
      const before = tbsItems.slice(0, at).map(raw)
      const after = tbsItems.slice(at).map(raw)
      const tbs = tlv(0x30, Buffer.concat([...before, tlv(0x30, Buffer.concat(entries)), ...after]))
      const sig = sign('sha256', tbs, createPrivateKey(fxBytes('int.key')))
      return tlv(0x30, Buffer.concat([tbs, raw(asn.valueBlock.value[1]), tlv(0x03, Buffer.concat([Buffer.from([0]), sig]))]))
    }
    const serial = (name: string): Buffer => Buffer.from(parseCert(certDer(name)).cert.serialNumber.valueBlock.valueHexView)

    it('nedenli 5000 kayıtlı liste ayrışır ve iptal görülür', async () => {
      const der = bigCrl(5000, serial('revoked'))
      const c = cache(async () => der)
      await evalLeaf(c, 'revoked')
      await c.drain()
      expect((await evalLeaf(c, 'revoked')).state).toBe('revoked')
      expect(await evalLeaf(c, 'alice')).toMatchObject({ state: 'ok', revocation: 'good' })
    })

    describe('saklı seri kümesi', () => {
      const leaf = (name = 'revoked'): ReturnType<typeof parseCert> => parseCert(certDer(name))
      const issuer = (): ReturnType<typeof parseCert> => parseCert(certDer('int'))
      const stored = (der: Buffer): void => q.putCrl({ url: CRL_URL, der, thisUpdate: 1, nextUpdate: now + 1000 * HOUR, fetchedAt: now, lastErrorAt: null })

      it('büyük liste kümesi hazır değilse pending, drain sonrası revoked', async () => {
        stored(bigCrl(10_000, serial('revoked')))
        const c = cache(async () => Buffer.alloc(0))
        expect(storedRevocation(q, leaf(), issuer())).toBe('pending')
        expect(storedRevocation(q, leaf('alice'), issuer())).toBe('pending') // listede yok diyebilmek için de küme gerekir
        await c.drain()
        expect(storedRevocation(q, leaf(), issuer())).toBe('revoked')
        expect(storedRevocation(q, leaf('alice'), issuer())).toBe('good')
      })

      it('küme kalıcıdır: önbellek boşalsa da, yeniden başlatmada da tablo okunur', async () => {
        stored(bigCrl(10_000, serial('revoked')))
        const a = cache(async () => Buffer.alloc(0))
        storedRevocation(q, leaf(), issuer())
        await a.drain()
        const reopened = makeQueries(db) // yeni süreç: bellekte hiçbir şey yok
        expect(storedRevocation(reopened, leaf(), issuer())).toBe('revoked')
      })

      it('çekilen büyük liste kümesiyle birlikte hazır gelir', async () => {
        const c = cache(async () => bigCrl(10_000, serial('revoked')))
        await evalLeaf(c, 'revoked')
        await c.drain()
        expect(storedRevocation(q, leaf(), issuer())).toBe('revoked')
      })

      it('yenileme sürerken eski küme okunur, pending olmaz', async () => {
        let serve = bigCrl(10_000, serial('revoked'))
        const c = cache(async () => serve)
        await evalLeaf(c, 'revoked')
        await c.drain()
        const seen: string[] = []
        const put = q.putCrl
        q.addCrlSerials = ((orig) => (...a: Parameters<typeof orig>) => {
          seen.push(storedRevocation(q, leaf(), issuer()))
          return orig(...a)
        })(q.addCrlSerials)
        now += 7 * HOUR
        const row = q.getCrl(CRL_URL)!
        put({ url: CRL_URL, der: row.der, thisUpdate: row.this_update, nextUpdate: now - 1, fetchedAt: row.fetched_at, lastErrorAt: null })
        serve = bigCrl(10_001, serial('revoked'))
        await evalLeaf(c, 'revoked')
        await c.drain()
        expect(seen.length).toBeGreaterThan(0)
        expect(new Set(seen)).toEqual(new Set(['revoked']))
      })

      it('küçük liste hemen yanıtlanır, imzası tutmayan liste küme yazmaz', () => {
        stored(fxBytes('int-badsig.crl.der'))
        expect(storedRevocation(q, leaf(), issuer())).toBe('good')
        expect(q.crlSetState(CRL_URL)?.set_key).toBeNull()
        stored(fxBytes('int-revoked.crl.der'))
        expect(storedRevocation(q, leaf(), issuer())).toBe('revoked')
      })

      it('küme anahtarı listeyi kapsar: sürüm aynı, içerik farklıysa eski küme okunmaz', () => {
        stored(fxBytes('int-revoked.crl.der'))
        expect(storedRevocation(q, leaf(), issuer())).toBe('revoked')
        stored(fxBytes('int-empty.crl.der')) // fetchedAt aynı
        expect(storedRevocation(q, leaf(), issuer())).toBe('good')
      })

      it('başka yayımcının reddi doğrulanmış kümeyi değiştirmez', () => {
        stored(fxBytes('int-revoked.crl.der'))
        expect(storedRevocation(q, leaf(), issuer())).toBe('revoked')
        const before = q.crlSetState(CRL_URL)
        const other = parseCert(certDer('root'))
        expect(storedRevocation(q, leaf(), other)).toBe('good')
        expect(storedRevocation(q, leaf(), other)).toBe('good')
        expect(q.crlSetState(CRL_URL)).toEqual(before)
        expect(storedRevocation(q, leaf(), issuer())).toBe('revoked')
      })

      it('aynı durumda küme yeniden yazılmaz: yeniden sıraya alınma da, aynı listenin çekimi de', async () => {
        const der = bigCrl(10_000, serial('revoked'))
        const c = cache(async () => der)
        await evalLeaf(c, 'revoked')
        await c.drain()
        const before = q.crlSetState(CRL_URL)
        const add = vi.spyOn(q, 'addCrlSerials')
        now += 7 * HOUR
        const row = q.getCrl(CRL_URL)!
        q.putCrl({ url: CRL_URL, der: row.der, thisUpdate: row.this_update, nextUpdate: now - 1, fetchedAt: row.fetched_at, lastErrorAt: null })
        await evalLeaf(c, 'revoked')
        await c.drain()
        expect(q.getCrl(CRL_URL)?.fetched_at).toBe(now)
        expect(add).not.toHaveBeenCalled()
        expect(q.crlSetState(CRL_URL)).toEqual(before)
      })

      it('yazım sürerken aynı adreste okuyucu pending alır, yeni yazım başlamaz', async () => {
        stored(bigCrl(10_000, serial('revoked')))
        const c = cache(async () => Buffer.alloc(0))
        expect(storedRevocation(q, leaf(), issuer())).toBe('pending')
        const seen: string[] = []
        const add = q.addCrlSerials
        q.addCrlSerials = (...a: Parameters<typeof add>) => {
          seen.push(storedRevocation(q, leaf(), issuer()))
          return add(...a)
        }
        await c.drain()
        expect(new Set(seen)).toEqual(new Set(['pending']))
        q.addCrlSerials = add
        expect(storedRevocation(q, leaf(), issuer())).toBe('revoked')
      })

      it('yarım kalan nesil okunmaz, tamamlanmış nesil silinmez', async () => {
        const c = cache(async () => bigCrl(10_001, serial('revoked')))
        stored(fxBytes('int-revoked.crl.der'))
        expect(storedRevocation(q, leaf(), issuer())).toBe('revoked')
        const count = (): number => (db.prepare(`SELECT COUNT(*) AS n FROM smime_crl_serials WHERE url = ? AND generation = ?`).get(CRL_URL, q.crlSetState(CRL_URL)!.set_generation) as { n: number }).n
        const committed = count()
        const add = q.addCrlSerials
        q.addCrlSerials = (...a: Parameters<typeof add>) => {
          add(...a)
          c.stop() // ilk parçadan sonra kapanış
        }
        q.putCrl({ url: CRL_URL, der: q.getCrl(CRL_URL)!.der, thisUpdate: 1, nextUpdate: now - 1, fetchedAt: now - 7 * HOUR, lastErrorAt: null })
        await evalLeaf(c, 'revoked')
        await c.drain()
        q.addCrlSerials = add
        expect(count()).toBe(committed)
        expect(storedRevocation(q, leaf(), issuer())).toBe('revoked')
        expect(q.nextCrlGeneration(CRL_URL)).toBeGreaterThan(q.crlSetState(CRL_URL)!.set_generation! + 1)
      })
    })

    it('10 MB liste olay döngüsünü kilitlemez', async () => {
      const der = bigCrl(240_000, serial('revoked'))
      expect(der.length).toBeGreaterThan(8_000_000)
      const c = cache(async () => der)
      await evalLeaf(c, 'revoked')
      const t0 = performance.now()
      await c.drain()
      expect((await evalLeaf(c, 'revoked')).state).toBe('revoked')
      expect(performance.now() - t0).toBeLessThan(1500)
    }, 60_000)
  })
})
