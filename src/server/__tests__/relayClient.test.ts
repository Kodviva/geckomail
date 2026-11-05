// Motorun röle istemcisi: imza, sonuç eşlemesi, anahtar saklama ve adres yapılandırması.
import { createPublicKey, randomBytes, verify } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEADER_ENGINE, HEADER_NONCE, HEADER_SIGNATURE, HEADER_TIME, signingString } from '../../shared/relayProtocol'
import { openDb } from '../../sync/db'
import { makeQueries } from '../../sync/db/queries'
import { configFromEnv } from '../config'
import { createServerHost } from '../hosts/serverHost'
import { loadOrCreateRelayKey, relayDeviceId, relayEndpoint, RelayClient, relayKeyLoader } from '../relayClient'

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
const URL_BASE = 'https://relay.example.com'
const DEVICE = 'cihaz_kimligi-1'

interface Call { url: string; init: RequestInit }
const reply = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status })

describe('RelayClient', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let host: ReturnType<typeof createServerHost>
  let calls: Call[]
  let next: () => Response | Promise<Response>
  let client: RelayClient

  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return next()
  }) as unknown as typeof fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-relayclient-'))
    db = openDb(dir)
    q = makeQueries(db)
    host = createServerHost(randomBytes(32), () => null)
    calls = []
    next = () => reply(200, { status: 'ok' })
    client = new RelayClient({ url: URL_BASE, keys: relayKeyLoader(q, host), fetch: fake, now: () => 1_800_000_000_000 })
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('istek imzalıdır: imza yolu, zamanı, nonce\'u ve gövdeyi kapsar', async () => {
    await client.push(DEVICE, 'kutu')
    const { url, init } = calls[0]
    expect(url).toBe(`${URL_BASE}/v1/push`)
    expect(init.redirect).toBe('error')
    const h = init.headers as Record<string, string>
    const pub = Buffer.from(h[HEADER_ENGINE], 'base64url')
    expect(pub).toHaveLength(32)
    const body = Buffer.from(init.body as string)
    expect(JSON.parse(body.toString())).toEqual({ deviceId: DEVICE, c: 'kutu' })
    const data = signingString('POST', 'relay.example.com', '/v1/push', Number(h[HEADER_TIME]), h[HEADER_NONCE], body)
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, pub]), format: 'der', type: 'spki' })
    expect(verify(null, Buffer.from(data), key, Buffer.from(h[HEADER_SIGNATURE], 'base64url'))).toBe(true)
    expect(h[HEADER_TIME]).toBe('1800000000000')
  })

  it('nonce her istekte yeni, anahtar aynı', async () => {
    await client.push(DEVICE, 'a')
    await client.push(DEVICE, 'b')
    const [a, b] = calls.map((c) => c.init.headers as Record<string, string>)
    expect(a[HEADER_NONCE]).not.toBe(b[HEADER_NONCE])
    expect(a[HEADER_ENGINE]).toBe(b[HEADER_ENGINE])
    expect(a[HEADER_NONCE]).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
  })

  it('push sonucu eşlenir: bilinmeyen cihaz gone, kalan her hata retry', async () => {
    next = () => reply(200, { status: 'gone' })
    expect(await client.push(DEVICE, 'c')).toBe('gone')
    next = () => reply(404, { reason: 'notFound' })
    expect(await client.push(DEVICE, 'c')).toBe('gone')
    // ara vekilin 404'ü cihaz satırlarını sildirmez
    next = () => new Response('<html>404</html>', { status: 404 })
    expect(await client.push(DEVICE, 'c')).toBe('retry')
    for (const status of [401, 429, 500, 503]) {
      next = () => reply(status, { reason: 'x' })
      expect(await client.push(DEVICE, 'c'), String(status)).toBe('retry')
    }
    next = () => reply(200, { status: 'bilinmeyen' })
    expect(await client.push(DEVICE, 'c')).toBe('retry')
    next = () => Promise.reject(new Error('ağ'))
    expect(await client.push(DEVICE, 'c')).toBe('retry')
  })

  it('register cihaz kimliği döner, hatada ve bozuk kimlikte fırlatır', async () => {
    next = () => reply(200, { deviceId: DEVICE })
    expect(await client.register({ platform: 'ios', env: 'sandbox', token: 'a'.repeat(64) })).toBe(DEVICE)
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ platform: 'ios', env: 'sandbox', token: 'a'.repeat(64) })
    next = () => reply(503)
    await expect(client.register({ platform: 'ios', env: 'sandbox', token: 'a'.repeat(64) })).rejects.toThrow('relay.unavailable')
    next = () => reply(200, { deviceId: '../kacis' })
    await expect(client.register({ platform: 'ios', env: 'sandbox', token: 'a'.repeat(64) })).rejects.toThrow('relay.unavailable')
  })

  it('unregister imzalı DELETE gönderir, hata fırlatmaz', async () => {
    next = () => reply(204)
    await client.unregister(DEVICE)
    expect(calls[0].url).toBe(`${URL_BASE}/v1/devices/${DEVICE}`)
    expect(calls[0].init.method).toBe('DELETE')
    next = () => Promise.reject(new Error('ağ'))
    await expect(client.unregister(DEVICE)).resolves.toBeUndefined()
    const before = calls.length
    await client.unregister('../kacis')
    expect(calls).toHaveLength(before)
  })

  it('uç nokta biçimi gidiş-dönüş', () => {
    expect(relayEndpoint(DEVICE)).toBe(`relay:${DEVICE}`)
    expect(relayDeviceId(relayEndpoint(DEVICE))).toBe(DEVICE)
  })

  describe('motor anahtarı', () => {
    it('private key encrypted in prefs', async () => {
      const keys = await loadOrCreateRelayKey(q, host)
      const saved = q.prefGet('relay_engine_key')!
      const stored = JSON.parse(saved) as { publicKey: string; enc: string }
      const pkcs8 = keys.privateKey.export({ format: 'der', type: 'pkcs8' })
      expect(saved).not.toContain(pkcs8.toString('base64'))
      expect(saved).not.toContain(pkcs8.toString('base64url'))
      expect(Buffer.from(stored.enc, 'base64').includes(pkcs8)).toBe(false)
      const again = await loadOrCreateRelayKey(q, host)
      expect(again.publicKey.equals(keys.publicKey)).toBe(true)
      expect(again.privateKey.export({ format: 'der', type: 'pkcs8' }).equals(pkcs8)).toBe(true)
    })

    it('çözülemeyen anahtarda yenisi üretilir, yalnız röle cihazları silinir', async () => {
      const uid = q.insertUser({ username: 'ali', passwordHash: 'x', role: 'member' })
      const row = (endpoint: string, kind?: 'apns'): number =>
        q.upsertPushDevice({ userId: uid, sessionId: null, endpoint, p256dh: 'p', auth: 'a', label: null, now: 1, kind })
      const web = row('https://fcm.googleapis.com/x')
      row('relay:eski', 'apns')
      const first = await loadOrCreateRelayKey(q, host)
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const otherHost = createServerHost(randomBytes(32), () => null)
      const second = await loadOrCreateRelayKey(q, otherHost)
      expect(log).toHaveBeenCalled()
      log.mockRestore()
      expect(second.publicKey.equals(first.publicKey)).toBe(false)
      expect(q.listPushDevices(uid).map((d) => d.id)).toEqual([web])
    })

    it('başarısız yükleme önbelleğe alınmaz', async () => {
      let broken = true
      const load = relayKeyLoader(q, {
        encrypt: (v) => (broken ? Promise.reject(new Error('x')) : host.encrypt(v)), decrypt: (v) => host.decrypt(v)
      })
      await expect(load()).rejects.toThrow()
      broken = false
      await expect(load()).resolves.toBeDefined()
    })
  })
})

describe('GECKO_RELAY_URL', () => {
  const env = { GECKO_PUBLIC_ORIGIN: 'https://posta.example.com' }

  it('varsayılan Kodviva rölesi, off kapatır', () => {
    expect(configFromEnv(env).relayUrl).toBe('https://relay.kodviva.com')
    expect(configFromEnv({ ...env, GECKO_RELAY_URL: 'off' }).relayUrl).toBeNull()
    expect(configFromEnv({ ...env, GECKO_RELAY_URL: 'https://relay.example.com/' }).relayUrl).toBe('https://relay.example.com')
  })

  it('https zorunlu; kimlik bilgisi ya da yol reddedilir', () => {
    for (const v of ['http://relay.example.com', 'ftp://relay.example.com', 'https://u:p@relay.example.com', 'https://relay.example.com/yol', 'bozuk']) {
      expect(() => configFromEnv({ ...env, GECKO_RELAY_URL: v }), v).toThrow('GECKO_RELAY_URL')
    }
  })
})
