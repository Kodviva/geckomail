import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcEventMsg, RuleAction, SessionUser } from '../../shared/rpc'
import { SIEVE_RULES_SCRIPT as RULES, SIEVE_VACATION_CONFLICT, SIEVE_WRAPPER_SCRIPT as WRAPPER, type SieveCapsInfo, type SieveVacation } from '../../shared/sieve'
import { createHash } from 'crypto'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { DEFAULT_LIMITS, HostGovernor } from '../net/hostGovernor'
import type { OpQueue } from '../opQueue'
import { RpcHub, type RpcServerDeps } from '../rpcHub'
import type { RpcSession } from '../rpcSession'
import type { Scheduler } from '../scheduler'
import { clearDetectCache } from '../sieve/detect'
import { SieveManager } from '../sieve/manager'
import { encodeSyncBlob, SYNC_VERSION } from '../deviceSync'
import { t } from '../../shared/i18n'
import { makeTestCert, startFakeManageSieve, type FakeSieve, type FakeSieveOptions, type TestCert } from './helpers/fakeManageSieve'
import { setVaultKey } from '../vault/state'

const EXT = ['fileinto', 'imap4flags', 'mailbox', 'include', 'vacation', 'date', 'relational']
const SECRET = 'cok-gizli-parola'
const USER_SCRIPT = 'require "fileinto";\r\nif header :contains "subject" "x" { fileinto "Y"; }\r\n'
const MOVE: RuleAction[] = [{ type: 'move', folderName: 'Raporlar' }]
const VAC: SieveVacation = { enabled: true, subject: 'İzindeyim', body: 'Dönünce yazarım', days: 3, startDate: null, endDate: null }
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
const capsOf = (sieve: string[]): SieveCapsInfo => ({ implementation: 'x', version: '1.0', sasl: ['PLAIN'], sieve, maxRedirects: null })

