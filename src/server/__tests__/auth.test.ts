import type Database from 'better-sqlite3'
import { createHash, randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../sync/auth/password'
import { openDb } from '../../sync/db'
import { makeQueries } from '../../sync/db/queries'
import type { EngineHost } from '../../sync/host'
import { LOCK_MAX_FAILS, LOCK_WINDOW_MS, SESSION_IDLE_MS, SESSION_IDLE_PUSH_MS, SESSION_TTL_MS, WebAuth } from '../auth'
import { createServerHost } from '../hosts/serverHost'
import { base32Decode, base32Encode, newTotpSecret, totpCode } from '../../sync/auth/totp'
import type { SessionUser } from '../../shared/rpc'
import type { OpQueue } from '../../sync/opQueue'
import { RpcHub, type RpcServerDeps } from '../../sync/rpcHub'
import type { Scheduler } from '../../sync/scheduler'

describe('WebAuth', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let host: EngineHost
  let clock: number
  const now = () => clock
  const PW = 'dogru-parola-1'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-webauth-'))
    db = openDb(dir)
    q = makeQueries(db)
    host = createServerHost(randomBytes(32), () => null)
    clock = Date.UTC(2026, 10, 3, 12, 0, 0)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const mkUser = (username: string, role: 'admin' | 'member' = 'member') => q.insertUser({ username, passwordHash: hashPassword(PW), role })
  const login = (a: WebAuth, username: string, password: string, ip = '10.0.0.1', totp?: string) =>
    a.login({ username, password, totp, ip, userAgent: 'test' })
  const enableTotp = async (userId: number): Promise<Buffer> => {
    const secret = newTotpSecret()
    const [enc] = await host.encrypt([base32Encode(secret)])
    q.setTotpPending(userId, Buffer.from(enc))
    q.enableTotp(userId, 0)
    return secret
  }

  it('login ok returns fresh token each time', async () => {
    const id = mkUser('ali')
    const a = new WebAuth(q, host, now)
    const r1 = await login(a, 'ali', PW)
    const r2 = await login(a, 'ali', PW)
    expect(r1.ok && r2.ok).toBe(true)
    if (!r1.ok || !r2.ok) return
    expect(r1.token).not.toBe(r2.token)
    expect(Buffer.from(r1.token, 'base64url')).toHaveLength(32)
    expect(r1.user).toMatchObject({ id, username: 'ali', role: 'member' })
    // yanıtta parola / özet / sır yok
    expect(JSON.stringify(r1.user)).not.toMatch(/password|hash|totp/i)
  })

  it('wrong password → bad', async () => {
    mkUser('ali')
    const a = new WebAuth(q, host, now)
    expect(await login(a, 'ali', 'yanlis')).toEqual({ ok: false, reason: 'bad' })
    expect(await login(a, 'yok', PW)).toEqual({ ok: false, reason: 'bad' })
  })

  it('disabled user → bad', async () => {
    const id = mkUser('ali')
    q.updateUserFields(id, { enabled: 0 })
    expect(await login(new WebAuth(q, host, now), 'ali', PW)).toEqual({ ok: false, reason: 'bad' })
  })

  it('lockout after 5 fails per ip', async () => {
    mkUser('ali')
    mkUser('veli')
    const a = new WebAuth(q, host, now)
    for (let i = 0; i < LOCK_MAX_FAILS; i++) {
      expect((await login(a, i % 2 ? 'ali' : 'veli', 'yanlis', '1.1.1.1')).ok).toBe(false)
      clock += 1000
    }
    // doğru parola bile: kilitliyken parola denetlenmez
    expect(await login(a, 'ali', PW, '1.1.1.1')).toEqual({ ok: false, reason: 'locked' })
    // başka IP'den etkilenmez
    expect((await login(a, 'ali', PW, '2.2.2.2')).ok).toBe(true)
    // pencere geçince açılır
    clock += LOCK_WINDOW_MS
    expect((await login(a, 'ali', PW, '1.1.1.1')).ok).toBe(true)
  })

  it('lockout per username across ips', async () => {
    mkUser('ali')
    mkUser('veli')
    const a = new WebAuth(q, host, now)
    for (let i = 0; i < LOCK_MAX_FAILS; i++) await login(a, 'ali', 'yanlis', `10.0.0.${i + 10}`)
    expect(await login(a, 'ali', PW, '10.9.9.9')).toEqual({ ok: false, reason: 'locked' })
    // büyük/küçük harf ve boşlukla kilit atlatılamaz
    expect(await login(a, ' ALI ', PW, '10.9.9.8')).toEqual({ ok: false, reason: 'locked' })
    // aynı IP'lerden başka kullanıcı girebilir
    expect((await login(a, 'veli', PW, '10.0.0.10')).ok).toBe(true)
  })

  it('lockout survives new connection', async () => {
    mkUser('ali')
    const a = new WebAuth(q, host, now)
    for (let i = 0; i < LOCK_MAX_FAILS; i++) await login(a, 'ali', 'yanlis')
    const b = new WebAuth(q, host, now)
    expect(await login(b, 'ali', PW)).toEqual({ ok: false, reason: 'locked' })
  })

  it('old attempts are pruned after 24h', async () => {
    mkUser('ali')
    const a = new WebAuth(q, host, now)
    await login(a, 'ali', 'yanlis')
    clock += 25 * 3600_000
    await login(a, 'ali', PW)
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM web_login_attempts`).get() as { n: number }).n
    expect(n).toBe(1)
  })

  it('totp required when enabled', async () => {
    const id = mkUser('ali')
    const secret = await enableTotp(id)
    const a = new WebAuth(q, host, now)
    expect(await login(a, 'ali', PW)).toEqual({ ok: false, reason: 'totpRequired' })
    const code = totpCode(secret, clock / 1000)
    expect((await login(a, 'ali', PW, '10.0.0.1', code)).ok).toBe(true)
    // aynı kod ikinci kez → totpBad (tekrar kullanım engeli)
    expect(await login(a, 'ali', PW, '10.0.0.1', code)).toEqual({ ok: false, reason: 'totpBad' })
    expect(await login(a, 'ali', PW, '10.0.0.1', '000000' === code ? '111111' : '000000')).toEqual({ ok: false, reason: 'totpBad' })
    // yanlış parolayla TOTP sorulmaz
    expect(await login(a, 'ali', 'yanlis', '10.0.0.1', code)).toEqual({ ok: false, reason: 'bad' })
  })

  it('bad totp counts as a failure', async () => {
    const id = mkUser('ali')
    const secret = await enableTotp(id)
    const a = new WebAuth(q, host, now)
    for (let i = 0; i < LOCK_MAX_FAILS; i++) await login(a, 'ali', PW, '10.0.0.1', 'abcdef')
    clock += 60_000
    expect(await login(a, 'ali', PW, '10.0.0.2', totpCode(secret, clock / 1000))).toEqual({ ok: false, reason: 'locked' })
  })

  it('concurrent bad totp logins cannot exceed the lockout', async () => {
    const id = mkUser('ali')
    await enableTotp(id)
    const a = new WebAuth(q, host, now)
    const rs = await Promise.all(Array.from({ length: LOCK_MAX_FAILS + 1 }, () => login(a, 'ali', PW, '10.0.0.1', 'abcdef')))
    expect(rs.some((r) => !r.ok && r.reason === 'locked')).toBe(true)
    const fails = (db.prepare(`SELECT COUNT(*) AS n FROM web_login_attempts WHERE ok = 0`).get() as { n: number }).n
    expect(fails).toBeLessThanOrEqual(LOCK_MAX_FAILS)
  })

  it('same totp code in two concurrent logins → exactly one ok', async () => {
    const id = mkUser('ali')
    const secret = await enableTotp(id)
    const a = new WebAuth(q, host, now)
    const code = totpCode(secret, clock / 1000)
    const rs = await Promise.all([login(a, 'ali', PW, '10.0.0.1', code), login(a, 'ali', PW, '10.0.0.2', code)])
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    expect(rs.find((r) => !r.ok)).toEqual({ ok: false, reason: 'totpBad' })
  })

  it('empty ip is rejected without a shared lockout bucket', async () => {
    mkUser('ali')
    const a = new WebAuth(q, host, now)
    expect(await login(a, 'ali', PW, '')).toEqual({ ok: false, reason: 'bad' })
    expect(await login(a, 'ali', PW, '   ')).toEqual({ ok: false, reason: 'bad' })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM web_login_attempts`).get()).toEqual({ n: 0 })
    expect((await login(a, 'ali', PW, '10.0.0.1')).ok).toBe(true)
  })

  it('require2fa forces setup', async () => {
    mkUser('ali')
    q.prefSet('require2fa', '1')
    const a = new WebAuth(q, host, now)
    expect(await login(a, 'ali', PW)).toEqual({ ok: false, reason: 'totpSetupRequired' })
    // yanlış parolada kurulum ekranı açılmaz
    expect(await login(a, 'ali', 'yanlis')).toEqual({ ok: false, reason: 'bad' })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM web_sessions`).get()).toEqual({ n: 0 })
  })

  it('resolve returns user and refreshes last_seen', async () => {
    const id = mkUser('ali')
    const a = new WebAuth(q, host, now)
    const r = await login(a, 'ali', PW)
    if (!r.ok) throw new Error('giriş olmadı')
    clock += 3600_000
    const res = a.resolve(r.token)
    expect(res?.user.id).toBe(id)
    expect(res?.sessionId).toMatch(/^[0-9a-f]{64}$/)
    expect((db.prepare(`SELECT last_seen_at FROM web_sessions`).get() as { last_seen_at: number }).last_seen_at).toBe(clock)
    expect(a.resolve('uydurma')).toBeNull()
  })

  it('resolve expires after idle', async () => {
    mkUser('ali')
    const a = new WebAuth(q, host, now)
    const r = await login(a, 'ali', PW)
    if (!r.ok) throw new Error('giriş olmadı')
    clock += SESSION_IDLE_MS + 1
    expect(a.resolve(r.token)).toBeNull()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM web_sessions`).get()).toEqual({ n: 0 })
  })

  it('idle session with a device loses mailbox access but keeps its device for push', async () => {
    const id = mkUser('ali')
    const a = new WebAuth(q, host, now)
    const r = await login(a, 'ali', PW)
    if (!r.ok) throw new Error('giriş olmadı')
    const { id_hash } = db.prepare(`SELECT id_hash FROM web_sessions`).get() as { id_hash: string }
    q.upsertPushDevice({ userId: id, sessionId: id_hash, endpoint: 'https://fcm.googleapis.com/x', p256dh: 'p', auth: 'a', label: null, now: clock })
    clock += SESSION_IDLE_MS + 1
    const seen = clock - SESSION_IDLE_MS - 1
    expect(a.resolve(r.token)).toBeNull()
    expect(a.resolve(r.token)).toBeNull() // reddedilen istek boşta süresini sıfırlamaz
    expect((db.prepare(`SELECT last_seen_at FROM web_sessions`).get() as { last_seen_at: number }).last_seen_at).toBe(seen)
    a.sweepExpired()
    expect(q.listPushDevices(id)).toHaveLength(1)
    clock += SESSION_IDLE_PUSH_MS
    expect(a.resolve(r.token)).toBeNull()
    expect(q.listPushDevices(id)).toHaveLength(0)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM web_sessions`).get()).toEqual({ n: 0 })
  })

  it('active session with a device rolls past the ttl, one without does not', async () => {
    const id = mkUser('ali')
    mkUser('veli')
    const a = new WebAuth(q, host, now)
    const r = await login(a, 'ali', PW)
    const v = await login(a, 'veli', PW)
    if (!r.ok || !v.ok) throw new Error('giriş olmadı')
    const { id_hash } = db.prepare(`SELECT id_hash FROM web_sessions WHERE user_id = ?`).get(id) as { id_hash: string }
    q.upsertPushDevice({ userId: id, sessionId: id_hash, endpoint: 'https://fcm.googleapis.com/z', p256dh: 'p', auth: 'a', label: null, now: clock })
    for (let t = 0; t < SESSION_TTL_MS * 2; t += SESSION_IDLE_MS / 2) {
      clock += SESSION_IDLE_MS / 2
      expect(a.resolve(r.token)).not.toBeNull()
      a.resolve(v.token)
    }
    expect(a.resolve(v.token)).toBeNull()
    expect(a.resolve(r.token)?.expiresAt).toBeGreaterThan(clock + SESSION_TTL_MS - 2 * 24 * 3600_000)
  })

  it('sweep ends an idle session without a device and keeps one with a device until the push idle limit', async () => {
    const id = mkUser('ali')
    mkUser('veli')
    const a = new WebAuth(q, host, now)
    if (!(await login(a, 'ali', PW)).ok) throw new Error('giriş olmadı')
    if (!(await login(a, 'veli', PW)).ok) throw new Error('giriş olmadı')
    const { id_hash } = db.prepare(`SELECT id_hash FROM web_sessions WHERE user_id = ?`).get(id) as { id_hash: string }
    q.upsertPushDevice({ userId: id, sessionId: id_hash, endpoint: 'https://fcm.googleapis.com/y', p256dh: 'p', auth: 'a', label: null, now: clock })
    clock += SESSION_IDLE_MS + 1
    a.sweepExpired()
    expect(db.prepare(`SELECT user_id FROM web_sessions`).all()).toEqual([{ user_id: id }])
    clock += SESSION_IDLE_PUSH_MS
    a.sweepExpired()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM web_sessions`).get()).toEqual({ n: 0 })
    expect(q.listPushDevices(id)).toHaveLength(0)
  })

  it('süpürme süresi dolan oturumların kullanıcılarını döner', async () => {
    const id = mkUser('ali')
    const a = new WebAuth(q, host, now)
    await login(a, 'ali', PW)
    expect(a.sweepExpired()).toEqual([])
    clock += SESSION_IDLE_MS + 1
    expect(a.sweepExpired()).toEqual([id])
  })

  it('resolve expires after ttl even when active', async () => {
    mkUser('ali')
    const a = new WebAuth(q, host, now)
    const r = await login(a, 'ali', PW)
    if (!r.ok) throw new Error('giriş olmadı')
    for (let t = 0; t < SESSION_TTL_MS; t += SESSION_IDLE_MS / 2) {
      clock += SESSION_IDLE_MS / 2
      a.resolve(r.token)
    }
    clock += 1
    expect(a.resolve(r.token)).toBeNull()
  })

  it('disabled user session resolves null', async () => {
    const id = mkUser('ali')
    const a = new WebAuth(q, host, now)
    const r = await login(a, 'ali', PW)
    if (!r.ok) throw new Error('giriş olmadı')
    q.updateUserFields(id, { enabled: 0 })
    expect(a.resolve(r.token)).toBeNull()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM web_sessions`).get()).toEqual({ n: 0 })
  })

  it('db stores only token hash', async () => {
    mkUser('ali')
    const a = new WebAuth(q, host, now)
    const r = await login(a, 'ali', PW, '10.1.1.1')
    if (!r.ok) throw new Error('giriş olmadı')
    const row = db.prepare(`SELECT * FROM web_sessions`).get() as { id_hash: string; ip: string; user_agent: string; expires_at: number }
    expect(row.id_hash).not.toBe(r.token)
    expect(row.id_hash).toBe(createHash('sha256').update(r.token).digest('hex'))
    expect(row).toMatchObject({ ip: '10.1.1.1', user_agent: 'test', expires_at: clock + SESSION_TTL_MS })
  })

  it('logout deletes the session', async () => {
    mkUser('ali')
    const a = new WebAuth(q, host, now)
    const r = await login(a, 'ali', PW)
    if (!r.ok) throw new Error('giriş olmadı')
    a.logout(r.token)
    expect(a.resolve(r.token)).toBeNull()
  })

  it('revokeUser deletes only that user sessions and returns ids', async () => {
    mkUser('ali')
    mkUser('veli')
    const a = new WebAuth(q, host, now)
    const r1 = await login(a, 'ali', PW)
    const r2 = await login(a, 'ali', PW)
    const r3 = await login(a, 'veli', PW)
    if (!r1.ok || !r2.ok || !r3.ok) throw new Error('giriş olmadı')
    const ids = a.revokeUser(r1.user.id)
    const h = (t: string) => createHash('sha256').update(t).digest('hex')
    expect(ids.sort()).toEqual([h(r1.token), h(r2.token)].sort())
    expect(a.resolve(r1.token)).toBeNull()
    expect(a.resolve(r3.token)?.user.username).toBe('veli')
  })

  it('revokeUser keeps the given session and its push devices, ends the rest', async () => {
    mkUser('ali')
    const a = new WebAuth(q, host, now)
    const r1 = await login(a, 'ali', PW)
    const r2 = await login(a, 'ali', PW)
    if (!r1.ok || !r2.ok) throw new Error('giriş olmadı')
    const h = (t: string) => createHash('sha256').update(t).digest('hex')
    const dev = (s: string): number => q.upsertPushDevice({ userId: r1.user.id, sessionId: s, endpoint: `https://fcm.googleapis.com/${s.slice(0, 8)}`, p256dh: 'p', auth: 'a', label: null, now: 1 })
    const keptDev = dev(h(r1.token))
    dev(h(r2.token))
    const ids = a.revokeUser(r1.user.id, h(r1.token))
    expect(ids).toEqual([h(r2.token)])
    expect(a.resolve(r1.token)?.user.username).toBe('ali')
    expect(a.resolve(r2.token)).toBeNull()
    expect(q.listPushDevices(r1.user.id).map((d) => d.id)).toEqual([keptDev])
  })

  it('user disabled during totp decrypt cannot get a session', async () => {
    const id = mkUser('ali')
    const secret = await enableTotp(id)
    // decrypt await'i sırasında yönetici kullanıcıyı devre dışı bırakır
    const racy: EngineHost = {
      ...host,
      decrypt: async (b) => {
        q.updateUserFields(id, { enabled: 0 })
        return host.decrypt(b)
      }
    }
    const a = new WebAuth(q, racy, now)
    expect(await login(a, 'ali', PW, '10.0.0.1', totpCode(secret, clock / 1000))).toEqual({ ok: false, reason: 'bad' })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM web_sessions`).get()).toEqual({ n: 0 })
  })

  it('user deleted during totp decrypt cannot get a session', async () => {
    const id = mkUser('ali')
    const secret = await enableTotp(id)
    const racy: EngineHost = {
      ...host,
      decrypt: async (b) => {
        db.prepare(`DELETE FROM users WHERE id = ?`).run(id)
        return host.decrypt(b)
      }
    }
    const a = new WebAuth(q, racy, now)
    expect(await login(a, 'ali', PW, '10.0.0.1', totpCode(secret, clock / 1000))).toEqual({ ok: false, reason: 'bad' })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM web_sessions`).get()).toEqual({ n: 0 })
  })

  it('2FA reset or secret change during totp decrypt cannot get a session', async () => {
    const id = mkUser('ali')
    const secret = await enableTotp(id)
    const code = totpCode(secret, clock / 1000)
    // yönetici 2FA'yı sıfırlar (sır silinir)
    let racy: EngineHost = {
      ...host,
      decrypt: async (b) => {
        q.clearTotp(id)
        return host.decrypt(b)
      }
    }
    expect(await login(new WebAuth(q, racy, now), 'ali', PW, '10.0.0.1', code)).toEqual({ ok: false, reason: 'totpBad' })
    // sır okunduktan sonra (await sırasında) başka bir sırla yeniden kurulur: eski sırrın kodu kabul edilmez
    const [encOld] = await host.encrypt([base32Encode(secret)])
    const [encNew] = await host.encrypt([base32Encode(newTotpSecret())])
    q.setTotpPending(id, Buffer.from(encOld))
    q.enableTotp(id, 0)
    racy = {
      ...host,
      decrypt: async (b) => {
        q.setTotpPending(id, Buffer.from(encNew))
        q.enableTotp(id, 0)
        return host.decrypt(b)
      }
    }
    expect(await login(new WebAuth(q, racy, now), 'ali', PW, '10.0.0.1', code)).toEqual({ ok: false, reason: 'totpBad' })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM web_sessions`).get()).toEqual({ n: 0 })
  })

  it('rpc twoFactorBegin/Confirm secret is accepted by WebAuth.login (same host)', async () => {
    const id = mkUser('ali')
    // sunucu bağlamasıyla aynı: RPC deps.encrypt/decrypt = host.encrypt/decrypt
    const stub = new Proxy({}, { get: () => () => undefined })
    const deps: RpcServerDeps = {
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: (v) => host.encrypt(v),
      decrypt: async (b) => (await host.decrypt(b)).map((u) => Buffer.from(u).toString('utf-8')),
      userData: dir, dbSchemaVersion: () => 0
    }
    const hub = new RpcHub(deps, 'server')
    const user: SessionUser = { id, username: 'ali', role: 'member', permittedGroupIds: [], manageableGroupIds: [] }
    const s = hub.openSession({ send() {}, onMessage() {}, onClose() {}, close() {} }, { user })
    const r = (await s.handle('twoFactorBegin', {})) as { secretBase32: string }
    const secret = base32Decode(r.secretBase32)
    const t0 = Date.now() / 1000
    await s.handle('twoFactorConfirm', { code: totpCode(secret, t0) })
    // yeni adımın kodu (onaylamada kullanılan adım ikinci kez kabul edilmez)
    clock = (t0 + 30) * 1000
    const a = new WebAuth(q, host, now)
    expect(await login(a, 'ali', PW)).toEqual({ ok: false, reason: 'totpRequired' })
    expect((await login(a, 'ali', PW, '10.0.0.1', totpCode(secret, clock / 1000))).ok).toBe(true)
  })

  describe('forced 2FA setup without a session', () => {
    const begin = (a: WebAuth, username: string, password: string, ip = '10.0.0.1') => a.setupBegin({ username, password, ip })
    const confirm = (a: WebAuth, username: string, password: string, code: string, ip = '10.0.0.1') =>
      a.setupConfirm({ username, password, code, ip, userAgent: 'test' })

    it('begin → confirm enables totp and returns a fresh session', async () => {
      const id = mkUser('ali')
      q.prefSet('require2fa', '1')
      const a = new WebAuth(q, host, now)
      const b = await begin(a, 'ali', PW)
      if (!b.ok) throw new Error('kurulum başlamadı')
      expect(b.otpauthUri).toMatch(/^otpauth:\/\/totp\/GeckoMail:ali\?secret=/)
      const row = q.getUserById(id)!
      expect(row.totp_enabled).toBe(0)
      // sır DB'de düz durmaz
      expect(Buffer.from(row.totp_secret_enc!).toString()).not.toContain(b.secretBase32)
      const secret = base32Decode(b.secretBase32)
      const wrong = totpCode(secret, clock / 1000) === '000000' ? '111111' : '000000'
      expect(await confirm(a, 'ali', PW, wrong)).toEqual({ ok: false, reason: 'totpBad' })
      expect(q.getUserById(id)!.totp_enabled).toBe(0)
      const code = totpCode(secret, clock / 1000)
      const r = await confirm(a, 'ali', PW, code)
      if (!r.ok) throw new Error('onay olmadı')
      expect(r.user).toMatchObject({ id, username: 'ali' })
      expect(a.resolve(r.token)?.user.id).toBe(id)
      expect(q.getUserById(id)!.totp_enabled).toBe(1)
      // aynı kod normal girişte yeniden kullanılamaz
      expect(await login(a, 'ali', PW, '10.0.0.1', code)).toEqual({ ok: false, reason: 'totpBad' })
      clock += 30_000
      expect((await login(a, 'ali', PW, '10.0.0.1', totpCode(secret, clock / 1000))).ok).toBe(true)
    })

    it('begin refuses when totp already active', async () => {
      const id = mkUser('ali')
      q.prefSet('require2fa', '1')
      const before = await enableTotp(id)
      const enc = q.getUserById(id)!.totp_secret_enc
      const a = new WebAuth(q, host, now)
      expect(await begin(a, 'ali', PW)).toEqual({ ok: false, reason: 'notRequired' })
      // etkin sır ezilmedi, 2FA kapanmadı
      const row = q.getUserById(id)!
      expect(row.totp_enabled).toBe(1)
      expect(Buffer.from(row.totp_secret_enc!).equals(Buffer.from(enc!))).toBe(true)
      expect((await login(a, 'ali', PW, '10.0.0.1', totpCode(before, clock / 1000))).ok).toBe(true)
      // etkinken confirm de oturum açmaz
      expect(await confirm(a, 'ali', PW, totpCode(before, clock / 1000 + 30))).toEqual({ ok: false, reason: 'totpRequired' })
    })

    it('begin refuses when 2FA is not required', async () => {
      mkUser('ali')
      const a = new WebAuth(q, host, now)
      expect(await begin(a, 'ali', PW)).toEqual({ ok: false, reason: 'notRequired' })
    })

    it('begin and confirm re-authenticate', async () => {
      mkUser('ali')
      q.prefSet('require2fa', '1')
      const a = new WebAuth(q, host, now)
      expect(await begin(a, 'ali', 'yanlis')).toEqual({ ok: false, reason: 'bad' })
      expect(await begin(a, 'yok', PW)).toEqual({ ok: false, reason: 'bad' })
      const b = await begin(a, 'ali', PW)
      if (!b.ok) throw new Error('kurulum başlamadı')
      const code = totpCode(base32Decode(b.secretBase32), clock / 1000)
      expect(await confirm(a, 'ali', 'yanlis', code)).toEqual({ ok: false, reason: 'bad' })
      expect(await begin(a, 'ali', PW, '')).toEqual({ ok: false, reason: 'bad' })
    })

    it('setup failures count toward lockout', async () => {
      mkUser('ali')
      q.prefSet('require2fa', '1')
      const a = new WebAuth(q, host, now)
      for (let i = 0; i < LOCK_MAX_FAILS; i++) await begin(a, 'ali', 'yanlis')
      expect(await begin(a, 'ali', PW)).toEqual({ ok: false, reason: 'locked' })
      expect(await login(a, 'ali', PW)).toEqual({ ok: false, reason: 'locked' })
      expect(await confirm(a, 'ali', PW, '123456')).toEqual({ ok: false, reason: 'locked' })
    })

    it('bad setup codes count toward lockout', async () => {
      mkUser('ali')
      q.prefSet('require2fa', '1')
      const a = new WebAuth(q, host, now)
      const b = await begin(a, 'ali', PW)
      if (!b.ok) throw new Error('kurulum başlamadı')
      const secret = base32Decode(b.secretBase32)
      for (let i = 0; i < LOCK_MAX_FAILS; i++) await confirm(a, 'ali', PW, 'abcdef')
      expect(await confirm(a, 'ali', PW, totpCode(secret, clock / 1000))).toEqual({ ok: false, reason: 'locked' })
    })

    it('user disabled during setup confirm cannot get a session', async () => {
      const id = mkUser('ali')
      q.prefSet('require2fa', '1')
      const b = await begin(new WebAuth(q, host, now), 'ali', PW)
      if (!b.ok) throw new Error('kurulum başlamadı')
      const racy: EngineHost = {
        ...host,
        decrypt: async (x) => {
          q.updateUserFields(id, { enabled: 0 })
          return host.decrypt(x)
        }
      }
      const a = new WebAuth(q, racy, now)
      expect(await confirm(a, 'ali', PW, totpCode(base32Decode(b.secretBase32), clock / 1000))).toEqual({ ok: false, reason: 'bad' })
      expect(q.getUserById(id)!.totp_enabled).toBe(0)
      expect(db.prepare(`SELECT COUNT(*) AS n FROM web_sessions`).get()).toEqual({ n: 0 })
    })
  })
})
