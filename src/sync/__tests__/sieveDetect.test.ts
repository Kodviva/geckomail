import { createServer, type AddressInfo } from 'net'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostGovernor } from '../net/hostGovernor'
import { clearDetectCache, detectSieve } from '../sieve/detect'
import { ManageSieveClient, ManageSieveError } from '../sieve/manageSieve'
import { makeTestCert, startFakeManageSieve, type FakeSieve, type FakeSieveOptions, type TestCert } from './helpers/fakeManageSieve'

const H = 3600_000
const target = (port: number, o: Partial<{ host: string; rejectUnauthorized: boolean; authType: string }> = {}) => ({
  host: '127.0.0.1', port, rejectUnauthorized: false, authType: 'password', ...o
})

describe('sağlayıcı', () => {
  it('OAuth account follows the provider, not the endpoint: no connection', async () => {
    const connect = vi.fn()
    for (const authType of ['oauth:google', 'oauth:microsoft']) {
      expect(await detectSieve({ host: 'saldirgan.ornek.test', port: 4190, rejectUnauthorized: true, authType }, { now: Date.now, connect: connect as never, force: true }))
        .toMatchObject({ supported: false, reason: 'provider' })
    }
    expect(connect).not.toHaveBeenCalled()
  })
})

describe('detectSieve', () => {
  let cert: TestCert
  const servers: FakeSieve[] = []
  beforeAll(() => {
    cert = makeTestCert()
  })
  beforeEach(() => clearDetectCache())
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()))
  })
  const fake = async (o: Partial<FakeSieveOptions> = {}): Promise<FakeSieve> => {
    const s = await startFakeManageSieve({ tls: 'starttls', cert, sasl: ['PLAIN'], extensions: ['fileinto'], ...o })
    servers.push(s)
    return s
  }
  const closedPort = async (): Promise<number> => {
    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const port = (probe.address() as AddressInfo).port
    await new Promise((r) => probe.close(r))
    return port
  }

  it('STARTTLS algılanır, kimlik gönderilmez', async () => {
    const s = await fake()
    const r = await detectSieve(target(s.port))
    expect(r).toMatchObject({ supported: true, tls: 'starttls', reason: null })
    expect(r.caps?.sieve).toEqual(['fileinto'])
    expect(s.commands.some((x) => x.startsWith('AUTHENTICATE'))).toBe(false)
  })

  it('force önbelleği atlar, yeni sonucu önbelleğe yazar', async () => {
    const s = await fake()
    await detectSieve(target(s.port))
    expect(s.connections).toBe(1)
    await detectSieve(target(s.port))
    expect(s.connections).toBe(1)
    await detectSieve(target(s.port), { now: Date.now, force: true })
    expect(s.connections).toBe(2)
    await detectSieve(target(s.port))
    expect(s.connections).toBe(2)
  })

  it('force başarısız önbelleği de atlar, sağlayıcı kısa devresini atlamaz', async () => {
    const port = await closedPort()
    const connect = vi.fn(ManageSieveClient.connect.bind(ManageSieveClient))
    await detectSieve(target(port), { now: Date.now, connect })
    const before = connect.mock.calls.length
    await detectSieve(target(port), { now: Date.now, connect })
    expect(connect.mock.calls.length).toBe(before)
    await detectSieve(target(port), { now: Date.now, connect, force: true })
    expect(connect.mock.calls.length).toBeGreaterThan(before)
    const r = await detectSieve(target(1, { host: 'imap.gmail.com' }), { now: Date.now, connect, force: true })
    expect(r.reason).toBe('provider')
  })

  it('DNS ve ağ kesintisi önbelleğe yazılmaz', async () => {
    const err = new ManageSieveError('getaddrinfo ENOTFOUND', { phase: 'connect', transport: 'no_tcp', networkDown: true })
    const connect = vi.fn(async () => {
      throw err
    })
    const r = await detectSieve(target(1, { host: 'yok.test' }), { now: Date.now, connect })
    expect(r).toMatchObject({ supported: false, reason: 'no_listener', transient: true })
    await detectSieve(target(1, { host: 'yok.test' }), { now: Date.now, connect })
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('reddedilen bağlantı önbelleğe yazılır', async () => {
    const port = await closedPort()
    const r = await detectSieve(target(port))
    expect(r.reason).toBe('no_listener')
    expect(r.transient).toBeUndefined()
  })

  it('implicit tls', async () => {
    const s = await fake({ tls: 'implicit' })
    const r = await detectSieve(target(s.port), { now: Date.now, greetingTimeoutMs: 100 })
    expect(r).toMatchObject({ supported: true, tls: 'tls', reason: null })
  })

  it('no credentials before tls', async () => {
    const s = await fake({ tls: 'none', leakPlainSaslBeforeTls: true })
    const r = await detectSieve(target(s.port))
    expect(r).toEqual({ supported: false, tls: null, caps: null, reason: 'no_tls' })
    expect(s.commands.some((x) => x.startsWith('AUTHENTICATE'))).toBe(false)
  })

  it('kullanılabilir SASL yoksa no_sasl', async () => {
    const s = await fake({ sasl: ['GSSAPI'] })
    expect(await detectSieve(target(s.port))).toMatchObject({ supported: false, reason: 'no_sasl' })
    const o = await fake({ sasl: ['PLAIN'] })
    expect(await detectSieve(target(o.port, { authType: 'oauth:ornek' }))).toMatchObject({ supported: false, reason: 'no_sasl' })
    const p = await fake({ sasl: ['XOAUTH2'] })
    expect(await detectSieve(target(p.port, { authType: 'oauth:ornek' }))).toMatchObject({ supported: true })
  })

  it('aynı sunucuda SASL sonucu kimlik türüne göre hesaplanır, önbellek paylaşılır', async () => {
    const s = await fake({ sasl: ['PLAIN'] })
    expect((await detectSieve(target(s.port))).supported).toBe(true)
    expect(await detectSieve(target(s.port, { authType: 'oauth:ornek' }))).toMatchObject({ supported: false, reason: 'no_sasl' })
    expect(s.connections).toBe(1)
  })

  it('geçersiz sertifika: no_tls', async () => {
    const s = await fake()
    expect(await detectSieve(target(s.port, { rejectUnauthorized: true }))).toMatchObject({ supported: false, reason: 'no_tls' })
    expect(s.commands).toEqual(['STARTTLS'])
  })

  it('closed port does not touch governor', async () => {
    const onLoginFailure = vi.spyOn(HostGovernor.prototype, 'onLoginFailure')
    const tryTakeLogin = vi.spyOn(HostGovernor.prototype, 'tryTakeLogin')
    const r = await detectSieve(target(await closedPort()))
    expect(r).toEqual({ supported: false, tls: null, caps: null, reason: 'no_listener' })
    expect(onLoginFailure).not.toHaveBeenCalled()
    expect(tryTakeLogin).not.toHaveBeenCalled()
    onLoginFailure.mockRestore()
    tryTakeLogin.mockRestore()
  })

  it('cache: başarı 24 saat', async () => {
    const s = await fake()
    let now = 1_000_000
    const deps = { now: () => now }
    await detectSieve(target(s.port), deps)
    await detectSieve(target(s.port), deps)
    expect(s.connections).toBe(1)
    now += 24 * H - 1
    await detectSieve(target(s.port), deps)
    expect(s.connections).toBe(1)
    now += 1
    await detectSieve(target(s.port), deps)
    expect(s.connections).toBe(2)
  })

  it('cache: başarısız 7 gün', async () => {
    const port = await closedPort()
    const connect = vi.fn(ManageSieveClient.connect.bind(ManageSieveClient))
    let now = 5
    const deps = { now: () => now, connect }
    await detectSieve(target(port), deps)
    const after = connect.mock.calls.length
    expect(after).toBeGreaterThan(0)
    now += 7 * 24 * H - 1
    await detectSieve(target(port), deps)
    expect(connect.mock.calls.length).toBe(after)
    now += 1
    await detectSieve(target(port), deps)
    expect(connect.mock.calls.length).toBeGreaterThan(after)
  })

  it('cache anahtarı ana makine + port', async () => {
    const a = await fake()
    const b = await fake()
    await detectSieve(target(a.port))
    await detectSieve(target(b.port))
    expect(a.connections + b.connections).toBe(2)
  })

  it('eşzamanlı istekler tek bağlantı açar', async () => {
    const s = await fake()
    await Promise.all(Array.from({ length: 5 }, () => detectSieve(target(s.port))))
    expect(s.connections).toBe(1)
  })

  it('imap.gmail.com hiç bağlanmaz', async () => {
    const connect = vi.fn()
    for (const host of ['imap.gmail.com', 'IMAP.GMAIL.COM', 'outlook.office365.com']) {
      expect(await detectSieve(target(4190, { host }), { now: Date.now, connect })).toEqual({ supported: false, tls: null, caps: null, reason: 'provider' })
    }
    expect(connect).not.toHaveBeenCalled()
  })
})
