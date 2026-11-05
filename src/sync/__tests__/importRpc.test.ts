// Yerelden sunucuya taşıma: gerçek zarf, gerçek iki DB, iki hub. Yerel motor mühürler, sunucu açar ve yazar.
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../shared/i18n/locales/all'
import { AUTOMATION_HOLD_PREF, type PlanItem, type Sealed } from '../../shared/importTypes'
import type { SessionUser } from '../../shared/rpc'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { buildImportPlan, importStaying, sealImportBatch } from '../importExport'
import { createParentPortHost } from '../hosts/parentPortHost'
import type { OpQueue } from '../opQueue'
import { RpcHub } from '../rpcHub'
import type { Scheduler } from '../scheduler'
import { runDueScheduledTriggers } from '../scheduledTriggers'
import { runRulesForAccount } from '../rulesRunner'
import { createVault } from '../vault/manager'
import { setVaultKey } from '../vault/state'

const PASSWORD = 'yerel-gercek-parola-93'
const SECRET = 'webhook-sirri-77'
const SOURCE = 'kaynak-1'

interface Side {
  dir: string
  db: Database.Database
  q: ReturnType<typeof makeQueries>
  hub: RpcHub
  creds: Map<number, string>
  scheduler: { reloadAccounts: ReturnType<typeof vi.fn>; retryAccount: ReturnType<typeof vi.fn>; pollAllSoon: ReturnType<typeof vi.fn>; applyPrefs: ReturnType<typeof vi.fn> }
  s: { handle(m: string, p: unknown): Promise<never>; currentUser: SessionUser | null; webSessionId: string | null }
  user: number
}

function side(mode: 'desktop' | 'server', role: 'admin' | 'member' = 'admin'): Side {
  const dir = mkdtempSync(join(tmpdir(), 'gecko-imp-'))
  const db = openDb(dir)
  const q = makeQueries(db)
  const creds = new Map<number, string>()
  const scheduler = { reloadAccounts: vi.fn(), retryAccount: vi.fn(), pollAllSoon: vi.fn(), applyPrefs: vi.fn() }
  const hub = new RpcHub({
    q, scheduler: scheduler as unknown as Scheduler, opq: { kick() {} } as unknown as OpQueue, creds, attachDir: join(dir, 'att'),
    encrypt: async (v) => v.map((s) => new TextEncoder().encode(`enc:${s}`)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)),
    userData: dir, dbSchemaVersion: () => 0
  }, mode)
  const user = Number(db.prepare(`INSERT INTO users (username, password_hash, role, created_at) VALUES ('u', 'x', ?, 1)`).run(role).lastInsertRowid)
  const s = hub.openSession({ send() {}, onMessage() {}, onClose() {}, close() {} }) as unknown as Side['s']
  s.currentUser = { id: user, username: 'u', role, permittedGroupIds: [], manageableGroupIds: [] }
  s.webSessionId = 'oturum'
  return { dir, db, q, hub, creds, scheduler, s, user }
}

const account = (x: Side, email: string, over: { password?: string | null; auth?: string; changed?: number; secure?: boolean } = {}): number => {
  const id = x.q.insertAccount({ email, displayName: 'Ad', imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from(`enc:${over.password ?? PASSWORD}`) })
  x.q.updateAccountFields(id, { password_changed_at: over.changed ?? 1000, ...(over.auth ? { auth_type: over.auth } : {}) })
  if (over.secure) x.q.setAccountSecureFlag(id, true)
  if (over.password !== null) x.creds.set(id, over.password ?? PASSWORD)
  return id
}

