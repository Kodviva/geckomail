// Passkey (WebAuthn) uçları: yazılım doğrulayıcı gerçek CBOR/ES256 yanıtları üretir, doğrulama @simplewebauthn/server'dan geçer.
import type Database from 'better-sqlite3'
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPassword } from '../../sync/auth/password'
import { openDb } from '../../sync/db'
import { makeQueries } from '../../sync/db/queries'
import type { OpQueue } from '../../sync/opQueue'
import { RpcHub, type RpcServerDeps } from '../../sync/rpcHub'
import type { Scheduler } from '../../sync/scheduler'
import { LOCK_MAX_FAILS, PASSKEY_ATTEMPT_KEY, WebAuth } from '../auth'
import { base32Encode, newTotpSecret, totpCode } from '../../sync/auth/totp'
import type { ServerConfig } from '../config'
import { createServerHost } from '../hosts/serverHost'
import { createHttpServer } from '../http'
import { PASSKEY_CHALLENGE_TTL_MS, passkeysAvailable } from '../passkeys'

const ORIGIN = 'https://posta.example.com'
const RP_ID = 'posta.example.com'
const PW = 'dogru-parola-1'

// --- yazılım doğrulayıcı: yalnız bu testin gerektirdiği kadar CBOR ---
const cborHead = (major: number, n: number): Buffer => {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 256) return Buffer.from([(major << 5) | 24, n])
  return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff])
}
const cborInt = (n: number): Buffer => (n >= 0 ? cborHead(0, n) : cborHead(1, -1 - n))
const cborBytes = (b: Buffer): Buffer => Buffer.concat([cborHead(2, b.length), b])
const cborText = (s: string): Buffer => Buffer.concat([cborHead(3, Buffer.byteLength(s)), Buffer.from(s)])
const cborMap = (pairs: [Buffer, Buffer][]): Buffer => Buffer.concat([cborHead(5, pairs.length), ...pairs.flat()])
const b64u = (b: Buffer): string => b.toString('base64url')
const sha256 = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest()
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

interface SoftOpts { origin?: string; uv?: boolean; rpId?: string; counter?: number; tamper?: boolean; id?: Buffer }

class SoftAuthenticator {
  readonly credId = randomBytes(32)
  readonly id = b64u(this.credId)
  counter = 0
  /** kayıt seçeneklerindeki user.id: girişte yanıtla döner */
  userHandle: string | undefined
  private readonly priv: KeyObject
  private readonly cose: Buffer

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.priv = privateKey
    const jwk = publicKey.export({ format: 'jwk' })
    this.cose = cborMap([
      [cborInt(1), cborInt(2)], [cborInt(3), cborInt(-7)], [cborInt(-1), cborInt(1)],
      [cborInt(-2), cborBytes(Buffer.from(jwk.x!, 'base64url'))], [cborInt(-3), cborBytes(Buffer.from(jwk.y!, 'base64url'))]
    ])
  }

  private clientData(type: string, challenge: string, o: SoftOpts): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: o.origin ?? ORIGIN, crossOrigin: false }))
  }

  private flags(o: SoftOpts, extra: number): Buffer {
    return Buffer.from([0x01 | (o.uv === false ? 0 : 0x04) | extra])
  }

  register(challenge: string, o: SoftOpts = {}): Record<string, unknown> {
    const attested = Buffer.concat([Buffer.alloc(16), Buffer.from([0, this.credId.length]), this.credId, this.cose])
    const authData = Buffer.concat([sha256(o.rpId ?? RP_ID), this.flags(o, 0x40), u32(this.counter), attested])
    const attestationObject = cborMap([
      [cborText('fmt'), cborText('none')], [cborText('attStmt'), cborMap([])], [cborText('authData'), cborBytes(authData)]
    ])
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(this.clientData('webauthn.create', challenge, o)), attestationObject: b64u(attestationObject), transports: ['internal']
      }
    }
  }

  assert(challenge: string, o: SoftOpts = {}): Record<string, unknown> {
    const authData = Buffer.concat([sha256(o.rpId ?? RP_ID), this.flags(o, 0), u32(o.counter ?? this.counter)])
    const client = this.clientData('webauthn.get', challenge, o)
    const signature = sign('sha256', Buffer.concat([authData, sha256(client)]), this.priv)
    if (o.tamper) signature[signature.length - 1] ^= 0xff
    const id = o.id ? b64u(o.id) : this.id
    return {
      id, rawId: id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(client), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: this.userHandle }
    }
  }
}

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }

