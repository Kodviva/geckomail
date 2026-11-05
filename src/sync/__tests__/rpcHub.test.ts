import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '../../shared/rpc'
import { t } from '../../shared/i18n'
import { hashPassword } from '../auth/password'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import type { OpQueue } from '../opQueue'
import type { RpcPort } from '../rpc/transport'
import { RpcHub, type RpcServerDeps } from '../rpcHub'
import type { Scheduler } from '../scheduler'
import { createVault, getVaultStatus, unlockVault } from '../vault/manager'

// Sahte taşıma: gönderilenleri dizide tutar; emit ile istemci iletisi, closeNow ile karşı uç kopar
class FakePort implements RpcPort {
  sent: unknown[] = []
  closed = false
  private msgCb: ((m: unknown) => void) | null = null
  private closeCbs: (() => void)[] = []
  send(msg: unknown): void {
    this.sent.push(msg)
  }
  onMessage(cb: (msg: unknown) => void): void {
    this.msgCb = cb
  }
  onClose(cb: () => void): void {
    this.closeCbs.push(cb)
  }
  close(): void {
    this.closed = true
  }
  emit(msg: unknown): void {
    this.msgCb?.(msg)
  }
  closeNow(): void {
    this.closed = true
    for (const cb of this.closeCbs) cb()
  }
  events(name: string): unknown[] {
    return this.sent.filter((m) => (m as { event?: string }).event === name)
  }
}

