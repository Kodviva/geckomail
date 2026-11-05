import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'

// Cihazlar arası senkron pull: yerel şifre yalnız daha yeni uzak şifreyle değişir (29 Eyl).
describe('upsertSyncAccount şifre koruması', () => {
  let dir: string
  let q: ReturnType<typeof makeQueries>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-sync-'))
    q = makeQueries(openDb(dir))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const base = {
    email: 'a@test.co', displayName: 'A', imapHost: 'mail.test.co', imapPort: 993, imapTls: 'tls',
    smtpHost: 'mail.test.co', smtpPort: 465, smtpTls: 'tls', color: '#000000', signature: null,
    allowInvalidCerts: false, groupId: null
  }

  it('yeni hesap şifre ve damgayla eklenir; şifresiz eklenemez', () => {
    expect(() => q.upsertSyncAccount({ ...base, password: null })).toThrow()
    const { id, isNew } = q.upsertSyncAccount({ ...base, password: { enc: Buffer.from('p1'), changedAt: 1000 } })
    expect(isNew).toBe(true)
    const row = q.getAccountRow(id)!
    expect(Buffer.from(row.password_enc).toString()).toBe('p1')
    expect(row.password_changed_at).toBe(1000)
  })

  it('password=null: diğer alanlar güncellenir, şifre ve damga korunur', () => {
    const { id } = q.upsertSyncAccount({ ...base, password: { enc: Buffer.from('yeni'), changedAt: 5000 } })
    q.upsertSyncAccount({ ...base, displayName: 'B', password: null })
    const row = q.getAccountRow(id)!
    expect(row.display_name).toBe('B')
    expect(Buffer.from(row.password_enc).toString()).toBe('yeni')
    expect(row.password_changed_at).toBe(5000)
  })

  it('içe aktarma ile şifre güncellemesi damgayı ilerletir', () => {
    const id = q.insertAccount({ ...base, passwordEnc: Buffer.from('x') })
    const before = q.getAccountRow(id)!.password_changed_at
    expect(before).toBeGreaterThan(0)
    q.updateAccountPassword(base.email, Buffer.from('y'))
    expect(q.getAccountRow(id)!.password_changed_at).toBeGreaterThanOrEqual(before)
  })
})