describe('passkey uçları', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let server: http.Server
  let port: number
  let clock: number
  let host: ReturnType<typeof createServerHost>

  beforeEach(async () => {
    clock = 1_800_000_000_000
    dir = mkdtempSync(join(tmpdir(), 'gecko-passkey-'))
    db = openDb(dir)
    q = makeQueries(db)
    host = createServerHost(randomBytes(32), () => hub)
    const stub = new Proxy({}, { get: () => () => undefined })
    const deps: RpcServerDeps = {
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: (v) => host.encrypt(v),
      decrypt: async (b) => (await host.decrypt(b)).map((u) => Buffer.from(u).toString('utf-8')),
      userData: dir, dbSchemaVersion: () => 0
    }
    hub = new RpcHub(deps, 'server')
    const now = (): number => clock
    const auth = new WebAuth(q, host, now)
    // güvenilen vekil 1: test IP'yi X-Forwarded-For ile seçer
    const cfg: ServerConfig = {
      dataDir: dir, listenHost: '127.0.0.1', listenPort: 0, keyFile: join(dir, 'master.key'), publicOrigin: ORIGIN, trustedProxyDepth: 1,
      webDir: join(dir, 'web')
    }
    server = createHttpServer({ cfg, hub, auth, now })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    if (server?.listening) await new Promise<void>((r) => server.close(() => r()))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const mkUser = (username: string) => q.insertUser({ username, passwordHash: hashPassword(PW), role: 'member' })

  const req = (method: string, path: string, o: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> =>
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
  const post = (path: string, body: unknown, o: { cookie?: string; ip?: string; origin?: string } = {}): Promise<Res> =>
    req('POST', path, {
      headers: {
        origin: o.origin ?? ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': o.ip ?? '10.0.0.1',
        ...(o.cookie ? { cookie: o.cookie } : {})
      },
      body: JSON.stringify(body)
    })
  const cookieNamed = (r: Res, name: string): string | undefined => r.headers['set-cookie']?.find((c) => c.startsWith(`${name}=`))
  const pair = (c: string | undefined): string => (c ?? '').split(';')[0]
  const signIn = async (username: string): Promise<string> => {
    const r = await post('/api/login', { username, password: PW })
    expect(r.status).toBe(200)
    return pair(cookieNamed(r, 'gm_session'))
  }
  const regOptions = (cookie: string, body: Record<string, unknown> = { password: PW }, ip?: string): Promise<Res> =>
    post('/api/passkey/register/options', body, { cookie, ip })
  const register = async (cookie: string, a: SoftAuthenticator, name = 'Telefon', o: SoftOpts = {}): Promise<Res> => {
    const opts = await regOptions(cookie)
    expect(opts.status).toBe(200)
    a.userHandle = JSON.parse(opts.body).user.id
    return post('/api/passkey/register/verify', { response: a.register(JSON.parse(opts.body).challenge, o), name }, { cookie })
  }
  const loginOptions = async (ip?: string): Promise<{ challenge: string; cookie: string; res: Res }> => {
    const res = await post('/api/passkey/login/options', {}, { ip })
    expect(res.status).toBe(200)
    return { challenge: JSON.parse(res.body).challenge, cookie: pair(cookieNamed(res, 'gm_pk')), res }
  }
  const passkeyLogin = async (a: SoftAuthenticator, o: SoftOpts = {}, ip?: string): Promise<Res> => {
    const { challenge, cookie } = await loginOptions(ip)
    return post('/api/passkey/login/verify', { response: a.assert(challenge, o) }, { cookie, ip })
  }
  const me = (cookie: string): Promise<Res> => req('GET', '/api/me', { headers: { cookie } })

  it('kayıt → giriş → oturum (kullanıcı adı istemez; parola + TOTP yerine geçer)', async () => {
    mkUser('ali')
    const cookie = await signIn('ali')
    const opts = await regOptions(cookie)
    const o = JSON.parse(opts.body)
    expect(o.rp.id).toBe(RP_ID)
    expect(o.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' })

    const a = new SoftAuthenticator()
    a.userHandle = o.user.id
    const reg = await post('/api/passkey/register/verify', { response: a.register(o.challenge), name: '  Telefon  ' }, { cookie })
    expect(reg.status).toBe(200)
    const list = JSON.parse((await req('GET', '/api/passkeys', { headers: { cookie } })).body)
    expect(list.passkeys).toEqual([{ id: a.id, name: 'Telefon', createdAt: clock, lastUsedAt: null }])

    const { res, challenge, cookie: pk } = await loginOptions()
    const lo = JSON.parse(res.body)
    expect(lo.rpId).toBe(RP_ID)
    expect(lo.userVerification).toBe('required')
    expect(lo.allowCredentials ?? []).toEqual([])
    const set = cookieNamed(res, 'gm_pk')!
    expect(set).toContain('HttpOnly')
    expect(set).toContain('; Secure') // https kökeni
    expect(set).toContain('SameSite=Strict')
    expect(set).toContain('Path=/api/passkey')
    expect(set).toContain('Max-Age=300')

    a.counter = 1
    clock += 1000
    const ok = await post('/api/passkey/login/verify', { response: a.assert(challenge) }, { cookie: pk })
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body).user.username).toBe('ali')
    expect(ok.body).not.toMatch(/token/i)
    expect(cookieNamed(ok, 'gm_session')).toContain('HttpOnly')
    expect(cookieNamed(ok, 'gm_pk')).toContain('Max-Age=0')
    expect(cookieNamed(ok, 'gm_pk')).toContain('; Secure') // temizleyen çerez de
    expect((await me(pair(cookieNamed(ok, 'gm_session')))).status).toBe(200)
    const after = JSON.parse((await req('GET', '/api/passkeys', { headers: { cookie } })).body)
    expect(after.passkeys[0].lastUsedAt).toBe(clock)
  })

  it('kayıt seçenekleri kullanıcının mevcut anahtarlarını dışlar ve kullanıcı kimliği sabittir', async () => {
    mkUser('ali')
    const cookie = await signIn('ali')
    const a = new SoftAuthenticator()
    expect((await register(cookie, a)).status).toBe(200)
    const o = JSON.parse((await regOptions(cookie)).body)
    expect(o.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([a.id])
    const o2 = JSON.parse((await regOptions(cookie)).body)
    expect(o2.user.id).toBe(o.user.id)
    expect(o.user.name).toBe('ali')
  })

  it('challenge single use', async () => {
    mkUser('ali')
    const a = new SoftAuthenticator()
    await register(await signIn('ali'), a)
    const { challenge, cookie } = await loginOptions()
    a.counter = 1
    const response = a.assert(challenge)
    expect((await post('/api/passkey/login/verify', { response }, { cookie })).status).toBe(200)
    expect((await post('/api/passkey/login/verify', { response }, { cookie })).status).toBe(401)
    // başarısız doğrulama da challenge'ı tüketir
    const again = await loginOptions()
    a.counter = 2
    expect((await post('/api/passkey/login/verify', { response: a.assert(again.challenge, { tamper: true }) }, { cookie: again.cookie })).status).toBe(401)
    expect((await post('/api/passkey/login/verify', { response: a.assert(again.challenge) }, { cookie: again.cookie })).status).toBe(401)
  })

  it('kayıt challenge\'ı da tek kullanımlık ve oturuma bağlı', async () => {
    mkUser('ali')
    mkUser('veli')
    const ali = await signIn('ali')
    const veli = await signIn('veli')
    const { challenge } = JSON.parse((await regOptions(ali)).body)
    const a = new SoftAuthenticator()
    // başka oturum ali'nin challenge'ıyla kaydedemez; ali'nin bekleyen challenge'ı da bozulmaz
    expect((await post('/api/passkey/register/verify', { response: a.register(challenge), name: 'x' }, { cookie: veli })).status).toBe(400)
    expect((await post('/api/passkey/register/verify', { response: a.register(challenge), name: 'x' }, { cookie: ali })).status).toBe(200)
    const b = new SoftAuthenticator()
    expect((await post('/api/passkey/register/verify', { response: b.register(challenge), name: 'y' }, { cookie: ali })).status).toBe(400)
    expect(q.listPasskeys(q.getUserByUsername('veli')!.id)).toEqual([])
  })

  it('challenge 5 dakikada düşer; çerezsiz istek reddedilir ve kilide sayılmaz', async () => {
    mkUser('ali')
    const cookie = await signIn('ali')
    const a = new SoftAuthenticator()
    const reg = JSON.parse((await regOptions(cookie)).body)
    clock += PASSKEY_CHALLENGE_TTL_MS + 1
    expect((await post('/api/passkey/register/verify', { response: a.register(reg.challenge), name: 'x' }, { cookie })).status).toBe(400)

    await register(cookie, a)
    const l = await loginOptions()
    clock += PASSKEY_CHALLENGE_TTL_MS + 1
    a.counter = 1
    expect((await post('/api/passkey/login/verify', { response: a.assert(l.challenge) }, { cookie: l.cookie })).status).toBe(401)
    for (let i = 0; i < LOCK_MAX_FAILS + 1; i++) {
      expect((await post('/api/passkey/login/verify', { response: a.assert(l.challenge) })).status).toBe(401)
    }
  })

  it('counter regression rejected', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    mkUser('ali')
    const a = new SoftAuthenticator()
    await register(await signIn('ali'), a)
    expect((await passkeyLogin(a, { counter: 5 })).status).toBe(200)
    // geri giden ve aynı kalan sayaç: kopyalanmış anahtar işareti
    expect((await passkeyLogin(a, { counter: 4 })).status).toBe(401)
    expect((await passkeyLogin(a, { counter: 5 })).status).toBe(401)
    expect(q.getPasskey(a.id)!.counter).toBe(5)
    const logged = log.mock.calls.flat().join(' ')
    expect(logged).toMatch(/sayac/)
    expect(logged).not.toContain(a.id)
    expect((await passkeyLogin(a, { counter: 6 })).status).toBe(200)
  })

  it('sayacı hep 0 olan (eşitlenen) passkey kabul edilir', async () => {
    mkUser('ali')
    const a = new SoftAuthenticator()
    await register(await signIn('ali'), a)
    expect((await passkeyLogin(a)).status).toBe(200)
    expect((await passkeyLogin(a)).status).toBe(200)
  })

  it('disabled user cannot login with passkey; silinen kullanıcının passkeyleri gider', async () => {
    const id = mkUser('ali')
    const a = new SoftAuthenticator()
    await register(await signIn('ali'), a)
    q.updateUserFields(id, { enabled: 0 })
    expect((await passkeyLogin(a, { counter: 1 })).status).toBe(401)
    q.updateUserFields(id, { enabled: 1 })
    expect((await passkeyLogin(a, { counter: 2 })).status).toBe(200)
    q.deleteUser(id)
    expect(q.getPasskey(a.id)).toBeUndefined()
    expect((await passkeyLogin(a, { counter: 3 })).status).toBe(401)
  })

  it('hatalı imza, yanlış köken, yanlış RP ve kullanıcı doğrulamasız yanıt reddedilir', async () => {
    mkUser('ali')
    const a = new SoftAuthenticator()
    const cookie = await signIn('ali')
    // kayıt da kullanıcı doğrulaması ister
    expect((await register(cookie, a, 'x', { uv: false })).status).toBe(400)
    expect((await register(cookie, a, 'x', { origin: 'https://kotu.example.com' })).status).toBe(400)
    expect((await register(cookie, a)).status).toBe(200)
    expect((await passkeyLogin(a, { tamper: true })).status).toBe(401)
    expect((await passkeyLogin(a, { origin: 'https://kotu.example.com' }, '10.0.0.2')).status).toBe(401)
    expect((await passkeyLogin(a, { rpId: 'kotu.example.com' }, '10.0.0.3')).status).toBe(401)
    expect((await passkeyLogin(a, { uv: false }, '10.0.0.4')).status).toBe(401)
    expect((await passkeyLogin(a, { id: randomBytes(32) }, '10.0.0.5')).status).toBe(401)
    // bozuk gövde süreç/500 değil
    const l = await loginOptions('10.0.0.6')
    expect((await post('/api/passkey/login/verify', { response: { id: 7 } }, { cookie: l.cookie, ip: '10.0.0.6' })).status).toBe(401)
    expect((await post('/api/passkey/login/verify', { response: 'x' }, { cookie: l.cookie, ip: '10.0.0.6' })).status).toBe(400)
  })

  it('kullanıcı kimliği anahtarın sahibi değilse ya da yoksa reddedilir', async () => {
    mkUser('ali')
    const a = new SoftAuthenticator()
    await register(await signIn('ali'), a)
    const own = a.userHandle
    a.userHandle = b64u(Buffer.from('999'))
    expect((await passkeyLogin(a, {}, '10.2.0.1')).status).toBe(401)
    a.userHandle = undefined
    expect((await passkeyLogin(a, {}, '10.2.0.2')).status).toBe(401)
    a.userHandle = own
    expect((await passkeyLogin(a, {}, '10.2.0.3')).status).toBe(200)
  })

  it('başarısız doğrulama IP kovasına işler, kullanıcı kovasını kirletmez', async () => {
    mkUser('ali')
    const a = new SoftAuthenticator()
    await register(await signIn('ali'), a)
    const ip = '10.9.9.9'
    for (let i = 0; i < LOCK_MAX_FAILS; i++) expect((await passkeyLogin(a, { tamper: true }, ip)).status).toBe(401)
    // kilit: seçenek de doğrulama da 423; aynı IP'den parola da kilitli
    expect((await post('/api/passkey/login/options', {}, { ip })).status).toBe(423)
    const l = await loginOptions('10.9.9.8')
    expect((await post('/api/passkey/login/verify', { response: a.assert(l.challenge) }, { cookie: l.cookie, ip })).status).toBe(423)
    expect((await post('/api/login', { username: 'ali', password: PW }, { ip })).status).toBe(423)
    // başka IP: passkey de parola da etkilenmez (kullanıcı adı olmadığından ortak kova yok)
    expect((await passkeyLogin(a, {}, '10.9.9.7')).status).toBe(200)
    expect((await post('/api/login', { username: 'ali', password: PW }, { ip: '10.9.9.6' })).status).toBe(200)
    const rows = db.prepare(`SELECT DISTINCT username FROM web_login_attempts WHERE ok = 0`).all()
    expect(rows).toEqual([{ username: PASSKEY_ATTEMPT_KEY }])
    // anahtar kullanıcı adlarıyla çakışamaz (giriş anahtarı hep küçük harf)
    expect(PASSKEY_ATTEMPT_KEY).not.toBe(PASSKEY_ATTEMPT_KEY.toLowerCase())
  })

  it('kullanıcı adının parola kilidi passkey girişini engellemez', async () => {
    mkUser('ali')
    const a = new SoftAuthenticator()
    await register(await signIn('ali'), a)
    for (let i = 0; i < LOCK_MAX_FAILS; i++) await post('/api/login', { username: 'ali', password: 'yanlis-parola' }, { ip: `10.1.1.${i}` })
    expect((await post('/api/login', { username: 'ali', password: PW }, { ip: '10.1.2.1' })).status).toBe(423)
    expect((await passkeyLogin(a, {}, '10.1.2.2')).status).toBe(200)
  })

  it('require2fa: passkey ile giriş geçer, parola ile giriş yine TOTP ister', async () => {
    mkUser('ali')
    const a = new SoftAuthenticator()
    await register(await signIn('ali'), a)
    q.prefSet('require2fa', '1')
    expect((await post('/api/login', { username: 'ali', password: PW })).status).toBe(428)
    expect((await passkeyLogin(a)).status).toBe(200)
  })

  it('girişli uçlar oturum ve aynı köken ister; başkasının passkeyi görülmez, silinemez', async () => {
    mkUser('ali')
    mkUser('veli')
    const ali = await signIn('ali')
    const veli = await signIn('veli')
    const a = new SoftAuthenticator()
    await register(ali, a)
    expect((await post('/api/passkey/register/options', { password: PW })).status).toBe(401)
    expect((await post('/api/passkey/register/verify', { response: {}, name: 'x' })).status).toBe(401)
    expect((await req('GET', '/api/passkeys')).status).toBe(401)
    expect((await req('DELETE', `/api/passkeys/${a.id}`)).status).toBe(401)
    expect((await post('/api/passkey/register/options', { password: PW }, { cookie: ali, origin: 'https://kotu.example.com' })).status).toBe(403)
    expect((await post('/api/passkey/login/options', {}, { origin: 'https://kotu.example.com' })).status).toBe(403)
    expect((await req('DELETE', `/api/passkeys/${a.id}`, { headers: { cookie: ali, origin: 'https://kotu.example.com' } })).status).toBe(403)

    expect(JSON.parse((await req('GET', '/api/passkeys', { headers: { cookie: veli } })).body).passkeys).toEqual([])
    expect((await req('DELETE', `/api/passkeys/${a.id}`, { headers: { cookie: veli, origin: ORIGIN } })).status).toBe(404)
    expect(q.getPasskey(a.id)).toBeDefined()
    expect((await req('DELETE', `/api/passkeys/${encodeURIComponent('%')}`, { headers: { cookie: ali, origin: ORIGIN } })).status).toBe(404)
    expect((await req('DELETE', `/api/passkeys/%E0%A4%A`, { headers: { cookie: ali, origin: ORIGIN } })).status).toBe(404)
    expect((await req('DELETE', `/api/passkeys/${a.id}`, { headers: { cookie: ali, origin: ORIGIN } })).status).toBe(204)
    expect(q.getPasskey(a.id)).toBeUndefined()
    expect((await passkeyLogin(a)).status).toBe(401)
  })

  it('ad zorunlu ve kırpılır; aynı kimlik ikinci kez kaydedilmez', async () => {
    mkUser('ali')
    mkUser('veli')
    const ali = await signIn('ali')
    const a = new SoftAuthenticator()
    expect((await register(ali, a, '   ')).status).toBe(400)
    const long = await register(ali, a, 'x'.repeat(200))
    expect(long.status).toBe(200)
    expect(q.getPasskey(a.id)!.name).toHaveLength(64)
    const dup = await register(await signIn('veli'), a)
    expect(dup.status).toBe(409)
    expect(q.getPasskey(a.id)!.user_id).toBe(q.getUserByUsername('ali')!.id)
  })

  it('giriş challenge\'ı başka akışın çerezine bağlanmaz; bozuk gövde de akışı tüketir', async () => {
    mkUser('ali')
    const a = new SoftAuthenticator()
    await register(await signIn('ali'), a)
    const first = await loginOptions()
    const second = await loginOptions()
    // birinci akışın challenge'ı ikinci akışın çereziyle: tüketilir, reddedilir
    expect((await post('/api/passkey/login/verify', { response: a.assert(first.challenge) }, { cookie: second.cookie })).status).toBe(401)
    expect((await post('/api/passkey/login/verify', { response: a.assert(second.challenge) }, { cookie: second.cookie })).status).toBe(401)
    expect((await post('/api/passkey/login/verify', { response: a.assert(first.challenge) }, { cookie: first.cookie })).status).toBe(200)

    const third = await loginOptions()
    const bad = await post('/api/passkey/login/verify', { response: 'x' }, { cookie: third.cookie })
    expect(bad.status).toBe(400)
    expect(cookieNamed(bad, 'gm_pk')).toContain('Max-Age=0')
    expect((await post('/api/passkey/login/verify', { response: a.assert(third.challenge) }, { cookie: third.cookie })).status).toBe(401)
  })

  describe('eklemede yeniden doğrulama', () => {
    const enableTotp = async (userId: number): Promise<Buffer> => {
      const secret = newTotpSecret()
      const [enc] = await host.encrypt([base32Encode(secret)])
      q.setTotpPending(userId, Buffer.from(enc))
      q.enableTotp(userId, 0)
      return secret
    }
    const codeNow = (secret: Buffer, offset = 0): string => totpCode(secret, Math.floor(clock / 1000) + offset * 30)

    it('parola yoksa 400, yanlışsa 401 ve kilide sayılır; challenge verilmez', async () => {
      mkUser('ali')
      const cookie = await signIn('ali')
      expect((await regOptions(cookie, {})).status).toBe(400)
      const a = new SoftAuthenticator()
      const r = await regOptions(cookie, { password: 'yanlis-parola' })
      expect(r.status).toBe(401)
      expect(JSON.parse(r.body)).toEqual({ reason: 'bad' })
      for (let i = 1; i < LOCK_MAX_FAILS; i++) await regOptions(cookie, { password: 'yanlis-parola' })
      // kilitliyken doğru parola da denenmez
      expect((await regOptions(cookie)).status).toBe(423)
      expect((await post('/api/login', { username: 'ali', password: PW })).status).toBe(423)
      expect((await post('/api/passkey/register/verify', { response: a.register('uydurma'), name: 'x' }, { cookie })).status).toBe(400)
    })

    it('2FA açıksa kod ister: kodsuz yanıt parolayı doğrulamaz, yanlış kod ve yanlış parola ayırt edilmez', async () => {
      const id = mkUser('ali')
      const cookie = await signIn('ali')
      const secret = await enableTotp(id)
      // parola denetlenmeden: doğru ya da yanlış aynı yanıt, sayaç işlemez
      const a = await regOptions(cookie, { password: PW })
      const b = await regOptions(cookie, { password: 'yanlis-parola' })
      expect([a.status, b.status]).toEqual([428, 428])
      expect(a.body).toBe(b.body)
      expect(db.prepare(`SELECT COUNT(*) AS n FROM web_login_attempts WHERE ok = 0`).get()).toEqual({ n: 0 })
      const wrongCode = await regOptions(cookie, { password: PW, totp: '000000' }, '10.3.0.1')
      const wrongPw = await regOptions(cookie, { password: 'yanlis-parola', totp: codeNow(secret) }, '10.3.0.2')
      expect(wrongCode.status).toBe(401)
      expect(wrongPw.status).toBe(401)
      expect(wrongCode.body).toBe(wrongPw.body)
    })

    it('doğru kod kabul edilir, aynı kod ikinci kez reddedilir; girişte de kullanılamaz', async () => {
      const id = mkUser('ali')
      const cookie = await signIn('ali')
      const secret = await enableTotp(id)
      const code = codeNow(secret)
      const ok = await regOptions(cookie, { password: PW, totp: code })
      expect(ok.status).toBe(200)
      const replay = await regOptions(cookie, { password: PW, totp: code })
      expect(replay.status).toBe(401)
      expect((await post('/api/login', { username: 'ali', password: PW, totp: code })).status).toBe(401)
      const a = new SoftAuthenticator()
      const { challenge } = JSON.parse(ok.body)
      expect((await post('/api/passkey/register/verify', { response: a.register(challenge), name: 'Telefon' }, { cookie })).status).toBe(200)
    })
  })

  it('passkeysAvailable: IP kökeninde WebAuthn yok', () => {
    expect(passkeysAvailable('https://posta.example.com')).toBe(true)
    expect(passkeysAvailable('http://localhost:8080')).toBe(true)
    expect(passkeysAvailable('http://127.0.0.1:8080')).toBe(false)
    expect(passkeysAvailable('https://10.0.0.5')).toBe(false)
    expect(passkeysAvailable('http://[::1]:8080')).toBe(false)
  })

  it('kayıt sürerken iptal edilen oturum passkey ekleyemez', async () => {
    const id = mkUser('ali')
    const cookie = await signIn('ali')
    const { challenge } = JSON.parse((await regOptions(cookie)).body)
    q.updateUserFields(id, { enabled: 0 })
    const a = new SoftAuthenticator()
    expect((await post('/api/passkey/register/verify', { response: a.register(challenge), name: 'x' }, { cookie })).status).toBe(401)
    expect(q.getPasskey(a.id)).toBeUndefined()
  })
})
