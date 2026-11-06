import { generateKeyPairSync, verify, type KeyObject } from 'crypto'
import http2 from 'http2'
import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APNS_BASES, apnsBody, createApns, type ApnsSender } from '../apns'
import type { RelayDevice } from '../store'

const device: RelayDevice = { id: 'd', engine_id: 'e', platform: 'ios', env: 'production', token: 'a'.repeat(64), last_day: 0 }

interface Seen { headers: http2.IncomingHttpHeaders; body: string }

describe('APNs', () => {
  let server: http2.Http2Server
  let base: string
  let seen: Seen[]
  let reply: { status: number; body?: string }
  let t: number
  let send: ApnsSender
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })

  const sender = (key: KeyObject = privateKey): ApnsSender =>
    createApns({ key, keyId: 'KID123', teamId: 'TEAM45', topic: 'com.kodviva.geckomail', now: () => t, bases: { production: base, sandbox: base } })

  beforeEach(async () => {
    t = 1_800_000_000_000
    seen = []
    reply = { status: 200 }
    server = http2.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString() })
        res.writeHead(reply.status)
        res.end(reply.body ?? '')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    send = sender()
  })
  afterEach(async () => {
    send.close()
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('apns request carries no level or collapse id', async () => {
    expect(await send(device, 'kutu')).toBe('ok')
    const { headers, body } = seen[0]
    expect(headers[':path']).toBe(`/3/device/${device.token}`)
    expect(headers['apns-topic']).toBe('com.kodviva.geckomail')
    expect(headers['apns-push-type']).toBe('alert')
    expect(headers['apns-priority']).toBe('10')
    expect(headers['apns-expiration']).toBe(String(Math.floor(t / 1000) + 86_400))
    expect(headers['apns-collapse-id']).toBeUndefined()
    expect(JSON.parse(body)).toEqual({ aps: { alert: { 'loc-key': 'PUSH_FALLBACK' }, 'mutable-content': 1, sound: 'default' }, c: 'kutu' })
    expect(body).toBe(apnsBody('kutu'))
  })

  it('apns jwt verifies and is reused', async () => {
    await send(device, 'a')
    await send(device, 'b')
    const j1 = String(seen[0].headers.authorization).replace('bearer ', '')
    expect(String(seen[1].headers.authorization)).toBe(`bearer ${j1}`)
    const [h, p, s] = j1.split('.')
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KID123' })
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({ iss: 'TEAM45', iat: Math.floor(t / 1000) })
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true)
    t += 29 * 60_000
    await send(device, 'c')
    expect(String(seen[2].headers.authorization)).toBe(`bearer ${j1}`)
    t += 60_000
    await send(device, 'd')
    expect(String(seen[3].headers.authorization)).not.toBe(`bearer ${j1}`)
  })

  it('sonuç eşlemesi', async () => {
    const cases: [number, string | undefined, string][] = [
      [410, JSON.stringify({ reason: 'Unregistered' }), 'gone'],
      [400, JSON.stringify({ reason: 'BadDeviceToken' }), 'gone'],
      [400, JSON.stringify({ reason: 'Unregistered' }), 'gone'],
      [429, JSON.stringify({ reason: 'TooManyRequests' }), 'retry'],
      [500, undefined, 'retry'],
      [503, undefined, 'retry'],
      [400, JSON.stringify({ reason: 'BadTopic' }), 'retry']
    ]
    for (const [status, body, want] of cases) {
      reply = { status, body }
      expect(await send(device, 'x'), `${status} ${body}`).toBe(want)
    }
  })

  it('süresi dolan sağlayıcı belirteci yenilenir', async () => {
    reply = { status: 403, body: JSON.stringify({ reason: 'ExpiredProviderToken' }) }
    expect(await send(device, 'x')).toBe('retry')
    t += 1000
    reply = { status: 200 }
    await send(device, 'y')
    expect(seen[1].headers.authorization).not.toBe(seen[0].headers.authorization)
  })

  it('ağ hatası retry', async () => {
    const dead = createApns({
      key: privateKey, keyId: 'K', teamId: 'T', topic: 't', bases: { production: 'http://127.0.0.1:1', sandbox: 'http://127.0.0.1:1' }
    })
    expect(await dead(device, 'x')).toBe('retry')
    dead.close()
  })

  it('ret günlüğü sağlayıcı, durum ve neden taşır, belirteç taşımaz', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    reply = { status: 400, body: JSON.stringify({ reason: 'BadTopic' }) }
    await send(device, 'x')
    reply = { status: 410, body: JSON.stringify({ reason: `Unregistered ${device.token}` }) }
    await send(device, 'x')
    expect(log.mock.calls[0][0]).toBe('relay: apns teslim etmedi (http 400, BadTopic)')
    expect(log.mock.calls[1][0]).toBe('relay: apns teslim etmedi (http 410, neden yok)')
    log.mockRestore()
  })

  it('başarılı gönderim günlüğe yazılmaz', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await send(device, 'x')
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('zaman aşımında HTTP/2 oturumu kapanır, sıradaki gönderim yeni bağlantı açar', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let sessions = 0
    let hang = true
    const slow = http2.createServer((_req, res) => {
      if (!hang) res.writeHead(200).end()
    })
    slow.on('session', () => sessions++)
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r))
    const at = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`
    const s = createApns({ key: privateKey, keyId: 'K', teamId: 'T', topic: 't', requestMs: 50, bases: { production: at, sandbox: at } })
    expect(await s(device, 'x')).toBe('retry')
    expect(log).toHaveBeenCalledWith('relay: apns teslim etmedi (http 0, timeout)')
    hang = false
    expect(await s(device, 'y')).toBe('ok')
    expect(sessions).toBe(2)
    s.close()
    await new Promise<void>((r) => slow.close(() => r()))
    log.mockRestore()
  })

  it('doğrulanmamış belirteç adrese girmez', async () => {
    expect(await send({ ...device, token: `${'a'.repeat(64)}/../x` }, 'x')).toBe('gone')
    expect(seen).toHaveLength(0)
  })

  it('taban adresler sabit', () => {
    expect(APNS_BASES).toEqual({ production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' })
  })
})
