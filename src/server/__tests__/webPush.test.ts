import { createECDH, createPublicKey, generateKeyPairSync, verify } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../../sync/db'
import { makeQueries, type PushDevice } from '../../sync/db/queries'
import { decryptPush } from './pushTestUtil'
import { encryptPayload, isAllowedPushHost, loadOrCreateVapid, sendPush, vapidHeaders, type VapidKeys } from '../webPush'

const b64 = (s: string): Buffer => Buffer.from(s, 'base64url')

function vapidPair(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const j = publicKey.export({ format: 'jwk' })
  const pub = Buffer.concat([Buffer.from([4]), b64(j.x!), b64(j.y!)]).toString('base64url')
  return { publicKey: pub, privateKey: privateKey.export({ format: 'jwk' }).d! }
}

describe('encryptPayload (RFC 8291)', () => {
  it('RFC 8291 Ek A test vektörü birebir', () => {
    // RFC 8291 Ek A değerleri (bölünmüş satırlar birleştirildi)
    const plain = b64('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24')
    const asPrivate = b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw')
    const uaPublic = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'
    const salt = b64('DGv6ra1nlYgDCS1FRnbzlw')
    const auth = 'BTBZMqHH6r4Tts7J_aSIgg'
    const header = b64('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8')
    const cipher = b64('8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ')
    const expected = Buffer.concat([header, cipher])

    const serverKeys = createECDH('prime256v1')
    serverKeys.setPrivateKey(asPrivate)
    const out = encryptPayload(plain, uaPublic, auth, { salt, serverKeys })
    expect(out.toString('base64url')).toBe(expected.toString('base64url'))
    expect(header.length).toBe(86)
  })

  it('her çağrı yeni salt ve geçici anahtar kullanır, alıcı çözer', () => {
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const auth = Buffer.alloc(16, 7)
    const plain = Buffer.from('çözülebilir yük')
    const p256dh = ua.getPublicKey().toString('base64url')
    const a = encryptPayload(plain, p256dh, auth.toString('base64url'))
    const b = encryptPayload(plain, p256dh, auth.toString('base64url'))
    expect(a.equals(b)).toBe(false)
    expect(a.readUInt32BE(16)).toBe(4096)
    expect(decryptPush(a, ua, auth).toString()).toBe('çözülebilir yük')
  })
})

describe('vapidHeaders', () => {
  it('ES256 JWT imzası doğrulanır; aud uç noktanın kökeni, exp en çok 12 saat', () => {
    const keys = vapidPair()
    const now = 1_800_000_000
    const { Authorization } = vapidHeaders('https://fcm.googleapis.com/fcm/send/abc?x=1', keys, 'mailto:postmaster@posta.example.com', now)
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(Authorization)!
    expect(m[2]).toBe(keys.publicKey)
    const [h, p, s] = m[1].split('.')
    expect(JSON.parse(b64(h).toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
    const claims = JSON.parse(b64(p).toString())
    expect(claims.aud).toBe('https://fcm.googleapis.com')
    expect(claims.sub).toBe('mailto:postmaster@posta.example.com')
    expect(claims.exp).toBeGreaterThan(now)
    expect(claims.exp).toBeLessThanOrEqual(now + 12 * 3600)

    const raw = b64(keys.publicKey)
    const key = createPublicKey({
      format: 'jwk',
      key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }
    })
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, b64(s))).toBe(true)
  })
})

describe('isAllowedPushHost', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/x',
    'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://foo.push.services.mozilla.com/x',
    'https://web.push.apple.com/x',
    'https://wns2-db5p.notify.windows.com/w/?token=x'
  ])('izinli: %s', (u) => expect(isAllowedPushHost(u)).toBe(true))

  it.each([
    'http://fcm.googleapis.com/fcm/send/x',
    'https://fcm.googleapis.com:8443/x',
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com.evil.test/x',
    'https://evilpush.apple.com/x',
    'https://push.apple.com/x',
    'https://169.254.169.254/latest',
    'https://localhost/x',
    'http://127.0.0.1:9/x',
    'bozuk'
  ])('izinsiz: %s', (u) => expect(isAllowedPushHost(u)).toBe(false))

  it('ek ana makine yalnız verilirse geçer (yerel sahte servis, düz http)', () => {
    expect(isAllowedPushHost('http://127.0.0.1:9/x', ['127.0.0.1'])).toBe(true)
    expect(isAllowedPushHost('http://127.0.0.2:9/x', ['127.0.0.1'])).toBe(false)
  })
})

