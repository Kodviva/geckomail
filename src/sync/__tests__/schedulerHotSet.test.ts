import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { Scheduler, type ServerIdleOptions } from '../scheduler'

// Sıcak küme (IDLE) kotası: sunucuda bildirim alan hesaplara genişler, masaüstünde değişmez.
describe('scheduler sıcak küme', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  const events = new Proxy({}, { get: () => () => undefined }) as ConstructorParameters<typeof Scheduler>[2]
  const made: Scheduler[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-hot-'))
    db = openDb(dir)
    q = makeQueries(db)
  })
  afterEach(() => {
    for (const s of made.splice(0)) s.stop()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const acct = (n: number): number =>
    q.insertAccount({ email: `a${n}@t.co`, displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
  const hotOf = (s: Scheduler): number[] => [...(s as unknown as { desiredHot(): Set<number> }).desiredHot()]
  const make = (idle?: ServerIdleOptions): Scheduler => {
    const s = new Scheduler(q, new Map(), events, undefined, idle)
    s.reloadAccounts()
    made.push(s)
    return s
  }

  it('server hot set capped by GECKO_IDLE_MAX', () => {
    const ids = Array.from({ length: 10 }, (_, i) => acct(i))
    const s = make({ max: 6, eligible: () => ids.map((id) => ({ id, rule: false, lastDate: id })) })
    const hot = hotOf(s)
    expect(hot).toHaveLength(6)
    expect(hot).toEqual([...ids].reverse().slice(0, 6)) // son ileti yeni olan önce
  })

  it('sıra: yıldızlı, sonra kural sahibi, sonra diğerleri', () => {
    const [a, b, c, d] = [acct(1), acct(2), acct(3), acct(4)]
    q.setAccountStarred(d, true)
    const s = make({
      max: 10,
      eligible: () => [
        { id: a, rule: false, lastDate: 900 },
        { id: b, rule: true, lastDate: 100 },
        { id: c, rule: true, lastDate: 500 },
        { id: d, rule: false, lastDate: 1 }
      ]
    })
    expect(hotOf(s)).toEqual([d, c, b, a])
  })

  it('muted-by-all account not in hot set', () => {
    const [a, b] = [acct(1), acct(2)]
    q.setAccountStarred(b, true)
    const s = make({ max: 10, eligible: () => [{ id: a, rule: false, lastDate: 1 }] })
    expect(hotOf(s)).toEqual([a])
  })

  it('desktop hot set unchanged', () => {
    const ids = Array.from({ length: 8 }, (_, i) => acct(i))
    q.setAccountStarred(ids[7], true)
    q.setAccountStarred(ids[6], true)
    const s = make()
    expect(hotOf(s)).toEqual([ids[6], ids[7]]) // yalnız yıldızlı; sınır 5
    for (const id of ids) q.setAccountStarred(id, true)
    expect(hotOf(s)).toHaveLength(5)
  })

  // oturum tavanı: ana makine başına sıcak <= tavan - 16
  const withHost = (n: number, host: string): number => {
    const id = acct(100 + n + (host.startsWith('h2') ? 5000 : 0))
    db.prepare(`UPDATE accounts SET imap_host = ? WHERE id = ?`).run(host, id)
    return id
  }
  const gov = (s: Scheduler, host: string): { maxSessions(): number; setLimits(l: unknown): void; limits: Record<string, number>; shrinkUntil: number } =>
    (s as unknown as { governorFor(h: string): never }).governorFor(host)

  it('max above session ceiling is clamped per host', () => {
    const ids = Array.from({ length: 60 }, (_, i) => withHost(i, 'h1.t.co'))
    const s = make({ max: 100, eligible: () => ids.map((id) => ({ id, rule: false, lastDate: id })) })
    expect(hotOf(s)).toHaveLength(48 - 16)
  })

  it('trusted ceiling lets all owner accounts be hot', () => {
    const ids = Array.from({ length: 68 }, (_, i) => withHost(i, 'h1.t.co'))
    q.prefSet('trustedServer', '1')
    const s = make({ max: 100, eligible: () => ids.map((id) => ({ id, rule: false, lastDate: id })) })
    s.applyPrefs()
    expect(hotOf(s)).toHaveLength(68)
  })

  it('halved ceiling shrinks the hot set', () => {
    const ids = Array.from({ length: 60 }, (_, i) => withHost(i, 'h1.t.co'))
    const s = make({ max: 100, eligible: () => ids.map((id) => ({ id, rule: false, lastDate: id })) })
    expect(hotOf(s)).toHaveLength(32)
    gov(s, 'h1.t.co').shrinkUntil = Date.now() + 60_000
    expect(hotOf(s)).toHaveLength(24 - 16)
  })

  it('multi-host accounts are counted per host', () => {
    const a = Array.from({ length: 40 }, (_, i) => withHost(i, 'h1.t.co'))
    const b = Array.from({ length: 40 }, (_, i) => withHost(i, 'h2.t.co'))
    const s = make({ max: 100, eligible: () => [...a, ...b].map((id) => ({ id, rule: false, lastDate: id })) })
    const hot = hotOf(s)
    expect(hot.filter((id) => a.includes(id))).toHaveLength(32)
    expect(hot.filter((id) => b.includes(id))).toHaveLength(32)
  })

  it('sunucuda kural sahibi hesap sorgusu: yalnız uygun ve susturulmamış hesaplar', () => {
    const [a, b] = [acct(1), acct(2)]
    const g = q.insertGroup('G', '#111111')
    q.setAccountGroup(a, g)
    q.setAccountGroup(b, g)
    const admin = q.insertUser({ username: 'ad', passwordHash: 'x', role: 'admin' })
    const mem = q.insertUser({ username: 'm', passwordHash: 'x', role: 'member' })
    q.setGroupPermission(mem, g, true, false)
    expect(q.notifyEligibleAccounts().map((r) => r.id)).toEqual([a, b])
    q.setNotifyAccountPref(admin, a, 'off')
    expect(q.notifyEligibleAccounts().map((r) => r.id)).toEqual([a, b]) // üye hâlâ istiyor
    q.setNotifyAccountPref(mem, a, 'off')
    expect(q.notifyEligibleAccounts().map((r) => r.id)).toEqual([b])
    expect(q.notifyEligibleAccounts()[0].rule).toBe(false)
    q.saveNotifyRule(mem, { id: 0, name: 'k', enabled: true, position: 0, groups: [], level: 'urgent' }, 1)
    expect(q.notifyEligibleAccounts()[0].rule).toBe(true)
  })

  it('yalnız can_manage izni olan üye de hesabı görür: kümeye ve kural bayrağına sayılır', () => {
    const a = acct(1)
    const g = q.insertGroup('G', '#111111')
    q.setAccountGroup(a, g)
    const mem = q.insertUser({ username: 'm', passwordHash: 'x', role: 'member' })
    q.setGroupPermission(mem, g, false, true)
    expect(q.notifyEligibleAccounts().map((r) => r.id)).toEqual([a])
    q.saveNotifyRule(mem, { id: 0, name: 'k', enabled: true, position: 0, groups: [], level: 'urgent' }, 1)
    expect(q.notifyEligibleAccounts()[0].rule).toBe(true)
  })
})