describe('taşıma', () => {
  let local: Side
  let server: Side
  const sides: Side[] = []
  const make = (mode: 'desktop' | 'server', role: 'admin' | 'member' = 'admin'): Side => {
    const x = side(mode, role)
    sides.push(x)
    return x
  }

  beforeEach(() => {
    local = make('desktop')
    server = make('server')
  })
  afterEach(() => {
    setVaultKey(null)
    for (const x of sides.splice(0)) {
      x.db.close()
      rmSync(x.dir, { recursive: true, force: true })
    }
  })

  const plan = (): PlanItem[] => buildImportPlan(local.hub)
  /** Göçün kurduğu varsayılan grup hariç */
  const own = (): PlanItem[] => plan().filter((i) => i.key !== 'group:Genel')
  const begin = (x: Side = server): Promise<{ importId: string; serverKey: string; done: string[]; notices: { key: string; notice: string }[] }> => x.s.handle('importBegin', { sourceId: SOURCE })
  const sealed = (b: { importId: string; serverKey: string }, keys: string[]): Sealed[] => sealImportBatch(local.hub, { ...b, keys })
  const one = (b: { importId: string; serverKey: string }, key: string): Sealed => sealed(b, [key])[0]
  const send = (key: string, b?: { importId: string; serverKey: string }): Promise<{ status: string; detail?: string }> =>
    (async () => {
      const run = b ?? (await begin())
      return server.s.handle('importItem', { importId: run.importId, item: one(run, key) })
    })()
  const sendAll = async (): Promise<void> => {
    const run = await begin()
    for (const i of plan().filter((p) => !p.blocked)) await server.s.handle('importItem', { importId: run.importId, item: one(run, i.key) })
  }
  /** Sunucuya sealImportBatch'in yazamayacağı içerik: gerçek zarfla, doğrudan */
  const raw = async (key: string, kind: string, data: unknown): Promise<{ status: string; detail?: string }> => {
    const { sealItem } = await import('../importEnvelope')
    const run = await begin()
    return server.s.handle('importItem', { importId: run.importId, item: sealItem(run.serverKey, run.importId, key, Buffer.from(JSON.stringify({ kind, data }))) })
  }

  describe('yetki', () => {
    it('non admin refused', async () => {
      const member = make('server', 'member')
      await expect(member.s.handle('importBegin', { sourceId: SOURCE })).rejects.toThrow()
    })

    it('rolü DB\'de düşen yönetici oturumu reddedilir', async () => {
      const run = await begin()
      server.db.prepare(`UPDATE users SET role = 'member'`).run()
      account(local, 'a@t.co')
      await expect(server.s.handle('importItem', { importId: run.importId, item: one(run, 'account:a@t.co') })).rejects.toThrow()
    })

    it('import methods absent in desktop mode', async () => {
      for (const m of ['importBegin', 'importItem', 'importFinish']) await expect(local.s.handle(m, { sourceId: SOURCE })).rejects.toThrow()
    })

    it('başka oturum aynı taşımayı süremez', async () => {
      account(local, 'a@t.co')
      const run = await begin()
      const other = server.hub.openSession({ send() {}, onMessage() {}, onClose() {}, close() {} }, { user: server.s.currentUser!, webSessionId: 'x' })
      await expect(other.handle('importItem', { importId: run.importId, item: one(run, 'account:a@t.co') })).rejects.toThrow()
    })

    it('anahtar 30 dakika sonra geçersiz', async () => {
      account(local, 'a@t.co')
      const run = await begin()
      const start = server.hub.now()
      server.hub.now = () => start + 30 * 60_000 + 1
      await expect(server.s.handle('importItem', { importId: run.importId, item: one(run, 'account:a@t.co') })).rejects.toThrow()
    })

    it('importFinish anahtarı düşürür', async () => {
      const run = await begin()
      expect(await server.s.handle('importFinish', { importId: run.importId })).toEqual({ accounts: 0 })
      expect(server.hub.imports.size).toBe(0)
      await expect(server.s.handle('importFinish', { importId: run.importId })).rejects.toThrow()
    })

    it('kötü kaynak kimliği reddedilir', async () => {
      await expect(server.s.handle('importBegin', { sourceId: '../x' })).rejects.toThrow()
    })

    it('kurcalanmış zarf defter ve hesap yazmaz, parola hata metnine girmez', async () => {
      account(local, 'a@t.co')
      const run = await begin()
      const item = one(run, 'account:a@t.co')
      const ct = Buffer.from(item.ct, 'base64')
      ct[3] ^= 1
      const err = await server.s.handle('importItem', { importId: run.importId, item: { ...item, ct: ct.toString('base64') } }).catch((e: Error) => e)
      expect(String(err)).not.toContain(PASSWORD)
      expect(server.q.importLedgerRows(SOURCE)).toEqual([])
      expect(server.q.getAccountRows()).toEqual([])
    })
  })

  describe('sürdürme ve hesap', () => {
    it('importBegin returns done keys', async () => {
      account(local, 'a@t.co')
      account(local, 'b@t.co')
      expect((await send('account:a@t.co')).status).toBe('added')
      const again = await begin()
      expect(again.done).toEqual(['account:a@t.co'])
      expect(again.serverKey).not.toBe('')
    })

    it('her başlangıçta yeni anahtar', async () => {
      expect((await begin()).serverKey).not.toBe((await begin()).serverKey)
    })

    it('parola sunucu şifrelemesiyle yazılır, belleğe de girer', async () => {
      account(local, 'a@t.co')
      await send('account:a@t.co')
      const row = server.q.getAccountRows()[0]
      expect(Buffer.from(row.password_enc).toString()).toBe(`enc:${PASSWORD}`)
      expect(server.creds.get(row.id)).toBe(PASSWORD)
      expect(server.scheduler.reloadAccounts).toHaveBeenCalled()
    })

    it('item is idempotent', async () => {
      account(local, 'a@t.co')
      const run = await begin()
      const item = one(run, 'account:a@t.co')
      expect(await server.s.handle('importItem', { importId: run.importId, item })).toEqual({ status: 'added' })
      const bytes = Buffer.from(server.q.getAccountRows()[0].password_enc)
      expect(await server.s.handle('importItem', { importId: run.importId, item })).toEqual({ status: 'kept' })
      expect(server.q.getAccountRows().length).toBe(1)
      expect(Buffer.from(server.q.getAccountRows()[0].password_enc).equals(bytes)).toBe(true)
    })

    it('newer server password kept', async () => {
      account(local, 'a@t.co', { changed: 1000 })
      const id = account(server, 'a@t.co', { password: 'sunucudaki-yeni', changed: 2000 })
      server.q.updateAccountFields(id, { display_name: 'Sunucu Adı' })
      expect((await send('account:a@t.co')).status).toBe('kept')
      const row = server.q.getAccountRow(id)!
      expect(Buffer.from(row.password_enc).toString()).toBe('enc:sunucudaki-yeni')
      expect(row.display_name).toBe('Sunucu Adı')
      expect(server.scheduler.retryAccount).not.toHaveBeenCalled()
    })

    it('yerel parola daha yeniyse güncellenir, auth durdurması kalkar', async () => {
      account(local, 'a@t.co', { changed: 3000 })
      const id = account(server, 'a@t.co', { password: 'eski', changed: 2000 })
      expect((await send('account:a@t.co')).status).toBe('updated')
      expect(server.creds.get(id)).toBe(PASSWORD)
      expect(server.scheduler.retryAccount).toHaveBeenCalledWith(id)
    })

    it('oauth blocked', async () => {
      expect(await raw('account:o@t.co', 'account', { email: 'o@t.co', authType: 'oauth:google' })).toEqual({ status: 'blocked', detail: 'oauthReconnect' })
      expect(server.q.getAccountRows()).toEqual([])
      expect(server.q.importLedgerRows(SOURCE)).toMatchObject([{ status: 'blocked' }])
    })

    it('vault without unlocked server vault blocked', async () => {
      createVault(local.q, 'kasa-parolasi-1')
      account(local, 'k@t.co', { secure: true })
      expect(await send('account:k@t.co')).toEqual({ status: 'blocked', detail: 'vaultRequired' })
      expect(server.q.getAccountRows()).toEqual([])
      setVaultKey(null) // kurulu ama kilitli
      createVault(server.q, 'sunucu-kasasi-1')
      setVaultKey(null)
      local.creds.set(local.q.getAccountRows()[0].id, PASSWORD)
      expect(await raw('account:k@t.co', 'account', { email: 'k@t.co', imapHost: 'm.t.co', imapPort: 993, imapTls: 'tls', smtpHost: 'm.t.co', smtpPort: 465, smtpTls: 'tls', color: '#111111', displayName: null, signature: null, groupName: null, allowInvalidCerts: false, secure: true, password: PASSWORD })).toEqual({ status: 'blocked', detail: 'vaultRequired' })
    })

    it('açık sunucu kasasına kasa hesabı olarak yazılır', async () => {
      createVault(server.q, 'sunucu-kasasi-1') // anahtar süreçte açık kalır
      createVault(local.q, 'kasa-parolasi-1')
      account(local, 'k@t.co', { secure: true })
      expect((await send('account:k@t.co')).status).toBe('added')
      const row = server.q.getAccountRows()[0]
      expect(row.secure).toBe(1)
      expect(server.q.isAccountSecure(row.id)).toBe(true)
      expect(Buffer.from(row.password_enc).toString()).not.toContain(PASSWORD)
    })

    it('sunucudaki kasa hesabına dokunulmaz', async () => {
      account(local, 'a@t.co', { changed: 9000 })
      const id = account(server, 'a@t.co', { password: 'kasadaki', changed: 1, secure: true })
      const before = Buffer.from(server.q.getAccountRow(id)!.password_enc)
      expect(await send('account:a@t.co')).toEqual({ status: 'blocked', detail: 'vaultConflict' })
      expect(Buffer.from(server.q.getAccountRow(id)!.password_enc).equals(before)).toBe(true)
    })

    it('engel kalkınca aynı öge sürer', async () => {
      const r = await raw('rule:R', 'rule', { name: 'R', enabled: true, accountEmail: 'yok@t.co', groupName: null, conditions: {}, actions: [] })
      expect(r).toEqual({ status: 'blocked', detail: 'unmappedAccount' })
      expect((await begin()).done).toEqual([])
    })

    it('geçersiz hesap engellenir, ayrıntı içerikten gelmez', async () => {
      expect(await raw('account:x@t.co', 'account', { email: 'x@t.co', imapHost: 'kötü host', password: PASSWORD })).toEqual({ status: 'blocked', detail: 'invalid' })
    })

    it('anahtar ve içerik türü uyuşmazsa yazılmaz', async () => {
      expect(await raw('template:s:a', 'pref', { key: 'backfillTarget', value: '1' })).toEqual({ status: 'blocked', detail: 'invalid' })
      expect(server.q.prefGet('backfillTarget')).toBeNull()
    })

    it('JSON olmayan içerik ayrıntı sızdırmaz', async () => {
      const { sealItem } = await import('../importEnvelope')
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const run = await begin()
      const r = await server.s.handle('importItem', { importId: run.importId, item: sealItem(run.serverKey, run.importId, 'pref:x', Buffer.from(`parola ${PASSWORD}`)) })
      expect(r).toEqual({ status: 'blocked', detail: 'invalid' })
      expect(JSON.stringify(log.mock.calls)).not.toContain(PASSWORD)
      log.mockRestore()
    })
  })

  describe('kimlik eşleme ve tercihler', () => {
    it('rule account remapped', async () => {
      account(server, 'once@t.co')
      const id = account(local, 'a@t.co')
      local.q.insertRule({ name: 'R', accountId: id, groupId: null, conditions: {}, actions: [{ type: 'archive' }] })
      await sendAll()
      const rule = server.q.getAllRules()[0]
      expect(rule.account_id).toBe(server.q.getAccountIdByEmail('a@t.co'))
      expect(rule.account_id).not.toBe(id)
    })

    it('webhook eylemi ada, sonra sunucu kimliğine çevrilir; sır defterde yok', async () => {
      local.db.prepare(`INSERT INTO webhooks (name, url, secret, created_at) VALUES ('dolgu', 'https://d.t.co', NULL, 1)`).run()
      const wid = local.q.insertWebhook({ name: 'Slack', url: 'https://h.t.co/x', secret: SECRET })
      local.q.insertRule({ name: 'R', accountId: null, groupId: null, conditions: {}, actions: [{ type: 'webhook', webhookId: wid }] })
      await sendAll()
      const sw = server.q.allWebhooks()[0]
      expect(sw).toMatchObject({ name: 'Slack', secret: SECRET })
      expect(JSON.parse(server.q.getAllRules()[0].actions_json)).toEqual([{ type: 'webhook', webhookId: sw.id }])
    })

    it('tetikleyici hesap ve webhook kimliği çevrilir', async () => {
      const a = account(local, 'a@t.co')
      account(server, 'once@t.co')
      local.q.insertScheduledTrigger({ name: 'Özet', scheduleType: 'daily', scheduleValue: '09:00', actionType: 'digest_email', actionPayload: { fromAccountId: a, toAddr: 'x@t.co', accountIds: [a] }, nextRunAt: 1 })
      await sendAll()
      const t = server.q.getAllScheduledTriggers()[0]
      const id = server.q.getAccountIdByEmail('a@t.co')
      expect(JSON.parse(t.action_payload_json)).toEqual({ fromAccountId: id, toAddr: 'x@t.co', accountIds: [id] })
      expect(t.next_run_at).toBeGreaterThan(1)
    })

    it('notify rule account clause remapped', async () => {
      account(server, 'once@t.co')
      const id = account(local, 'a@t.co')
      local.q.saveNotifyRule(local.user, { id: 0, name: 'N', enabled: true, position: 0, level: 'urgent', groups: [[{ field: 'account', value: String(id) }, { field: 'from', value: 'x' }]] }, 1)
      await sendAll()
      const [rule] = server.q.listNotifyRules(server.user)
      expect(rule.groups[0]).toEqual([{ field: 'account', value: String(server.q.getAccountIdByEmail('a@t.co')) }, { field: 'from', value: 'x' }])
      expect(rule.level).toBe('urgent')
    })

    it('kişisel veri girişli sunucu kullanıcısına gider', async () => {
      const id = account(local, 'a@t.co')
      local.q.userPrefSet(local.user, 'notifyQuiet', '1')
      local.q.setNotifyAccountPref(local.user, id, 'off')
      local.q.setUserSignature(local.user, id, 'imzam')
      local.q.saveTemplate({ name: 'Kişisel', subject: null, body: 'b', shared: false }, local.user, 5)
      local.q.saveTemplate({ name: 'Ortak', subject: 's', body: 'o', shared: true }, null, 6)
      await sendAll()
      const sid = server.q.getAccountIdByEmail('a@t.co')!
      expect(server.q.userPrefGet(server.user, 'notifyQuiet')).toBe('1')
      expect(server.q.listNotifyAccountPrefs(server.user)).toEqual([{ accountId: sid, mode: 'off' }])
      expect(server.q.userSignatureMap(server.user).get(sid)).toBe('imzam')
      expect(server.q.listTemplates(server.user).map((t) => [t.name, t.shared])).toEqual([['Kişisel', false], ['Ortak', true]])
    })

    it('başka yöneticinin taşıması kişisel veriyi tamamlanmış saymaz, genel veriyi sayar', async () => {
      account(local, 'a@t.co')
      local.q.userPrefSet(local.user, 'notifyQuiet', '1')
      await sendAll()
      const other = Number(server.db.prepare(`INSERT INTO users (username, password_hash, role, created_at) VALUES ('b', 'x', 'admin', 1)`).run().lastInsertRowid)
      server.s.currentUser = { ...server.s.currentUser!, id: other }
      expect((await begin()).done.sort()).toEqual(['account:a@t.co'])
    })

    it('sunucuda aynı adlı kural, webhook ve şablon ezilmez', async () => {
      server.q.insertRule({ name: 'R', accountId: null, groupId: null, conditions: {}, actions: [{ type: 'markRead' }] })
      server.q.upsertWebhookByName({ name: 'W', url: 'https://sunucu.t.co', secret: 'sunucu-sirri', enabled: true })
      server.q.saveTemplate({ name: 'T', subject: null, body: 'sunucu', shared: true }, null, 99)
      local.q.insertRule({ name: 'R', accountId: null, groupId: null, conditions: {}, actions: [{ type: 'archive' }] })
      local.q.upsertWebhookByName({ name: 'W', url: 'https://yerel.t.co', secret: SECRET, enabled: true })
      local.q.saveTemplate({ name: 'T', subject: null, body: 'yerel', shared: true }, null, 1)
      await sendAll()
      expect(JSON.parse(server.q.getAllRules()[0].actions_json)).toEqual([{ type: 'markRead' }])
      expect(server.q.allWebhooks()[0]).toMatchObject({ url: 'https://sunucu.t.co', secret: 'sunucu-sirri' })
      expect(server.q.listTemplates(server.user)[0].body).toBe('sunucu')
    })

    it('pref outside whitelist ignored', async () => {
      for (const key of ['trustedServer', 'require2fa', 'vault_check', 'sync_auto', 'autoBackup']) {
        expect((await raw(`pref:${key}`, 'pref', { key, value: '1' })).status).toBe('kept')
        expect(server.q.prefGet(key)).toBeNull()
      }
      expect((await raw('userPref:u1:require2fa', 'userPref', { key: 'require2fa', value: '1' })).status).toBe('kept')
      expect(server.q.userPrefGet(server.user, 'require2fa')).toBeNull()
    })

    it('beyaz liste tercihi taşınır, sunucu değeri ezilmez', async () => {
      local.q.prefSet('pollCadenceSec', '60')
      local.q.prefSet('bodyPrefetch', '1')
      local.q.prefSet('trustedServer', '1')
      server.q.prefSet('bodyPrefetch', '0')
      await sendAll()
      expect(server.q.prefGet('pollCadenceSec')).toBe('60')
      expect(server.q.prefGet('bodyPrefetch')).toBe('0')
      expect(server.q.prefGet('trustedServer')).toBeNull()
      expect(plan().map((i) => i.key)).not.toContain('pref:trustedServer')
    })

    it('ledger holds no secret', async () => {
      account(local, 'a@t.co')
      local.q.insertWebhook({ name: 'Slack', url: 'https://h.t.co/x', secret: SECRET })
      await sendAll()
      await send('account:a@t.co')
      const dump = JSON.stringify(server.db.prepare('SELECT * FROM import_ledger').all())
      expect(dump).toContain('account:a@t.co')
      expect(dump).not.toContain(PASSWORD)
      expect(dump).not.toContain(SECRET)
    })
  })

  describe('yerel plan', () => {
    it('plan marks locked vault', () => {
      account(local, 'k@t.co', { secure: true, password: null })
      expect(own()).toMatchObject([{ key: 'account:k@t.co', blocked: 'vaultLocked' }])
    })

    it('oauth ve parolası bellekte olmayan hesap engelli', () => {
      account(local, 'o@t.co', { auth: 'oauth:google' })
      account(local, 'p@t.co', { password: null })
      expect(own().map((i) => [i.key, i.blocked])).toEqual([['account:o@t.co', 'oauthReconnect'], ['account:p@t.co', 'noPassword']])
    })

    it('plan has no passwords', () => {
      account(local, 'a@t.co')
      local.q.insertWebhook({ name: 'Slack', url: 'https://h.t.co/gizli-yol', secret: SECRET })
      const text = JSON.stringify(plan())
      expect(text).not.toContain(PASSWORD)
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain('gizli-yol')
    })

    it('kural hesaptan, kişisel veri kuraldan sonra gelir', () => {
      const id = account(local, 'a@t.co')
      local.q.userPrefSet(local.user, 'notifyQuiet', '1')
      local.q.insertRule({ name: 'R', accountId: id, groupId: null, conditions: {}, actions: [] })
      local.q.insertGroup('G', '#111111')
      expect(own().map((i) => i.kind)).toEqual(['group', 'account', 'rule', 'userPref'])
    })

    it('bağlanamayan bildirim kuralı engelli', () => {
      local.q.saveNotifyRule(local.user, { id: 0, name: 'N', enabled: true, position: 0, level: 'normal', groups: [[{ field: 'account', value: '999' }]] }, 1)
      expect(own()).toMatchObject([{ kind: 'notifyRule', blocked: 'unmappedAccount' }])
    })

    it('zarf parolayı açık taşımaz, engelli ve bilinmeyen anahtar mühürlenmez', async () => {
      account(local, 'a@t.co')
      account(local, 'o@t.co', { auth: 'oauth:google' })
      const run = await begin()
      const out = sealed(run, ['account:a@t.co', 'account:o@t.co', 'account:yok@t.co'])
      expect(out.map((s) => s.key)).toEqual(['account:a@t.co'])
      expect(JSON.stringify(out)).not.toContain(PASSWORD)
    })

    it('üye ya da oturumsuz yerel motor plan vermez, mühürlemez', () => {
      account(local, 'a@t.co')
      local.s.currentUser = { ...local.s.currentUser!, role: 'member' }
      expect(() => buildImportPlan(local.hub)).toThrow()
      expect(() => sealImportBatch(local.hub, { importId: 'i', serverKey: 'k', keys: ['account:a@t.co'] })).toThrow()
      local.s.currentUser = null
      expect(() => buildImportPlan(local.hub)).toThrow()
    })

    it('yerelde kalanlar sayılır', () => {
      const id = account(local, 'a@t.co')
      local.db.prepare(`INSERT INTO op_queue (account_id, kind, payload_json, state, not_before, created_at) VALUES (?, 'smtp_send', '{}', 'pending', ?, 1), (?, 'store_flags', '{}', 'pending', NULL, 1), (?, 'store_flags', '{}', 'done', NULL, 1)`).run(id, Date.now() + 60_000, id, id)
      expect(importStaying(local.hub)).toEqual({ scheduled: 1, pending: 1 })
    })
  })

  describe('mühürleme kapısı', () => {
    it('seal rejects request from rpc session', async () => {
      account(local, 'a@t.co')
      for (const m of RpcHub.methodNames()) expect(m).not.toMatch(/seal|importPlan|buildImport/i)
      const run = await begin()
      for (const m of ['sealImportBatch', 'importSeal', 'import-seal', 'buildImportPlan']) {
        await expect(local.s.handle(m, { ...run, keys: ['account:a@t.co'] })).rejects.toThrow()
      }
    })

    it('mühür isteği RPC kanalından sinyale ulaşmaz: yalnız parentPort', () => {
      const sent: unknown[] = []
      let deliver: (e: { data: unknown }) => void = () => {}
      const bridge = createParentPortHost({ postMessage: (m) => sent.push(m), on: (_e, cb) => { deliver = cb } })
      const signals: unknown[] = []
      bridge.onSignal((s) => signals.push(s))
      for (const bad of [{ type: 'import-seal', id: 1 }, { type: 'import-seal', id: 1, importId: 'i', serverKey: 5, keys: [] }, { type: 'import-seal', id: 'x', importId: 'i', serverKey: 'k', keys: [] }, { type: 'import-seal', id: 1, importId: 'i', serverKey: 'k', keys: [1] }]) deliver({ data: bad })
      expect(signals).toEqual([])
      deliver({ data: { type: 'import-seal', id: 2, importId: 'i', serverKey: 'k', keys: ['a'] } })
      deliver({ data: { type: 'import-plan', id: 3 } })
      expect(signals).toEqual([{ type: 'import-seal', id: 2, importId: 'i', serverKey: 'k', keys: ['a'] }, { type: 'import-plan', id: 3 }])
      bridge.host.importResult?.(2, { ok: true, value: [] })
      expect(sent).toEqual([{ type: 'import:res', id: 2, ok: true, value: [] }])
    })
  })

  describe('otomasyon', () => {
    const newMail = (x: Side, accountId: number): void => {
      const f = Number(x.db.prepare(`INSERT INTO folders (account_id, path, kind) VALUES (?, 'INBOX', 'inbox')`).run(accountId).lastInsertRowid)
      x.db.prepare(
        `INSERT INTO messages (folder_id, account_id, folder_kind, uid, subject, from_addr, to_json, date, size, seen, flagged, answered, has_attachments, rules_eligible)
         VALUES (?, ?, 'inbox', 1, 'konu', 'x@t.co', '[]', 1, 1, 0, 0, 0, 0, 1)`
      ).run(f, accountId)
    }
    const ops = (x: Side): string[] => (x.db.prepare('SELECT kind FROM op_queue').all() as { kind: string }[]).map((r) => r.kind)

    it('automation paused after import', async () => {
      const id = account(local, 'a@t.co')
      newMail(local, id)
      local.q.insertRule({ name: 'R', accountId: null, groupId: null, conditions: {}, actions: [{ type: 'forward', to: 'b@t.co' }, { type: 'notify', urgent: true }] })
      expect(local.q.prefGet(AUTOMATION_HOLD_PREF)).toBeNull()
      await sendAll()
      expect(local.q.prefGet(AUTOMATION_HOLD_PREF)).toBe('1')
      const reasons = new Map<number, string>()
      await runRulesForAccount(local.q, { kick() {} } as unknown as OpQueue, id, () => {}, (_r, why) => why.forEach((v, k) => reasons.set(k, v)))
      expect(ops(local)).toEqual([])
      expect([...reasons.values()]).toEqual(['rule-urgent']) // bildirim kararı sürer
      expect(local.db.prepare('SELECT trigger_count AS n FROM rules').get()).toEqual({ n: 0 })
    })

    it('kullanıcı geri açtıktan sonra yeni kural mühürlenirse otomasyon yeniden durur', async () => {
      const id = account(local, 'a@t.co')
      newMail(local, id)
      local.q.insertRule({ name: 'R', accountId: null, groupId: null, conditions: {}, actions: [{ type: 'forward', to: 'b@t.co' }] })
      await sendAll()
      await local.s.handle('setPrefs', { values: { [AUTOMATION_HOLD_PREF]: '0' } })
      local.q.insertRule({ name: 'R2', accountId: null, groupId: null, conditions: {}, actions: [] })
      const run = await begin()
      sealed(run, ['rule:R2'])
      expect(local.q.prefGet(AUTOMATION_HOLD_PREF)).toBe('1')
      await runRulesForAccount(local.q, { kick() {} } as unknown as OpQueue, id, () => {})
      expect(ops(local)).toEqual([])
    })

    it('bekleyen kural yoksa sürdürme otomasyonu yeniden durdurmaz', async () => {
      account(local, 'a@t.co')
      local.q.insertRule({ name: 'R', accountId: null, groupId: null, conditions: {}, actions: [] })
      await sendAll()
      await local.s.handle('setPrefs', { values: { [AUTOMATION_HOLD_PREF]: '0' } })
      const run = await begin()
      expect(run.done).toContain('rule:R')
      sealed(run, ['account:a@t.co'])
      expect(local.q.prefGet(AUTOMATION_HOLD_PREF)).toBe('0')
    })

    it('mühürleme başarısızsa otomasyon durmaz', async () => {
      local.q.insertRule({ name: 'R', accountId: null, groupId: null, conditions: {}, actions: [] })
      expect(() => sealImportBatch(local.hub, { importId: 'x', serverKey: 'bozuk', keys: ['rule:R'] })).toThrow()
      expect(local.q.prefGet(AUTOMATION_HOLD_PREF)).toBeNull()
    })

    it('kural yoksa otomasyon durmaz', async () => {
      account(local, 'a@t.co')
      await sendAll()
      expect(local.q.prefGet(AUTOMATION_HOLD_PREF)).toBeNull()
    })

    it('tetikleyici çalışmaz, sessize alma sürer, zaman öne alınır', () => {
      local.q.prefSet(AUTOMATION_HOLD_PREF, '1')
      const wid = local.q.insertWebhook({ name: 'W', url: 'https://h.t.co', secret: null })
      local.q.insertScheduledTrigger({ name: 'Ping', scheduleType: 'interval', scheduleValue: '5', actionType: 'webhook_ping', actionPayload: { webhookId: wid }, nextRunAt: 1 })
      local.q.insertScheduledTrigger({ name: 'Sus', scheduleType: 'daily', scheduleValue: '09:00', actionType: 'mute_notifications', actionPayload: { resumeAtHHMM: '10:00' }, nextRunAt: 1 })
      runDueScheduledTriggers(local.q, { kick() {} } as unknown as OpQueue)
      expect(ops(local)).toEqual([])
      expect(local.q.prefGet('notifyMutedUntil')).not.toBeNull()
      expect(local.q.getAllScheduledTriggers().every((t) => t.next_run_at > 1)).toBe(true)
    })

    it('setPrefs yalnız 0/1 kabul eder', async () => {
      await expect(local.s.handle('setPrefs', { values: { [AUTOMATION_HOLD_PREF]: 'x' } })).rejects.toThrow()
    })
  })

  describe('kapsam genişlemez', () => {
    const rule = (over: { accountId?: number | null; groupId?: number | null } = {}): number =>
      Number(local.q.insertRule({ name: 'R', accountId: over.accountId ?? null, groupId: over.groupId ?? null, conditions: {}, actions: [{ type: 'markRead' }] }))
    const other = (): void => void account(server, 'baskasi@t.co')

    it('göçün kurduğu Genel de var olan grup gibi çakışır', async () => {
      expect(await send('group:Genel')).toEqual({ status: 'blocked', detail: 'groupConflict' })
    })

    it('başka hesap varken genel kural kapalı gelir, bildirilir', async () => {
      other()
      rule()
      const r = await send('rule:R')
      expect(r).toMatchObject({ status: 'added', notice: 'scopeDisabled' })
      expect(server.q.getAllRules()[0].enabled).toBe(0)
    })

    it('sunucuda yalnız bu kaynağın hesapları varsa genel kural açık kalır', async () => {
      account(local, 'a@t.co')
      rule()
      await sendAll()
      expect(server.q.getAllRules()[0].enabled).toBe(1)
    })

    it('hesaba bağlı kural başka hesap varken de açık kalır', async () => {
      other()
      rule({ accountId: account(local, 'a@t.co') })
      await sendAll()
      expect(server.q.getAllRules()[0].enabled).toBe(1)
    })

    it('başka hesap varken tüm hesap özeti kapalı gelir, bildirilir', async () => {
      other()
      const id = account(local, 'a@t.co')
      await send('account:a@t.co')
      local.q.insertScheduledTrigger({ name: 'Ozet', scheduleType: 'daily', scheduleValue: '09:00', actionType: 'digest_email', actionPayload: { fromAccountId: id, toAddr: 'x@t.co', accountIds: null }, nextRunAt: 1 })
      expect(await send('trigger:Ozet')).toMatchObject({ status: 'added', notice: 'scopeDisabled' })
      expect(server.q.getAllScheduledTriggers()[0].enabled).toBe(0)
    })

    it('uyarı sürdürmede kaybolmaz', async () => {
      other()
      rule()
      await send('rule:R')
      expect((await begin()).notices).toEqual([{ key: 'rule:R', notice: 'scopeDisabled' }])
    })

    it('sunucuda var olan grup çakışmadır, birleştirilmez', async () => {
      const gid = server.q.ensureGroupByName('Ekip', '#111111')
      local.q.ensureGroupByName('Ekip', '#222222')
      expect(await send('group:Ekip')).toEqual({ status: 'blocked', detail: 'groupConflict' })
      expect(server.q.getSyncExport().groups.filter((g) => g.name === 'Ekip')).toHaveLength(1)
      const id = account(local, 'a@t.co')
      local.q.setAccountGroup(id, local.q.ensureGroupByName('Ekip', '#222222'))
      expect(await send('account:a@t.co')).toMatchObject({ status: 'added', notice: 'groupDropped' })
      expect(server.q.getAccountRows()[0].group_id).not.toBe(gid)
      expect(server.q.getAccountRows()[0].group_id).toBeNull()
    })

    it('bu kaynağın eklediği grup kullanılır', async () => {
      const gid = local.q.ensureGroupByName('Yeni', '#222222')
      const id = account(local, 'a@t.co')
      local.q.setAccountGroup(id, gid)
      expect((await send('group:Yeni')).status).toBe('added')
      expect((await send('account:a@t.co')).status).toBe('added')
      expect(server.q.getAccountRows()[0].group_id).toBe(server.q.ensureGroupByName('Yeni', '#000000'))
    })

    it('çakışan gruba bağlı kural engellenir', async () => {
      server.q.ensureGroupByName('Ekip', '#111111')
      rule({ groupId: local.q.ensureGroupByName('Ekip', '#222222') })
      await send('group:Ekip')
      expect(await send('rule:R')).toEqual({ status: 'blocked', detail: 'groupConflict' })
      expect(server.q.getAllRules()).toEqual([])
    })
  })

  describe('Sieve ile', () => {
    it('sunucusunda betik kalan hesap planda uyarı taşır, diğeri taşımaz', () => {
      const a = local.q.insertAccount({ email: 'betikli@example.test', displayName: null, imapHost: 'm.example.test', imapPort: 993, smtpHost: 'm.example.test', smtpPort: 465, passwordEnc: Buffer.from('x') })
      local.q.insertAccount({ email: 'betiksiz@example.test', displayName: null, imapHost: 'm.example.test', imapPort: 993, smtpHost: 'm.example.test', smtpPort: 465, passwordEnc: Buffer.from('x') })
      local.q.upsertSieveAccount(a, { script_hash: 'h', deployed_at: 1 }, 1)
      const notes = plan().filter((i) => i.kind === 'account' && i.label.endsWith('example.test'))
      expect(notes.find((i) => i.label === 'betikli@example.test')?.notice).toBe('sieveLeft')
      expect(notes.find((i) => i.label === 'betiksiz@example.test')?.notice).toBeUndefined()
    })

    const sieve = (): { schedule: ReturnType<typeof vi.fn>; scheduleAll: ReturnType<typeof vi.fn>; onCredentialsChanged: ReturnType<typeof vi.fn> } => {
      const m = { schedule: vi.fn(), scheduleAll: vi.fn(), onCredentialsChanged: vi.fn() }
      ;(server.hub.deps as { sieve?: unknown }).sieve = m
      return m
    }

    it('sunucuda çalıştırma seçimi taşınır, kapalı kural kapalı kalır', async () => {
      local.q.insertRule({ name: 'R', accountId: null, groupId: null, conditions: {}, actions: [{ type: 'markRead' }], runOnServer: false })
      local.q.insertRule({ name: 'S', accountId: null, groupId: null, conditions: {}, actions: [{ type: 'markRead' }] })
      await send('rule:R')
      await send('rule:S')
      expect(server.q.getAllRules().map((r) => [r.name, r.run_on_server])).toEqual([['R', 0], ['S', 1]])
    })

    it('seçimi taşımayan eski kaynakta varsayılan sunucuda, bozuk değer engellenir', async () => {
      await raw('rule:E', 'rule', { name: 'E', enabled: true, accountEmail: null, groupName: null, conditions: {}, actions: [] })
      expect(server.q.getAllRules().map((r) => r.run_on_server)).toEqual([1])
      expect(await raw('rule:B', 'rule', { name: 'B', enabled: true, accountEmail: null, groupName: null, conditions: {}, actions: [], runOnServer: 'evet' })).toEqual({ status: 'blocked', detail: 'invalid' })
    })

    it('gelen kural dağıtımı tetikler: hesaba bağlıysa o hesap, değilse hepsi', async () => {
      const m = sieve()
      const id = account(server, 'a@t.co')
      account(local, 'a@t.co')
      await raw('rule:H', 'rule', { name: 'H', enabled: true, accountEmail: 'a@t.co', groupName: null, conditions: {}, actions: [] })
      expect(m.schedule).toHaveBeenCalledWith(id)
      expect(m.scheduleAll).not.toHaveBeenCalled()
      await raw('rule:G', 'rule', { name: 'G', enabled: false, accountEmail: null, groupName: null, conditions: {}, actions: [] })
      expect(m.scheduleAll).toHaveBeenCalledOnce()
    })

    it('var olan hesabın parolası değişince Sieve yeniden dener', async () => {
      const m = sieve()
      account(local, 'a@t.co', { changed: 3000 })
      const id = account(server, 'a@t.co', { password: 'eski', changed: 2000 })
      await send('account:a@t.co')
      expect(m.onCredentialsChanged).toHaveBeenCalledWith(id)
    })
  })

  describe('var olan hesap', () => {
    it('daha yeni parola yalnız parola alanlarını yazar', async () => {
      account(local, 'a@t.co', { changed: 3000 })
      const lid = local.q.getAccountIdByEmail('a@t.co')!
      local.q.updateAccountFields(lid, { imap_host: 'kotu.t.co', smtp_host: 'kotu.t.co', color: '#000000', signature: 'yerel', allow_invalid_certs: 1 })
      const gid = server.q.ensureGroupByName('Ekip', '#111111')
      const id = account(server, 'a@t.co', { password: 'eski', changed: 2000 })
      server.q.setAccountGroup(id, gid)
      server.q.updateAccountFields(id, { signature: 'sunucu', color: '#ffffff' })
      const before = server.q.getAccountRow(id)!
      expect((await send('account:a@t.co')).status).toBe('updated')
      const after = server.q.getAccountRow(id)!
      expect(Buffer.from(after.password_enc).toString()).toBe(`enc:${PASSWORD}`)
      expect(after.password_changed_at).toBe(3000)
      expect({ ...after, password_enc: null, password_changed_at: null }).toEqual({ ...before, password_enc: null, password_changed_at: null })
      expect(server.scheduler.retryAccount).toHaveBeenCalledWith(id)
    })
  })

  describe('yinelenen adlar', () => {
    it('aynı adlı iki kural planda engellenir, gönderilmez', () => {
      for (let i = 0; i < 2; i++) local.q.insertRule({ name: 'R', accountId: null, groupId: null, conditions: {}, actions: [] })
      expect(own().filter((i) => i.key === 'rule:R').map((i) => i.blocked)).toEqual(['duplicateName', 'duplicateName'])
      expect(sealImportBatch(local.hub, { importId: 'x', serverKey: 'y', keys: ['rule:R'] })).toEqual([])
    })

    it('aynı adlı webhook ve ona bağlı kural engellenir', () => {
      const a = local.q.insertWebhook({ name: 'W', url: 'https://a.t.co', secret: null })
      local.q.insertWebhook({ name: 'W', url: 'https://b.t.co', secret: null })
      local.q.insertRule({ name: 'R', accountId: null, groupId: null, conditions: {}, actions: [{ type: 'webhook', webhookId: a }] })
      const byKey = new Map(own().map((i) => [i.key, i.blocked]))
      expect(byKey.get('webhook:W')).toBe('duplicateName')
      expect(byKey.get('rule:R')).toBe('duplicateName')
    })

    it('sunucudaki aynı adlı webhook başka adrese gidiyorsa kural engellenir', async () => {
      server.q.upsertWebhookByName({ name: 'W', url: 'https://sunucu.t.co', secret: null, enabled: true })
      const w = local.q.insertWebhook({ name: 'W', url: 'https://yerel.t.co', secret: null })
      local.q.insertRule({ name: 'R', accountId: null, groupId: null, conditions: {}, actions: [{ type: 'webhook', webhookId: w }] })
      expect((await send('webhook:W')).status).toBe('kept')
      expect(await send('rule:R')).toEqual({ status: 'blocked', detail: 'webhookConflict' })
      expect(server.q.getAllRules()).toEqual([])
    })

    it('aynı adres aynı addaysa kural eklenir', async () => {
      server.q.upsertWebhookByName({ name: 'W', url: 'https://ayni.t.co', secret: null, enabled: true })
      const w = local.q.insertWebhook({ name: 'W', url: 'https://ayni.t.co', secret: null })
      local.q.insertRule({ name: 'R', accountId: null, groupId: null, conditions: {}, actions: [{ type: 'webhook', webhookId: w }] })
      expect((await send('rule:R')).status).toBe('added')
    })
  })

  describe('küçük sertleştirmeler', () => {
    it('büyük harfli sunucu adı küçültülür', async () => {
      const r = await raw('account:b@t.co', 'account', { email: 'b@t.co', imapHost: 'Mail.T.CO', imapPort: 993, imapTls: 'tls', smtpHost: 'SMTP.t.co', smtpPort: 465, smtpTls: 'tls', color: '#111111', displayName: null, signature: null, groupName: null, allowInvalidCerts: false, secure: false, password: PASSWORD })
      expect(r.status).toBe('added')
      expect(server.q.getAccountRows()[0]).toMatchObject({ imap_host: 'mail.t.co', smtp_host: 'smtp.t.co' })
    })

    it('oturum kapanınca taşıma ve özel anahtar bellekten düşer', async () => {
      await begin()
      expect(server.hub.imports.size).toBe(1)
      server.hub.closeSessionsWhere(() => true)
      expect(server.hub.imports.size).toBe(0)
    })

    it('süresi dolan taşıma kendiliğinden düşer', async () => {
      vi.useFakeTimers()
      try {
        await begin()
        vi.advanceTimersByTime(31 * 60_000)
        expect(server.hub.imports.size).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('rolü DB\'de düşen yerel yönetici plan alamaz', () => {
      local.db.prepare(`UPDATE users SET role = 'member'`).run()
      expect(() => buildImportPlan(local.hub)).toThrow()
    })
  })

  it('local data untouched', async () => {
    const id = account(local, 'a@t.co')
    local.q.insertRule({ name: 'R', accountId: id, groupId: null, conditions: {}, actions: [] })
    const accounts = JSON.stringify(local.db.prepare('SELECT * FROM accounts').all())
    const rules = JSON.stringify(local.db.prepare('SELECT * FROM rules').all())
    const counts = (): unknown => local.db.prepare('SELECT (SELECT COUNT(*) FROM messages) AS m, (SELECT COUNT(*) FROM op_queue) AS o').get()
    const before = counts()
    await sendAll()
    expect(JSON.stringify(local.db.prepare('SELECT * FROM accounts').all())).toBe(accounts)
    expect(JSON.stringify(local.db.prepare('SELECT * FROM rules').all())).toBe(rules)
    expect(counts()).toEqual(before)
  })
})
