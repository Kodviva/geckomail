import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'crypto'
import { readFileSync } from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clientIp } from '../../shared/clientIp'
import {
  engineId, OUTBOUND_HOSTS, RELAY_MAX_CIPHERTEXT, RELAY_SKEW_MS, signingString, WEB_PUSH_HOSTS, WEB_PUSH_SUFFIXES, type RelayResult
} from '../../shared/relayProtocol'
import { isAllowedPushHost } from '../../server/webPush'
import { APNS_BASES } from '../apns'
import { relayConfigFromEnv, type RelayConfig } from '../config'
import { FCM_BASE, OAUTH_BASE } from '../fcm'
import { MAX_DEVICES } from '../limits'
import { createRelayServer } from '../server'
import { dayOf, RelayStore, type RelayDevice } from '../store'

const IOS_TOKEN = 'a'.repeat(64)
const ANDROID_TOKEN = 'b'.repeat(40)

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }

interface Engine { publicRaw: Buffer; privateKey: KeyObject; id: string }

function newEngine(): Engine {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicRaw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')
  return { publicRaw, privateKey, id: engineId(publicRaw) }
}

describe('geckomail-relay', () => {
  let store: RelayStore
  let server: http.Server
  let port: number
  let t: number
  let apnsResult: RelayResult
  let fcmResult: RelayResult
  let apnsCalls: [RelayDevice, string][]
  let fcmCalls: [RelayDevice, string][]
  let engine: Engine
  const cfg: RelayConfig = { listenHost: '127.0.0.1', listenPort: 0, dataDir: '/yok', trustedProxyDepth: 0, publicHost: 'relay.example.com' }

  beforeEach(async () => {
    t = 1_800_000_000_000
    apnsResult = 'ok'
    fcmResult = 'ok'
    apnsCalls = []
    fcmCalls = []
    engine = newEngine()
    store = new RelayStore(':memory:')
    server = createRelayServer({
      cfg, store, now: () => t,
      apns: async (d, c) => {
        apnsCalls.push([d, c])
        return apnsResult
      },
      fcm: async (d, c) => {
        fcmCalls.push([d, c])
        return fcmResult
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await new Promise<void>((r) => server.close(() => r()))
    server.closeAllConnections()
    store.close()
  })

  const raw = (method: string, path: string, o: { headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<Res> =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method, path, headers: o.headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }))
      })
      r.on('error', reject)
      if (o.body != null) r.write(o.body)
      r.end()
    })

  const signed = (
    method: string, path: string, body?: unknown,
    o: { engine?: Engine; ts?: number; nonce?: string; key?: KeyObject; headers?: Record<string, string>; host?: string } = {}
  ): Promise<Res> => {
    const e = o.engine ?? engine
    const buf = Buffer.from(body === undefined ? '' : JSON.stringify(body))
    const ts = o.ts ?? t
    const nonce = o.nonce ?? randomBytes(16).toString('base64url')
    const sig = sign(null, Buffer.from(signingString(method, o.host ?? cfg.publicHost, path, ts, nonce, buf)), o.key ?? e.privateKey)
    return raw(method, path, {
      headers: {
        'content-type': 'application/json', 'x-gecko-engine': e.publicRaw.toString('base64url'), 'x-gecko-time': String(ts),
        'x-gecko-nonce': nonce, 'x-gecko-signature': sig.toString('base64url'), ...o.headers
      },
      body: buf
    })
  }
  const register = async (o: { token?: string; platform?: string; env?: string; engine?: Engine } = {}): Promise<string> => {
    const r = await signed('POST', '/v1/devices', { platform: o.platform ?? 'ios', env: o.env ?? 'production', token: o.token ?? IOS_TOKEN }, { engine: o.engine })
    expect(r.status).toBe(200)
    return (JSON.parse(r.body) as { deviceId: string }).deviceId
  }
  const push = (deviceId: string, c = 'kutu', e?: Engine) => signed('POST', '/v1/push', { deviceId, c }, { engine: e })

  it('healthz imzasız, diğer her şey imzalı', async () => {
    const r = await raw('GET', '/healthz')
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toEqual({ ok: true })
    expect((await raw('POST', '/v1/devices', { body: '{}' })).status).toBe(401)
    expect((await raw('POST', '/v1/push', { body: '{}' })).status).toBe(401)
    expect((await raw('DELETE', '/v1/devices/abc')).status).toBe(401)
  })

  it('bad signature 401', async () => {
    const other = newEngine()
    expect((await signed('POST', '/v1/devices', { platform: 'ios', env: 'production', token: IOS_TOKEN }, { key: other.privateKey })).status).toBe(401)
    // gövde imzadan sonra değişti
    const buf = Buffer.from('{"a":1}')
    const nonce = randomBytes(16).toString('base64url')
    const sig = sign(null, Buffer.from(signingString('POST', cfg.publicHost, '/v1/push', t, nonce, buf)), engine.privateKey).toString('base64url')
    const r = await raw('POST', '/v1/push', {
      headers: { 'x-gecko-engine': engine.publicRaw.toString('base64url'), 'x-gecko-time': String(t), 'x-gecko-nonce': nonce, 'x-gecko-signature': sig },
      body: '{"a":2}'
    })
    expect(r.status).toBe(401)
    // yol imzaya dahil
    const path = await signed('POST', '/v1/devices', {}, { headers: { 'x-gecko-signature': sig } })
    expect(path.status).toBe(401)
    expect(store.hasEngine(engine.id)).toBe(false)
    expect(store.hasEngine(other.id)).toBe(false)
  })

  it('bozuk başlıklar 401, sunucu düşmez', async () => {
    const h = { 'x-gecko-engine': 'AAAA', 'x-gecko-time': String(t), 'x-gecko-nonce': 'n'.repeat(16), 'x-gecko-signature': 'AAAA' }
    expect((await raw('POST', '/v1/push', { headers: h, body: '{}' })).status).toBe(401)
    expect((await raw('POST', '/v1/push', { headers: { ...h, 'x-gecko-time': 'abc' }, body: '{}' })).status).toBe(401)
    expect((await raw('POST', '/v1/push', { headers: { ...h, 'x-gecko-engine': '$$$' }, body: '{}' })).status).toBe(401)
    expect((await signed('POST', '/v1/devices', {}, { nonce: 'kisa' })).status).toBe(401)
  })

  it('replayed nonce 401', async () => {
    const nonce = randomBytes(16).toString('base64url')
    const body = { platform: 'ios', env: 'production', token: IOS_TOKEN }
    expect((await signed('POST', '/v1/devices', body, { nonce })).status).toBe(200)
    expect((await signed('POST', '/v1/devices', body, { nonce })).status).toBe(401)
    // başka motorun aynı nonce'u çakışmaz
    expect((await signed('POST', '/v1/devices', body, { nonce, engine: newEngine() })).status).toBe(200)
  })

  it('skewed clock 401', async () => {
    const body = { platform: 'ios', env: 'production', token: IOS_TOKEN }
    expect((await signed('POST', '/v1/devices', body, { ts: t - RELAY_SKEW_MS - 1 })).status).toBe(401)
    expect((await signed('POST', '/v1/devices', body, { ts: t + RELAY_SKEW_MS + 1 })).status).toBe(401)
    expect((await signed('POST', '/v1/devices', body, { ts: t - RELAY_SKEW_MS })).status).toBe(200)
  })

  it('metrics 404', async () => {
    for (const p of ['/metrics', '/debug', '/status']) expect((await raw('GET', p)).status).toBe(404)
    expect((await signed('GET', '/metrics')).status).toBe(404)
  })

  it('unknown path 404', async () => {
    expect((await raw('GET', '/')).status).toBe(404)
    expect((await signed('POST', '/v1/nope', {})).status).toBe(404)
    expect((await signed('GET', '/v1/devices')).status).toBe(404)
    expect((await signed('PUT', '/v1/push', {})).status).toBe(404)
    expect((await raw('POST', '/healthz')).status).toBe(404)
  })

  it('invalid apns token 400 (no path injection)', async () => {
    for (const token of [`../../${'a'.repeat(64)}`, `${'a'.repeat(64)}/x`, `${'a'.repeat(32)}/../${'a'.repeat(32)}`, 'kisa', 'z'.repeat(64), 'a'.repeat(401)]) {
      const r = await signed('POST', '/v1/devices', { platform: 'ios', env: 'production', token })
      expect(r.status, token).toBe(400)
    }
    for (const token of ['a/b'.repeat(20), 'kisa', `${'a'.repeat(40)}?x=1`, 'a'.repeat(4097)]) {
      const r = await signed('POST', '/v1/devices', { platform: 'android', env: 'production', token })
      expect(r.status).toBe(400)
    }
    expect((await signed('POST', '/v1/devices', { platform: 'ios', env: 'prod', token: IOS_TOKEN })).status).toBe(400)
    expect((await signed('POST', '/v1/devices', { platform: 'web', env: 'production', token: IOS_TOKEN })).status).toBe(400)
    expect((await signed('POST', '/v1/devices', [1])).status).toBe(400)
  })

  it('oversized ciphertext 400', async () => {
    const id = await register()
    expect((await push(id, 'a'.repeat(RELAY_MAX_CIPHERTEXT + 1))).status).toBe(400)
    expect((await push(id, 'a/b')).status).toBe(400)
    expect((await push(id, '')).status).toBe(400)
    expect(apnsCalls).toHaveLength(0)
    expect((await push(id, 'a'.repeat(RELAY_MAX_CIPHERTEXT))).status).toBe(200)
    // gövde sınırı
    expect((await raw('POST', '/v1/push', { body: Buffer.alloc(9000, 'a') })).status).toBe(413)
  })

  it('aynı üçlüde aynı kimlik, platforma göre sağlayıcı', async () => {
    const a = await register()
    expect(await register()).toBe(a)
    const b = await register({ platform: 'android', token: ANDROID_TOKEN })
    expect(b).not.toBe(a)
    const r = JSON.parse((await push(a)).body) as { status: string }
    expect(r.status).toBe('ok')
    expect(apnsCalls[0][1]).toBe('kutu')
    expect(apnsCalls[0][0].token).toBe(IOS_TOKEN)
    await push(b)
    expect(fcmCalls[0][0].token).toBe(ANDROID_TOKEN)
  })

  it('410 deletes device and returns gone', async () => {
    const id = await register()
    apnsResult = 'gone'
    expect(JSON.parse((await push(id)).body)).toEqual({ status: 'gone' })
    expect(store.ownDevice(engine.id, id)).toBeUndefined()
    expect((await push(id)).status).toBe(404)
  })

  it('429 returns retry', async () => {
    const id = await register()
    apnsResult = 'retry'
    expect(JSON.parse((await push(id)).body)).toEqual({ status: 'retry' })
    expect(store.ownDevice(engine.id, id)).toBeDefined()
  })

  it('sağlayıcı istisnası retry', async () => {
    await new Promise<void>((r) => server.close(() => r()))
    server = createRelayServer({
      cfg, store, now: () => t, apns: async () => { throw new Error('patladı') }, fcm: async () => 'ok'
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
    expect(JSON.parse((await push(await register())).body)).toEqual({ status: 'retry' })
  })

  it('rate limit per engine and per ip', async () => {
    const id = await register()
    let got: Res | undefined
    for (let i = 0; i < 120; i++) expect((await push(id)).status, `#${i}`).toBe(200)
    got = await push(id)
    expect(got.status).toBe(429)
    expect(Number(got.headers['retry-after'])).toBeGreaterThan(0)
    // IP sınırı: sayaç bu pencerede 122 istek gördü
    for (let i = 0; i < 300 - 122; i++) expect((await raw('GET', '/yok')).status).toBe(404)
    got = await raw('GET', '/yok')
    expect(got.status).toBe(429)
    expect(got.headers['retry-after']).toBeDefined()
    expect((await raw('GET', '/healthz')).status).toBe(200) // yoklama sınıra girmez
    t += 60_000
    expect((await raw('GET', '/yok')).status).toBe(404)
  })

  it('cihaz kaydı saatte 60', async () => {
    for (let i = 0; i < 60; i++) await register({ token: String(i).padStart(64, 'a') })
    const r = await signed('POST', '/v1/devices', { platform: 'ios', env: 'production', token: 'c'.repeat(64) })
    expect(r.status).toBe(429)
  })

  it('new engine limit per ip', async () => {
    for (let i = 0; i < 20; i++) await register({ engine: newEngine() })
    const e = newEngine()
    const r = await signed('POST', '/v1/devices', { platform: 'ios', env: 'production', token: IOS_TOKEN }, { engine: e })
    expect(r.status).toBe(429)
    expect(store.hasEngine(e.id)).toBe(false)
    // kayıtlı motor etkilenmez
    expect((await signed('POST', '/v1/devices', { platform: 'ios', env: 'production', token: IOS_TOKEN })).status).toBe(429)
    t += 3600_000
    expect((await signed('POST', '/v1/devices', { platform: 'ios', env: 'production', token: IOS_TOKEN }, { engine: e })).status).toBe(200)
  })

  it('device cap', async () => {
    const id = await register()
    for (let i = 1; i < MAX_DEVICES; i++) store.upsertDevice({ engineId: engine.id, platform: 'ios', env: 'production', token: `t${i}`, day: 0 })
    expect(store.deviceCount(engine.id)).toBe(MAX_DEVICES)
    const r = await signed('POST', '/v1/devices', { platform: 'ios', env: 'production', token: 'd'.repeat(64) })
    expect(r.status).toBe(429)
    expect(r.headers['retry-after']).toBeDefined()
    expect(await register()).toBe(id) // yenileme sınıra takılmaz
  })

  it('idle 90 days swept, 89 kept', async () => {
    const stale = await register({ token: 'e'.repeat(64) })
    const fresh = await register({ token: 'f'.repeat(64) })
    const today = dayOf(t)
    const quiet = newEngine()
    store.touchEngine(quiet.id, quiet.publicRaw, today - 90)
    const quiet89 = newEngine()
    store.touchEngine(quiet89.id, quiet89.publicRaw, today - 89)
    const db = (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
    db.prepare('UPDATE devices SET last_day = ? WHERE id = ?').run(today - 90, stale)
    db.prepare('UPDATE devices SET last_day = ? WHERE id = ?').run(today - 89, fresh)
    store.sweep(today)
    expect(store.ownDevice(engine.id, stale)).toBeUndefined()
    expect(store.ownDevice(engine.id, fresh)).toBeDefined()
    expect(store.hasEngine(quiet.id)).toBe(false)
    expect(store.hasEngine(quiet89.id)).toBe(true)
    expect(store.hasEngine(engine.id)).toBe(true)
  })

  it('süpürme açılışta bir kez koşar: sık yeniden başlayan süreçte de eski cihaz kalmaz', async () => {
    const stale = await register()
    const db = (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
    db.prepare('UPDATE devices SET last_day = ? WHERE id = ?').run(dayOf(t) - 90, stale)
    const restarted = createRelayServer({ cfg, store, now: () => t, apns: async () => 'ok', fcm: async () => 'ok' })
    expect(store.ownDevice(engine.id, stale)).toBeUndefined()
    restarted.close()
  })

  it('başka röleye imzalanmış istek reddedilir (hedef)', async () => {
    const r = await signed('POST', '/v1/devices', { platform: 'ios', env: 'sandbox', token: IOS_TOKEN }, { host: 'relay.baska.example' })
    expect(r.status).toBe(401)
  })

  it('RELAY_PUBLIC_HOST varsayılanı ve doğrulaması', () => {
    expect(relayConfigFromEnv({}).publicHost).toBe('relay.kodviva.com')
    expect(relayConfigFromEnv({ RELAY_PUBLIC_HOST: 'Relay.Example.com:8443' }).publicHost).toBe('relay.example.com:8443')
    for (const bad of ['https://relay.example.com', 'a/b', 'a b']) expect(() => relayConfigFromEnv({ RELAY_PUBLIC_HOST: bad }), bad).toThrow('RELAY_PUBLIC_HOST')
  })

  it('cihazı olan eski motor süpürülmez', async () => {
    const id = await register()
    const today = dayOf(t)
    const db = (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
    db.prepare('UPDATE engines SET last_day = ?').run(today - 200)
    store.sweep(today)
    expect(store.ownDevice(engine.id, id)).toBeDefined()
    expect(store.hasEngine(engine.id)).toBe(true)
  })

  it('pushing refreshes last_day', async () => {
    const id = await register()
    const day = dayOf(t)
    t += 5 * 86_400_000
    await push(id)
    expect(store.ownDevice(engine.id, id)!.last_day).toBe(day + 5)
  })

  it('no ip or token in logs', async () => {
    const lines: string[] = []
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')))
    }
    const id = await register()
    await push(id)
    await raw('POST', '/v1/push', { body: '{}' })
    apnsResult = 'gone'
    await push(id)
    await signed('POST', '/v1/devices', { platform: 'ios', env: 'production', token: 'kisa' })
    const text = lines.join('\n')
    expect(text).not.toContain(IOS_TOKEN)
    expect(text).not.toContain('127.0.0.1')
    expect(text).not.toContain(id)
    expect(text).not.toContain(engine.id)
    expect(lines).toHaveLength(0) // istek başına satır yok
  })

  it('engine isolation', async () => {
    const other = newEngine()
    const id = await register({ engine: other })
    expect((await push(id, 'kutu')).status).toBe(404)
    expect(apnsCalls).toHaveLength(0)
    expect((await signed('DELETE', `/v1/devices/${id}`)).status).toBe(404)
    expect(store.ownDevice(other.id, id)).toBeDefined()
    expect((await signed('DELETE', `/v1/devices/${id}`, undefined, { engine: other })).status).toBe(204)
    expect(store.ownDevice(other.id, id)).toBeUndefined()
  })

  it('outbound only allowlisted hosts', () => {
    for (const base of [...Object.values(APNS_BASES), FCM_BASE, OAUTH_BASE]) expect(OUTBOUND_HOSTS).toContain(new URL(base).hostname)
    expect(OUTBOUND_HOSTS).toEqual(expect.arrayContaining([...WEB_PUSH_HOSTS, ...WEB_PUSH_SUFFIXES]))
    // Web Push izinli listesi tek kaynaktan
    expect(isAllowedPushHost('https://web.push.apple.com/x')).toBe(true)
    expect(isAllowedPushHost('https://evil.example/x')).toBe(false)
    // relay kaynağında başka dış adres yok (OAuth kapsam adı istek gitmeyen bir tanımlayıcıdır)
    for (const f of ['apns.ts', 'fcm.ts', 'server.ts', 'index.ts']) {
      const hosts = [...readFileSync(join(__dirname, '..', f), 'utf-8').matchAll(/https:\/\/(?!www\.googleapis\.com\/auth\/)([a-z0-9.-]+)/g)].map((m) => m[1])
      for (const h of hosts) expect(OUTBOUND_HOSTS, `${f}: ${h}`).toContain(h)
    }
  })

  it('protokol değerleri', () => {
    expect(signingString('POST', 'relay.example.com', '/v1/push', 5, 'n', Buffer.from('abc'))).toBe(
      'gecko-relay-v1\nrelay.example.com\nPOST\n/v1/push\n5\nn\nba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    expect(RELAY_MAX_CIPHERTEXT).toBe(3700)
    expect(RELAY_SKEW_MS).toBe(300_000)
  })

  it('yapılandırma', () => {
    expect(relayConfigFromEnv({})).toMatchObject({ listenHost: '0.0.0.0', listenPort: 8090, dataDir: '/data', trustedProxyDepth: 0 })
    expect(relayConfigFromEnv({ RELAY_LISTEN: '[::]:9', RELAY_TRUSTED_PROXY_DEPTH: '2', RELAY_APNS_TOPIC: 't' })).toMatchObject({
      listenHost: '::', listenPort: 9, trustedProxyDepth: 2, apnsTopic: 't'
    })
    expect(() => relayConfigFromEnv({ RELAY_LISTEN: 'x' })).toThrow('RELAY_LISTEN')
    expect(() => relayConfigFromEnv({ RELAY_TRUSTED_PROXY_DEPTH: 'x' })).toThrow('RELAY_TRUSTED_PROXY_DEPTH')
  })

  it('clientIp vekil derinliğini izler', () => {
    const r = { socket: { remoteAddress: '::ffff:10.0.0.1' }, headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } } as unknown as http.IncomingMessage
    expect(clientIp(r, 0)).toBe('10.0.0.1')
    expect(clientIp(r, 1)).toBe('2.2.2.2')
    expect(clientIp(r, 2)).toBe('1.1.1.1')
    expect(clientIp(r, 3)).toBe('10.0.0.1')
  })
})
