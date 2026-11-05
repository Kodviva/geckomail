import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuleAction, RuleCondition } from '../../shared/rpc'
import { randomBytes } from 'crypto'
import { t } from '../../shared/i18n'
import { SIEVE_RULES_SCRIPT as RULES, SIEVE_VACATION_CONFLICT, SIEVE_WRAPPER_SCRIPT as WRAPPER, type SieveCapsInfo, type SieveVacation } from '../../shared/sieve'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { DEFAULT_LIMITS, HostGovernor } from '../net/hostGovernor'
import { clearDetectCache, type detectSieve } from '../sieve/detect'
import { generateEmptyRules, generateWrapper, parseManagedHeader } from '../sieve/generate'
import { ManageSieveClient, ManageSieveError } from '../sieve/manageSieve'
import { SieveManager, type SieveManagerDeps } from '../sieve/manager'
import { setVaultKey } from '../vault/state'
import { makeTestCert, startFakeManageSieve, type FakeSieve, type FakeSieveOptions, type TestCert } from './helpers/fakeManageSieve'

const EXT = ['fileinto', 'imap4flags', 'mailbox', 'include', 'vacation']
const USER_SCRIPT = 'require "fileinto";\r\n# Şeker kuralı\r\nif header :contains "subject" "x" { fileinto "Y"; }\r\n'
const SECRET = 'cok-gizli-parola'
const MOVE: RuleAction[] = [{ type: 'move', folderName: 'Raporlar' }]
const VAC: SieveVacation = { enabled: true, subject: 'İzindeyim', body: 'Dönünce yazarım', days: 3, startDate: null, endDate: null }

const capsOf = (sieve: string[]): SieveCapsInfo => ({ implementation: 'x', version: '1.0', sasl: ['PLAIN'], sieve, maxRedirects: null })
const writes = (s: FakeSieve) => s.commands.filter((c) => /^(PUTSCRIPT|DELETESCRIPT)/.test(c))
const commandsFor = (s: FakeSieve, verb: string) => s.commands.filter((c) => c.startsWith(verb))

