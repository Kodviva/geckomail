import { generateKeyPairSync, verify } from 'crypto'
import http from 'http'
import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFcm, fcmBody, parseServiceAccount } from '../fcm'
import type { RelayDevice } from '../store'

const token = 'f'.repeat(40)
const device: RelayDevice = { id: 'd', engine_id: 'e', platform: 'android', env: 'production', token, last_day: 0 }

describe('FCM', () => {
  let server: http.Server
  let base: string
  let oauthCalls: string[]
  let sends: { auth: string; path: string; body: string }[]
  let reply: { status: number; body: string }
  let t: number
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const account = parseServiceAccount(JSON.stringify({ project_id: 'gecko-demo', client_email: 'push@gecko-demo.iam', private_key: pem, token_uri: 'https://evil.example/token' }))

  beforeEach(async () => {
    t = 1_800_000_000_000
    oauthCalls = []
    sends = []
    reply = { status: 200, body: '{"name":"x"}' }
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        if (req.url === '/token') {
          oauthCalls.push(body)
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: `at-${oauthCalls.length}` }))
          return
        }
        sends.push({ auth: String(req.headers.authorization), path: String(req.url), body })
        res.writeHead(reply.status).end(reply.body)
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(() => new Promise<void>((r) => server.close(() => r())))

  const sender = () => createFcm({ account, now: () => t, bases: { fcm: base, oauth: base } })

  it('fcm message has no notification block', async () => {
    expect(await sender()(device, 'kutu')).toBe('ok')
    expect(sends[0].path).toBe('/v1/projects/gecko-demo/messages:send')
    const m = JSON.parse(sends[0].body) as { message: Record<string, unknown> }
    expect(m).toEqual({ message: { token, data: { c: 'kutu' }, android: { priority: 'HIGH', ttl: '86400s' } } })
    expect(m.message.notification).toBeUndefined()
    expect(sends[0].body).toBe(fcmBody(token, 'kutu'))
  })

  it('fcm token cached', async () => {
    const send = sender()
    await send(device, 'a')
    await send(device, 'b')
    expect(oauthCalls).toHaveLength(1)
    expect(sends[1].auth).toBe('Bearer at-1')
    t += 49 * 60_000
    await send(device, 'c')
    expect(oauthCalls).toHaveLength(1)
    t += 60_000
    await send(device, 'd')
    expect(oauthCalls).toHaveLength(2)
    expect(sends[3].auth).toBe('Bearer at-2')
  })

  it('yönlendirme izlenmez', async () => {
    const redirects: unknown[] = []
    const spy = ((u: string, init: RequestInit) => {
      redirects.push(init.redirect)
      return fetch(u, init)
    }) as typeof fetch
    await createFcm({ account, now: () => t, bases: { fcm: base, oauth: base }, fetch: spy })(device, 'a')
    expect(redirects).toEqual(['error', 'error'])
  })

  it('oauth isteği imzalı JWT taşır, adres dosyadan alınmaz', async () => {
    await sender()(device, 'a')
    const params = new URLSearchParams(oauthCalls[0])
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const [h, p, s] = params.get('assertion')!.split('.')
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toMatchObject({
      iss: 'push@gecko-demo.iam', aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/firebase.messaging'
    })
    expect(verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true)
  })

  it('sonuç eşlemesi', async () => {
    const send = sender()
    for (const [status, body, want] of [
      [404, JSON.stringify({ error: { details: [{ errorCode: 'UNREGISTERED' }] } }), 'gone'],
      [404, '{}', 'retry'],
      [400, JSON.stringify({ error: { status: 'INVALID_ARGUMENT', details: [{ fieldViolations: [{ field: 'message.token', description: 'x' }] }] } }), 'gone'],
      [400, JSON.stringify({ error: { status: 'INVALID_ARGUMENT', details: [{ fieldViolations: [{ field: 'message.data', description: 'x' }] }] } }), 'retry'],
      [400, 'bozuk', 'retry'],
      [429, '{}', 'retry'],
      [503, '{}', 'retry'],
      [401, '{}', 'retry']
    ] as [number, string, string][]) {
      reply = { status, body }
      expect(await send(device, 'x'), `${status}`).toBe(want)
    }
    // 401 önbelleği düşürür
    reply = { status: 200, body: '{}' }
    await send(device, 'y')
    expect(oauthCalls).toHaveLength(2)
  })

  it('ağ hatası retry, belirteç alınamazsa retry', async () => {
    const f = vi.fn(async () => {
      throw new Error('ağ')
    })
    expect(await createFcm({ account, fetch: f as unknown as typeof fetch })(device, 'x')).toBe('retry')
    const denied = vi.fn(async () => new Response('{}', { status: 400 }))
    expect(await createFcm({ account, fetch: denied as unknown as typeof fetch })(device, 'x')).toBe('retry')
  })

  it('doğrulanmamış belirteç gönderilmez', async () => {
    expect(await sender()({ ...device, token: 'kısa/../x' }, 'x')).toBe('gone')
    expect(sends).toHaveLength(0)
  })

  it('servis hesabı biçim hatası içerik göstermez', () => {
    expect(() => parseServiceAccount(JSON.stringify({ project_id: '../x', client_email: 'a', private_key: pem }))).toThrow('gecko.relay.fcm.account')
  })
})
