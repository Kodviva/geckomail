import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'

describe('gözlemlenebilirlik sorguları', () => {
  let dir: string
  let q: ReturnType<typeof makeQueries>
  let acc: number
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-obs-'))
    q = makeQueries(openDb(dir))
    acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('durum geçmişi yalnız değişimde yazılır; status_since yalnız değişimde ilerler', async () => {
    q.updateAccountStatus(acc, 'ok', null, true)
    const since1 = q.getAccountRow(acc)!.status_since
    await new Promise((r) => setTimeout(r, 5))
    q.updateAccountStatus(acc, 'ok', null, true) // aynı durum: geçmiş/since değişmez
    expect(q.getAccountRow(acc)!.status_since).toBe(since1)
    q.updateAccountStatus(acc, 'degraded', 'Şifre reddedildi — 14:00', false)
    const h = q.accountStatusHistory(acc)
    expect(h.map((x) => x.status)).toEqual(['degraded', 'ok'])
    expect(h[0].detail).toMatch(/Şifre reddedildi/)
  })

  it('login sonuçları host başına sayılır; eski kayıtlar budanır', () => {
    q.recordLoginAttempt('m.t.co', acc, 'imap', 'ok')
    q.recordLoginAttempt('m.t.co', acc, 'imap', 'auth')
    q.recordLoginAttempt('m.t.co', acc, 'smtp', 'auth')
    const stats = q.loginStats(0)
    expect(stats.find((s) => s.result === 'auth')?.n).toBe(2)
    expect(q.recentLoginFailures(10)).toHaveLength(2)
    q.pruneObservability(Date.now() + 1000)
    expect(q.loginStats(0)).toHaveLength(0)
  })
})