describe.each(['server', 'desktop'] as const)('Sieve RPC (%s)', (mode) => {
  let cert: TestCert
  let dir: string
  let db: ReturnType<typeof openDb>
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let sieve: SieveManager
  let admin: RpcSession
  let accA: number
  let accB: number
  let groupA: number
  let creds: Map<number, string>
  let sent: RpcEventMsg[]
  let clock: number
  const servers: FakeSieve[] = []
  const ADMIN: SessionUser = { id: 1, username: 'admin', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] }

  beforeAll(() => {
    cert = makeTestCert()
  })
  beforeEach(() => {
    clearDetectCache()
    dir = mkdtempSync(join(tmpdir(), 'gecko-sieverpc-'))
    db = openDb(dir)
    q = makeQueries(db)
    creds = new Map()
    sent = []
    clock = 1_800_000_000_000
    const mk = (email: string): number => {
      const id = q.insertAccount({ email, displayName: null, imapHost: '127.0.0.1', imapPort: 993, smtpHost: '127.0.0.1', smtpPort: 465, passwordEnc: Buffer.from('x') })
      q.updateAccountFields(id, { allow_invalid_certs: 1 })
      creds.set(id, SECRET)
      q.upsertFolder(id, 'INBOX', 'inbox', false)
      q.upsertFolder(id, 'Raporlar', 'other', false)
      return id
    }
    accA = mk('a@t.test')
    accB = mk('b@t.test')
    groupA = q.insertGroup('Görünen', '#111111')
    q.setAccountGroup(accA, groupA)
    q.setAccountGroup(accB, q.insertGroup('Gizli', '#222222'))
    const gov = new HostGovernor('127.0.0.1', DEFAULT_LIMITS, () => (clock += 60_000)) // her sorguda ilerler: testler login aralığına takılmaz
    const stub = new Proxy({}, { get: () => () => undefined })
    const scheduler = new Proxy({ governorFor: () => gov, sieveLoginGate: () => null } as Record<string, unknown>, {
      get: (t, k: string) => t[k] ?? (() => undefined)
    }) as unknown as Scheduler
    const deps: RpcServerDeps = {
      q, scheduler, opq: stub as OpQueue, creds, attachDir: join(dir, 'att'),
      encrypt: async (v) => v.map((s) => new TextEncoder().encode(s)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)),
      userData: dir, dbSchemaVersion: () => 0
    }
    sieve = new SieveManager({ q, creds, scheduler, onState: (accountId) => hub.broadcast('sieve:state', { accountId }), debounceMs: 5, now: () => clock })
    deps.sieve = sieve
    hub = new RpcHub(deps, mode)
    admin = open(ADMIN)
    sent = []
  })
  afterEach(async () => {
    vi.useRealTimers()
    setVaultKey(null)
    sieve.stop()
    await Promise.all(servers.splice(0).map((s) => s.close()))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function open(user: SessionUser, inbox?: RpcEventMsg[]): RpcSession {
    const port = { send: (m: unknown) => void (inbox ?? sent).push(m as RpcEventMsg), onMessage() {}, onClose() {}, close() {} }
    const s = hub.openSession(port, { user })
    s.currentUser = user
    return s
  }
  const call = (session: RpcSession, method: string, params: unknown): Promise<unknown> => session.handle(method, params) as Promise<unknown>
  const rulePayload = () => ({ name: `r${clock++}`, accountId: null, groupId: null, conditions: { senderContains: 'a' }, actions: MOVE })
  const memberOf = (o: Partial<SessionUser> = {}): SessionUser => ({ id: 2, username: 'uye', role: 'member', permittedGroupIds: [groupA], manageableGroupIds: [], ...o })
  /** Masaüstünde tek oturum yaşar: üye aynı oturumda sınanır */
  const asMember = (u: SessionUser): RpcSession => {
    admin.currentUser = u
    return admin
  }
  const fake = async (o: Partial<FakeSieveOptions> = {}): Promise<FakeSieve> => {
    const s = await startFakeManageSieve({ tls: 'starttls', cert, sasl: ['PLAIN'], extensions: EXT, ...o })
    servers.push(s)
    return s
  }
  const enable = (id: number, s: Pick<FakeSieve, 'port'>, ext = EXT): void => {
    q.upsertSieveAccount(id, { enabled: 1, state: 'pending', port: s.port, tls: 'starttls', caps_json: JSON.stringify(capsOf(ext)), caps_at: clock }, clock)
  }
  const puts = (s: FakeSieve): string[] => s.commands.filter((c) => /^(PUTSCRIPT|DELETESCRIPT)/.test(c))
  const save = (name: string, content: string, baseSha: string) => admin.handle('sieveSaveScript', { accountId: accA, name, content, baseSha })
  const row = (id = accA) => q.getSieveAccount(id)
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  describe('yetki', () => {
    const WRITE: [string, Record<string, unknown>][] = [
      ['sieveDetect', {}], ['sieveSetEnabled', { enabled: true }], ['sieveConsent', { scriptName: 'x' }],
      ['sieveDeployNow', {}], ['sieveRollback', {}], ['sieveListScripts', {}], ['sieveGetScript', { name: 'x' }], ['sieveCheckScript', { content: 'x' }],
      ['sieveSaveScript', { name: 'x', content: 'x', baseSha: 'x' }], ['getSieveVacation', {}], ['setSieveVacation', { vacation: VAC }]
    ]

    it('member cannot manage', async () => {
      const s = asMember(memberOf())
      for (const [m, p] of WRITE) await expect(s.handle(m, { accountId: accA, ...p }), m).rejects.toThrow('yönetim yetkiniz yok')
    })

    it('viewer sees only status', async () => {
      const s = asMember(memberOf())
      await expect(s.handle('getSieveAccount', { accountId: accA })).resolves.toMatchObject({ accountId: accA, state: 'unknown' })
      await expect(s.handle('getSieveAccount', { accountId: accB })).rejects.toThrow('yetkiniz yok')
      await expect(s.handle('sieveGetScript', { accountId: accA, name: 'x' })).rejects.toThrow('yönetim yetkiniz yok')
      const list = (await s.handle('listSieveAccounts', {})) as { accountId: number }[]
      expect(list.map((a) => a.accountId)).toEqual([accA])
    })

    it('manager of the group can operate', async () => {
      const srv = await fake()
      enable(accA, srv)
      const s = asMember(memberOf({ manageableGroupIds: [groupA] }))
      await expect(s.handle('sieveListScripts', { accountId: accA })).resolves.toEqual([])
      await expect(s.handle('sieveListScripts', { accountId: accB })).rejects.toThrow('yönetim yetkiniz yok')
    })

    it('viewer gets neither raw server text nor script names', async () => {
      q.upsertSieveAccount(accA, { state: 'error', state_detail: 'sunucu metni: gizli-betik satır 3', wrapper_of: 'kisisel' }, clock)
      const viewer = asMember(memberOf())
      const info = await call(viewer, 'getSieveAccount', { accountId: accA })
      expect(info).toMatchObject({ detail: null, wrapperOf: null, consentNeededFor: null })
      const [listed] = (await call(viewer, 'listSieveAccounts', {})) as unknown[]
      expect(JSON.stringify(listed)).not.toContain('gizli-betik')
      q.upsertSieveAccount(accA, { state: 'active', state_detail: SIEVE_VACATION_CONFLICT }, clock)
      expect(await call(viewer, 'getSieveAccount', { accountId: accA })).toMatchObject({ detail: SIEVE_VACATION_CONFLICT })
      const manager = asMember(memberOf({ manageableGroupIds: [groupA] }))
      q.upsertSieveAccount(accA, { state: 'error', state_detail: 'sunucu metni' }, clock)
      expect(await call(manager, 'getSieveAccount', { accountId: accA })).toMatchObject({ detail: 'sunucu metni' })
    })

    it('endpoint is admin only', async () => {
      const manager = asMember(memberOf({ manageableGroupIds: [groupA] }))
      await expect(call(manager, 'sieveSetEndpoint', { accountId: accA, host: 'sieve.ornek.test', port: 4190 })).rejects.toThrow(t('sync.perm.adminRequired'))
      expect(q.getSieveAccount(accA)?.host ?? null).toBeNull()
    })

    it('getRulePlacements admin only', async () => {
      await expect(asMember(memberOf()).handle('getRulePlacements', {})).rejects.toThrow('yönetici yetkisi')
    })
  })

  describe('durum ve yerleşim', () => {
    it('lists every account for an admin with defaults', async () => {
      const list = (await admin.handle('listSieveAccounts', {})) as { accountId: number; enabled: boolean; port: number }[]
      expect(list.map((a) => a.accountId)).toEqual([accA, accB])
      expect(list[0]).toMatchObject({ enabled: false, port: 4190, host: '127.0.0.1' })
    })

    it('unknown account is refused', async () => {
      await expect(admin.handle('sieveSetEnabled', { accountId: 9999, enabled: true })).rejects.toThrow('Hesap bulunamadı')
      expect(row(9999)).toBeUndefined()
    })

    it('rule placements open no connection and sum accounts', async () => {
      const srv = await fake()
      const id = q.insertRule({ name: 'r', accountId: null, groupId: null, conditions: { senderContains: 'a' }, actions: MOVE })
      enable(accA, srv)
      q.upsertSieveAccount(accA, { state: 'active' }, clock)
      const before = srv.connections
      const out = await admin.handle('getRulePlacements', {})
      expect(srv.connections).toBe(before)
      expect(out).toEqual([{ ruleId: id, server: 1, split: 0, client: 1, reasons: ['sieve_off'] }])
    })

    it('rejects a malformed endpoint and clears on null', async () => {
      await expect(admin.handle('sieveSetEndpoint', { accountId: accA, host: 'a b', port: 4190 })).rejects.toThrow()
      await expect(admin.handle('sieveSetEndpoint', { accountId: accA, host: 'sieve.t.test', port: 70000 })).rejects.toThrow()
      if (mode === 'desktop') await expect(admin.handle('sieveSetEndpoint', { accountId: accA, host: 'Sieve.T.test', port: 4191 })).resolves.toMatchObject({ host: 'sieve.t.test', port: 4191 })
      await expect(admin.handle('sieveSetEndpoint', { accountId: accA, host: null, port: null })).resolves.toMatchObject({ host: '127.0.0.1', port: 4190 })
    })

    it.runIf(mode === 'server')('private endpoint is refused in server mode', async () => {
      for (const host of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254']) {
        await expect(call(admin, 'sieveSetEndpoint', { accountId: accA, host, port: 4190 }), host).rejects.toThrow(t('sync.sieve.privateEndpoint'))
      }
      await call(admin, 'sieveSetEndpoint', { accountId: accA, host: '8.8.8.8', port: 4190 })
      expect(q.getSieveAccount(accA)).toMatchObject({ host: '8.8.8.8' })
      await call(admin, 'sieveSetEndpoint', { accountId: accB, host: null, port: 4190 })
    })

    it.runIf(mode === 'desktop')('private endpoint is allowed on the desktop', async () => {
      await call(admin, 'sieveSetEndpoint', { accountId: accA, host: '10.1.2.3', port: 4190 })
      expect(q.getSieveAccount(accA)).toMatchObject({ host: '10.1.2.3' })
    })

    it('imap host change is refused while the old server cannot be reached', async () => {
      const srv = await fake()
      enable(accA, srv)
      await call(admin, 'createRule', rulePayload())
      await sieve.deployNow(accA)
      await srv.close()
      await expect(call(admin, 'updateAccount', { accountId: accA, patch: { imapHost: 'yeni.t.test' } })).rejects.toThrow()
      expect(q.getAccountRow(accA)?.imap_host).toBe('127.0.0.1')
      expect(q.getSieveAccount(accA)?.script_hash).not.toBeNull()
    })

    const deployedThenDead = async (): Promise<void> => {
      const srv = await fake()
      enable(accA, srv)
      await call(admin, 'createRule', rulePayload())
      await sieve.deployNow(accA)
      q.upsertSieveAccount(accA, { consent_script: 'eski', consent_at: clock }, clock)
      await srv.close()
    }
    const kept = (): void => {
      expect(q.getAccountRow(accA)?.imap_host).toBe('127.0.0.1')
      expect(q.getSieveAccount(accA)?.script_hash).not.toBeNull()
    }

    it('the refusal for an unreachable old server carries a code the admin can confirm', async () => {
      await deployedThenDead()
      await expect(call(admin, 'updateAccount', { accountId: accA, patch: { imapHost: 'yeni.t.test' } })).rejects.toMatchObject({ code: 'SIEVE_UNREACHABLE' })
      await expect(call(admin, 'sieveSetEndpoint', { accountId: accA, host: '8.8.8.8', port: 4190 })).rejects.toMatchObject({ code: 'SIEVE_UNREACHABLE' })
      kept()
    })

    it('admin confirms: imap host changes, local sieve state is cleared, script stays on the old server', async () => {
      await deployedThenDead()
      const res = await call(admin, 'updateAccount', { accountId: accA, patch: { imapHost: 'yeni.t.test' }, abandonSieve: true })
      expect(res).toEqual({ sieveLeft: true })
      expect(q.getAccountRow(accA)?.imap_host).toBe('yeni.t.test')
      expect(row()).toMatchObject({ enabled: 0, consent_script: null, consent_at: null, wrapper_of: null, script_hash: null })
    })

    it('admin confirms: sieveSetEndpoint goes through and reports the script stayed', async () => {
      await deployedThenDead()
      const res = (await call(admin, 'sieveSetEndpoint', { accountId: accA, host: '8.8.8.8', port: 4190, abandon: true })) as { left: boolean; enabled: boolean; host: string }
      expect(res).toMatchObject({ left: true, enabled: false, host: '8.8.8.8' })
      expect(row()).toMatchObject({ enabled: 0, consent_script: null, wrapper_of: null, script_hash: null })
    })

    it('a reachable server is still rolled back, no abandon', async () => {
      const srv = await fake()
      enable(accA, srv)
      await call(admin, 'createRule', rulePayload())
      await sieve.deployNow(accA)
      const res = await call(admin, 'updateAccount', { accountId: accA, patch: { imapHost: 'yeni.t.test' }, abandonSieve: true })
      expect(res).toBeNull()
      expect(row()?.script_hash).toBeNull()
    })

    it('a member cannot abandon: the refusal stays', async () => {
      await deployedThenDead()
      const s = asMember(memberOf({ manageableGroupIds: [groupA] }))
      await expect(call(s, 'updateAccount', { accountId: accA, patch: { imapHost: 'yeni.t.test' }, abandonSieve: true })).rejects.toThrow(t('sync.sieve.endpointRefused', { reason: '' }).slice(0, 20))
      await expect(call(s, 'sieveSetEndpoint', { accountId: accA, host: '8.8.8.8', port: 4190, abandon: true })).rejects.toThrow()
      kept()
    })

    it('deleting an account retries rollback for a disabled account that still holds scripts', async () => {
      const srv = await fake()
      enable(accA, srv)
      await call(admin, 'createRule', rulePayload())
      await sieve.deployNow(accA)
      q.upsertSieveAccount(accA, { enabled: 0 }, clock)
      await call(admin, 'deleteAccount', { accountId: accA })
      expect(srv.active).toBeNull()
    })

    it('a save costs one login and returns what the editor needs', async () => {
      const srv = await fake()
      enable(accA, srv)
      srv.scripts.set('kisisel', USER_SCRIPT)
      const { sha: base } = (await call(admin, 'sieveGetScript', { accountId: accA, name: 'kisisel' })) as { sha: string }
      const before = srv.connections
      const r = (await call(admin, 'sieveSaveScript', { accountId: accA, name: 'kisisel', content: 'keep;\r\n', baseSha: base })) as { scripts: { name: string }[] }
      expect(r).toMatchObject({ ok: true, content: 'keep;\r\n', sha: sha('keep;\r\n') })
      expect(r.scripts.find((x) => x.name === 'kisisel')).toMatchObject({ managed: false })
      expect(srv.connections).toBe(before + 1)
    })

    it('consent with an empty name works only from displaced', async () => {
      const srv = await fake()
      enable(accA, srv)
      await expect(call(admin, 'sieveConsent', { accountId: accA, scriptName: '' })).rejects.toThrow()
      q.upsertSieveAccount(accA, { state: 'displaced', state_detail: null, wrapper_of: 'x' }, clock)
      await call(admin, 'createRule', rulePayload())
      expect(await call(admin, 'sieveConsent', { accountId: accA, scriptName: '' })).toMatchObject({ state: 'active' })
    })

    it('enable, consent and rollback flow', async () => {
      const srv = await fake()
      srv.scripts.set('kisisel', USER_SCRIPT)
      srv.active = 'kisisel'
      q.insertRule({ name: 'r', accountId: null, groupId: null, conditions: { senderContains: 'a' }, actions: MOVE })
      await admin.handle('sieveSetEndpoint', { accountId: accA, host: null, port: srv.port })
      await expect(admin.handle('sieveSetEnabled', { accountId: accA, enabled: true })).resolves.toMatchObject({ state: 'needs_consent', consentNeededFor: 'kisisel' })
      await expect(admin.handle('sieveConsent', { accountId: accA, scriptName: 'kisisel' })).resolves.toMatchObject({ state: 'active', wrapperOf: 'kisisel' })
      expect(srv.active).toBe(WRAPPER)
      await expect(admin.handle('sieveRollback', { accountId: accA })).resolves.toMatchObject({ state: 'off', enabled: false })
      expect(srv.active).toBe('kisisel')
      expect(srv.scripts.get('kisisel')).toBe(USER_SCRIPT)
    })

    it('deploy button checks the server even with an unchanged hash', async () => {
      const srv = await fake()
      enable(accA, srv)
      q.insertRule({ name: 'r', accountId: null, groupId: null, conditions: { senderContains: 'a' }, actions: MOVE })
      await admin.handle('sieveDeployNow', { accountId: accA })
      srv.scripts.set(RULES, `${srv.scripts.get(RULES)}# elle\r\n`)
      await expect(admin.handle('sieveDeployNow', { accountId: accA })).resolves.toMatchObject({ state: 'drift' })
    })
  })

  describe('ham düzenleyici', () => {
    let srv: FakeSieve
    beforeEach(async () => {
      srv = await fake()
      enable(accA, srv)
      srv.scripts.set('kisisel', USER_SCRIPT)
      srv.scripts.set(RULES, '# bizim')
      srv.active = 'kisisel'
    })

    it('list and read mark managed scripts', async () => {
      expect(await admin.handle('sieveListScripts', { accountId: accA })).toEqual([
        { name: 'kisisel', active: true, managed: false }, { name: RULES, active: false, managed: true }
      ])
      expect(await admin.handle('sieveGetScript', { accountId: accA, name: 'kisisel' })).toEqual({ content: USER_SCRIPT, sha: sha(USER_SCRIPT), managed: false })
      await expect(admin.handle('sieveGetScript', { accountId: accA, name: RULES })).resolves.toMatchObject({ managed: true })
    })

    it('check reports the server error line', async () => {
      srv.scripts.delete(RULES)
      const bad = await fake({ checkScript: () => ({ ok: false, error: 'line 3: unexpected token' }) })
      enable(accB, bad)
      await expect(admin.handle('sieveCheckScript', { accountId: accB, content: 'if' })).resolves.toEqual({ ok: false, error: 'line 3: unexpected token' })
      await expect(admin.handle('sieveCheckScript', { accountId: accA, content: 'keep;' })).resolves.toEqual({ ok: true })
    })

    it('content over 256 KiB is refused', async () => {
      const big = 'ş'.repeat(131_073)
      await expect(admin.handle('sieveCheckScript', { accountId: accA, content: big })).rejects.toThrow('256 KiB')
      await expect(save('kisisel', big, sha(USER_SCRIPT))).rejects.toThrow('256 KiB')
      expect(srv.connections).toBe(0)
    })

    it('save conflict', async () => {
      await expect(save('kisisel', 'keep;', 'eski')).resolves.toEqual({ ok: false, conflict: true })
      expect(puts(srv)).toEqual([])
    })

    it('save refuses managed script', async () => {
      for (const name of [RULES, WRAPPER]) await expect(save(name, 'keep;', 'x')).rejects.toThrow('GeckoMail')
      expect(srv.connections).toBe(0)
    })

    it('save refuses a script that does not exist', async () => {
      await expect(save('yeni', 'keep;', sha(''))).resolves.toMatchObject({ ok: false, error: expect.any(String) })
      expect(puts(srv)).toEqual([])
    })

    it('save creates backup first', async () => {
      const r = (await save('kisisel', 'keep;', sha(USER_SCRIPT))) as { ok: boolean; backupName: string }
      expect(r.ok).toBe(true)
      expect(r.backupName).toMatch(/^kisisel\.bak-\d{12}$/)
      expect(puts(srv).map((c) => c.split(' ')[1])).toEqual([`"${r.backupName}"`, '"kisisel"'])
      expect(srv.scripts.get(r.backupName)).toBe(USER_SCRIPT)
      expect(srv.scripts.get('kisisel')).toBe('keep;')
    })

    it('backup quota keeps the script unchanged', async () => {
      const full = await fake({ maxScripts: 1 })
      full.scripts.set('kisisel', USER_SCRIPT)
      enable(accB, full)
      const r = await admin.handle('sieveSaveScript', { accountId: accB, name: 'kisisel', content: 'keep;', baseSha: sha(USER_SCRIPT) })
      expect(r).toMatchObject({ ok: false, error: expect.any(String) })
      expect(full.scripts.get('kisisel')).toBe(USER_SCRIPT)
      expect(puts(full)).toEqual([])
    })

    it('backup write failure keeps the script unchanged', async () => {
      const broken = await fake({ intercept: (l) => (l.startsWith('PUTSCRIPT') ? 'NO (QUOTA/MAXSIZE) "full"\r\n' : undefined) })
      broken.scripts.set('kisisel', USER_SCRIPT)
      enable(accB, broken)
      await expect(admin.handle('sieveSaveScript', { accountId: accB, name: 'kisisel', content: 'keep;', baseSha: sha(USER_SCRIPT) })).resolves.toMatchObject({ ok: false })
      expect(broken.scripts.get('kisisel')).toBe(USER_SCRIPT)
      expect(broken.commands.filter((c) => c.startsWith('PUTSCRIPT'))).toHaveLength(1)
    })

    it('failed check blocks save', async () => {
      const strict = await fake({ checkScript: () => ({ ok: false, error: 'syntax' }) })
      strict.scripts.set('kisisel', USER_SCRIPT)
      enable(accB, strict)
      await expect(admin.handle('sieveSaveScript', { accountId: accB, name: 'kisisel', content: 'if', baseSha: sha(USER_SCRIPT) })).resolves.toEqual({ ok: false, error: 'syntax' })
      expect(puts(strict)).toEqual([])
    })

    it('backup retention keeps three and only the pattern', async () => {
      for (const n of ['202601010000', '202602010000', '202603010000', '202604010000']) srv.scripts.set(`kisisel.bak-${n}`, 'eski')
      srv.scripts.set('kisisel.bak-final', 'elle')
      srv.scripts.set('kisisel2.bak-202501010000', 'baska')
      const r = (await save('kisisel', 'keep;', sha(USER_SCRIPT))) as { backupName: string }
      const left = [...srv.scripts.keys()].filter((n) => n.startsWith('kisisel.bak-')).sort()
      expect(left).toEqual(['kisisel.bak-202603010000', 'kisisel.bak-202604010000', r.backupName, 'kisisel.bak-final'].sort())
      expect(srv.scripts.has('kisisel2.bak-202501010000')).toBe(true)
    })

    it('two saves in one minute keep both backups', async () => {
      const a = (await save('kisisel', 'keep;', sha(USER_SCRIPT))) as { backupName: string }
      const b = (await save('kisisel', 'stop;', sha('keep;'))) as { backupName: string }
      expect(b.backupName).not.toBe(a.backupName)
      expect(srv.scripts.get(a.backupName)).toBe(USER_SCRIPT)
      expect(srv.scripts.get(b.backupName)).toBe('keep;')
    })

    it('script names with quotes stay in one argument', async () => {
      srv.scripts.set('a"b', USER_SCRIPT)
      await expect(save('a"b', 'keep;', sha(USER_SCRIPT))).resolves.toMatchObject({ ok: true })
      expect(srv.scripts.get('a"b')).toBe('keep;')
    })

    it('locked vault gives a clean error', async () => {
      creds.delete(accA)
      await expect(admin.handle('sieveListScripts', { accountId: accA })).rejects.toThrow(/\S/)
      await expect(admin.handle('sieveListScripts', { accountId: accA })).rejects.not.toThrow('deferred')
    })
  })

  describe('tatil', () => {
    it('defaults and capability flags need no connection', async () => {
      const srv = await fake()
      enable(accA, srv, ['fileinto', 'vacation'])
      await expect(admin.handle('getSieveVacation', { accountId: accA })).resolves.toEqual({
        vacation: { enabled: false, subject: '', body: '', days: 1, startDate: null, endDate: null }, supported: true, dateRange: false, conflict: false
      })
      expect(srv.connections).toBe(0)
    })

    it('reports conflict from the deployed detail', async () => {
      q.upsertSieveAccount(accA, { state: 'active', state_detail: SIEVE_VACATION_CONFLICT, caps_json: JSON.stringify(capsOf(EXT)) }, clock)
      await expect(admin.handle('getSieveVacation', { accountId: accA })).resolves.toMatchObject({ conflict: true, supported: true, dateRange: true })
    })

    it('validation errors use locale keys', async () => {
      await expect(admin.handle('setSieveVacation', { accountId: accA, vacation: { ...VAC, subject: 'a\r\nb' } })).rejects.toThrow('Konu')
      await expect(admin.handle('setSieveVacation', { accountId: accA, vacation: { ...VAC, days: 99 } })).rejects.toThrow('gün')
      await expect(admin.handle('setSieveVacation', { accountId: accA, vacation: null })).rejects.not.toThrow('sync.sieve')
    })

    it('saves and schedules a deploy', async () => {
      const srv = await fake()
      enable(accA, srv)
      await expect(admin.handle('setSieveVacation', { accountId: accA, vacation: VAC })).resolves.toMatchObject({ accountId: accA })
      expect(q.getSieveVacation(accA)).toEqual(VAC)
      await vi.waitFor(() => expect(srv.scripts.get(RULES)).toContain('vacation'))
    })

    it('refuses enabling on a server without the extension', async () => {
      q.upsertSieveAccount(accA, { caps_json: JSON.stringify(capsOf(['fileinto'])) }, clock)
      await expect(admin.handle('setSieveVacation', { accountId: accA, vacation: VAC })).rejects.toThrow('tatil')
      await expect(admin.handle('setSieveVacation', { accountId: accA, vacation: { ...VAC, enabled: false } })).resolves.toBeTruthy()
    })

    it('locked vault passes through as a clean RPC error', async () => {
      setVaultKey(Buffer.alloc(32, 7))
      db.prepare(`UPDATE accounts SET secure = 1 WHERE id = ?`).run(accA)
      q.refreshSecureAccounts()
      q.setSieveVacation(accA, VAC, clock)
      setVaultKey(null)
      await expect(admin.handle('getSieveVacation', { accountId: accA })).rejects.toThrow('Kasa')
      await expect(admin.handle('setSieveVacation', { accountId: accA, vacation: VAC })).rejects.toThrow('Kasa')
    })
  })

  describe('bağlama', () => {
    const rule = { name: 'r', accountId: null, groupId: null, conditions: { senderContains: 'a' }, actions: MOVE }

    it('rule change schedules deploy', async () => {
      const srv = await fake()
      enable(accA, srv)
      await admin.handle('createRule', { ...rule, accountId: accA })
      await vi.waitFor(() => expect(row()?.state).toBe('active'))
      expect(srv.active).toBe(RULES)
    })

    it('update of the run flag and deletion redeploy', async () => {
      const srv = await fake()
      enable(accA, srv)
      const { id } = (await admin.handle('createRule', { ...rule, accountId: accA })) as { id: number }
      await vi.waitFor(() => expect(srv.scripts.get(RULES)).toContain('Raporlar'))
      await admin.handle('updateRule', { id, patch: { runOnServer: false } })
      await vi.waitFor(() => expect(srv.scripts.get(RULES)).not.toContain('Raporlar'))
      await admin.handle('updateRule', { id, patch: { runOnServer: true } })
      await vi.waitFor(() => expect(srv.scripts.get(RULES)).toContain('Raporlar'))
      await admin.handle('deleteRule', { id })
      await vi.waitFor(() => expect(srv.scripts.get(RULES)).not.toContain('Raporlar'))
    })

    it('moving a rule to another account redeploys the old one', async () => {
      const srv = await fake()
      const other = await fake()
      enable(accA, srv)
      enable(accB, other)
      const { id } = (await admin.handle('createRule', { ...rule, accountId: accA })) as { id: number }
      await vi.waitFor(() => expect(srv.scripts.get(RULES)).toContain('Raporlar'))
      await admin.handle('updateRule', { id, patch: { accountId: accB } })
      await vi.waitFor(() => expect(other.scripts.get(RULES)).toContain('Raporlar'))
      await vi.waitFor(() => expect(srv.scripts.get(RULES)).not.toContain('Raporlar'))
    })

    it('global rule schedules all enabled', async () => {
      const a = await fake()
      const b = await fake()
      enable(accA, a)
      enable(accB, b)
      await admin.handle('createRule', rule)
      await vi.waitFor(() => expect([a.active, b.active]).toEqual([RULES, RULES]))
    })

    it('disabled account ignored', async () => {
      const a = await fake()
      const b = await fake()
      enable(accA, a)
      q.upsertSieveAccount(accB, { enabled: 0, port: b.port, tls: 'starttls', caps_json: JSON.stringify(capsOf(EXT)) }, clock)
      await admin.handle('createRule', rule)
      await vi.waitFor(() => expect(a.active).toBe(RULES))
      await wait(30)
      expect(b.connections).toBe(0)
    })

    it('group change schedules', async () => {
      const srv = await fake()
      enable(accA, srv)
      const g = q.insertGroup('Yeni', '#333333')
      q.insertRule({ ...rule, name: 'g', groupId: g })
      await admin.handle('setAccountGroup', { accountId: accA, groupId: g })
      await vi.waitFor(() => expect(srv.active).toBe(RULES))
    })

    it('sync pull changing the imap host rolls back first, or keeps the local host', async () => {
      const srv = await fake()
      enable(accA, srv)
      q.insertRule({ name: 'h', accountId: null, groupId: null, conditions: { senderContains: 'a' }, actions: MOVE })
      await sieve.deployNow(accA)
      const account = { email: 'a@t.test', displayName: null, imapHost: 'yeni.t.test', imapPort: 993, imapTls: 'tls', smtpHost: '127.0.0.1', smtpPort: 465, smtpTls: 'tls', color: '#111111', signature: null, allowInvalidCerts: true, password: SECRET, passwordChangedAt: 0, groupName: null, authType: 'password' }
      const blob = encodeSyncBlob({ version: SYNC_VERSION, exportedAt: 1, accounts: [account], groups: [], rules: [] } as never, 'parola')
      ;(hub.deps.scheduler as unknown as { enqueueInteractive: unknown }).enqueueInteractive = async () => blob
      await srv.close()
      await hub.doSyncPull(accA, 'parola')
      expect(q.getAccountRow(accA)?.imap_host).toBe('127.0.0.1')
      expect(q.getSieveAccount(accA)?.script_hash).not.toBeNull()
    })

    it('sync pull schedules all enabled', async () => {
      const spy = vi.spyOn(sieve, 'scheduleAll')
      const blob = encodeSyncBlob({ version: SYNC_VERSION, exportedAt: 1, accounts: [], groups: [], rules: [] }, 'parola')
      ;(hub.deps.scheduler as unknown as { enqueueInteractive: unknown }).enqueueInteractive = async () => blob
      await hub.doSyncPull(accA, 'parola')
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('password change clears auth_failed and redeploys', async () => {
      const srv = await fake()
      enable(accA, srv)
      q.upsertSieveAccount(accA, { state: 'auth_failed' }, clock)
      q.insertRule({ ...rule, accountId: accA })
      await admin.handle('updateAccount', { accountId: accA, patch: { password: 'yeni' } })
      await vi.waitFor(() => expect(row()?.state).toBe('active'))
    })

    it('imap host change forgets the cached transport', async () => {
      q.upsertSieveAccount(accA, { tls: 'starttls', state: 'off' }, clock)
      await admin.handle('updateAccount', { accountId: accA, patch: { imapHost: 'yeni.t.test' } })
      expect(row()).toMatchObject({ tls: null, state: 'unknown' })
    })

    it('saving the same imap host keeps the deployed state', async () => {
      q.upsertSieveAccount(accA, { enabled: 1, tls: 'starttls', state: 'active' }, clock)
      await admin.handle('updateAccount', { accountId: accA, patch: { imapHost: '127.0.0.1' } })
      expect(row()).toMatchObject({ tls: 'starttls', state: 'active' })
    })

    it('vault unlock schedules pending accounts', async () => {
      const spy = vi.spyOn(sieve, 'schedulePending')
      await admin.handle('createVault', { password: 'kasa-parolasi-1234' })
      admin.lockVaultNow()
      await expect(admin.handle('unlockVault', { password: 'yanlis' })).resolves.toMatchObject({ ok: false })
      expect(spy).not.toHaveBeenCalled()
      await expect(admin.handle('unlockVault', { password: 'kasa-parolasi-1234' })).resolves.toMatchObject({ ok: true })
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('event filtered', async () => {
      if (mode === 'desktop') return // masaüstünde tek oturum yaşar
      const srv = await fake()
      enable(accB, srv)
      const seen: RpcEventMsg[] = []
      open(memberOf(), seen)
      await sieve.setEndpoint(accB, '127.0.0.1', srv.port)
      await sieve.setEndpoint(accA, '127.0.0.1', srv.port)
      expect(sent).toContainEqual({ event: 'sieve:state', data: { accountId: accB } })
      expect(seen.filter((m) => m.event === 'sieve:state')).toEqual([{ event: 'sieve:state', data: { accountId: accA } }])
    })

    it('deleting an account attempts rollback', async () => {
      const srv = await fake()
      enable(accA, srv)
      q.insertRule({ ...rule, accountId: accA })
      await sieve.deployNow(accA)
      expect(srv.active).toBe(RULES)
      await admin.handle('deleteAccount', { accountId: accA })
      expect(srv.active).toBeNull()
      expect(srv.scripts.has(RULES)).toBe(false)
      expect(q.getAccountRow(accA)).toBeUndefined()
    })

    it('delete is not blocked by a hung rollback', async () => {
      const hang = vi.spyOn(sieve, 'rollback').mockReturnValue(new Promise(() => {}))
      q.upsertSieveAccount(accA, { enabled: 1 }, clock)
      vi.useFakeTimers()
      const done = admin.handle('deleteAccount', { accountId: accA })
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(done).resolves.toBeNull()
      expect(hang).toHaveBeenCalled()
      expect(q.getAccountRow(accA)).toBeUndefined()
    })

    it('delete skips rollback when sieve is off', async () => {
      const spy = vi.spyOn(sieve, 'rollback')
      await admin.handle('deleteAccount', { accountId: accB })
      expect(spy).not.toHaveBeenCalled()
    })
  })
})
