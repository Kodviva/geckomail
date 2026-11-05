import { createServer, type AddressInfo } from 'net'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { classifyError } from '../imapClient'
import type { LoginFailureKind } from '../net/hostGovernor'
import { assertManagedName, freshProgress, ManageSieveClient, ManageSieveError, parseResponse, sieveFailureKind, type SieveConnectOpts } from '../sieve/manageSieve'
import { makeTestCert, startFakeManageSieve, type FakeSieve, type FakeSieveOptions, type TestCert } from './helpers/fakeManageSieve'

const PASSWORD = 'çok-gizli-parola'
const CRED = { kind: 'password' as const, user: 'a@t.test', password: PASSWORD }

describe('ManageSieveClient', () => {
  let cert: TestCert
  const servers: FakeSieve[] = []
  const clients: ManageSieveClient[] = []
  beforeAll(() => {
    cert = makeTestCert()
  })
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close()
    await Promise.all(servers.splice(0).map((s) => s.close()))
  })

  const fake = async (o: Partial<FakeSieveOptions> = {}): Promise<FakeSieve> => {
    const s = await startFakeManageSieve({ tls: 'starttls', cert, sasl: ['PLAIN'], ...o })
    servers.push(s)
    return s
  }
  const open = async (s: FakeSieve, o: Partial<SieveConnectOpts> = {}): Promise<ManageSieveClient> => {
    const c = await ManageSieveClient.connect({ host: '127.0.0.1', port: s.port, tls: 'starttls', rejectUnauthorized: false, ...o })
    clients.push(c)
    return c
  }
  const session = async (o: Partial<FakeSieveOptions> = {}, co: Partial<SieveConnectOpts> = {}): Promise<{ s: FakeSieve; c: ManageSieveClient }> => {
    const s = await fake(o)
    const c = await open(s, co)
    await c.authenticate(CRED)
    return { s, c }
  }
  const fails = async (p: Promise<unknown>): Promise<ManageSieveError> => {
    const e = await p.then(() => null, (x: unknown) => x)
    expect(e).toBeInstanceOf(ManageSieveError)
    return e as ManageSieveError
  }

  it('starttls then caps', async () => {
    const s = await fake({ sasl: ['PLAIN', 'OAUTHBEARER'], extensions: ['fileinto', 'vacation'], maxRedirects: 1 })
    const c = await open(s)
    expect(s.commands).toEqual(['STARTTLS'])
    expect(c.caps).toEqual({ implementation: 'Fake Sieve', version: '1.0', sasl: ['PLAIN', 'OAUTHBEARER'], sieve: ['fileinto', 'vacation'], maxRedirects: 1 })
  })

  it('implicit tls', async () => {
    const s = await fake({ tls: 'implicit' })
    const c = await open(s, { tls: 'tls' })
    expect(c.caps.sasl).toEqual(['PLAIN'])
    expect(s.commands).toEqual([])
  })

  it('no credentials before tls', async () => {
    const s = await fake({ tls: 'none', leakPlainSaslBeforeTls: true })
    const e = await fails(open(s))
    expect(e.phase).toBe('tls')
    expect(s.commands.some((x) => x.startsWith('AUTHENTICATE'))).toBe(false)
    await expect.poll(() => s.closed).toBe(1)
  })

  it('STARTTLS reddi kimlik göndermez', async () => {
    const s = await fake({ refuseStarttls: true, saslBeforeTls: ['PLAIN'] })
    const e = await fails(open(s))
    expect(e.phase).toBe('tls')
    expect(s.commands).toEqual(['STARTTLS'])
  })

  it('STARTTLS onayına eklenen düz metin reddedilir', async () => {
    const s = await fake({ injectAfterStarttlsOk: '"SASL" "PLAIN"\r\nOK "sahte"\r\n' })
    const e = await fails(open(s))
    expect(e.phase).toBe('tls')
  })

  it('caps reread after starttls', async () => {
    const s = await fake({ saslBeforeTls: ['PLAIN', 'LOGIN'], sasl: ['OAUTHBEARER'] })
    const c = await open(s)
    expect(c.caps.sasl).toEqual(['OAUTHBEARER'])
    // TLS öncesi PLAIN ilanına güvenilmez: parola gönderilmez
    const e = await fails(c.authenticate(CRED))
    expect(e.phase).toBe('auth')
    expect(e.authenticationFailed).toBe(false)
    expect(s.commands.some((x) => x.startsWith('AUTHENTICATE'))).toBe(false)
  })

  it('plain auth', async () => {
    const { s, c } = await session()
    const payload = Buffer.from(`\0a@t.test\0${PASSWORD}`).toString('base64')
    expect(s.commands).toContain(`AUTHENTICATE "PLAIN" "${payload}"`)
    // yetenekler kimlik doğrulamadan sonra yeniden okunur
    expect(s.commands.at(-1)).toBe('CAPABILITY')
    expect(c.caps.sasl).toEqual(['PLAIN'])
  })

  it('xoauth2 auth', async () => {
    const s = await fake({ sasl: ['XOAUTH2'] })
    const c = await open(s)
    await c.authenticate({ kind: 'oauth', user: 'a@t.test', accessToken: 'TOK' })
    const payload = Buffer.from('user=a@t.test\x01auth=Bearer TOK\x01\x01').toString('base64')
    expect(s.commands).toContain(`AUTHENTICATE "XOAUTH2" "${payload}"`)
  })

  it('oauthbearer auth', async () => {
    const s = await fake({ sasl: ['XOAUTH2', 'OAUTHBEARER'] })
    const c = await open(s)
    await c.authenticate({ kind: 'oauth', user: 'a@t.test', accessToken: 'TOK' })
    const line = s.commands.find((x) => x.startsWith('AUTHENTICATE'))!
    expect(line).toContain('"OAUTHBEARER"')
    const payload = /"([^"]+)"$/.exec(line)![1]
    expect(Buffer.from(payload, 'base64').toString()).toBe(`n,a=a@t.test,\x01host=127.0.0.1\x01port=${s.port}\x01auth=Bearer TOK\x01\x01`)
  })

  it('OAuth hatasında sürdürme satırı boş yanıtla kapanır', async () => {
    for (const [mech, reply] of [['XOAUTH2', '""'], ['OAUTHBEARER', '"AQ=="']]) {
      const s = await fake({ sasl: [mech], failAuth: true })
      const c = await open(s)
      const e = await fails(c.authenticate({ kind: 'oauth', user: 'a@t.test', accessToken: 'TOK' }))
      expect(e.authenticationFailed).toBe(true)
      expect(s.commands.at(-1)).toBe(reply)
    }
  })

  it('uzun SASL yükü literal gider', async () => {
    const accessToken = 'b'.repeat(3000)
    const o = await fake({ sasl: ['XOAUTH2'] })
    const c = await open(o)
    await c.authenticate({ kind: 'oauth', user: 'a@t.test', accessToken })
    const auth = o.commands.find((x) => x.startsWith('AUTHENTICATE'))!
    expect(auth).toMatch(/^AUTHENTICATE "XOAUTH2" \{\d+\+\}$/)
    expect(Buffer.from(o.authPayloads[0], 'base64').toString()).toContain(accessToken)
    expect(await c.listScripts()).toEqual([])
  })

  it('kısa SASL yükü tırnaklı kalır', async () => {
    const { s } = await session()
    expect(s.commands.find((x) => x.startsWith('AUTHENTICATE'))).toMatch(/^AUTHENTICATE "PLAIN" "[^"]+"$/)
  })

  it.each(['AUTH-TOO-WEAK', 'ENCRYPT-NEEDED', 'TRANSITION-NEEDED'])('%s kimlik reddi değildir', async (code) => {
    const s = await fake({ intercept: (l) => (l.startsWith('AUTHENTICATE') ? `NO (${code}) "yöntem"\r\n` : undefined) })
    const c = await open(s)
    const e = await fails(c.authenticate(CRED))
    expect(e).toMatchObject({ code, authenticationFailed: false, phase: 'auth' })
    expect(sieveFailureKind(e)).toBe('other')
  })

  it('yanıt ayrıştırma kaldığı yerden sürer', () => {
    const p = freshProgress()
    const first = Buffer.from('"a"\r\n"b"\r\n"c')
    expect(parseResponse(first, false, p)).toBeNull()
    expect(p.lines).toHaveLength(2)
    expect(p.pos).toBe(10)
    // tamamlanmış satırlar yeniden taranmaz: başı bozuk olsa da sonuç değişmez
    const next = Buffer.concat([Buffer.alloc(10, 0x7b), Buffer.from('"c"\r\nOK "tamam"\r\n')])
    const r = parseResponse(next, false, p)
    expect(r).toMatchObject({ kind: 'response', response: { status: 'OK', text: 'tamam' } })
    expect(r?.kind === 'response' && r.response.lines).toHaveLength(3)
    expect(r?.next).toBe(next.length)
  })

  it('parçalı büyük liste doğru okunur', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => `"s${i}"\r\n`).join('')
    const { c } = await session({ intercept: (l) => (l === 'LISTSCRIPTS' ? `${rows}OK "x"\r\n` : undefined) })
    expect(await c.listScripts()).toHaveLength(2000)
  })

  it('auth failure', async () => {
    const s = await fake({ failAuth: true })
    const c = await open(s)
    const e = await fails(c.authenticate(CRED))
    expect(e.authenticationFailed).toBe(true)
    expect(e.phase).toBe('auth')
    expect(sieveFailureKind(e)).toBe('auth')
    expect(classifyError(e)).toBe('auth')
  })

  it('no secret in errors', async () => {
    const s = await fake({ failAuth: true, echoAuthPayload: true })
    const c = await open(s)
    const e = await fails(c.authenticate(CRED))
    const payload = Buffer.from(`\0a@t.test\0${PASSWORD}`).toString('base64')
    expect(e.message).not.toContain(PASSWORD)
    expect(e.message).not.toContain(payload)
    expect(JSON.stringify({ ...e, m: e.message })).not.toContain(payload)
  })

  it('auth sırasında BYE de sır sızdırmaz', async () => {
    const payload = Buffer.from(`\0a@t.test\0${PASSWORD}`).toString('base64')
    const s = await fake({ intercept: (l) => (l.startsWith('AUTHENTICATE') ? `BYE "kapandi ${payload}"\r\n` : undefined) })
    const c = await open(s)
    const e = await fails(c.authenticate(CRED))
    expect(e.message).not.toContain(payload)
    expect((await fails(c.listScripts())).message).not.toContain(payload)
  })

  it('trylater maps to limit', async () => {
    const s = await fake({ intercept: (l) => (l.startsWith('AUTHENTICATE') ? 'NO (TRYLATER) "busy"\r\n' : undefined) })
    const c = await open(s)
    const e = await fails(c.authenticate(CRED))
    expect(e.code).toBe('TRYLATER')
    expect(e.authenticationFailed).toBe(false)
    expect(sieveFailureKind(e)).toBe('limit')
  })

  it('closed port returns unreachable', async () => {
    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const port = (probe.address() as AddressInfo).port
    await new Promise((r) => probe.close(r))
    const e = await fails(ManageSieveClient.connect({ host: '127.0.0.1', port, tls: 'starttls', rejectUnauthorized: true }))
    expect(e.phase).toBe('connect')
    const kind = sieveFailureKind(e)
    expect(kind).toBe('unreachable')
    // governor türü değildir: onLoginFailure'a verilemez
    const asGovernor = kind as LoginFailureKind
    expect((['auth', 'limit', 'preauth', 'net', 'other'] as LoginFailureKind[]).includes(asGovernor)).toBe(false)
  })

  it('karşılamadan sonra kopan bağlantı preauth sayılır', async () => {
    const srv = createServer((sock) => sock.destroy())
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const e = await fails(ManageSieveClient.connect({ host: '127.0.0.1', port: (srv.address() as AddressInfo).port, tls: 'starttls', rejectUnauthorized: true }))
    await new Promise((r) => srv.close(r))
    expect(e.phase).toBe('connect')
    expect(sieveFailureKind(e)).toBe('preauth')
  })

  it('oturumda kopan bağlantı net sayılır', async () => {
    const { c } = await session({ intercept: (l) => (l === 'LISTSCRIPTS' ? null : undefined) })
    const pending = fails(c.listScripts())
    await servers[0].close()
    const e = await pending
    expect(e.phase).toBe('command')
    expect(sieveFailureKind(e)).toBe('net')
  })

  it('bilinmeyen hata sınıflandırıcıya gider', () => {
    expect(sieveFailureKind(new Error('Invalid credentials'))).toBe('auth')
  })

  it('invalid cert rejected', async () => {
    const s = await fake()
    const e = await fails(open(s, { rejectUnauthorized: true }))
    expect(e.phase).toBe('tls')
    expect(s.commands).toEqual(['STARTTLS'])
    const implicit = await fake({ tls: 'implicit' })
    const e2 = await fails(open(implicit, { tls: 'tls', rejectUnauthorized: true }))
    expect(e2.phase).toBe('tls')
    expect(sieveFailureKind(e2)).toBe('other')
  })

  it('güvenilen sertifikada ad uyuşmazlığı reddedilir', async () => {
    const s = await fake()
    const good = await open(s, { rejectUnauthorized: true, ca: cert.cert, servername: 'sieve.fake.test' })
    expect(good.caps.sasl).toEqual(['PLAIN'])
    const e = await fails(open(s, { rejectUnauthorized: true, ca: cert.cert, servername: 'baska.ad.test' }))
    expect(e.phase).toBe('tls')
    expect(e.transport).toBeNull()
    expect(e.message).toMatch(/altnames|does not match/i)
  })

  it('allow invalid cert', async () => {
    const s = await fake()
    const c = await open(s, { rejectUnauthorized: false })
    expect(c.caps.sasl).toEqual(['PLAIN'])
  })

  it('betik komutları', async () => {
    const { s, c } = await session()
    await c.putScript('geckomail-rules', 'keep;')
    await c.putScript('b"ş', 'stop;')
    expect(await c.listScripts()).toEqual([{ name: 'geckomail-rules', active: false }, { name: 'b"ş', active: false }])
    await c.setActive('geckomail-rules')
    expect(s.active).toBe('geckomail-rules')
    expect((await c.listScripts())[0].active).toBe(true)
    await c.setActive('')
    expect(s.active).toBeNull()
    expect(s.commands).toContain('SETACTIVE ""')
    await c.deleteScript('geckomail-rules')
    expect([...s.scripts.keys()]).toEqual(['b"ş'])
    await c.logout()
  })

  it('literal adlı betik listelenir', async () => {
    const { c } = await session({ intercept: (l) => (l === 'LISTSCRIPTS' ? '{3}\r\nabc ACTIVE\r\n"d"\r\nOK\r\n' : undefined) })
    expect(await c.listScripts()).toEqual([{ name: 'abc', active: true }, { name: 'd', active: false }])
  })

  it('literal roundtrip', async () => {
    const { s, c } = await session()
    const text = '# Şeker güzel\r\nkeep; # ığüşöç 🦎\r\n'
    await c.putScript('x', text)
    expect(s.scripts.get('x')).toBe(text)
    expect(s.commands).toContain(`PUTSCRIPT "x" {${Buffer.byteLength(text)}+}`)
    expect(await c.getScript('x')).toBe(text)
  })

  it('satır sonu içeren ad komut enjeksiyonu yapamaz', async () => {
    const { s, c } = await session()
    await expect(c.getScript('x"\r\nDELETESCRIPT "y')).rejects.toThrow()
    expect(s.commands.some((x) => x.startsWith('DELETESCRIPT'))).toBe(false)
  })

  it('response caps', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61)
    const { s, c } = await session({ intercept: (l) => (l.startsWith('GETSCRIPT') ? Buffer.concat([Buffer.from(`{${big.length}}\r\n`), big, Buffer.from('\r\nOK\r\n')]) : undefined) })
    const e = await fails(c.getScript('x'))
    expect(e).toBeInstanceOf(ManageSieveError)
    await expect.poll(() => s.closed).toBe(1)
    await fails(c.listScripts())
  })

  it('64 KiB aşan satır reddedilir', async () => {
    const { s, c } = await session({ intercept: (l) => (l === 'LISTSCRIPTS' ? `"${'a'.repeat(70 * 1024)}"\r\nOK\r\n` : undefined) })
    await fails(c.listScripts())
    await expect.poll(() => s.closed).toBe(1)
  })

  it('timeout', async () => {
    const silent = await fake({ silent: true })
    const e = await fails(open(silent, { timeoutMs: 80 }))
    expect(e.phase).toBe('connect')
    const { c } = await session({ intercept: (l) => (l === 'LISTSCRIPTS' ? null : undefined) }, { timeoutMs: 80 })
    const e2 = await fails(c.listScripts())
    expect(e2.phase).toBe('command')
  })

  it('checkscript ok and warning', async () => {
    const { c } = await session({ checkScript: (t) => (t.includes('uyari') ? { ok: true, warning: 'line 2: deprecated' } : { ok: true }) })
    expect(await c.checkScript('keep;')).toEqual({ ok: true })
    expect(await c.checkScript('uyari;')).toEqual({ ok: true, warning: 'line 2: deprecated' })
  })

  describe('CHECKSCRIPT olmayan sunucu', () => {
    it('uyarı başarıdır, geçici betik silinir', async () => {
      const { s, c } = await session({ version: null, putWarning: 'eski sözdizimi' })
      expect(await c.checkScript('keep;')).toEqual({ ok: true, warning: 'eski sözdizimi' })
      expect(s.scripts.size).toBe(0)
    })

    it('var olan geckomail-check betiğine dokunulmaz', async () => {
      const { s, c } = await session({ version: null })
      s.scripts.set('geckomail-check', 'kullanıcının;')
      s.scripts.set('geckomail-check-2', 'bu da;')
      expect(await c.checkScript('keep;')).toEqual({ ok: true })
      expect(s.scripts.get('geckomail-check')).toBe('kullanıcının;')
      expect(s.scripts.get('geckomail-check-2')).toBe('bu da;')
      expect(s.scripts.size).toBe(2)
      expect(s.commands.filter((x) => /^(PUTSCRIPT|DELETESCRIPT)/.test(x)).every((x) => x.includes('"geckomail-check-3"'))).toBe(true)
    })

    it('betik reddi hata metniyle döner', async () => {
      const { c } = await session({ version: null, checkScript: () => ({ ok: false, error: 'line 1: bad' }) })
      expect(await c.checkScript('x')).toEqual({ ok: false, error: 'line 1: bad' })
    })
  })

  it('checkscript failure', async () => {
    const { s, c } = await session({ checkScript: () => ({ ok: false, error: 'line 3: unknown command' }) })
    expect(await c.checkScript('bad')).toEqual({ ok: false, error: 'line 3: unknown command' })
    expect(s.commands.at(-1)).toBe('CHECKSCRIPT {3+}')
  })

  it('checkscript hata metni literal olabilir ve 300 karakterle sınırlıdır', async () => {
    const long = 'x'.repeat(500)
    const { c } = await session({ intercept: (l) => (l.startsWith('CHECKSCRIPT') ? `NO {${long.length}}\r\n${long}\r\n` : undefined) })
    const r = await c.checkScript('bad')
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toHaveLength(300)
  })

  it('CHECKSCRIPT olmayan eski sunucuda geçici betikle denetlenir', async () => {
    const { s, c } = await session({ version: null, checkScript: (t) => (t === 'bad' ? { ok: false, error: 'line 1: nope' } : { ok: true }) })
    expect(await c.checkScript('keep;')).toEqual({ ok: true })
    expect(s.scripts.has('geckomail-check')).toBe(false)
    expect(s.commands.filter((x) => x.startsWith('DELETESCRIPT'))).toEqual(['DELETESCRIPT "geckomail-check"'])
    expect(await c.checkScript('bad')).toEqual({ ok: false, error: 'line 1: nope' })
    expect(s.commands.some((x) => x.startsWith('CHECKSCRIPT'))).toBe(false)
  })

  it('quota codes', async () => {
    const { c } = await session({ maxScripts: 1 })
    await c.putScript('a', 'keep;')
    expect(await c.haveSpace('a', 10)).toBe(true)
    expect(await c.haveSpace('b', 10)).toBe(false)
    const e = await fails(c.putScript('b', 'keep;'))
    expect(e.code).toBe('QUOTA/MAXSCRIPTS')
    expect(e.phase).toBe('command')
    expect(sieveFailureKind(e)).toBe('other')
  })

  it('yanıt kodları ayrışır', async () => {
    const { c } = await session()
    expect((await fails(c.getScript('yok'))).code).toBe('NONEXISTENT')
    await c.putScript('a', 'keep;')
    await c.setActive('a')
    expect((await fails(c.deleteScript('a'))).code).toBe('ACTIVE')
  })

  it('referral not followed', async () => {
    const other = await fake()
    const s = await fake({ intercept: (l) => (l.startsWith('AUTHENTICATE') ? `NO (REFERRAL "sieve://127.0.0.1:${other.port}") "gidin"\r\n` : undefined) })
    const c = await open(s)
    const e = await fails(c.authenticate(CRED))
    expect(e.code).toBe('REFERRAL')
    expect(e.authenticationFailed).toBe(false)
    expect(other.connections).toBe(0)
  })

  it('BYE bağlantıyı bitirir', async () => {
    const { c } = await session({ intercept: (l) => (l === 'LISTSCRIPTS' ? 'BYE (TRYLATER) "shutting down"\r\n' : undefined) })
    const e = await fails(c.listScripts())
    expect(e.code).toBe('TRYLATER')
    await fails(c.listScripts())
  })

  it('logout soketi kapatır, hata atmaz', async () => {
    const { s, c } = await session()
    await c.logout()
    await expect.poll(() => s.closed).toBe(1)
    await c.logout()
    c.close()
  })

  it('assertManagedName', () => {
    expect(() => assertManagedName('roundcube')).toThrow()
    expect(() => assertManagedName('geckomail-rules-x')).toThrow()
    expect(() => assertManagedName('geckomail-check')).toThrow()
    expect(() => assertManagedName('geckomail-rules')).not.toThrow()
    expect(() => assertManagedName('geckomail-main')).not.toThrow()
  })
})
