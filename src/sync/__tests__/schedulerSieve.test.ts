import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { Scheduler } from '../scheduler'

// Sieve'in scheduler yüzeyi: izlenen klasöre varış kural turunu başlatır, soğuma IMAP'inkiyle aynı uyarıyı verir.
describe('scheduler Sieve yüzeyi', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let s: Scheduler
  let acc: number
  const onNewMail = vi.fn()
  const onHostAlert = vi.fn()
  const onHostHealth = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    dir = mkdtempSync(join(tmpdir(), 'gecko-sched-sieve-'))
    db = openDb(dir)
    q = makeQueries(db)
    acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'M.T.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    const events = new Proxy({ onNewMail, onHostAlert, onHostHealth } as Record<string, unknown>, {
      get: (t, k: string) => t[k] ?? (() => undefined)
    }) as unknown as ConstructorParameters<typeof Scheduler>[2]
    s = new Scheduler(q, new Map([[acc, 'p']]), events)
    s.reloadAccounts()
  })
  afterEach(() => {
    s.stop()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  type PollResult = { changed: boolean; newInboxMessages: number; watchedArrivals: number }
  const poll = async (result: PollResult): Promise<void> => {
    const inner = s as unknown as {
      pool: { run(id: number, prio: string, fn: unknown): Promise<PollResult> }
      accounts: Map<number, unknown>
      runPoll(rt: unknown, row: unknown, host: string): Promise<void>
    }
    inner.pool.run = async () => result
    await inner.runPoll(inner.accounts.get(acc), q.getAccountRow(acc), 'm.t.co')
  }

  it('watched arrival triggers new mail run', async () => {
    await poll({ changed: false, newInboxMessages: 0, watchedArrivals: 1 })
    expect(onNewMail).toHaveBeenCalledTimes(1)
    expect(onNewMail).toHaveBeenCalledWith(acc)
  })

  it('inbox arrival still triggers, empty poll does not', async () => {
    await poll({ changed: false, newInboxMessages: 2, watchedArrivals: 0 })
    expect(onNewMail).toHaveBeenCalledTimes(1)
    await poll({ changed: false, newInboxMessages: 0, watchedArrivals: 0 })
    expect(onNewMail).toHaveBeenCalledTimes(1)
  })

  it('sieve cooldown raises the host alert once, keyed like IMAP', () => {
    const until = Date.now() + 60_000
    s.sieveCooldown('M.T.co', { kind: 'cooldown', reason: 'blocked', until, first: true })
    s.sieveCooldown('M.T.co', { kind: 'cooldown', reason: 'blocked', until, first: false })
    expect(onHostAlert).toHaveBeenCalledTimes(1)
    expect(onHostAlert.mock.calls[0][0]).toBe('m.t.co')
    expect(onHostHealth).toHaveBeenCalledWith('m.t.co', 'cooldown', until, expect.any(String))
    expect(q.getAccountRow(acc)?.status).toBe('degraded') // aynı governor: IMAP de bekler
  })

  it('sieve login clears the shown cooldown', () => {
    s.sieveCooldown('m.t.co', { kind: 'cooldown', reason: 'limit', until: Date.now() + 60_000, first: true })
    onHostHealth.mockClear()
    s.sieveLoginOk('M.T.co')
    expect(onHostHealth).toHaveBeenCalledWith('m.t.co', 'ok', null, null)
    onHostHealth.mockClear()
    s.sieveLoginOk('m.t.co') // soğuma yoksa olay da yok
    expect(onHostHealth).not.toHaveBeenCalled()
  })
})