describe('SieveManager', () => {
  let cert: TestCert
  let dir: string
  let db: ReturnType<typeof openDb>
  let q: ReturnType<typeof makeQueries>
  let acc: number
  let gov: HostGovernor
  let clock: number
  let tickMs: number
  let gate: string | null
  let creds: Map<number, string>
  let managers: SieveManager[]
  let states: number[]
  const servers: FakeSieve[] = []
  const sieveCooldown = vi.fn()
  const sieveLoginOk = vi.fn()

  beforeAll(() => {
    cert = makeTestCert()
  })
  beforeEach(() => {
    clearDetectCache()
    sieveCooldown.mockClear()
    sieveLoginOk.mockClear()
    dir = mkdtempSync(join(tmpdir(), 'gecko-sm-'))
    db = openDb(dir)
    q = makeQueries(db)
    clock = 1_000_000
    tickMs = 1000 // governor her sorguda saati ilerletir: login'ler arası en kısa boşluğa takılmasın
    gate = null
    gov = new HostGovernor('127.0.0.1', DEFAULT_LIMITS, () => (clock += tickMs))
    creds = new Map()
    managers = []
    states = []
    acc = account('a@t.test')
    q.upsertFolder(acc, 'INBOX', 'inbox', false)
    q.upsertFolder(acc, 'Raporlar', 'other', false)
  })
  afterEach(async () => {
    managers.forEach((m) => m.stop())
    await Promise.all(servers.splice(0).map((s) => s.close()))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function account(email: string): number {
    const id = q.insertAccount({ email, displayName: null, imapHost: '127.0.0.1', imapPort: 993, smtpHost: '127.0.0.1', smtpPort: 465, passwordEnc: Buffer.from('x') })
    q.updateAccountFields(id, { allow_invalid_certs: 1 })
    creds.set(id, SECRET)
    return id
  }
  const fake = async (o: Partial<FakeSieveOptions> = {}): Promise<FakeSieve> => {
    const s = await startFakeManageSieve({ tls: 'starttls', cert, sasl: ['PLAIN'], extensions: EXT, ...o })
    servers.push(s)
    return s
  }
  const enable = (id: number, s: Pick<FakeSieve, 'port'>, ext = EXT): void => {
    q.upsertSieveAccount(id, { enabled: 1, state: 'pending', port: s.port, tls: 'starttls', caps_json: JSON.stringify(capsOf(ext)), caps_at: clock }, clock)
  }
  const addRule = (conditions: RuleCondition = { senderContains: 'a' }, actions: RuleAction[] = MOVE) =>
    q.insertRule({ name: `r${Math.random()}`, accountId: null, groupId: null, conditions, actions })
  const manager = (o: Partial<SieveManagerDeps> = {}): SieveManager => {
    const m = new SieveManager({
      q, creds,
      scheduler: { governorFor: () => gov, sieveLoginGate: () => gate, sieveCooldown, sieveLoginOk },
      now: () => clock, onState: (id) => states.push(id), debounceMs: 10, ...o
    })
    managers.push(m)
    return m
  }
  const row = (id = acc) => q.getSieveAccount(id)!
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const expectForeignUntouched = (s: FakeSieve, name: string, text: string): void => {
    expect(s.scripts.get(name)).toBe(text)
    expect(writes(s).filter((c) => c.includes(`"${name}"`))).toEqual([])
  }

  describe('dağıtım', () => {
    it('no active activates rules', async () => {
      const s = await fake()
      enable(acc, s)
      addRule()
      const info = await manager().deployNow(acc)
      expect(info).toMatchObject({ state: 'active', detail: null })
      expect(s.active).toBe(RULES)
      expect(parseManagedHeader(s.scripts.get(RULES)!)).toEqual({ kind: 'rules', valid: true })
      expect(row()).toMatchObject({ state: 'active', watched_json: '["Raporlar"]', wrapper_of: null })
      expect(row().script_hash).toHaveLength(64)
      expect(row().deployed_at).toBeGreaterThan(0)
      expect(commandsFor(s, 'LOGOUT')).toHaveLength(1)
      await vi.waitFor(() => expect(s.closed).toBe(s.connections))
      expect(q.loginStats(0)).toEqual([{ host: '127.0.0.1', result: 'ok', n: 1 }])
      expect(states).toContain(acc)
    })

    it('VERSION yoksa denetim için geçici betik yüklenmez', async () => {
      const s = await fake({ version: null })
      s.scripts.set('kullanici', USER_SCRIPT)
      s.active = 'kullanici'
      enable(acc, s)
      addRule()
      expect((await manager().consent(acc, 'kullanici')).state).toBe('active')
      expect(commandsFor(s, 'PUTSCRIPT').map((c) => /"([^"]+)"/.exec(c)![1])).toEqual([RULES, WRAPPER])
      expect(commandsFor(s, 'CHECKSCRIPT')).toEqual([])
      expect(commandsFor(s, 'DELETESCRIPT')).toEqual([])
    })

    it('etkin kendi betiğimiz: yerinde değişir, SETACTIVE yok', async () => {
      const s = await fake()
      enable(acc, s)
      const m = manager()
      addRule()
      await m.deployNow(acc)
      const first = s.scripts.get(RULES)
      addRule({ senderContains: 'b' }, [{ type: 'flag' }])
      s.commands.length = 0
      expect((await m.deployNow(acc)).state).toBe('active')
      expect(s.scripts.get(RULES)).not.toBe(first)
      expect(commandsFor(s, 'SETACTIVE')).toEqual([])
    })

    it('hash unchanged no connection', async () => {
      const s = await fake()
      enable(acc, s)
      const connect = vi.fn(ManageSieveClient.connect.bind(ManageSieveClient))
      const m = manager({ connect })
      addRule()
      await m.deployNow(acc)
      expect(connect).toHaveBeenCalledTimes(1)
      await m.deployNow(acc)
      expect(connect).toHaveBeenCalledTimes(1)
    })

    it('yetenek yoksa algılanır, giriş sonrası liste üretimi belirler', async () => {
      const s = await fake({ extensions: ['fileinto'] })
      q.upsertSieveAccount(acc, { enabled: 1, port: s.port }, clock)
      addRule()
      expect((await manager().deployNow(acc)).state).toBe('active')
      expect(row().tls).toBe('starttls')
      expect(JSON.parse(row().caps_json!).sieve).toEqual(['fileinto'])
      expect(s.scripts.get(RULES)).toContain('fileinto')
    })

    it('kapalı hesap, unsupported ve kapı bağlantı açmaz', async () => {
      const connect = vi.fn()
      const m = manager({ connect })
      expect((await m.deployNow(acc)).enabled).toBe(false)
      enable(acc, { port: 1 })
      q.upsertSieveAccount(acc, { state: 'unsupported' }, clock)
      expect((await m.deployNow(acc)).state).toBe('unsupported')
      expect(connect).not.toHaveBeenCalled()
    })

    it('kapı kapalıysa pending', async () => {
      const connect = vi.fn()
      enable(acc, { port: 1 })
      gate = 'parola yok'
      expect(await manager({ connect }).deployNow(acc)).toMatchObject({ state: 'pending', detail: 'parola yok' })
      expect(connect).not.toHaveBeenCalled()
    })

    it('locked vault pending', async () => {
      const s = await fake()
      enable(acc, s)
      addRule()
      creds.delete(acc)
      const connect = vi.fn(ManageSieveClient.connect.bind(ManageSieveClient))
      const m = manager({ connect })
      gate = 'kilitli'
      expect((await m.deployNow(acc)).state).toBe('pending')
      expect(connect).not.toHaveBeenCalled()
      gate = null
      creds.set(acc, SECRET)
      m.onCredentialsChanged(acc)
      await vi.waitFor(() => expect(row().state).toBe('active'))
    })

    it('kasa kilitliyse tatil okunamaz: bağlantı yok, pending', async () => {
      enable(acc, { port: 1 })
      const connect = vi.fn()
      vi.spyOn(q, 'getSieveVacation').mockImplementation(() => {
        throw new Error('kilitli')
      })
      expect((await manager({ connect }).deployNow(acc)).state).toBe('pending')
      expect(connect).not.toHaveBeenCalled()
    })

    it('30s debounce', async () => {
      const s = await fake()
      enable(acc, s)
      addRule()
      const m = manager({ debounceMs: 20 })
      for (let i = 0; i < 10; i++) m.schedule(acc)
      await vi.waitFor(() => expect(row().state).toBe('active'))
      await wait(40)
      expect(s.connections).toBe(1)
    })

    it('schedule ve scheduleAll kapalı hesabı atlar', async () => {
      const s = await fake()
      enable(acc, s)
      addRule()
      const off = account('b@t.test')
      q.upsertSieveAccount(off, { enabled: 0, port: s.port }, clock)
      const m = manager()
      const deploy = vi.spyOn(m, 'deployNow')
      m.schedule(off)
      m.scheduleAll()
      await vi.waitFor(() => expect(deploy).toHaveBeenCalled())
      await wait(20)
      expect(deploy.mock.calls.map((c) => c[0])).toEqual([acc])
    })

    it('stop bekleyen zamanlayıcıyı siler', async () => {
      const s = await fake()
      enable(acc, s)
      const m = manager()
      m.schedule(acc)
      m.stop()
      await wait(30)
      expect(s.connections).toBe(0)
    })

    it('aynı hesapta işler sıralı', async () => {
      const s = await fake()
      enable(acc, s)
      addRule()
      const m = manager()
      await Promise.all([m.deployNow(acc), m.deployNow(acc), m.deployNow(acc)])
      expect(s.connections).toBe(1)
    })
  })

  describe('K22 boş betik', () => {
    it('hiç dağıtılmamış hesapta bağlantı açılmaz', async () => {
      const connect = vi.fn()
      enable(acc, { port: 1 })
      expect(await manager({ connect }).deployNow(acc)).toMatchObject({ state: 'active', deployedAt: null, scriptHash: null })
      expect(connect).not.toHaveBeenCalled()
    })

    it('dağıtılmışsa yalnız başlık yazılır, etkin durum korunur', async () => {
      const s = await fake()
      enable(acc, s)
      const id = addRule()
      const m = manager()
      await m.deployNow(acc)
      q.deleteRule(id)
      expect((await m.deployNow(acc)).state).toBe('active')
      expect(s.scripts.get(RULES)).toBe(generateEmptyRules().text)
      expect(s.active).toBe(RULES)
      expect(row()).toMatchObject({ script_hash: generateEmptyRules().hash, watched_json: '[]' })
      s.commands.length = 0
      const conns = s.connections
      await m.deployNow(acc)
      expect(s.connections).toBe(conns)
    })

    it('sarmalayıcı ve onay korunur', async () => {
      const s = await fake()
      s.scripts.set('kullanici', USER_SCRIPT)
      s.active = 'kullanici'
      enable(acc, s)
      q.upsertSieveAccount(acc, { consent_script: 'kullanici' }, clock)
      const id = addRule()
      const m = manager()
      await m.deployNow(acc)
      q.deleteRule(id)
      await m.deployNow(acc)
      expect(s.active).toBe(WRAPPER)
      expect(row()).toMatchObject({ consent_script: 'kullanici', wrapper_of: 'kullanici', state: 'active' })
    })
  })

  describe('kullanıcı betiğiyle birlikte yaşama', () => {
    it('needs consent: hiçbir yazma yok, ad satırda', async () => {
      const s = await fake()
      s.scripts.set('kullanici', USER_SCRIPT)
      s.active = 'kullanici'
      enable(acc, s)
      addRule()
      const info = await manager().deployNow(acc)
      expect(info).toMatchObject({ state: 'needs_consent', consentNeededFor: 'kullanici' })
      expect(writes(s)).toEqual([])
      expect(commandsFor(s, 'SETACTIVE')).toEqual([])
      expect(commandsFor(s, 'LOGOUT')).toHaveLength(1)
    })

    it('wrapper keeps user script bytes', async () => {
      const s = await fake()
      s.scripts.set('kullanici', USER_SCRIPT)
      s.active = 'kullanici'
      enable(acc, s)
      addRule()
      const info = await manager().consent(acc, 'kullanici')
      expect(info).toMatchObject({ state: 'active', wrapperOf: 'kullanici' })
      expect(s.active).toBe(WRAPPER)
      expect(s.scripts.get(WRAPPER)).toContain('include :personal "kullanici";')
      expectForeignUntouched(s, 'kullanici', USER_SCRIPT)
    })

    it('consent bound to name', async () => {
      const s = await fake()
      s.scripts.set('yeni', USER_SCRIPT)
      s.active = 'yeni'
      enable(acc, s)
      addRule()
      expect(await manager().consent(acc, 'eski')).toMatchObject({ state: 'needs_consent', consentNeededFor: 'yeni' })
      expect(s.scripts.has(WRAPPER)).toBe(false)
      expect(s.active).toBe('yeni')
    })

    it('include yok ya da kullanıcı include kullanıyor: yazma yok', async () => {
      const a = await fake({ extensions: ['fileinto'] })
      a.scripts.set('kullanici', USER_SCRIPT)
      a.active = 'kullanici'
      enable(acc, a, ['fileinto'])
      addRule()
      expect((await manager().consent(acc, 'kullanici')).state).toBe('blocked_no_include')
      expect(writes(a)).toEqual([])

      const b = await fake()
      const inc = 'require "include";\r\ninclude "y";\r\n'
      b.scripts.set('kullanici', inc)
      b.active = 'kullanici'
      const other = account('b@t.test')
      enable(other, b)
      expect((await manager().consent(other, 'kullanici')).state).toBe('blocked_user_include')
      expect(writes(b)).toEqual([])
    })

    it('başlıksız aynı ad conflict, elle düzenlenmiş drift: üzerine yazılmaz', async () => {
      const a = await fake()
      a.scripts.set(RULES, 'keep;\r\n')
      enable(acc, a)
      addRule()
      expect((await manager().deployNow(acc)).state).toBe('conflict')
      expect(a.scripts.get(RULES)).toBe('keep;\r\n')

      const b = await fake()
      const drifted = `${generateEmptyRules().text}# elle\r\n`
      b.scripts.set(RULES, drifted)
      const other = account('b@t.test')
      enable(other, b)
      expect((await manager().deployNow(other)).state).toBe('drift')
      expect(b.scripts.get(RULES)).toBe(drifted)
      expect(writes(b)).toEqual([])
    })

    it('başka cihazın betiği başlıkla sahiplenilir', async () => {
      const s = await fake()
      s.scripts.set(RULES, generateEmptyRules().text)
      s.active = RULES
      enable(acc, s)
      addRule()
      expect((await manager().deployNow(acc)).state).toBe('active')
      expect(commandsFor(s, 'PUTSCRIPT')).toHaveLength(1)
    })

    it('sarmalayıcı kuruluyken başka betik etkinleşirse displaced, yeniden onayla döner', async () => {
      const s = await fake()
      s.scripts.set('kullanici', USER_SCRIPT)
      s.active = 'kullanici'
      enable(acc, s)
      addRule()
      const m = manager()
      await m.consent(acc, 'kullanici')
      s.scripts.set('diger', USER_SCRIPT)
      s.active = 'diger'
      addRule({ senderContains: 'b' }, [{ type: 'flag' }])
      expect((await m.deployNow(acc)).state).toBe('displaced')
      expect(s.active).toBe('diger')
      expect(await m.consent(acc, 'diger')).toMatchObject({ state: 'active', wrapperOf: 'diger' })
      expect(s.active).toBe(WRAPPER)
      expectForeignUntouched(s, 'diger', USER_SCRIPT)
    })

    it('wrapper survives deleted user script', async () => {
      const s = await fake()
      s.scripts.set('kullanici', USER_SCRIPT)
      s.active = 'kullanici'
      enable(acc, s)
      q.upsertSieveAccount(acc, { consent_script: 'kullanici' }, clock)
      addRule()
      const m = manager()
      await m.deployNow(acc)
      s.scripts.delete('kullanici')
      addRule({ senderContains: 'b' }, [{ type: 'flag' }])
      expect((await m.deployNow(acc)).state).toBe('active')
      expect(s.active).toBe(WRAPPER)
      expect(s.scripts.get(WRAPPER)).not.toContain(':optional')
      expect(s.scripts.get(RULES)).toContain('addflag')
    })

    it('partial failure idempotent', async () => {
      let fail = true
      const s = await fake({ intercept: (l) => (fail && l.startsWith('SETACTIVE') ? 'NO "geçici"\r\n' : undefined) })
      s.scripts.set('kullanici', USER_SCRIPT)
      s.active = 'kullanici'
      enable(acc, s)
      addRule()
      const m = manager()
      expect((await m.consent(acc, 'kullanici')).state).toBe('error')
      expect(s.active).toBe('kullanici')
      expect(s.scripts.has(WRAPPER)).toBe(true)
      fail = false
      expect((await m.deployNow(acc)).state).toBe('active')
      expect(s.active).toBe(WRAPPER)
      expect([...s.scripts.keys()].filter((n) => n === WRAPPER)).toHaveLength(1)
      expectForeignUntouched(s, 'kullanici', USER_SCRIPT)
    })

    it('single active only', async () => {
      const s = await fake()
      s.scripts.set('kullanici', USER_SCRIPT)
      s.active = 'kullanici'
      enable(acc, s)
      addRule()
      await manager().consent(acc, 'kullanici')
      expect(commandsFor(s, 'SETACTIVE')).toEqual([`SETACTIVE "${WRAPPER}"`])
    })

    it('never writes foreign script', async () => {
      // bütün kollar: onaysız, onaylı, kaldırılmış, kapalı, geri alma
      const s = await fake()
      s.scripts.set('kullanici', USER_SCRIPT)
      s.active = 'kullanici'
      s.scripts.set('duran', USER_SCRIPT)
      enable(acc, s)
      addRule()
      const m = manager()
      await m.deployNow(acc)
      await m.consent(acc, 'kullanici')
      addRule({ senderContains: 'b' }, [{ type: 'flag' }])
      await m.deployNow(acc)
      await m.rollback(acc)
      for (const name of ['kullanici', 'duran']) expectForeignUntouched(s, name, USER_SCRIPT)
      for (const c of writes(s)) expect(c).toMatch(new RegExp(`"(${RULES}|${WRAPPER})"`))
    })
  })

  describe('hatalar', () => {
    it('auth failure single attempt', async () => {
      const s = await fake({ failAuth: true })
      enable(acc, s)
      addRule()
      const failure = vi.spyOn(gov, 'onLoginFailure')
      const onAuthFailure = vi.fn()
      const m = manager()
      Object.assign(m, { onAuthFailure })
      const first = await m.deployNow(acc)
      expect(first.state).toBe('auth_failed')
      expect(first.detail).not.toContain(SECRET)
      expect(failure.mock.calls).toEqual([['auth']])
      expect(q.loginStats(0)).toEqual([{ host: '127.0.0.1', result: 'auth', n: 1 }])
      await m.deployNow(acc)
      await m.deployNow(acc)
      expect(s.connections).toBe(1)
      expect(onAuthFailure).not.toHaveBeenCalled()

      gov.onLoginSuccess()
      vi.spyOn(gov, 'authBudgetWait').mockReturnValue(0)
      creds.set(acc, 'yeni')
      m.onCredentialsChanged(acc)
      await vi.waitFor(() => expect(s.connections).toBe(2))
    })

    it('bulk enable respects governor', async () => {
      tickMs = 0
      const ids = [acc, ...Array.from({ length: 19 }, (_, i) => account(`u${i}@t.test`))]
      addRule()
      const connect = vi.fn(async () => stubClient())
      const take = vi.spyOn(gov, 'tryTakeLogin')
      const detect = vi.fn(async () => ({ supported: true, tls: 'starttls' as const, caps: capsOf(EXT), reason: null }))
      const m = manager({ connect, detect })
      const infos: { state: string }[] = []
      for (const id of ids) {
        q.upsertSieveAccount(id, { port: 4190 }, clock)
        infos.push(await m.setEnabled(id, true))
        clock += 400
      }
      // 20 hesap ~8 sn: kova 4 başlar, dakikada 8 dolar, arka plan son jetonu alamaz
      expect(take).toHaveBeenCalledTimes(20)
      expect(connect.mock.calls.length).toBeLessThanOrEqual(DEFAULT_LIMITS.loginBurst)
      expect(infos.filter((i) => i.state === 'pending').length).toBe(20 - connect.mock.calls.length)
      expect(take.mock.calls.every((c) => c[0] === 'background')).toBe(true)
    })

    it('cooldown skips', async () => {
      const s = await fake()
      enable(acc, s)
      addRule()
      gov.onLoginFailure('limit')
      expect(gov.blockedFor()).toBeGreaterThan(0)
      expect((await manager().deployNow(acc)).state).toBe('pending')
      expect(s.connections).toBe(0)
    })

    it('soğumadaki ana makineye yoklama yok', async () => {
      const detect = vi.fn()
      q.upsertSieveAccount(acc, { enabled: 1 }, clock)
      gov.onLoginFailure('limit')
      const m = manager({ detect })
      await m.detect(acc, true)
      expect((await m.deployNow(acc)).state).toBe('pending')
      expect(detect).not.toHaveBeenCalled()
    })

    it('invalid script nothing deployed', async () => {
      const s = await fake({ checkScript: () => ({ ok: false, error: 'line 2: bad' }) })
      enable(acc, s)
      addRule()
      expect(await manager().deployNow(acc)).toMatchObject({ state: 'invalid', detail: 'line 2: bad' })
      expect(commandsFor(s, 'PUTSCRIPT')).toEqual([])
      expect(s.active).toBeNull()
    })

    it('PUTSCRIPT reddi de invalid', async () => {
      const s = await fake({ intercept: (l) => (l.startsWith('PUTSCRIPT') ? 'NO "syntax error"\r\n' : undefined) })
      enable(acc, s)
      addRule()
      expect((await manager().deployNow(acc)).state).toBe('invalid')
    })

    it('quota no retry', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const s = await fake({ maxScripts: 1 })
        s.scripts.set('kullanici', USER_SCRIPT)
        enable(acc, s)
        addRule()
        const info = await manager().deployNow(acc)
        expect(info.state).toBe('error')
        expect(commandsFor(s, 'PUTSCRIPT')).toEqual([])
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('kota kodlu PUTSCRIPT reddi yeniden denenmez', async () => {
      const connect = vi.fn(async () => stubClient({ put: new ManageSieveError('over', { phase: 'command', code: 'QUOTA/MAXSIZE' }) }))
      enable(acc, { port: 1 })
      addRule()
      const m = manager({ connect, debounceMs: 1 })
      expect((await m.deployNow(acc)).state).toBe('error')
      await wait(10)
      expect(connect).toHaveBeenCalledTimes(1)
    })

    it('ağ hatası governor türüyle bildirilir, geri çekilmeli yeniden denenir, en çok 5', async () => {
      const err = new ManageSieveError('lost', { phase: 'connect', transport: 'lost' })
      const connect = vi.fn(async () => {
        throw err
      })
      const delays: number[] = []
      const realSet = globalThis.setTimeout
      const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0)
        return realSet(fn, 0)
      }) as typeof setTimeout)
      try {
        const failure = vi.spyOn(gov, 'onLoginFailure').mockReturnValue(null)
        enable(acc, { port: 1 })
        addRule()
        const m = manager({ connect })
        await m.deployNow(acc)
        await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(6))
        expect(delays.filter((d) => d >= 60_000)).toEqual([5, 10, 20, 40, 60].map((n) => n * 60_000))
        expect(failure).toHaveBeenCalledWith('preauth')
        expect(row().state).toBe('error')
      } finally {
        spy.mockRestore()
      }
    })

    it('kapalı port governor saymaz', async () => {
      const err = new ManageSieveError('refused', { phase: 'connect', transport: 'no_tcp' })
      const failure = vi.spyOn(gov, 'onLoginFailure')
      enable(acc, { port: 1 })
      addRule()
      const m = manager({ connect: vi.fn(async () => { throw err }) })
      expect((await m.deployNow(acc)).state).toBe('error')
      expect(failure).not.toHaveBeenCalled()
    })

    it('no secret in rule_log', async () => {
      const content = 'gizli-kural-degeri'
      const s = await fake({ checkScript: (c) => ({ ok: false, error: `bad ${c.slice(0, 200)}` }) })
      enable(acc, s)
      addRule({ senderContains: content })
      await manager().deployNow(acc)
      const logs = db.prepare(`SELECT summary, error FROM rule_log`).all() as { summary: string; error: string | null }[]
      expect(logs.length).toBeGreaterThan(0)
      const blob = JSON.stringify(logs)
      for (const needle of [SECRET, content, 'geckomail v1']) expect(blob).not.toContain(needle)
    })

    it('başarılı dağıtım rule_log yazmaz', async () => {
      const s = await fake()
      enable(acc, s)
      addRule()
      await manager().deployNow(acc)
      expect(db.prepare(`SELECT COUNT(*) AS n FROM rule_log`).get()).toEqual({ n: 0 })
    })
  })

  describe('tatil', () => {
    it('sığmayan tatil ayrıntıda görünür, kurallar gider', async () => {
      const s = await fake()
      enable(acc, s)
      q.setSieveVacation(acc, VAC, clock)
      for (let i = 0; i < 1000; i++) addRule({ subjectContains: 'y'.repeat(100) + i }, [{ type: 'spam' }])
      q.upsertFolder(acc, 'Junk', 'junk', false)
      const m = manager()
      expect(await m.deployNow(acc)).toMatchObject({ state: 'active', detail: 'vacation_too_large' })
      const conns = s.connections
      await m.deployNow(acc)
      expect(s.connections).toBe(conns)
    })

    it('kurallardan bağımsız dağıtılır', async () => {
      const s = await fake()
      enable(acc, s)
      q.setSieveVacation(acc, VAC, clock)
      expect((await manager().deployNow(acc)).state).toBe('active')
      expect(s.scripts.get(RULES)).toContain('vacation :days 3')
    })

    it('vacation conflict blocks only vacation', async () => {
      const s = await fake()
      const script = 'require "vacation";\r\nvacation "yoktayim";\r\n'
      s.scripts.set('kullanici', script)
      s.active = 'kullanici'
      enable(acc, s)
      q.upsertSieveAccount(acc, { consent_script: 'kullanici' }, clock)
      q.setSieveVacation(acc, VAC, clock)
      addRule()
      const m = manager()
      expect(await m.deployNow(acc)).toMatchObject({ state: 'active', detail: 'vacation_conflict' })
      expect(s.scripts.get(RULES)).toContain('fileinto')
      expect(s.scripts.get(RULES)).not.toContain('vacation')
      expectForeignUntouched(s, 'kullanici', script)

      // yeniden dağıtımda da denetlenir: kullanıcı komutu kaldırınca tatil gelir
      s.scripts.set('kullanici', 'keep;\r\n')
      expect(await m.deployNow(acc, true)).toMatchObject({ state: 'active', detail: null })
      expect(s.scripts.get(RULES)).toContain('vacation')
    })

    it('tatil kapanınca çatışma ayrıntısı temizlenir', async () => {
      const s = await fake()
      s.scripts.set('kullanici', 'require "vacation";\r\nvacation "x";\r\n')
      s.active = 'kullanici'
      enable(acc, s)
      q.upsertSieveAccount(acc, { consent_script: 'kullanici' }, clock)
      q.setSieveVacation(acc, VAC, clock)
      addRule()
      const m = manager()
      await m.deployNow(acc)
      q.setSieveVacation(acc, { ...VAC, enabled: false }, clock)
      expect((await m.deployNow(acc)).detail).toBeNull()
    })
  })

  describe('rollback', () => {
    it('rollback restores exact active', async () => {
      const s = await fake()
      s.scripts.set('kullanici', USER_SCRIPT)
      s.active = 'kullanici'
      enable(acc, s)
      addRule()
      const m = manager()
      await m.consent(acc, 'kullanici')
      const info = await m.rollback(acc)
      expect(s.active).toBe('kullanici')
      expect([...s.scripts.keys()]).toEqual(['kullanici'])
      expect(info).toMatchObject({ enabled: false, state: 'off', wrapperOf: null, scriptHash: null })
      expect(row()).toMatchObject({ enabled: 0, watched_json: '[]', consent_script: null, deployed_at: null })
    })

    it('hiç etkin yokken SETACTIVE ""', async () => {
      const s = await fake()
      enable(acc, s)
      addRule()
      const m = manager()
      await m.deployNow(acc)
      await m.rollback(acc)
      expect(s.active).toBeNull()
      expect(commandsFor(s, 'SETACTIVE').at(-1)).toBe('SETACTIVE ""')
      expect(s.scripts.size).toBe(0)
    })

    it('satırda iz yoksa sarmalanan ad sarmalayıcıdan okunur', async () => {
      const s = await fake()
      s.scripts.set('kullanici', USER_SCRIPT)
      s.active = 'kullanici'
      enable(acc, s)
      addRule()
      const m = manager()
      await m.consent(acc, 'kullanici')
      q.upsertSieveAccount(acc, { wrapper_of: null }, clock)
      await m.rollback(acc)
      expect(s.active).toBe('kullanici')
    })

    it('sarmalanan betik silinmişse hepsi kapanır', async () => {
      const s = await fake()
      s.scripts.set('kullanici', USER_SCRIPT)
      s.active = 'kullanici'
      enable(acc, s)
      addRule()
      const m = manager()
      await m.consent(acc, 'kullanici')
      s.scripts.delete('kullanici')
      await m.rollback(acc)
      expect(s.active).toBeNull()
      expect(s.scripts.size).toBe(0)
    })

    it('drift betiği silinmez, etkin durumu değişmez', async () => {
      const s = await fake()
      const drifted = `${generateEmptyRules().text}# elle\r\n`
      s.scripts.set(RULES, drifted)
      s.active = RULES
      enable(acc, s)
      q.upsertSieveAccount(acc, { script_hash: 'x', state: 'drift' }, clock)
      await manager().rollback(acc)
      expect(s.scripts.get(RULES)).toBe(drifted)
      expect(s.active).toBe(RULES)
      expect(commandsFor(s, 'SETACTIVE')).toEqual([])
      expect(commandsFor(s, 'DELETESCRIPT')).toEqual([])
      expect(row()).toMatchObject({ enabled: 0, state: 'drift' })
    })

    it('elle düzenlenmiş sarmalayıcı etkinken kural betiği silinmez', async () => {
      const s = await fake()
      s.scripts.set('kullanici', USER_SCRIPT)
      s.active = 'kullanici'
      enable(acc, s)
      addRule()
      const m = manager()
      await m.consent(acc, 'kullanici')
      s.scripts.set(WRAPPER, `${s.scripts.get(WRAPPER)}# elle\r\n`)
      await m.rollback(acc)
      expect(s.active).toBe(WRAPPER)
      expect(s.scripts.has(RULES)).toBe(true)
    })

    it('etkin yabancıysa dokunulmaz, kendi betiklerimiz silinir', async () => {
      const s = await fake()
      s.scripts.set('kullanici', USER_SCRIPT)
      s.active = 'kullanici'
      enable(acc, s)
      addRule()
      const m = manager()
      await m.consent(acc, 'kullanici')
      s.scripts.set('diger', USER_SCRIPT)
      s.active = 'diger'
      await m.rollback(acc)
      expect(s.active).toBe('diger')
      expect([...s.scripts.keys()].sort()).toEqual(['diger', 'kullanici'])
      expect(commandsFor(s, 'SETACTIVE').filter((c) => c.includes('diger'))).toEqual([])
    })

    it('hiç yazılmamışsa bağlantı açılmaz', async () => {
      const connect = vi.fn()
      q.upsertSieveAccount(acc, { state: 'off' }, clock)
      expect(await manager({ connect }).rollback(acc)).toMatchObject({ state: 'off', enabled: false })
      expect(connect).not.toHaveBeenCalled()
    })

    it('sunucuya ulaşılamazsa satır kalır, yeniden dağıtım başlamaz', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const err = new ManageSieveError('refused', { phase: 'connect', transport: 'no_tcp' })
        enable(acc, { port: 1 })
        q.upsertSieveAccount(acc, { script_hash: 'h', state: 'active' }, clock)
        const info = await manager({ connect: vi.fn(async () => { throw err }) }).rollback(acc)
        expect(info).toMatchObject({ state: 'error', enabled: false, scriptHash: 'h' })
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('kapatma geri alır', async () => {
      const s = await fake()
      enable(acc, s)
      addRule()
      const m = manager()
      await m.deployNow(acc)
      expect(await m.setEnabled(acc, false)).toMatchObject({ enabled: false, state: 'off' })
      expect(s.scripts.size).toBe(0)
    })
  })

  describe('algılama ve yerleşim', () => {
    it('setEnabled algılar, dağıtır', async () => {
      const s = await fake()
      q.upsertSieveAccount(acc, { port: s.port }, clock)
      addRule()
      expect(await manager().setEnabled(acc, true)).toMatchObject({ enabled: true, state: 'active' })
      expect(row().caps_at).toBeGreaterThan(0)
    })

    it('desteklenmeyen sunucuda açılmaz', async () => {
      const detect = vi.fn(async () => ({ supported: false, tls: null, caps: null, reason: 'no_listener' as const }))
      expect(await manager({ detect }).setEnabled(acc, true)).toMatchObject({ enabled: false, state: 'unsupported', detail: 'no_listener' })
    })

    it('force algılayıcıya geçer, durum tazelenir', async () => {
      const detect = vi.fn<typeof detectSieve>(async () => ({ supported: true, tls: 'tls', caps: capsOf(EXT), reason: null }))
      q.upsertSieveAccount(acc, { state: 'unsupported' }, clock)
      const m = manager({ detect })
      const info = await m.detect(acc, true)
      expect(detect.mock.calls[0][1]).toMatchObject({ force: true })
      expect(detect.mock.calls[0][0]).toMatchObject({ host: '127.0.0.1', port: 4190, rejectUnauthorized: false })
      expect(info.state).toBe('off')
      expect(info.caps?.sieve).toEqual(EXT)
      expect(row().tls).toBe('tls')
      await m.detect(acc)
      expect(detect.mock.calls[1][1]).toMatchObject({ force: false })
    })

    it('ağ kesintisi desteklenmiyor sayılmaz', async () => {
      const detect = vi.fn<typeof detectSieve>(async () => ({ supported: false, tls: null, caps: null, reason: 'no_listener', transient: true }))
      expect(await manager({ detect }).setEnabled(acc, true)).toMatchObject({ enabled: true, state: 'pending' })
    })

    it('dağıtılmış hesapta geçici yoklama hatası durumu ezmez', async () => {
      const detect = vi.fn(async () => ({ supported: false, tls: null, caps: null, reason: 'no_listener' as const }))
      q.upsertSieveAccount(acc, { enabled: 1, state: 'active', script_hash: 'h' }, clock)
      expect((await manager({ detect }).detect(acc)).state).toBe('active')
    })

    it('placementFor bağlantı açmaz, kapalı hesapta sieve_off', async () => {
      const connect = vi.fn()
      const id = addRule()
      const m = manager({ connect })
      expect(m.placementFor(acc)).toMatchObject([{ ruleId: id, placement: 'client', reason: 'sieve_off' }])
      enable(acc, { port: 1 })
      q.upsertSieveAccount(acc, { state: 'active' }, clock)
      expect(m.placementFor(acc)).toMatchObject([{ ruleId: id, placement: 'server', reason: null, targetPath: 'Raporlar' }])
      expect(connect).not.toHaveBeenCalled()
    })

    it('placementFor kasa kilitliyken de çalışır', async () => {
      addRule()
      enable(acc, { port: 1 })
      q.upsertSieveAccount(acc, { state: 'active' }, clock)
      const spy = vi.spyOn(q, 'getSieveVacation')
      manager().placementFor(acc)
      expect(spy).not.toHaveBeenCalled()
    })
  })

  describe('withSession', () => {
    it('etkileşimli öncelikle iş yapar, oturumu kapatır', async () => {
      const s = await fake()
      enable(acc, s)
      s.scripts.set('kullanici', USER_SCRIPT)
      const take = vi.spyOn(gov, 'tryTakeLogin')
      const text = await manager().withSession(acc, 'interactive', (c) => c.getScript('kullanici'))
      expect(text).toBe(USER_SCRIPT)
      expect(take).toHaveBeenCalledWith('interactive', false)
      expect(commandsFor(s, 'LOGOUT')).toHaveLength(1)
    })

    it('izin yoksa bağlanmaz, auth_failed durumunda da', async () => {
      const connect = vi.fn()
      enable(acc, { port: 1 })
      const m = manager({ connect })
      q.upsertSieveAccount(acc, { state: 'auth_failed' }, clock)
      await expect(m.withSession(acc, 'interactive', async () => 1)).rejects.toThrow()
      q.upsertSieveAccount(acc, { state: 'active' }, clock)
      gov.onLoginFailure('limit')
      await expect(m.withSession(acc, 'interactive', async () => 1)).rejects.toThrow()
      expect(connect).not.toHaveBeenCalled()
    })
  })

  describe('inceleme düzeltmeleri', () => {
    const deployedWrapper = async (s: FakeSieve, m: SieveManager, name = 'roundcube'): Promise<void> => {
      s.scripts.set(name, USER_SCRIPT)
      s.active = name
      enable(acc, s)
      q.upsertSieveAccount(acc, { consent_script: name, consent_at: clock }, clock)
      addRule()
      await m.deployNow(acc)
      expect(s.active).toBe(WRAPPER)
    }

    it('endpoint change rolls back the old server and consent does not cross', async () => {
      const [s1, s2] = [await fake(), await fake()]
      const m = manager()
      await deployedWrapper(s1, m)
      s2.scripts.set('roundcube', USER_SCRIPT)
      s2.active = 'roundcube'
      await m.setEndpoint(acc, null, s2.port)
      expect(s1.active).toBe('roundcube')
      expect([...s1.scripts.keys()]).toEqual(['roundcube'])
      expect(row()).toMatchObject({ consent_script: null, consent_at: null, wrapper_of: null, script_hash: null, deployed_at: null, watched_json: '[]' })
      await vi.waitFor(() => expect(row().state).toBe('needs_consent'))
      expect(s2.active).toBe('roundcube')
      expect(s2.scripts.has(WRAPPER)).toBe(false)
    })

    it('endpoint change is refused while the old server cannot be reached', async () => {
      const s1 = await fake()
      const m = manager()
      await deployedWrapper(s1, m)
      await s1.close()
      const before = row()
      await expect(m.setEndpoint(acc, 'yeni.t.test', 4190)).rejects.toThrow()
      expect(row()).toMatchObject({ host: before.host, port: before.port, consent_script: 'roundcube', wrapper_of: 'roundcube', script_hash: before.script_hash })
    })

    it('account host change rolls back before the new host is written', async () => {
      const s1 = await fake()
      const m = manager()
      await deployedWrapper(s1, m)
      q.upsertSieveAccount(acc, { host: null }, clock)
      await m.prepareHostChange(acc)
      expect(s1.active).toBe('roundcube')
      m.onAccountHostChanged(acc)
      await vi.waitFor(() => expect(row()).toMatchObject({ consent_script: null, wrapper_of: null, script_hash: null }))
    })

    it('host change with an endpoint override leaves the server alone', async () => {
      const s1 = await fake()
      const m = manager()
      await deployedWrapper(s1, m)
      q.upsertSieveAccount(acc, { host: '127.0.0.1' }, clock)
      await m.prepareHostChange(acc)
      expect(s1.active).toBe(WRAPPER)
    })

    it('uniform rejection stops at the host budget', async () => {
      tickMs = 0
      const s = await fake({ failAuth: true })
      addRule()
      const ids = [acc, ...Array.from({ length: 19 }, (_, i) => account(`u${i}@t.test`))]
      const m = manager()
      const states: string[] = []
      for (const id of ids) {
        enable(id, s)
        states.push((await m.deployNow(id)).state)
        clock += 20_000
      }
      expect(s.commands.filter((c) => c.startsWith('AUTHENTICATE'))).toHaveLength(DEFAULT_LIMITS.authFailPerHour)
      expect(states.filter((x) => x === 'auth_failed')).toHaveLength(DEFAULT_LIMITS.authFailPerHour)
      expect(states.filter((x) => x === 'pending')).toHaveLength(ids.length - DEFAULT_LIMITS.authFailPerHour)
    })

    it('a sieve login, not IMAP, makes the account known good', async () => {
      const s = await fake()
      enable(acc, s)
      addRule()
      const take = vi.spyOn(gov, 'tryTakeLogin')
      const m = manager()
      await m.deployNow(acc, true)
      await m.deployNow(acc, true)
      expect(take.mock.calls.map((c) => c[1])).toEqual([false, true])
      m.onCredentialsChanged(acc)
      await m.deployNow(acc, true)
      expect(take.mock.calls[2][1]).toBe(false)
    })

    it('rollback finishes after a password fix', async () => {
      let reject = false
      const s = await fake({ intercept: (l) => (reject && l.startsWith('AUTHENTICATE') ? 'NO "kimlik"\r\n' : undefined) })
      const m = manager()
      enable(acc, s)
      addRule()
      await m.deployNow(acc)
      reject = true
      q.upsertSieveAccount(acc, { state: 'auth_failed' }, clock)
      await m.setEnabled(acc, false)
      expect(row()).toMatchObject({ enabled: 0, state: 'auth_failed' })
      reject = false
      m.onCredentialsChanged(acc)
      await vi.waitFor(() => expect(row()).toMatchObject({ state: 'off', script_hash: null }))
      expect(s.active).toBeNull()
    })

    it('an in-flight deploy cannot put auth_failed back after the password fix', async () => {
      let reject = true
      const s = await fake({
        intercept: (l) => {
          if (!reject || !l.startsWith('AUTHENTICATE')) return undefined
          reject = false
          return 'NO "kimlik"\r\n'
        }
      })
      enable(acc, s)
      addRule()
      const m = manager({ debounceMs: 60_000 })
      const running = m.deployNow(acc)
      m.onCredentialsChanged(acc)
      await running
      await vi.waitFor(() => expect(row().state).toBe('pending'))
    })

    it('live wrapper target beats the stale row', async () => {
      const s = await fake()
      const m = manager()
      await deployedWrapper(s, m, 'A')
      s.scripts.set('B', USER_SCRIPT)
      s.scripts.set(WRAPPER, generateWrapper('B'))
      await m.rollback(acc)
      expect(s.active).toBe('B')
    })

    it('redeploy reads the vacation conflict from the live target', async () => {
      const s = await fake()
      const m = manager()
      await deployedWrapper(s, m, 'A')
      s.scripts.set('B', `require "vacation";\r\nvacation "x";\r\n`)
      s.scripts.set(WRAPPER, generateWrapper('B'))
      q.setSieveVacation(acc, VAC, clock)
      expect(await m.deployNow(acc, true)).toMatchObject({ detail: SIEVE_VACATION_CONFLICT, wrapperOf: 'B' })
    })

    it('edited wrapped script that now includes is blocked', async () => {
      const s = await fake()
      const m = manager()
      await deployedWrapper(s, m)
      s.scripts.set('roundcube', 'require "include";\r\ninclude :personal "z";\r\n')
      m.onScriptEdited(acc, 'roundcube')
      await vi.waitFor(() => expect(row()).toMatchObject({ state: 'blocked_user_include', state_detail: 'roundcube' }))
      s.scripts.set('roundcube', USER_SCRIPT)
      m.onScriptEdited(acc, 'roundcube')
      await vi.waitFor(() => expect(row().state).toBe('active'))
    })

    it('watched folder is stored before the script goes live', async () => {
      const s = await fake()
      enable(acc, s)
      addRule()
      const seen: string[][] = []
      const real = ManageSieveClient.connect.bind(ManageSieveClient)
      const m = manager({
        connect: async (o) => {
          const c = await real(o)
          const setActive = c.setActive.bind(c)
          c.setActive = (n) => {
            seen.push(q.sieveWatchedPaths(acc))
            return setActive(n)
          }
          return c
        }
      })
      await m.deployNow(acc)
      expect(seen).toEqual([['Raporlar']])
      expect(q.sieveWatchSince(acc).Raporlar).toBeLessThanOrEqual(clock)
    })

    it('in-place replacement keeps the old target watched until the upload is done', async () => {
      let refuse = false
      const s = await fake({ checkScript: () => (refuse ? { ok: false, error: 'hayir' } : { ok: true }) })
      q.upsertFolder(acc, 'Yeni', 'other', false)
      enable(acc, s)
      const id = addRule()
      const m = manager()
      await m.deployNow(acc)
      const since = q.sieveWatchSince(acc).Raporlar
      clock += 1000
      q.updateRuleFields(id, { actions_json: JSON.stringify([{ type: 'move', folderName: 'Yeni' }]) })
      refuse = true
      await m.deployNow(acc)
      expect(q.sieveWatchedPaths(acc).sort()).toEqual(['Raporlar', 'Yeni'])
      refuse = false
      await m.deployNow(acc, true)
      expect(q.sieveWatchedPaths(acc)).toEqual(['Yeni'])
      expect(q.sieveWatchSince(acc).Raporlar).toBeUndefined()
      expect(q.sieveWatchSince(acc).Yeni).toBeGreaterThanOrEqual(since)
    })

    it('a drop after login does not count towards a host cooldown', async () => {
      const s = await fake()
      enable(acc, s)
      addRule()
      const failure = vi.spyOn(gov, 'onLoginFailure')
      await expect(manager().withSession(acc, 'interactive', async () => {
        throw new ManageSieveError('koptu', { phase: 'command', transport: 'lost' })
      })).rejects.toThrow('koptu')
      expect(failure).not.toHaveBeenCalled()
    })

    it('deferred rollback shows a reason and retries', async () => {
      const s = await fake()
      const m = manager()
      enable(acc, s)
      addRule()
      await m.deployNow(acc)
      vi.spyOn(gov, 'tryTakeLogin').mockReturnValueOnce({ ok: false, reason: 'cooldown', waitMs: 1 })
      const info = await m.rollback(acc)
      expect(info.detail).toBe(t('sync.sieve.busy'))
      await vi.waitFor(() => expect(row()).toMatchObject({ state: 'off', script_hash: null }), { timeout: 3000 })
    })

    it('rollback with an active drift script is not reported as off', async () => {
      const s = await fake()
      s.scripts.set(RULES, `${generateEmptyRules().text}# elle\r\n`)
      s.active = RULES
      enable(acc, s)
      q.upsertSieveAccount(acc, { script_hash: 'x', state: 'drift', watched_json: '["Raporlar"]' }, clock)
      expect(await manager().rollback(acc)).toMatchObject({ enabled: false, state: 'drift', scriptHash: 'x' })
      expect(q.sieveWatchedPaths(acc)).toEqual(['Raporlar'])
    })

    it('endpoint change is refused while a drift script stays active', async () => {
      const s = await fake()
      s.scripts.set(RULES, `${generateEmptyRules().text}# elle\r\n`)
      s.active = RULES
      enable(acc, s)
      q.upsertSieveAccount(acc, { script_hash: 'x', state: 'drift' }, clock)
      await expect(manager().setEndpoint(acc, 'yeni.t.test', 4190)).rejects.toThrow()
      expect(row().port).toBe(s.port)
    })

    it('host change is serialized with a running deploy', async () => {
      const s = await fake()
      enable(acc, s)
      addRule()
      const m = manager({ debounceMs: 60_000 })
      const running = m.deployNow(acc)
      m.onAccountHostChanged(acc)
      await running
      await vi.waitFor(() => expect(row().script_hash).toBeNull())
    })

    it('vacation conflict does not log in on every scheduled pass', async () => {
      const s = await fake()
      s.scripts.set('kisisel', `require "vacation";\r\nvacation "x";\r\n`)
      s.active = 'kisisel'
      enable(acc, s)
      q.upsertSieveAccount(acc, { consent_script: 'kisisel', consent_at: clock }, clock)
      q.setSieveVacation(acc, VAC, clock)
      addRule()
      const m = manager()
      await m.deployNow(acc)
      expect(row().state_detail).toBe(SIEVE_VACATION_CONFLICT)
      const before = s.connections
      await m.deployNow(acc)
      expect(s.connections).toBe(before)
    })

    it('a corrupt vacation row is an error, not an endless pending', async () => {
      setVaultKey(randomBytes(32))
      const s = await fake()
      enable(acc, s)
      addRule()
      vi.spyOn(q, 'getSieveVacation').mockImplementation(() => {
        throw new Error('bozuk')
      })
      expect((await manager().deployNow(acc)).state).toBe('error')
      setVaultKey(null)
    })

    it('displaced with nothing active can be reinstalled', async () => {
      const s = await fake()
      const m = manager()
      await deployedWrapper(s, m)
      s.active = null
      expect(await m.deployNow(acc, true)).toMatchObject({ state: 'displaced', detail: null })
      expect(await m.consent(acc, '')).toMatchObject({ state: 'active', wrapperOf: null })
      expect(s.active).toBe(RULES)
    })
  })

  describe('motor bağlama', () => {
    it('cooldown reaches the scheduler alert', async () => {
      const s = await fake({ failAuth: true })
      enable(acc, s)
      addRule()
      await manager().deployNow(acc)
      expect(sieveCooldown).not.toHaveBeenCalled() // tek ret soğutmaz
      const limited = await fake({ intercept: (l) => (l.startsWith('AUTHENTICATE') ? 'NO (TRYLATER) "busy"\r\n' : undefined) })
      q.upsertSieveAccount(acc, { state: 'pending', port: limited.port }, clock)
      await manager().deployNow(acc)
      expect(sieveCooldown).toHaveBeenCalledTimes(1)
      expect(sieveCooldown.mock.calls[0][0]).toBe('127.0.0.1')
      expect(sieveCooldown.mock.calls[0][1]).toMatchObject({ kind: 'cooldown', reason: 'limit' })
    })

    it('interactive session waits out the login gap, background defers', async () => {
      const s = await fake()
      enable(acc, s)
      tickMs = 0 // saat ilerlemez: ardışık login aralığa takılır
      const real = HostGovernor.prototype.tryTakeLogin
      let refused = 0
      const take = vi.spyOn(gov, 'tryTakeLogin').mockImplementation(function (this: HostGovernor, p, k) {
        if (refused++ === 0) return { ok: false, reason: 'rate', waitMs: 5 }
        return real.call(this, p, k)
      })
      const m = manager()
      await expect(m.withSession(acc, 'interactive', (c) => c.listScripts())).resolves.toEqual([])
      expect(take).toHaveBeenCalledTimes(2)
      refused = 0
      await expect(m.withSession(acc, 'background', (c) => c.listScripts())).rejects.toMatchObject({ name: 'SieveDeferred' })
    })

    it('interactive session never waits out a cooldown', async () => {
      const s = await fake()
      enable(acc, s)
      vi.spyOn(gov, 'tryTakeLogin').mockReturnValue({ ok: false, reason: 'cooldown', waitMs: 5 })
      await expect(manager().withSession(acc, 'interactive', (c) => c.listScripts())).rejects.toMatchObject({ name: 'SieveDeferred' })
      expect(gov.tryTakeLogin).toHaveBeenCalledTimes(1)
    })

    it('successful login reports host recovery', async () => {
      const s = await fake()
      enable(acc, s)
      addRule()
      await manager().deployNow(acc)
      expect(sieveLoginOk).toHaveBeenCalledWith('127.0.0.1')
    })

    it('forced deploy reconnects and sees drift', async () => {
      const s = await fake()
      enable(acc, s)
      addRule()
      const m = manager()
      await m.deployNow(acc)
      s.scripts.set(RULES, `${s.scripts.get(RULES)}# elle\r\n`)
      const edited = s.scripts.get(RULES)
      const before = s.connections
      await m.deployNow(acc)
      expect(s.connections).toBe(before)
      expect((await m.deployNow(acc, true)).state).toBe('drift')
      expect(s.scripts.get(RULES)).toBe(edited)
    })

    it('endpoint change clears cached transport and redeploys', async () => {
      const old = await fake()
      enable(acc, old)
      addRule()
      const m = manager()
      await m.deployNow(acc)
      const next = await fake()
      const info = await m.setEndpoint(acc, '127.0.0.1', next.port)
      expect(info).toMatchObject({ state: 'pending', port: next.port, caps: null })
      expect(row().tls).toBeNull()
      await vi.waitFor(() => expect(row().state).toBe('active'))
      expect(next.active).toBe(RULES)
    })

    it('endpoint change on a disabled account resets a cached verdict', async () => {
      q.upsertSieveAccount(acc, { state: 'unsupported', state_detail: 'no_listener' }, clock)
      const s = await fake()
      const info = await manager().setEndpoint(acc, '127.0.0.1', s.port)
      expect(info).toMatchObject({ state: 'unknown', detail: null, enabled: false })
    })

    it('account host change follows only without an override', async () => {
      q.upsertSieveAccount(acc, { tls: 'starttls', state: 'off' }, clock)
      const m = manager()
      m.onAccountHostChanged(acc)
      await vi.waitFor(() => expect(row()).toMatchObject({ tls: null, state: 'unknown' }))
      q.upsertSieveAccount(acc, { tls: 'starttls', host: 'sieve.t.test', state: 'off' }, clock)
      m.onAccountHostChanged(acc)
      await wait(5)
      expect(row()).toMatchObject({ tls: 'starttls', state: 'off' })
    })

    it('schedulePending retries only pending enabled accounts', async () => {
      const s = await fake()
      const other = account('b@t.test')
      q.upsertFolder(other, 'Raporlar', 'other', false)
      enable(acc, s)
      enable(other, s)
      q.upsertSieveAccount(other, { state: 'error' }, clock)
      addRule()
      manager().schedulePending()
      await vi.waitFor(() => expect(row().state).toBe('active'))
      await wait(30)
      expect(row(other).state).toBe('error')
    })

    it('editing the wrapped script rechecks on the next deploy', async () => {
      const s = await fake()
      s.scripts.set('kisisel', USER_SCRIPT)
      s.active = 'kisisel'
      enable(acc, s)
      q.upsertSieveAccount(acc, { consent_script: 'kisisel', consent_at: clock }, clock)
      q.setSieveVacation(acc, VAC, clock)
      addRule()
      const m = manager()
      await m.deployNow(acc)
      expect(s.active).toBe(WRAPPER)
      s.scripts.set('kisisel', `require "vacation";\r\nvacation "x";\r\n`)
      m.onScriptEdited(acc, 'baska')
      expect(row().state).toBe('active')
      m.onScriptEdited(acc, 'kisisel')
      expect(row().state).toBe('pending')
      await vi.waitFor(() => expect(row()).toMatchObject({ state: 'active', state_detail: 'vacation_conflict' }))
      expect(s.scripts.get(RULES)).not.toContain('vacation')
    })
  })
})

/** Ağsız istemci: sahte saatle yüzlerce dağıtım için */
function stubClient(o: { put?: Error } = {}): ManageSieveClient {
  const scripts = new Map<string, string>()
  let active = ''
  return {
    caps: { implementation: 'x', version: '1.0', sasl: ['PLAIN'], sieve: EXT, maxRedirects: null },
    authenticate: async () => {},
    listScripts: async () => [...scripts.keys()].map((name) => ({ name, active: name === active })),
    getScript: async (n: string) => scripts.get(n)!,
    checkScript: async () => ({ ok: true }),
    haveSpace: async () => true,
    putScript: async (n: string, c: string) => {
      if (o.put) throw o.put
      scripts.set(n, c)
    },
    setActive: async (n: string) => {
      active = n
    },
    deleteScript: async (n: string) => void scripts.delete(n),
    logout: async () => {},
    close: () => {}
  } as unknown as ManageSieveClient
}