describe('sendPush', () => {
  const ua = createECDH('prime256v1')
  ua.generateKeys()
  const auth = Buffer.alloc(16, 3)
  const dev = {
    id: 1, user_id: 1, web_session_id: null, endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: ua.getPublicKey().toString('base64url'),
    auth: auth.toString('base64url'), label: null, kind: 'webpush', created_at: 0, last_ok_at: null
  } as PushDevice
  const opts = { keys: vapidPair(), subject: 'mailto:postmaster@x.test', urgency: 'high' as const, ttl: 86400 }

  it('başlıklar ve şifreli gövde; yönlendirme izlenmez', async () => {
    const fetch = vi.fn(async (..._a: Parameters<typeof globalThis.fetch>) => new Response(null, { status: 201 }))
    expect(await sendPush(dev, { title: 'gizli konu' }, { ...opts, fetch })).toBe('ok')
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(dev.endpoint)
    const h = init!.headers as Record<string, string>
    expect(h['Content-Encoding']).toBe('aes128gcm')
    expect(h.TTL).toBe('86400')
    expect(h.Urgency).toBe('high')
    expect(h.Authorization).toMatch(/^vapid t=/)
    expect(init!.redirect).toBe('error')
    const body = Buffer.from(init!.body as Uint8Array)
    expect(body.includes('gizli konu')).toBe(false)
    expect(JSON.parse(decryptPush(body, ua, auth).toString())).toEqual({ title: 'gizli konu' })
  })

  it.each([
    [404, 'gone'], [410, 'gone'], [429, 'retry'], [500, 'retry'], [503, 'retry'], [201, 'ok']
  ])('durum %i → %s', async (status, want) => {
    const fetch = vi.fn(async () => new Response(null, { status }))
    expect(await sendPush(dev, {}, { ...opts, fetch })).toBe(want)
  })

  it('ağ hatası retry; kayıt silinmez', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await sendPush(dev, {}, { ...opts, fetch })).toBe('retry')
  })
})

describe('loadOrCreateVapid', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  const host = {
    encrypt: async (v: string[]) => v.map((s) => new Uint8Array(Buffer.from(`sealed:${Buffer.from(s).toString('hex')}`))),
    decrypt: async (b: Uint8Array[]) =>
      b.map((u) => {
        const s = Buffer.from(u).toString()
        return new Uint8Array(s.startsWith('sealed:') ? Buffer.from(s.slice(7), 'hex') : [])
      })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-vapid-'))
    db = openDb(dir)
    q = makeQueries(db)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('bir kez üretir, sonra aynısını okur; özel anahtar prefs\'te düz değil', async () => {
    const a = await loadOrCreateVapid(q, host)
    expect(b64(a.publicKey).length).toBe(65)
    expect(b64(a.privateKey).length).toBe(32)
    expect(await loadOrCreateVapid(q, host)).toEqual(a)
    expect(JSON.stringify(q.getAllPrefs())).not.toContain(a.privateKey)
  })

  it('eşzamanlı ilk çağrılar aynı anahtarda buluşur', async () => {
    const [a, b] = await Promise.all([loadOrCreateVapid(q, host), loadOrCreateVapid(q, host)])
    expect(a).toEqual(b)
  })

  it('çözülemeyen anahtar yenilenir, eski anahtara bağlı cihazlar silinir', async () => {
    const a = await loadOrCreateVapid(q, host)
    const userId = q.insertUser({ username: 'u', passwordHash: 'x', role: 'member' })
    q.upsertPushDevice({ userId, sessionId: null, endpoint: 'https://fcm.googleapis.com/x', p256dh: 'p', auth: 'a', label: null, now: 1 })
    const b = await loadOrCreateVapid(q, { ...host, decrypt: async (l) => l.map(() => new Uint8Array(0)) })
    expect(b.publicKey).not.toBe(a.publicKey)
    expect(q.listPushDevices(userId)).toEqual([])
  })
})
