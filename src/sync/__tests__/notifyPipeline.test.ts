import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../shared/i18n/locales/all'
import { tFor } from '../../shared/i18n'
import type { MessageRow, SessionUser } from '../../shared/rpc'
import type { NotifyRule } from '../../shared/notifyRules'
import { fetchNotifyBodyText } from '../bodyFetch'
import { openDb } from '../db'
import { makeQueries, type HeaderInput } from '../db/queries'
import { setSyncLog } from '../log'
import { notifyNewMail } from '../newMailNotify'
import type { PushItem } from '../../shared/pushTypes'
import { followupNotice, hostSink, NotifyPipeline, usersFor, MAX_INDIVIDUAL, type NotifySink } from '../notifyPipeline'
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
  events(name: string): { data: unknown }[] {
    return this.sent.filter((m) => (m as { event?: string }).event === name) as { data: unknown }[]
  }
}

const NOON = new Date(2026, 10, 3, 12, 0)

describe('bildirim hattı', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let deps: RpcServerDeps
  let accA: number
  let accB: number
  let groupA: number
  let folderA: number
  let folderB: number
  let uid = 0
  let delivered: { userId: number; items: PushItem[] }[]
  const stub = new Proxy({}, { get: () => () => undefined })
  const sink: NotifySink = { deliver: (userId, items) => void delivered.push({ userId, items }) }
  const fetchBodyText = vi.fn(async (): Promise<string | null> => null)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-pipe-'))
    db = openDb(dir)
    q = makeQueries(db)
    const mk = (email: string) =>
      q.insertAccount({ email, displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    accA = mk('a@t.co')
    accB = mk('b@t.co')
    groupA = q.insertGroup('A', '#111111')
    q.setAccountGroup(accA, groupA)
    folderA = q.upsertFolder(accA, 'INBOX', 'inbox')
    folderB = q.upsertFolder(accB, 'INBOX', 'inbox')
    q.prefSet('notifyScope', 'all')
    deps = {
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: async (v) => v.map((s) => new TextEncoder().encode(s)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)),
      userData: dir, dbSchemaVersion: () => 0
    }
    hub = new RpcHub(deps, 'server')
    delivered = []
    fetchBodyText.mockReset()
    fetchBodyText.mockResolvedValue(null)
    uid = 0
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const member = (name: string, groups: number[] = [groupA]): number => {
    const id = q.insertUser({ username: name, passwordHash: 'x', role: 'member' })
    for (const g of groups) q.setGroupPermission(id, g, true, false)
    return id
  }
  const admin = (name = 'yonetici'): number => q.insertUser({ username: name, passwordHash: 'x', role: 'admin' })
  const pipeline = (over: Partial<ConstructorParameters<typeof NotifyPipeline>[0]> = {}) =>
    new NotifyPipeline({ q, hub, sink, mode: 'server', windowMs: 60_000, now: () => NOON, fetchBodyText, ...over })

  const mail = (accountId: number, fromAddr: string, subject: string, over: Partial<HeaderInput> = {}): MessageRow => {
    uid++
    q.upsertHeader({
      folderId: accountId === accA ? folderA : folderB, accountId, folderKind: 'inbox', uid, messageId: `<m${uid}@t>`, inReplyTo: null, subject, fromName: null, fromAddr,
      toJson: null, date: 1_700_000_000_000 + uid, size: 10, seen: false, flagged: false, answered: false, hasAttachments: false,
      listUnsubscribe: null, listUnsubscribePost: null, rulesEligible: true, ...over
    })
    return q.pendingRuleMessages(accountId, 500).at(-1)!
  }
  const mails = (accountId: number, n: number): MessageRow[] => Array.from({ length: n }, (_, i) => mail(accountId, `x${i}@y.co`, `konu ${i}`))
  const rule = (userId: number, groups: NotifyRule['groups'], level: NotifyRule['level']): NotifyRule =>
    q.saveNotifyRule(userId, { id: 0, name: 'k', enabled: true, position: 0, groups, level }, 1)!
  const quiet = (userId: number) => {
    q.userPrefSet(userId, 'notifyQuiet', '1')
    q.userPrefSet(userId, 'notifyQuietStart', '11:00')
    q.userPrefSet(userId, 'notifyQuietEnd', '13:00')
  }
  const itemsFor = (userId: number): PushItem[] => delivered.filter((d) => d.userId === userId).flatMap((d) => d.items)

  it('decides for user with no open session', async () => {
    const u = admin()
    expect(hub.sessions()).toHaveLength(0)
    const p = pipeline()
    await p.onNewMail(accA, [mail(accA, 'x@y.co', 'merhaba')])
    await p.flush()
    expect(itemsFor(u)).toHaveLength(1)
    expect(itemsFor(u)[0]).toMatchObject({ title: 'a@t.co', accountId: accA, messageId: null, level: 'normal', count: 1 })
  })

  it('200 messages one summary', async () => {
    const u = admin()
    const p = pipeline()
    await p.onNewMail(accA, mails(accA, 200))
    await p.flush()
    expect(itemsFor(u)).toHaveLength(1)
    expect(itemsFor(u)[0].count).toBe(200)
  })

  it('kural eşleşen 200 iletide en çok 5 bireysel, kalanı tek özet', async () => {
    const u = admin()
    rule(u, [[{ field: 'subject', value: 'konu' }]], 'normal')
    const p = pipeline()
    await p.onNewMail(accA, mails(accA, 200))
    await p.flush()
    const items = itemsFor(u)
    expect(items.filter((i) => i.messageId != null)).toHaveLength(MAX_INDIVIDUAL)
    const summary = items.filter((i) => i.messageId == null)
    expect(summary).toHaveLength(1)
    expect(summary[0].count).toBe(195)
  })

  it('üst sınıra takılan acil iletiler öne alınır, özet de sessiz saati deler', async () => {
    const u = admin()
    quiet(u)
    rule(u, [[{ field: 'subject', value: 'acil' }]], 'urgent')
    const p = pipeline()
    await p.onNewMail(accA, [...mails(accA, 3), ...Array.from({ length: 7 }, (_, i) => mail(accA, 'x@y.co', `acil ${i}`))])
    await p.flush()
    const items = itemsFor(u)
    expect(items.filter((i) => i.messageId != null).every((i) => i.level === 'urgent')).toBe(true)
    expect(items.find((i) => i.messageId == null)).toMatchObject({ count: 2, level: 'urgent' })
  })

  it('kapsam kapalıyken üst sınırı aşan VIP iletiler kaybolmaz', async () => {
    const u = admin()
    q.userPrefSet(u, 'notifyScope', 'off')
    q.userPrefSet(u, 'notifyVip', '@firma.co')
    const p = pipeline()
    await p.onNewMail(accA, Array.from({ length: 7 }, (_, i) => mail(accA, 'ceo@firma.co', `s${i}`)))
    await p.flush()
    expect(itemsFor(u)).toHaveLength(6)
    expect(itemsFor(u).at(-1)!.count).toBe(2)
  })

  it('body fetch capped', async () => {
    const u = admin()
    rule(u, [[{ field: 'body', value: 'gizli' }]], 'urgent')
    fetchBodyText.mockResolvedValue('içinde gizli söz')
    const rows = mails(accA, 21)
    const p = pipeline()
    await p.onNewMail(accA, rows)
    await p.flush()
    expect(fetchBodyText).toHaveBeenCalledTimes(20)
    expect(fetchBodyText).not.toHaveBeenCalledWith(rows[20].id)
  })

  it('metnin yalnız ilk 200 KB kısmına bakılır', async () => {
    const u = admin()
    rule(u, [[{ field: 'body', value: 'gizli' }]], 'urgent')
    fetchBodyText.mockResolvedValue(`${'a'.repeat(200 * 1024)}gizli`)
    const p = pipeline()
    await p.onNewMail(accA, [mail(accA, 'x@y.co', 'k')])
    await p.flush()
    expect(itemsFor(u).filter((i) => i.level === 'urgent')).toHaveLength(0)
  })

  it('gövde kuralı yoksa, kural kapalıysa ya da hesap kasaysa gövde çekilmez', async () => {
    const u = admin()
    const p = pipeline()
    await p.onNewMail(accA, [mail(accA, 'x@y.co', 'k')])
    q.saveNotifyRule(u, { id: 0, name: 'k', enabled: false, position: 0, groups: [[{ field: 'body', value: 'g' }]], level: 'urgent' }, 1)
    await p.onNewMail(accA, [mail(accA, 'x@y.co', 'k')])
    expect(fetchBodyText).not.toHaveBeenCalled()
    rule(u, [[{ field: 'body', value: 'g' }]], 'urgent')
    db.prepare('UPDATE accounts SET secure = 1 WHERE id = ?').run(accB)
    await p.onNewMail(accB, [mail(accB, 'x@y.co', 'k')])
    expect(fetchBodyText).not.toHaveBeenCalled()
    p.stop()
  })

  it('gövde çekimi hata verirse iletinin bildirimi düşmez', async () => {
    const u = admin()
    rule(u, [[{ field: 'body', value: 'g' }]], 'urgent')
    fetchBodyText.mockRejectedValue(new Error('imap'))
    const p = pipeline()
    await p.onNewMail(accA, [mail(accA, 'x@y.co', 'k')])
    await p.flush()
    expect(itemsFor(u)).toHaveLength(1)
  })

  it('account off silences', async () => {
    const u = admin()
    q.userPrefSet(u, 'notifyVip', '@firma.co')
    rule(u, [[{ field: 'subject', value: 'k' }]], 'urgent')
    q.setNotifyAccountPref(u, accA, 'off')
    const p = pipeline()
    await p.onNewMail(accA, [mail(accA, 'ceo@firma.co', 'k')], new Map())
    await p.flush()
    expect(delivered).toHaveLength(0)
  })

  it('account on overrides scope', async () => {
    const u = admin()
    q.userPrefSet(u, 'notifyScope', 'starred')
    q.setNotifyAccountPref(u, accA, 'on')
    const p = pipeline()
    await p.onNewMail(accA, [mail(accA, 'x@y.co', 'k')])
    await p.onNewMail(accB, [mail(accB, 'x@y.co', 'k')])
    await p.flush()
    expect(itemsFor(u).map((i) => i.accountId)).toEqual([accA])
  })

  it('silent rule produces nothing', async () => {
    const u = admin()
    q.userPrefSet(u, 'notifyVip', '@firma.co')
    rule(u, [[{ field: 'domain', value: 'firma.co' }]], 'silent')
    const p = pipeline()
    await p.onNewMail(accA, [mail(accA, 'ceo@firma.co', 'k')], new Map([[1, 'rule-urgent']]))
    await p.flush()
    expect(delivered).toHaveLength(0)
  })

  it('urgent passes quiet hours', async () => {
    const u = admin()
    quiet(u)
    rule(u, [[{ field: 'subject', value: 'k' }]], 'urgent')
    const p = pipeline()
    await p.onNewMail(accA, [mail(accA, 'x@y.co', 'k')])
    await p.flush()
    expect(itemsFor(u)[0]).toMatchObject({ level: 'urgent', title: tFor('tr', 'sync.notify.titleUrgent', { from: 'x@y.co' }) })
  })

  it("normal doesn't", async () => {
    const u = admin()
    quiet(u)
    rule(u, [[{ field: 'subject', value: 'k' }]], 'normal')
    const p = pipeline()
    await p.onNewMail(accA, [mail(accA, 'x@y.co', 'k'), mail(accA, 'x@y.co', 'başka')])
    await p.flush()
    expect(delivered).toHaveLength(0)
  })

  it('VIP sessiz saati geçer ve kişi başına değerlendirilir', async () => {
    const a = admin('a')
    const b = admin('b')
    q.userPrefSet(a, 'notifyVip', '@firma.co')
    q.userPrefSet(b, 'notifyScope', 'off')
    quiet(a)
    const p = pipeline()
    await p.onNewMail(accA, [mail(accA, 'ceo@firma.co', 'k')])
    await p.flush()
    expect(itemsFor(a)[0].title).toBe(tFor('tr', 'sync.notify.titleVip', { from: 'ceo@firma.co' }))
    expect(itemsFor(b)).toHaveLength(0)
  })

  it('kişisel kural VIP ve otomasyondan önce gelir', async () => {
    const u = admin()
    q.userPrefSet(u, 'notifyVip', '@firma.co')
    quiet(u)
    rule(u, [[{ field: 'domain', value: 'firma.co' }]], 'normal')
    const row = mail(accA, 'ceo@firma.co', 'k')
    const p = pipeline()
    await p.onNewMail(accA, [row], new Map([[row.id, 'rule-urgent']]))
    await p.flush()
    expect(delivered).toHaveLength(0)
  })

  it('otomasyon notify eylemi hesabı gören herkese ulaşır', async () => {
    const a = admin('a')
    const m = member('m')
    q.userPrefSet(a, 'notifyScope', 'off')
    q.userPrefSet(m, 'notifyScope', 'off')
    const row = mail(accA, 'x@y.co', 'yedek')
    const p = pipeline()
    await p.onNewMail(accA, [row], new Map([[row.id, 'rule-urgent']]))
    await p.flush()
    for (const id of [a, m]) expect(itemsFor(id)).toEqual([expect.objectContaining({ messageId: row.id, level: 'urgent' })])
  })

  it('member not notified for invisible account', async () => {
    const a = admin()
    const m = member('m')
    const p = pipeline()
    await p.onNewMail(accB, [mail(accB, 'x@y.co', 'k')], new Map())
    await p.flush()
    expect(itemsFor(a)).toHaveLength(1)
    expect(itemsFor(m)).toHaveLength(0)
    expect(usersFor(q, accB)).toEqual([a])
    expect(usersFor(q, accA).sort()).toEqual([a, m].sort())
  })

  it('devre dışı kullanıcıya bildirim yok', async () => {
    const m = member('m')
    q.updateUserFields(m, { enabled: 0 })
    expect(usersFor(q, accA)).toEqual([])
  })

  it('multi-account summary', async () => {
    const u = admin()
    const p = pipeline()
    await p.onNewMail(accA, mails(accA, 2))
    await p.onNewMail(accB, mails(accB, 3))
    await p.flush()
    expect(itemsFor(u)).toHaveLength(1)
    expect(itemsFor(u)[0]).toMatchObject({
      accountId: null, messageId: null, count: 5,
      body: tFor('tr', 'sync.notify.newMailMulti', { accounts: 2, count: 5 })
    })
  })

  it('user language', async () => {
    const a = admin('a')
    const b = admin('b')
    q.userPrefSet(a, 'locale', 'en')
    q.userPrefSet(b, 'locale', 'de')
    const p = pipeline()
    await p.onNewMail(accA, mails(accA, 2))
    await p.flush()
    expect(itemsFor(a)[0].body).toBe(tFor('en', 'sync.notify.newMail', { count: 2 }))
    expect(itemsFor(b)[0].body).toBe(tFor('de', 'sync.notify.newMail', { count: 2 }))
    expect(itemsFor(a)[0].body).not.toBe(itemsFor(b)[0].body)
  })

  it('setSessionLocale kullanıcının diline yazılır', async () => {
    const u = admin()
    const port = new FakePort()
    const s = hub.openSession(port, { user: { id: u, username: 'y', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] } })
    await s.handle('setSessionLocale', { locale: 'fr' })
    expect(q.userPrefGet(u, 'locale')).toBe('fr')
  })

  it('pencere dolunca teslim edilir, pencere içindekiler birikir', async () => {
    vi.useFakeTimers()
    try {
      const u = admin()
      const p = pipeline({ windowMs: 3000 })
      await p.onNewMail(accA, mails(accA, 1))
      await vi.advanceTimersByTimeAsync(2000)
      await p.onNewMail(accA, mails(accA, 2))
      expect(delivered).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1000)
      expect(itemsFor(u)).toHaveLength(1)
      expect(itemsFor(u)[0].count).toBe(3)
      p.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop kararı verilmişleri teslim eder, sonrası sessiz', async () => {
    const u = admin()
    const p = pipeline()
    await p.onNewMail(accA, mails(accA, 1))
    p.stop()
    expect(itemsFor(u)).toHaveLength(1)
    await p.onNewMail(accA, mails(accA, 1))
    p.notice({ title: 't', body: 'b', accountId: accA })
    await p.flush()
    expect(itemsFor(u)).toHaveLength(1)
  })

  describe('gövde bekleyen iletiler', () => {
    const never = () => new Promise<string | null>(() => {})

    it('başka kullanıcının gövde kuralı VIP bildirimini bekletmez', async () => {
      const a = admin('a')
      const b = admin('b')
      rule(a, [[{ field: 'body', value: 'g' }]], 'urgent')
      q.userPrefSet(b, 'notifyVip', '@firma.co')
      fetchBodyText.mockImplementation(never)
      const p = pipeline({ windowMs: 1, bodyBudgetMs: 60_000 })
      void p.onNewMail(accA, [mail(accA, 'ceo@firma.co', 'k')])
      await vi.waitFor(() => expect(itemsFor(b)).toHaveLength(1))
      expect(itemsFor(a)).toHaveLength(0)
      p.stop()
    })

    it('gövde kuralı sonucu değiştiremeyecekse çekilmez ve beklenmez', async () => {
      const u = admin()
      rule(u, [[{ field: 'subject', value: 'ilk' }]], 'urgent') // önce eşleşen kural
      rule(u, [[{ field: 'body', value: 'g' }]], 'silent')
      rule(u, [[{ field: 'from', value: 'patron' }, { field: 'body', value: 'g' }]], 'silent') // diğer koşulu tutmuyor
      const p = pipeline()
      await p.onNewMail(accA, [mail(accA, 'x@y.co', 'ilk konu')])
      await p.flush()
      expect(itemsFor(u)[0].level).toBe('urgent')
      expect(fetchBodyText).not.toHaveBeenCalled()
    })

    it('kişi kendi önceki gövde kuralı için bekler: sonraki düşük kural öne geçmez', async () => {
      const u = admin()
      rule(u, [[{ field: 'body', value: 'gizli' }]], 'silent')
      rule(u, [[{ field: 'subject', value: 'k' }]], 'urgent')
      fetchBodyText.mockResolvedValue('gizli metin')
      const p = pipeline()
      await p.onNewMail(accA, [mail(accA, 'x@y.co', 'k')])
      await p.flush()
      expect(delivered).toHaveLength(0)
    })

    it('süre bütçesi dolunca çekim durur, kalanlar gövdesiz değerlendirilir', async () => {
      const u = admin()
      rule(u, [[{ field: 'body', value: 'g', not: true }]], 'silent')
      fetchBodyText.mockImplementation(never)
      const p = pipeline({ bodyBudgetMs: 20 })
      await p.onNewMail(accA, mails(accA, 3))
      await p.flush()
      expect(fetchBodyText).toHaveBeenCalledTimes(1)
      expect(itemsFor(u)[0].count).toBe(3) // gövdesiz "değil" koşulu tutmaz: özet adayı
    })

    it('ilk hatada durur; günlükte yalnız ileti kimliği ve hata sınıfı', async () => {
      const u = admin()
      rule(u, [[{ field: 'body', value: 'g' }]], 'urgent')
      fetchBodyText.mockRejectedValue(new TypeError('gizli içerik'))
      const logged: unknown[] = []
      setSyncLog({ info() {}, warn: (...a: unknown[]) => logged.push(a), error() {} } as never)
      const rows = mails(accA, 3)
      const p = pipeline()
      await p.onNewMail(accA, rows)
      await p.flush()
      setSyncLog(null as never)
      expect(fetchBodyText).toHaveBeenCalledTimes(1)
      expect(itemsFor(u)[0].count).toBe(3)
      expect(JSON.stringify(logged)).toContain('TypeError')
      expect(JSON.stringify(logged)).toContain(String(rows[0].id))
      expect(JSON.stringify(logged)).not.toContain('gizli')
    })
  })

  it('kasa hesabında bildirim içerik taşımaz', async () => {
    const u = admin()
    db.prepare('UPDATE accounts SET secure = 1 WHERE id = ?').run(accA)
    rule(u, [[{ field: 'subject', value: 'gizli' }]], 'urgent')
    const row = { ...mail(accA, 'x@y.co', 'gizli konu'), subject: 'gizli konu' }
    const p = pipeline()
    await p.onNewMail(accA, [row])
    await p.flush()
    const [item] = itemsFor(u)
    expect(item).toMatchObject({ title: 'a@t.co', level: 'urgent', messageId: row.id })
    expect(JSON.stringify(item)).not.toContain('gizli')
    expect(JSON.stringify(item)).not.toContain('x@y.co')
  })

  it('kilitli kasa iletisi için bildirim yok', async () => {
    admin()
    const p = pipeline()
    await p.onNewMail(accA, [{ ...mail(accA, 'x@y.co', 'k'), locked: true }])
    await p.flush()
    expect(delivered).toHaveLength(0)
  })

  it('to koşulu to_json alıcılarına bakar', async () => {
    const u = admin()
    rule(u, [[{ field: 'to', value: 'muhasebe@' }]], 'urgent')
    const p = pipeline()
    const to = JSON.stringify([{ name: 'M', address: 'muhasebe@firma.co' }])
    await p.onNewMail(accA, [mail(accA, 'x@y.co', 'k', { toJson: to }), { ...mail(accA, 'x@y.co', 'k2'), toJson: '{bozuk' }])
    await p.flush()
    expect(itemsFor(u).filter((i) => i.level === 'urgent')).toHaveLength(1)
  })

  it('followup goes only to its owner and respects quiet hours', async () => {
    const owner = member('sahip')
    const other = member('diger')
    const a = admin()
    const quietOwner = member('sessiz')
    quiet(quietOwner)
    const p = pipeline()
    p.notice({ title: 'T', body: 'B', accountId: accA, userIds: [owner] })
    p.notice({ title: 'T2', body: 'B2', accountId: accA, userIds: [quietOwner] })
    await p.flush()
    expect(itemsFor(owner)).toEqual([expect.objectContaining({ title: 'T', body: 'B', accountId: accA, messageId: null, level: 'normal', count: 1 })])
    expect(itemsFor(other)).toHaveLength(0)
    expect(itemsFor(a)).toHaveLength(0)
    expect(itemsFor(quietOwner)).toHaveLength(0)
  })

  it('hesabı artık görmeyen sahibe takip gitmez; sahipsiz bildirim hesabı görenlere', async () => {
    const m = member('m', [])
    const a = admin()
    const p = pipeline()
    p.notice({ title: 'T', body: 'B', accountId: accA, userIds: [m] })
    p.notice({ title: 'U', body: 'B', accountId: accA })
    await p.flush()
    expect(itemsFor(m)).toHaveLength(0)
    expect(itemsFor(a).map((i) => i.title)).toEqual(['U'])
  })

  it('hesabı kapatan kullanıcıya anomali bildirimi gitmez', async () => {
    const u = admin()
    q.setNotifyAccountPref(u, accA, 'off')
    const p = pipeline()
    p.notice({ title: 'U', body: 'B', accountId: accA })
    await p.flush()
    expect(delivered).toHaveLength(0)
  })

  it('üst sınırı aşan duyurular tek satıra iner, posta özetine karışmaz', async () => {
    const u = admin()
    const p = pipeline()
    for (let i = 0; i < 8; i++) p.notice({ title: `T${i}`, body: 'B', accountId: accA })
    await p.flush()
    const items = itemsFor(u)
    expect(items).toHaveLength(MAX_INDIVIDUAL + 1)
    expect(items.at(-1)).toMatchObject({ count: 3, body: tFor('tr', 'sync.notify.moreNotices', { count: 3 }), accountId: null })
  })

  const render = (v: string | ((l: 'tr' | 'en') => string), l: 'tr' | 'en') => (typeof v === 'string' ? v : v(l))

  it('followupNotice: sahip taşınır, metin alıcının dilinde, kasa hesabında konu ve alıcı yazılmaz', () => {
    const f = { id: 1, accountId: accA, subject: null, to: 'ali@y.co', userId: 7 }
    const n = followupNotice(q, f)
    expect(n).toMatchObject({ accountId: accA, userIds: [7] })
    expect(render(n.title, 'en')).toBe(tFor('en', 'sync.notify.noReply'))
    expect(render(n.body, 'en')).toContain(tFor('en', 'sync.notify.noSubject'))
    expect(render(n.body, 'en')).toContain('ali@y.co')
    expect(followupNotice(q, { ...f, userId: null }).userIds).toBeUndefined()
    db.prepare('UPDATE accounts SET secure = 1 WHERE id = ?').run(accA)
    expect(render(followupNotice(q, f).body, 'tr')).toBe('a@t.co')
  })

  it('duyuru metni kullanıcının dilinde yazılır', async () => {
    const a = admin('a')
    q.userPrefSet(a, 'locale', 'en')
    const p = pipeline()
    p.notice({ title: (l) => tFor(l, 'sync.notify.noReply'), body: 'b', accountId: accA })
    await p.flush()
    expect(itemsFor(a)[0].title).toBe(tFor('en', 'sync.notify.noReply'))
  })

  it('takip sahibi kayda geçer; süresi dolan bildirilene dek bekler', () => {
    const u = admin()
    q.addFollowup({ accountId: accA, opId: null, messageId: '<x>', subject: 's', to: 't', dueAt: 5, userId: u }, 1)
    q.addFollowup({ accountId: accA, opId: null, messageId: '<y>', subject: 's', to: 't', dueAt: 5 }, 1)
    q.markDueFollowups(10)
    expect(q.followupsToNotify().map((f) => f.userId).sort()).toEqual([null, u].sort())
    q.markFollowupNotified(q.followupsToNotify()[0].id, 11)
    expect(q.followupsToNotify()).toHaveLength(1)
  })

  it('sessiz saatte dolan takip kaybolmaz: saat bitince bir kez bildirilir', async () => {
    const u = admin()
    quiet(u)
    q.addFollowup({ accountId: accA, opId: null, messageId: '<x>', subject: 's', to: 't', dueAt: 5, userId: u }, 1)
    let now = NOON
    const p = pipeline({ now: () => now })
    q.markDueFollowups(10)
    p.deliverDueFollowups()
    await p.flush()
    expect(delivered).toHaveLength(0)
    expect(q.listFollowups(null).filter((f) => f.state === 'due')).toHaveLength(1) // arayüz yine görür
    now = new Date(2026, 10, 3, 13, 1)
    p.deliverDueFollowups()
    p.deliverDueFollowups()
    await p.flush()
    expect(itemsFor(u)).toHaveLength(1)
    expect(q.followupsToNotify()).toHaveLength(0)
  })

  it('takip kapanırsa sessiz saat sonrası bildirilmez', async () => {
    const u = admin()
    quiet(u)
    const id = q.addFollowup({ accountId: accA, opId: null, messageId: '<x>', subject: 's', to: 't', dueAt: 5, userId: u }, 1)
    const p = pipeline()
    q.markDueFollowups(10)
    p.deliverDueFollowups()
    q.closeFollowup(id)
    expect(q.followupsToNotify()).toHaveLength(0)
  })

  it('teslim edilemeyen takip işaretlenmez', async () => {
    const u = admin()
    q.addFollowup({ accountId: accA, opId: null, messageId: '<x>', subject: 's', to: 't', dueAt: 5, userId: u }, 1)
    q.markDueFollowups(10)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = pipeline({ sink: { deliver: () => { throw new Error('teslim') } } })
    p.deliverDueFollowups()
    await p.flush()
    err.mockRestore()
    expect(q.followupsToNotify()).toHaveLength(1)
  })

  it('kimseye gitmeyecek takip beklemede kalmaz', async () => {
    const m = member('m', [])
    q.addFollowup({ accountId: accA, opId: null, messageId: '<x>', subject: 's', to: 't', dueAt: 5, userId: m }, 1)
    const p = pipeline()
    q.markDueFollowups(10)
    p.deliverDueFollowups()
    expect(q.followupsToNotify()).toHaveLength(0)
  })

  describe('masaüstü', () => {
    const desktop = () => {
      const h = new RpcHub(deps, 'desktop')
      const notes: unknown[] = []
      const p = pipeline({ hub: h, mode: 'desktop', sink: hostSink({ notify: (n) => notes.push(n) }) })
      return { h, notes, p }
    }

    it('desktop without rules unchanged', async () => {
      const { notes, p } = desktop()
      admin()
      await p.onNewMail(accA, mails(accA, 2))
      await p.flush()
      expect(notes).toEqual([expect.objectContaining({ title: 'a@t.co', body: tFor('tr', 'sync.notify.newMail', { count: 2 }), accountId: accA, actions: [] })])
    })

    it('kimse girişli değilken kişisel hatırlatmanın başlığı görünmez', async () => {
      const { notes, p } = desktop()
      p.notice({ title: 'Doktor randevusu', anonymousTitle: () => 'Takvim', body: () => 'b', accountId: null, userIds: [admin()] })
      await p.flush()
      expect(JSON.stringify(notes)).not.toContain('Doktor')
    })

    it('hiç kullanıcı yokken genel tercihle çalışır', async () => {
      const { notes, p } = desktop()
      await p.onNewMail(accA, mails(accA, 1))
      await p.flush()
      expect(notes).toHaveLength(1)
    })

    it('girişli kullanıcı yoksa ilk admin, varsa o karar verir', async () => {
      const { h, notes, p } = desktop()
      const adm = admin()
      q.userPrefSet(adm, 'notifyScope', 'off')
      h.openSession(new FakePort())
      await p.onNewMail(accA, mails(accA, 1))
      await p.flush()
      expect(notes).toHaveLength(0)
      const m = member('uye')
      const su: SessionUser = { id: m, username: 'uye', role: 'member', permittedGroupIds: [groupA], manageableGroupIds: [] }
      h.sessions()[0].currentUser = su
      await p.onNewMail(accA, mails(accA, 1))
      await p.flush()
      expect(notes).toHaveLength(1)
      // gördüğü hesap dışındaki iletide girişli üye için bildirim yok
      await p.onNewMail(accB, mails(accB, 1))
      await p.flush()
      expect(notes).toHaveLength(1)
    })

    it('bireysel bildirim messageId taşır, dil süreç dilidir', async () => {
      const { notes, p } = desktop()
      const u = admin()
      q.userPrefSet(u, 'locale', 'en')
      rule(u, [[{ field: 'subject', value: 'k' }]], 'normal')
      const row = mail(accA, 'x@y.co', 'k')
      await p.onNewMail(accA, [row])
      await p.flush()
      expect(notes).toEqual([expect.objectContaining({ title: 'x@y.co', body: 'k — a@t.co', accountId: accA, messageId: row.id })])
    })

    const login = (h: RpcHub, id: number, name: string) => {
      const su: SessionUser = { id, username: name, role: 'admin', permittedGroupIds: [], manageableGroupIds: [] }
      h.openSession(new FakePort()).currentUser = su // masaüstünde giriş RPC ile gelir
    }

    it('kimse girişli değilken takip sahibi kim olursa olsun gösterilir', async () => {
      const { notes, p } = desktop()
      const adm = admin()
      p.notice({ title: 'T', body: 'B', accountId: accA, userIds: [adm + 1] })
      await p.flush()
      expect(notes).toHaveLength(1)
    })

    it('başka kullanıcı girişliyse takip gösterilmez, sahibi girişliyse gösterilir', async () => {
      const { h, notes, p } = desktop()
      const adm = admin()
      login(h, adm, 'yonetici')
      p.notice({ title: 'T', body: 'B', accountId: accA, userIds: [adm + 1] })
      p.notice({ title: 'T2', body: 'B', accountId: accA, userIds: [adm] })
      await p.flush()
      expect(notes).toEqual([expect.objectContaining({ title: 'T2' })])
    })

    it('pencere içinde girişli kullanıcı değişirse bekleyen atılır', async () => {
      const { h, notes, p } = desktop()
      const a = admin('a')
      const b = admin('b')
      login(h, a, 'a')
      await p.onNewMail(accA, mails(accA, 1))
      h.sessions()[0].currentUser = { id: b, username: 'b', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] }
      await p.flush()
      expect(notes).toHaveLength(0)
    })

    it('pencere içinde çıkış yapılırsa bekleyen atılır', async () => {
      const { h, notes, p } = desktop()
      const a = admin('a')
      login(h, a, 'a')
      await p.onNewMail(accA, mails(accA, 1))
      h.sessions()[0].currentUser = null
      await p.flush()
      expect(notes).toHaveLength(0)
    })

    describe('gövde beklerken oturum değişir', () => {
      const waiting = (h: RpcHub, a: number) => {
        rule(a, [[{ field: 'body', value: 'g' }]], 'urgent')
        login(h, a, 'a')
        let release: (v: string) => void = () => {}
        fetchBodyText.mockImplementation(() => new Promise((r) => (release = r)))
        return { release: (v: string) => release(v) }
      }

      it('çıkış yapılırsa ileti teslim edilmez', async () => {
        const { h, notes, p } = desktop()
        const a = admin('a')
        const w = waiting(h, a)
        const job = p.onNewMail(accA, [mail(accA, 'x@y.co', 'k')])
        await vi.waitFor(() => expect(fetchBodyText).toHaveBeenCalled())
        h.sessions()[0].currentUser = null
        w.release('g')
        await job
        await p.flush()
        expect(notes).toHaveLength(0)
      })

      it('başka kullanıcı girerse ileti düşer', async () => {
        const { h, notes, p } = desktop()
        const a = admin('a')
        const b = admin('b')
        const w = waiting(h, a)
        const job = p.onNewMail(accA, [mail(accA, 'x@y.co', 'k')])
        await vi.waitFor(() => expect(fetchBodyText).toHaveBeenCalled())
        h.sessions()[0].currentUser = { id: b, username: 'b', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] }
        w.release('g')
        await job
        await p.flush()
        expect(notes).toHaveLength(0)
      })
    })

    describe('takip teslimi', () => {
      const followup = (userId: number) => {
        q.addFollowup({ accountId: accA, opId: null, messageId: `<f${userId}>`, subject: 's', to: 't', dueAt: 5, userId }, 1)
        q.markDueFollowups(10)
      }

      it('başka kullanıcı girişliyken işaretlenmez, sahibi girince gösterilir', async () => {
        const { h, notes, p } = desktop()
        const a = admin('a')
        const b = admin('b')
        followup(a)
        login(h, b, 'b')
        p.deliverDueFollowups()
        await p.flush()
        expect(notes).toHaveLength(0)
        expect(q.followupsToNotify()).toHaveLength(1)
        h.sessions()[0].currentUser = { id: a, username: 'a', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] }
        p.deliverDueFollowups()
        await p.flush()
        expect(notes).toHaveLength(1)
        expect(q.followupsToNotify()).toHaveLength(0)
      })

      it('girişli üye hesabı görmüyorsa işaretlenmez', async () => {
        const { h, notes, p } = desktop()
        const a = admin('a')
        const m = member('m', [])
        followup(a)
        login(h, m, 'm')
        h.sessions()[0].currentUser = { id: m, username: 'm', role: 'member', permittedGroupIds: [], manageableGroupIds: [] }
        p.notice({ title: 'U', body: 'B', accountId: accA }) // sahipsiz duyuru da gitmez
        p.deliverDueFollowups()
        await p.flush()
        expect(notes).toHaveLength(0)
        expect(q.followupsToNotify()).toHaveLength(1)
      })

      it('pencerede kullanıcı değişip bildirim atılırsa işaretlenmez, sonra gider', async () => {
        const { h, notes, p } = desktop()
        const a = admin('a')
        const b = admin('b')
        followup(a)
        login(h, a, 'a')
        p.deliverDueFollowups()
        p.deliverDueFollowups() // pencerede ikinci kez sıraya girmez
        h.sessions()[0].currentUser = { id: b, username: 'b', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] }
        await p.flush()
        expect(notes).toHaveLength(0)
        expect(q.followupsToNotify()).toHaveLength(1)
        h.sessions()[0].currentUser = { id: a, username: 'a', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] }
        p.deliverDueFollowups()
        await p.flush()
        expect(notes).toHaveLength(1)
        expect(q.followupsToNotify()).toHaveLength(0)
      })
    })

    it('kimse girişli değilken karar verilen, aynı kişi girince teslim edilir', async () => {
      const { h, notes, p } = desktop()
      const a = admin('a')
      await p.onNewMail(accA, mails(accA, 1))
      login(h, a, 'a')
      await p.flush()
      expect(notes).toHaveLength(1)
    })
  })

  it('notifyUser yalnız o kullanıcının oturumlarına yayınlar', async () => {
    const a = admin('a')
    const m = member('m', [])
    const pa = new FakePort()
    const pm = new FakePort()
    hub.openSession(pa, { user: { id: a, username: 'a', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] } })
    hub.openSession(pm, { user: { id: m, username: 'm', role: 'member', permittedGroupIds: [], manageableGroupIds: [] } })
    const p = pipeline({ sink: { deliver: (userId, items) => items.forEach((i) => hub.notifyUser(userId, { ...i, actions: [] })) } })
    await p.onNewMail(accA, mails(accA, 1))
    await p.flush()
    expect(pa.events('server:notify')).toEqual([
      { event: 'server:notify', data: expect.objectContaining({ title: 'a@t.co', accountId: accA, messageId: null, level: 'normal', count: 1 }) }
    ])
    expect(pm.events('server:notify')).toHaveLength(0)
  })

  it('notifyNewMail: otomasyon turu bitince hat çalışır, watermark ikinci turda tekrar ettirmez', async () => {
    const u = admin()
    q.insertRule({ name: 'yedek', accountId: null, groupId: null, conditions: { subjectContains: 'FAILED' }, actions: [{ type: 'notify', urgent: true }] })
    rule(u, [[{ field: 'body', value: 'g' }]], 'silent')
    const inTx: boolean[] = []
    fetchBodyText.mockImplementation(async () => (inTx.push(db.inTransaction), null))
    const row = mail(accA, 'x@y.co', 'Job FAILED')
    const p = pipeline()
    const ctx = { q, opq: { kick() {} } as unknown as OpQueue, hub, pipeline: p }
    await notifyNewMail(ctx, accA)
    await notifyNewMail(ctx, accA)
    await p.flush()
    expect(inTx).toEqual([false])
    expect(itemsFor(u)).toEqual([expect.objectContaining({ messageId: row.id, level: 'urgent', tag: `msg:${row.id}` })])
  })

  it('notifyNewMail: 500 satırı aşan varış yeni posta beklemeden tamamlanır', async () => {
    const u = admin()
    for (let i = 0; i < 501; i++) mail(accA, 'x@y.co', `s${i}`)
    const p = pipeline()
    await notifyNewMail({ q, opq: { kick() {} } as unknown as OpQueue, hub, pipeline: p }, accA)
    await p.flush()
    expect(itemsFor(u)[0].count).toBe(501)
  }, 30_000)

  it('notifyNewMail: rule:matched yayını patlasa da parti kaybolmaz', async () => {
    const u = admin()
    q.insertRule({ name: 'y', accountId: null, groupId: null, conditions: { subjectContains: 'FAILED' }, actions: [{ type: 'notify' }] })
    const row = mail(accA, 'x@y.co', 'Job FAILED')
    vi.spyOn(hub, 'broadcast').mockImplementation(() => {
      throw new Error('yayın')
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = pipeline()
    await notifyNewMail({ q, opq: { kick() {} } as unknown as OpQueue, hub, pipeline: p }, accA)
    await p.flush()
    err.mockRestore()
    expect(itemsFor(u)).toEqual([expect.objectContaining({ messageId: row.id })])
  })

  describe('fetchNotifyBodyText', () => {
    it('kasa hesabına dokunmaz; önbellekteki metni döndürür, yoksa indirir', async () => {
      const row = mail(accA, 'x@y.co', 'k')
      const download = vi.fn(async () => q.saveBody(row.id, null, '<p>Merhaba</p>', 10))
      expect(await fetchNotifyBodyText(q, row.id, download)).toContain('Merhaba')
      expect(download).toHaveBeenCalledTimes(1)
      expect(await fetchNotifyBodyText(q, row.id, download)).toContain('Merhaba')
      expect(download).toHaveBeenCalledTimes(1)
      const other = mail(accA, 'x@y.co', 'k2')
      db.prepare('UPDATE accounts SET secure = 1 WHERE id = ?').run(accA)
      expect(await fetchNotifyBodyText(q, other.id, download)).toBeNull()
      expect(download).toHaveBeenCalledTimes(1)
      expect(await fetchNotifyBodyText(q, 9999, download)).toBeNull()
    })
  })
})
