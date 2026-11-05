import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '../../shared/rpc'
import { t } from '../../shared/i18n'
import { migrate, MIGRATIONS, openDb } from '../db'
import { makeQueries } from '../db/queries'
import { notifyNewMail } from '../newMailNotify'
import { NotifyPipeline } from '../notifyPipeline'
import type { OpQueue } from '../opQueue'
import type { RpcPort } from '../rpc/transport'
import { RpcHub, type RpcServerDeps } from '../rpcHub'
import type { Scheduler } from '../scheduler'

class FakePort implements RpcPort {
  sent: unknown[] = []
  send(msg: unknown): void {
    this.sent.push(msg)
  }
  onMessage(): void {}
  onClose(): void {}
  close(): void {}
  events(name: string): unknown[] {
    return this.sent.filter((m) => (m as { event?: string }).event === name)
  }
}

describe('kişiye ait veri (§10.1)', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let deps: RpcServerDeps
  let acc: number
  let group: number
  const stub = new Proxy({}, { get: () => () => undefined })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-scope-'))
    db = openDb(dir)
    q = makeQueries(db)
    acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    group = q.insertGroup('A', '#111111')
    q.setAccountGroup(acc, group)
    deps = {
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: async (v) => v.map((s) => new TextEncoder().encode(s)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)),
      userData: dir, dbSchemaVersion: () => 0
    }
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const user = (role: 'admin' | 'member', name: string): SessionUser => {
    const id = q.insertUser({ username: name, passwordHash: 'x', role })
    return { id, username: name, role, permittedGroupIds: role === 'admin' ? [] : [group], manageableGroupIds: [] }
  }

  it('migration copies global notify prefs to every user', () => {
    const d2 = mkdtempSync(join(tmpdir(), 'gecko-scope-mig-'))
    try {
      const path = join(d2, 'geckomail.db')
      const raw = new Database(path)
      migrate(raw, d2, path, MIGRATIONS.slice(0, 18))
      const now = Date.now()
      raw.prepare(`INSERT INTO users (username, password_hash, role, created_at) VALUES ('a', 'x', 'admin', ?), ('b', 'x', 'member', ?)`).run(now, now)
      raw.prepare(`INSERT INTO prefs (key, value) VALUES ('notifyVip', 'a@x.co'), ('notifyQuiet', '1'), ('pollCadenceSec', '60')`).run()
      raw.prepare(`INSERT INTO templates (name, subject, body, updated_at) VALUES ('Eski', NULL, 'gövde', 5)`).run()
      migrate(raw, d2, path)
      const q2 = makeQueries(raw)
      const ids = (raw.prepare(`SELECT id FROM users ORDER BY id`).all() as { id: number }[]).map((r) => r.id)
      expect(ids).toHaveLength(2)
      for (const id of ids) {
        expect(q2.userPrefGet(id, 'notifyVip')).toBe('a@x.co')
        expect(q2.userPrefGet(id, 'notifyQuiet')).toBe('1')
        expect(q2.userPrefGet(id, 'pollCadenceSec')).toBeNull() // genel ayar kişiye kopyalanmaz
        // mevcut şablon paylaşılan olarak korunur
        expect(q2.listTemplates(id).map((x) => [x.name, x.shared])).toEqual([['Eski', true]])
      }
      raw.close()
    } finally {
      rmSync(d2, { recursive: true, force: true })
    }
  })

  it("member can set own notify prefs, not others'", async () => {
    const hub = new RpcHub(deps, 'server')
    const m = user('member', 'uye')
    const a = user('admin', 'yonetici')
    const sm = hub.openSession(new FakePort(), { user: m })
    const sa = hub.openSession(new FakePort(), { user: a })
    await expect(sm.handle('setMyPrefs', { notifyQuiet: '1' })).resolves.toBeNull()
    expect(q.userPrefGet(m.id, 'notifyQuiet')).toBe('1')
    expect(q.userPrefGet(a.id, 'notifyQuiet')).toBeNull()
    await expect(sm.handle('setMyPrefs', { trustedServer: '1' })).rejects.toThrow(t('sync.pref.notWritable', { key: 'trustedServer' }))
    await expect(sa.handle('setPrefs', { values: { notifyVip: 'x' } })).rejects.toThrow(t('sync.pref.useMyPrefs'))
    // getPrefs kişisel anahtarları oturumun kullanıcısından okur
    const pm = (await sm.handle('getPrefs', {})) as Record<string, string>
    const pa = (await sa.handle('getPrefs', {})) as Record<string, string>
    expect(pm.notifyQuiet).toBe('1')
    expect(pa.notifyQuiet).toBeUndefined()
  })

  it('signature falls back to account default', () => {
    db.prepare(`UPDATE accounts SET signature = 'S' WHERE id = ?`).run(acc)
    const u1 = user('member', 'u1')
    const u2 = user('member', 'u2')
    expect(q.getSignatureFor(u1.id, acc)).toBe('S')
    q.setUserSignature(u1.id, acc, 'K')
    expect(q.getSignatureFor(u1.id, acc)).toBe('K')
    expect(q.getSignatureFor(u2.id, acc)).toBe('S')
    q.setUserSignature(u1.id, acc, null)
    expect(q.getSignatureFor(u1.id, acc)).toBe('S')
  })

  it('getAccounts returns the per-user signature', async () => {
    db.prepare(`UPDATE accounts SET signature = 'S' WHERE id = ?`).run(acc)
    const hub = new RpcHub(deps, 'server')
    const u1 = user('member', 'u1')
    const s1 = hub.openSession(new FakePort(), { user: u1 })
    await s1.handle('setMySignature', { accountId: acc, signature: 'K' })
    const list = (await s1.handle('getAccounts', {})) as { id: number; signature: string | null; mySignature: string | null }[]
    // signature hesabın varsayılanı kalır (hesap düzenleme kişisel imzayı varsayılana yazmasın)
    expect(list.find((x) => x.id === acc)?.signature).toBe('S')
    expect(list.find((x) => x.id === acc)?.mySignature).toBe('K')
    const u2 = user('member', 'u2')
    const s2 = hub.openSession(new FakePort(), { user: u2 })
    const list2 = (await s2.handle('getAccounts', {})) as { id: number; signature: string | null; mySignature: string | null }[]
    expect(list2.find((x) => x.id === acc)?.mySignature).toBe('S')
  })

  it('templates: own + shared, name unique per owner', async () => {
    const hub = new RpcHub(deps, 'server')
    const A = user('member', 'A')
    const B = user('member', 'B')
    const adm = user('admin', 'adm')
    const sA = hub.openSession(new FakePort(), { user: A })
    const sB = hub.openSession(new FakePort(), { user: B })
    const sAdm = hub.openSession(new FakePort(), { user: adm })
    await sA.handle('saveTemplate', { name: 'Ret', subject: null, body: 'A ret' })
    await sB.handle('saveTemplate', { name: 'Ret', subject: null, body: 'B ret' })
    await sAdm.handle('saveTemplate', { name: 'Ortak', subject: null, body: 'herkese', shared: true })
    await expect(sA.handle('saveTemplate', { name: 'X', subject: null, body: 'x', shared: true })).rejects.toThrow(t('sync.perm.adminRequired'))
    const la = (await sA.handle('listTemplates', {})) as { name: string; body: string; shared: boolean }[]
    expect(la.map((x) => [x.name, x.body, x.shared])).toEqual([['Ortak', 'herkese', true], ['Ret', 'A ret', false]])
    const lb = (await sB.handle('listTemplates', {})) as { name: string; body: string }[]
    expect(lb.map((x) => x.body)).toEqual(['herkese', 'B ret'])
    // üye paylaşılanı silemez; kendi şablonunu siler
    await expect(sA.handle('deleteTemplate', { name: 'Ortak' })).rejects.toThrow(t('sync.perm.adminRequired'))
    await sA.handle('deleteTemplate', { name: 'Ret' })
    expect(q.listTemplates(A.id).map((x) => x.name)).toEqual(['Ortak'])
    expect(q.listTemplates(B.id).map((x) => x.name)).toEqual(['Ortak', 'Ret'])
    await sAdm.handle('deleteTemplate', { name: 'Ortak' })
    expect(q.listTemplates(B.id).map((x) => x.name)).toEqual(['Ret'])
  })

  it('personal template hides the shared one with the same name', async () => {
    const hub = new RpcHub(deps, 'server')
    const adm = user('admin', 'adm')
    const m = user('member', 'uye')
    const other = user('member', 'diger')
    await hub.openSession(new FakePort(), { user: adm }).handle('saveTemplate', { name: 'Ret', subject: null, body: 'ortak' })
    const sm = hub.openSession(new FakePort(), { user: m })
    await sm.handle('saveTemplate', { name: 'Ret', subject: null, body: 'kendi' })
    const lm = (await sm.handle('listTemplates', {})) as { name: string; body: string; shared: boolean }[]
    expect(lm.map((x) => [x.name, x.body, x.shared])).toEqual([['Ret', 'kendi', false]])
    // başka üye paylaşılanı görür
    expect(q.listTemplates(other.id).map((x) => [x.body, x.shared])).toEqual([['ortak', true]])
    // kişisel silinince paylaşılan yeniden görünür
    await sm.handle('deleteTemplate', { name: 'Ret' })
    expect(q.listTemplates(m.id).map((x) => [x.body, x.shared])).toEqual([['ortak', true]])
  })

  it('admin saveTemplate without shared saves a shared template; member saves personal', async () => {
    const hub = new RpcHub(deps, 'server')
    const adm = user('admin', 'adm')
    const m = user('member', 'uye')
    await hub.openSession(new FakePort(), { user: adm }).handle('saveTemplate', { name: 'Yönetici', subject: null, body: 'a' })
    await hub.openSession(new FakePort(), { user: m }).handle('saveTemplate', { name: 'Üye', subject: null, body: 'u' })
    expect(q.listTemplates(m.id).map((x) => [x.name, x.shared])).toEqual([['Yönetici', true], ['Üye', false]])
    expect(q.templatesForSync().map((x) => x.name)).toEqual(['Yönetici'])
  })

  it('device sync carries only shared templates', () => {
    const A = user('member', 'A')
    q.saveTemplate({ name: 'Ortak', subject: null, body: 'o', shared: true }, null, 100)
    q.saveTemplate({ name: 'Özel', subject: null, body: 'ö', shared: false }, A.id, 100)
    expect(q.templatesForSync(200).map((x) => x.name)).toEqual(['Ortak'])
    // içe alma kişisel şablona dokunmaz: aynı adda paylaşılan oluşturur
    q.mergeSyncTemplates([{ name: 'Özel', subject: null, body: 'uzak', updatedAt: 300, deleted: false }])
    expect(q.templatesForSync(400).map((x) => [x.name, x.body])).toEqual([['Ortak', 'o'], ['Özel', 'uzak']])
    // A'nın listesinde kişisel olan paylaşılanı gizler
    expect(q.listTemplates(A.id).map((x) => [x.name, x.body, x.shared])).toEqual([
      ['Ortak', 'o', true],
      ['Özel', 'ö', false]
    ])
  })

  it("server notify respects each user's quiet hours", async () => {
    q.prefSet('notifyScope', 'all')
    const hub = new RpcHub(deps, 'server')
    const A = user('member', 'A')
    const B = user('member', 'B')
    for (const u of [A, B]) q.setGroupPermission(u.id, group, true, false)
    q.userPrefSet(A.id, 'notifyQuiet', '1')
    q.userPrefSet(A.id, 'notifyQuietStart', '11:00')
    q.userPrefSet(A.id, 'notifyQuietEnd', '13:00')
    const pA = new FakePort()
    const pB = new FakePort()
    hub.openSession(pA, { user: A })
    hub.openSession(pB, { user: B })
    const folder = q.upsertFolder(acc, 'INBOX', 'inbox')
    q.upsertHeader({
      folderId: folder, accountId: acc, folderKind: 'inbox', uid: 1, messageId: '<a@t>', inReplyTo: null, subject: 's', fromName: null, fromAddr: 'x@y.co', toJson: null,
      date: 1, size: 1, seen: false, flagged: false, answered: false, hasAttachments: false, listUnsubscribe: null, listUnsubscribePost: null, rulesEligible: true
    })
    const pipeline = new NotifyPipeline({
      q, hub, mode: 'server', sink: { deliver: (userId, items) => items.forEach((i) => hub.notifyUser(userId, { ...i, actions: [] })) }, now: () => new Date(2026, 10, 3, 12, 0), fetchBodyText: async () => null
    })
    await notifyNewMail({ q, opq: stub as OpQueue, hub, pipeline }, acc)
    await pipeline.flush()
    expect(pA.events('server:notify')).toHaveLength(0)
    expect(pB.events('server:notify')).toHaveLength(1)
  })
})