describe('RpcHub', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let deps: RpcServerDeps
  let accA: number
  let accB: number
  let groupA: number
  let groupB: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-hub-'))
    db = openDb(dir)
    q = makeQueries(db)
    const mk = (email: string) =>
      q.insertAccount({ email, displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    accA = mk('a@t.co')
    accB = mk('b@t.co')
    groupA = q.insertGroup('A', '#111111')
    groupB = q.insertGroup('B', '#222222')
    q.setAccountGroup(accA, groupA)
    q.setAccountGroup(accB, groupB)
    const stub = new Proxy({}, { get: () => () => undefined })
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

  const member = (id: number, group: number): SessionUser => ({
    id, username: `uye${id}`, role: 'member', permittedGroupIds: [group], manageableGroupIds: []
  })

  it('desktop mode new session closes previous and locks vault', () => {
    createVault(q, 'kasa-parolasi-123') // oluşturulan kasa açık başlar
    expect(getVaultStatus(q)).toBe('unlocked')
    const hub = new RpcHub(deps, 'desktop')
    const p1 = new FakePort()
    hub.openSession(p1)
    expect(getVaultStatus(q)).toBe('locked')
    // ikinci bağlantıdan önce kasa yeniden açılır: yeni port onu tekrar kilitlemeli
    expect(unlockVault(q, deps.creds, 'kasa-parolasi-123')).toBe(true)
    const p2 = new FakePort()
    const s2 = hub.openSession(p2)
    expect(p1.closed).toBe(true)
    expect(hub.sessions()).toEqual([s2])
    expect(s2.currentUser).toBeNull()
    expect(getVaultStatus(q)).toBe('locked')
    expect(p2.events('sync:hello')).toHaveLength(1)
  })

  it('server mode connect does not lock vault', () => {
    createVault(q, 'kasa-parolasi-123')
    const hub = new RpcHub(deps, 'server')
    const p1 = new FakePort()
    const s1 = hub.openSession(p1, { user: member(2, groupA) })
    const p2 = new FakePort()
    hub.openSession(p2, { user: member(3, groupB) })
    expect(getVaultStatus(q)).toBe('unlocked')
    expect(p1.closed).toBe(false)
    expect(hub.sessions()).toHaveLength(2)
    expect(s1.currentUser?.id).toBe(2)
    // sync:hello yalnız yeni oturuma
    expect(p1.events('sync:hello')).toHaveLength(1)
  })

  it('sync:hello.user: sunucu modunda oturum kullanıcısı, masaüstünde null', () => {
    const server = new RpcHub(deps, 'server')
    const ps = new FakePort()
    server.openSession(ps, { user: member(2, groupA) })
    expect(ps.events('sync:hello')).toEqual([
      { event: 'sync:hello', data: { accountCount: expect.any(Number), usersCount: expect.any(Number), user: member(2, groupA) } }
    ])
    const desktop = new RpcHub(deps, 'desktop')
    const pd = new FakePort()
    desktop.openSession(pd, { user: member(2, groupA) }) // masaüstünde hazır kullanıcı yok sayılır
    expect((pd.events('sync:hello')[0] as { data: { user: unknown } }).data.user).toBeNull()
  })

  it('broadcast filters by canView', () => {
    const hub = new RpcHub(deps, 'server')
    const pa = new FakePort()
    const pb = new FakePort()
    const pAnon = new FakePort()
    hub.openSession(pa, { user: member(2, groupA) })
    hub.openSession(pb, { user: member(3, groupB) })
    hub.openSession(pAnon)
    hub.broadcast('account:status', { accountId: accA, status: 'ok', detail: null })
    expect(pa.events('account:status')).toHaveLength(1)
    expect(pb.events('account:status')).toHaveLength(0)
    hub.broadcast('counts:changed', {})
    expect(pa.events('counts:changed')).toHaveLength(1)
    expect(pb.events('counts:changed')).toHaveLength(1)
    // girişsiz oturum olay almaz
    expect(pAnon.events('counts:changed')).toHaveLength(0)
  })

  it('body:ready carries accountId and reaches only sessions that can view it', async () => {
    const f = q.upsertFolder(accA, 'INBOX', 'inbox')
    const msgId = Number(
      db.prepare(`INSERT INTO messages (folder_id, account_id, folder_kind, uid, date, subject, flagged, thread_root) VALUES (?,?,?,?,?,?,0,?)`)
        .run(f, accA, 'inbox', 1, 1000, 'konu', '<r1>').lastInsertRowid
    )
    // gövde indirme yapılmaz: kuyruk işi hemen biter
    const hub = new RpcHub({ ...deps, scheduler: { enqueueInteractive: async () => {} } as unknown as Scheduler }, 'server')
    const pa = new FakePort()
    const pb = new FakePort()
    const pAdm = new FakePort()
    const sa = hub.openSession(pa, { user: member(2, groupA) })
    hub.openSession(pb, { user: member(3, groupB) })
    hub.openSession(pAdm, { user: { id: 1, username: 'admin', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] } })
    expect(await sa.handle('getBody', { messageId: msgId })).toEqual({ state: 'fetching' })
    await vi.waitFor(() => expect(pa.events('body:ready')).toHaveLength(1))
    expect(pa.events('body:ready')[0]).toEqual({ event: 'body:ready', data: { messageId: msgId, accountId: accA } })
    expect(pAdm.events('body:ready')).toHaveLength(1)
    expect(pb.events('body:ready')).toHaveLength(0)
  })

  it('başarısız gönderimin taslağı yalnız gönderene gider', () => {
    const hub = new RpcHub(deps, 'server')
    const psender = new FakePort()
    const pviewer = new FakePort()
    const pother = new FakePort()
    hub.openSession(psender, { user: member(2, groupA) })
    hub.openSession(pviewer, { user: member(3, groupA) })
    hub.openSession(pother, { user: member(4, groupB) })
    const draft = { accountId: accA, to: 'a@example.test', subject: 'gizli', text: 'gizli' }
    hub.broadcastOpFailed({ accountId: accA, kind: 'smtp_send', error: 'x', id: 7 }, 2, draft)
    expect(psender.events('op:failed')).toEqual([{ event: 'op:failed', data: { accountId: accA, kind: 'smtp_send', error: 'x', id: 7, own: true, draft } }])
    expect(pviewer.events('op:failed')).toEqual([{ event: 'op:failed', data: { accountId: accA, kind: 'smtp_send', error: 'x', id: 7 } }])
    expect(pother.events('op:failed')).toEqual([])
  })

  it('gönderen bilinmiyorsa taslak kimseye gitmez', () => {
    const hub = new RpcHub(deps, 'server')
    const p = new FakePort()
    hub.openSession(p, { user: member(2, groupA) })
    hub.broadcastOpFailed({ accountId: accA, kind: 'smtp_send', error: 'x', id: 7 }, undefined, { accountId: accA, to: 'a@example.test', subject: 's', text: 't' })
    expect(p.events('op:failed')).toEqual([{ event: 'op:failed', data: { accountId: accA, kind: 'smtp_send', error: 'x', id: 7 } }])
  })

  it('followups:changed sayı taşımaz', async () => {
    const hub = new RpcHub(deps, 'server')
    const pa = new FakePort()
    const pb = new FakePort()
    const sa = hub.openSession(pa, { user: { ...member(2, groupA), manageableGroupIds: [groupA] } })
    hub.openSession(pb, { user: member(3, groupB) })
    const id = q.addFollowup({ accountId: accA, opId: null, messageId: '<m@t.co>', subject: 's', to: 'a@t.co', dueAt: 1 })
    q.markDueFollowups(2)
    await sa.handle('closeFollowup', { id })
    expect(pa.events('followups:changed')).toEqual([{ event: 'followups:changed', data: {} }])
    expect(pb.events('followups:changed')).toEqual([{ event: 'followups:changed', data: {} }])
  })

  it('setGroupPermission üyenin açık sekmesine counts:changed yollar', async () => {
    const hub = new RpcHub(deps, 'server')
    const padm = new FakePort()
    const pmember = new FakePort()
    const pother = new FakePort()
    const uid = q.insertUser({ username: 'uye', passwordHash: 'h', role: 'member' })
    const admin = hub.openSession(padm, { user: { id: 1, username: 'admin', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] } })
    hub.openSession(pmember, { user: member(uid, groupA) })
    hub.openSession(pother, { user: member(uid + 1, groupA) })
    await admin.handle('setGroupPermission', { userId: uid, groupId: groupA, canView: false, canManage: false })
    expect(pmember.events('counts:changed')).toEqual([{ event: 'counts:changed', data: {} }])
    expect(pother.events('counts:changed')).toEqual([])
  })

  it('server mode rejects desktop-only methods', async () => {
    const hub = new RpcHub(deps, 'server')
    const s = hub.openSession(new FakePort(), { user: member(2, groupA) })
    await expect(s.handle('login', { username: 'x', password: 'y' })).rejects.toThrow(t('sync.server.desktopOnly'))
    const anon = hub.openSession(new FakePort())
    await expect(anon.handle('loginBiometric', {})).rejects.toThrow(t('sync.server.desktopOnly'))
    // sunucu dosya sistemi yolu: yönetici için de kapalı. OAuth yalnız web akışıyla (hub.webOAuth): kurulmamışsa
    // geri döngü akışına düşülmez
    q.prefSet('oauth_google_client_id', 'cid')
    const admin = hub.openSession(new FakePort(), {
      user: { id: 1, username: 'admin', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] }, webSessionId: 'w1'
    })
    for (const m of ['backupToFile', 'stageRestore', 'oauthStart', 'oauthFinish', 'oauthCancel']) {
      await expect(admin.handle(m, { path: '/tmp/x.sqlite', provider: 'google', flowId: 'x' }), m).rejects.toThrow(t('sync.server.desktopOnly'))
    }
  })

  it('server mode oauth goes only through the web flow of the calling web session', async () => {
    const hub = new RpcHub(deps, 'server')
    q.prefSet('oauth_google_client_id', 'cid')
    const calls: unknown[][] = []
    hub.webOAuth = {
      start: (o) => (calls.push(['start', o.owner, o.provider, o.loginHint]), { flowId: 'f1', url: 'https://saglayici/auth' }),
      cancel: (owner, flowId) => void calls.push(['cancel', owner, flowId]),
      wait: async (owner, flowId) => (calls.push(['wait', owner, flowId]), { email: 'a@gmail.com', added: true })
    }
    const admin = hub.openSession(new FakePort(), {
      user: { id: 1, username: 'admin', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] }, webSessionId: 'w1'
    })
    expect(await admin.handle('oauthStart', { provider: 'google', email: 'a@gmail.com' })).toEqual({ flowId: 'f1', url: 'https://saglayici/auth' })
    await admin.handle('oauthCancel', { flowId: 'f1' })
    expect(await admin.handle('oauthFinish', { flowId: 'f1', provider: 'google' })).toEqual({ email: 'a@gmail.com', added: true })
    expect(calls).toEqual([['start', 'w1', 'google', 'a@gmail.com'], ['cancel', 'w1', 'f1'], ['wait', 'w1', 'f1']])
    // üye: yönetici yetkisi
    const uye = hub.openSession(new FakePort(), { user: member(2, groupA), webSessionId: 'w2' })
    await expect(uye.handle('oauthStart', { provider: 'google' })).rejects.toThrow(t('sync.perm.adminRequired'))
  })

  it('oauth events go only to the owning web session', () => {
    const hub = new RpcHub(deps, 'server')
    const user = { id: 1, username: 'admin', role: 'admin' as const, permittedGroupIds: [], manageableGroupIds: [] }
    const p1 = new FakePort()
    const p1b = new FakePort()
    const p2 = new FakePort()
    hub.openSession(p1, { user, webSessionId: 'w1' })
    hub.openSession(p1b, { user, webSessionId: 'w1' })
    hub.openSession(p2, { user, webSessionId: 'w2' })
    hub.sendToWebSession('w1', 'oauth:done', { ok: true, flowId: 'f' })
    expect(p1.events('oauth:done')).toHaveLength(1)
    expect(p1b.events('oauth:done')).toHaveLength(1)
    expect(p2.events('oauth:done')).toHaveLength(0)
  })

  it('backup methods are desktop-only; oauth methods are open in server mode and stay admin-only', () => {
    const { desktopOnly, adminOnly } = RpcHub.permissionSets()
    for (const m of ['backupToFile', 'stageRestore']) expect(desktopOnly, m).toContain(m)
    for (const m of ['oauthStart', 'oauthFinish', 'oauthCancel']) expect(desktopOnly, m).not.toContain(m)
    for (const m of ['backupToFile', 'stageRestore', 'oauthStart', 'oauthFinish', 'oauthCancel']) expect(adminOnly, m).toContain(m)
  })

  it('desktop mode anonymous session receives only account-agnostic broadcasts', () => {
    const hub = new RpcHub(deps, 'desktop')
    const p = new FakePort()
    const s = hub.openSession(p)
    hub.broadcast('network:state', { online: false })
    hub.broadcast('account:status', { accountId: accB, status: 'ok', detail: null })
    hub.broadcast('counts:changed', {})
    expect(p.events('network:state')).toHaveLength(1)
    expect(p.events('account:status')).toHaveLength(0)
    expect(p.events('counts:changed')).toHaveLength(0)
    // giriş sonrası hesap olayları gelir
    s.currentUser = { id: 1, username: 'admin', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] }
    hub.broadcast('account:status', { accountId: accB, status: 'ok', detail: null })
    expect(p.events('account:status')).toHaveLength(1)
  })

  it('notifySessions filters by login, canView and per-user decision', () => {
    const hub = new RpcHub(deps, 'server')
    const pa = new FakePort()
    const pb = new FakePort()
    const pc = new FakePort()
    const pAnon = new FakePort()
    hub.openSession(pa, { user: member(2, groupA) })
    hub.openSession(pb, { user: member(3, groupB) })
    hub.openSession(pc, { user: member(4, groupA) })
    hub.openSession(pAnon)
    hub.notifySessions({ title: 'T', body: 'B', accountId: accA }, (u) => u.id !== 4)
    expect(pa.events('server:notify')).toEqual([{ event: 'server:notify', data: expect.objectContaining({ title: 'T', body: 'B', accountId: accA, messageId: null, level: 'normal', count: 1 }) }])
    expect(pb.events('server:notify')).toHaveLength(0) // hesabı görmez
    expect(pc.events('server:notify')).toHaveLength(0) // kendi tercihi hayır
    expect(pAnon.events('server:notify')).toHaveLength(0)
    hub.notifySessions({ title: 'T', body: 'B' }, () => true)
    expect(pb.events('server:notify')).toEqual([{ event: 'server:notify', data: expect.objectContaining({ title: 'T', body: 'B', accountId: null }) }])
    expect(pAnon.events('server:notify')).toHaveLength(0)
  })

  it('desktop login lockout survives new connection', async () => {
    q.insertUser({ username: 'admin', passwordHash: hashPassword('dogru-parola-1'), role: 'admin' })
    const hub = new RpcHub(deps, 'desktop')
    const s1 = hub.openSession(new FakePort())
    for (let i = 0; i < 5; i++) {
      await expect(s1.handle('login', { username: 'admin', password: 'yanlis' })).rejects.toThrow(t('sync.auth.badCredentials'))
    }
    // pencere yenilendi: yeni port, yeni oturum — doğru parola da bekleme bitene dek reddedilir
    const s2 = hub.openSession(new FakePort())
    const err = await s2.handle('login', { username: 'admin', password: 'dogru-parola-1' }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toBe(t('sync.auth.badCredentials'))
    expect(s2.currentUser).toBeNull()
  })

  it('debounced events for different accounts are not coalesced away', () => {
    vi.useFakeTimers()
    try {
      const hub = new RpcHub(deps, 'server')
      const pa = new FakePort()
      hub.openSession(pa, { user: member(2, groupA) })
      hub.broadcastDebounced('messages:changed', { accountId: accA })
      hub.broadcastDebounced('messages:changed', { accountId: accB })
      vi.advanceTimersByTime(300)
      expect(pa.events('messages:changed')).toEqual([{ event: 'messages:changed', data: { accountId: accA } }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('session removed on port close', () => {
    const hub = new RpcHub(deps, 'server')
    const p = new FakePort()
    hub.openSession(p)
    expect(hub.sessions()).toHaveLength(1)
    p.closeNow()
    expect(hub.sessions().length).toBe(0)
  })

  it('istemci isteği porttan yanıtlanır', async () => {
    const hub = new RpcHub(deps, 'desktop')
    const p = new FakePort()
    hub.openSession(p)
    p.emit({ id: 7, method: 'getAccounts', params: {} })
    await new Promise((r) => setTimeout(r, 0))
    expect(p.sent).toContainEqual(expect.objectContaining({ id: 7, ok: false }))
  })

  it('desktopOnly adları gerçek yöntemler', () => {
    const names = new Set(RpcHub.methodNames())
    for (const m of RpcHub.permissionSets().desktopOnly) expect(names.has(m), m).toBe(true)
  })
})
