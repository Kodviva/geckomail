import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { SIEVE_VACATION_CONFLICT, validateVacation, type SieveVacation } from '../../shared/sieve'
import { setVaultKey } from '../vault/state'

const OK: SieveVacation = { enabled: true, subject: 'İzindeyim', body: 'Dönünce yazarım', days: 3, startDate: '2026-11-04', endDate: '2026-11-10' }

describe('validateVacation', () => {
  it('geçerli değeri olduğu gibi döndürür', () => {
    expect(validateVacation(OK)).toEqual(OK)
    expect(validateVacation({ ...OK, startDate: null, endDate: null })).toEqual({ ...OK, startDate: null, endDate: null })
  })

  it('nesne olmayan girdi reddedilir', () => {
    for (const bad of [null, undefined, 'x', 3, []]) expect(typeof validateVacation(bad)).toBe('string')
  })

  it('konuda CRLF reddedilir', () => {
    expect(typeof validateVacation({ ...OK, subject: 'a\r\nBcc: x@y.z' })).toBe('string')
    expect(typeof validateVacation({ ...OK, subject: 'a\nb' })).toBe('string')
    expect(typeof validateVacation({ ...OK, subject: 'a\tb\u0000' })).toBe('string')
  })

  it('200 karakteri aşan konu reddedilir', () => {
    expect(validateVacation({ ...OK, subject: 'a'.repeat(200) })).toMatchObject({ subject: 'a'.repeat(200) })
    expect(typeof validateVacation({ ...OK, subject: 'a'.repeat(201) })).toBe('string')
  })

  it('3901 bayt Türkçe gövde reddedilir, 3900 bayt geçer', () => {
    // ş iki bayt: karakter sayısı 3900'den küçük olsa da sınır bayttır
    expect(typeof validateVacation({ ...OK, body: 'ş'.repeat(1950) })).toBe('object')
    expect(typeof validateVacation({ ...OK, body: 'ş'.repeat(1950) + 'a' })).toBe('string')
  })

  it('satır sonu betikte CRLF olduğundan bayt sınırı CRLF ile sayılır', () => {
    expect(typeof validateVacation({ ...OK, body: 'a\n'.repeat(1300) })).toBe('object')
    expect(typeof validateVacation({ ...OK, body: 'a\n'.repeat(1301) })).toBe('string')
  })

  it('gövdede satır sonu ve sekme dışı denetim karakteri reddedilir', () => {
    expect(typeof validateVacation({ ...OK, body: 'a\r\n\tb' })).toBe('object')
    expect(typeof validateVacation({ ...OK, body: 'a\u0000b' })).toBe('string')
  })

  it('gün 1–30 tamsayı', () => {
    for (const days of [1, 30]) expect(typeof validateVacation({ ...OK, days })).toBe('object')
    for (const days of [0, 31, 1.5, '3', NaN]) expect(typeof validateVacation({ ...OK, days })).toBe('string')
  })

  it('tarih biçimi ve gerçek takvim günü denetlenir', () => {
    expect(typeof validateVacation({ ...OK, startDate: '2026-1-4' })).toBe('string')
    expect(typeof validateVacation({ ...OK, startDate: '2026-02-30', endDate: null })).toBe('string')
  })

  it('end < start reddedilir, tek taraflı aralık geçer', () => {
    expect(typeof validateVacation({ ...OK, startDate: '2026-11-10', endDate: '2026-11-04' })).toBe('string')
    expect(typeof validateVacation({ ...OK, startDate: '2026-11-04', endDate: '2026-11-04' })).toBe('object')
    expect(typeof validateVacation({ ...OK, startDate: null })).toBe('object')
    expect(typeof validateVacation({ ...OK, endDate: null })).toBe('object')
  })
})

describe('Sieve sorguları', () => {
  let dir: string
  let q: ReturnType<typeof makeQueries>
  let db: ReturnType<typeof openDb>
  let acc: number
  const account = (email: string) =>
    q.insertAccount({ email, displayName: null, imapHost: 'imap.t.test', imapPort: 993, smtpHost: 'smtp.t.test', smtpPort: 465, passwordEnc: Buffer.from('x') })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-sv-'))
    db = openDb(dir)
    q = makeQueries(db)
    acc = account('a@t.test')
  })
  afterEach(() => {
    setVaultKey(null)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('upsert satırı oluşturur, yalnız verilen alanları değiştirir', () => {
    expect(q.getSieveAccount(acc)).toBeUndefined()
    q.upsertSieveAccount(acc, { enabled: 1, state: 'pending', host: 'sieve.t.test' }, 10)
    expect(q.getSieveAccount(acc)).toMatchObject({ enabled: 1, state: 'pending', host: 'sieve.t.test', port: null, watched_json: '[]', updated_at: 10 })
    q.upsertSieveAccount(acc, { state: 'active', state_detail: null }, 20)
    expect(q.getSieveAccount(acc)).toMatchObject({ enabled: 1, state: 'active', host: 'sieve.t.test', updated_at: 20 })
  })

  it('upsert boş yamayla da satır oluşturur ve hesabı değiştiremez', () => {
    q.upsertSieveAccount(acc, {}, 5)
    q.upsertSieveAccount(acc, { account_id: 999 } as never, 6)
    expect(q.getSieveAccount(acc)).toMatchObject({ account_id: acc, enabled: 0, state: 'unknown', updated_at: 6 })
  })

  it('listSieveAccounts bütün satırları döndürür', () => {
    const b = account('b@t.test')
    q.upsertSieveAccount(b, {}, 1)
    q.upsertSieveAccount(acc, {}, 1)
    expect(q.listSieveAccounts().map((r) => r.account_id).sort()).toEqual([acc, b].sort())
  })

  it('tatil yazılır, okunur, yerinde değişir', () => {
    expect(q.getSieveVacation(acc)).toBeNull()
    q.setSieveVacation(acc, OK, 1)
    expect(q.getSieveVacation(acc)).toEqual(OK)
    q.setSieveVacation(acc, { ...OK, enabled: false, startDate: null, endDate: null }, 2)
    expect(q.getSieveVacation(acc)).toEqual({ ...OK, enabled: false, startDate: null, endDate: null })
  })

  describe('kasa hesabında tatil', () => {
    const raw = () => db.prepare(`SELECT subject, body, enc FROM sieve_vacation WHERE account_id = ?`).get(acc) as { subject: string; body: string; enc: number }

    it('konu ve gövde mühürlü yazılır, açıkken okunur', () => {
      q.setAccountSecureFlag(acc, true)
      setVaultKey(randomBytes(32))
      q.setSieveVacation(acc, OK, 1)
      expect(raw().enc).toBe(1)
      expect(raw().subject).not.toContain('İzindeyim')
      expect(raw().body).not.toContain('Dönünce')
      expect(q.getSieveVacation(acc)).toEqual(OK)
    })

    it('kilitliyken yazılamaz, okuma düz metin vermez', () => {
      q.setAccountSecureFlag(acc, true)
      expect(() => q.setSieveVacation(acc, OK, 1)).toThrow()
      expect(q.getSieveVacation(acc)).toBeNull()
      setVaultKey(randomBytes(32))
      q.setSieveVacation(acc, OK, 2)
      setVaultKey(null)
      expect(() => q.getSieveVacation(acc)).toThrow()
    })

    it('kasa dışı hesap düz kalır', () => {
      q.setSieveVacation(acc, OK, 1)
      expect(raw()).toEqual({ subject: OK.subject, body: OK.body, enc: 0 })
    })

    it('hesap kasaya geçince düz satır mühürlenir, geri dönünce açılır', () => {
      q.setSieveVacation(acc, OK, 1)
      setVaultKey(randomBytes(32))
      q.convertAccountToSecure(acc)
      q.setAccountSecureFlag(acc, true)
      expect(raw().enc).toBe(1)
      expect(raw().subject).not.toContain('İzindeyim')
      expect(q.getSieveVacation(acc)).toEqual(OK)
      q.convertAccountToLive(acc)
      q.setAccountSecureFlag(acc, false)
      expect(raw()).toEqual({ subject: OK.subject, body: OK.body, enc: 0 })
    })
  })

  it('izlenen yollar: satır yoksa ve bozuk JSON boş liste', () => {
    expect(q.sieveWatchedPaths(acc)).toEqual([])
    q.upsertSieveAccount(acc, { watched_json: JSON.stringify(['A', 'B/C']) }, 1)
    expect(q.sieveWatchedPaths(acc)).toEqual(['A', 'B/C'])
    q.upsertSieveAccount(acc, { watched_json: '{bozuk' }, 2)
    expect(q.sieveWatchedPaths(acc)).toEqual([])
  })

  it('giriş kaydı sieve şeridini kabul eder', () => {
    q.recordLoginAttempt('imap.t.test', acc, 'sieve', 'ok')
    expect(db.prepare(`SELECT lane FROM login_attempts`).all()).toEqual([{ lane: 'sieve' }])
  })

  it('getActiveRulesFor returns id order', () => {
    const ids = ['z', 'a', 'm'].map((name) => q.insertRule({ name, accountId: acc, groupId: null, conditions: {}, actions: [] }))
    expect(q.getActiveRulesFor(acc).map((r) => r.id)).toEqual([...ids].sort((x, y) => x - y))
  })

  describe('state_detail mühürü', () => {
    const key = randomBytes(32)
    afterEach(() => setVaultKey(null))
    const raw = (): { state_detail: string; detail_enc: number } => db.prepare('SELECT state_detail, detail_enc FROM sieve_accounts WHERE account_id = ?').get(acc) as never

    it('vault account stores server text sealed, constants stay readable', () => {
      setVaultKey(key)
      q.convertAccountToSecure(acc)
      q.setAccountSecureFlag(acc, true)
      q.upsertSieveAccount(acc, { state: 'error', state_detail: 'sunucu metni' }, 1)
      expect(raw()).toMatchObject({ detail_enc: 1 })
      expect(raw().state_detail).not.toContain('sunucu')
      expect(q.getSieveAccount(acc)?.state_detail).toBe('sunucu metni')
      expect(q.listSieveAccounts()[0].state_detail).toBe('sunucu metni')
      setVaultKey(null)
      expect(q.getSieveAccount(acc)?.state_detail).toBeNull()
      setVaultKey(key)
      q.upsertSieveAccount(acc, { state: 'active', state_detail: SIEVE_VACATION_CONFLICT }, 2)
      expect(raw()).toMatchObject({ state_detail: SIEVE_VACATION_CONFLICT, detail_enc: 0 })
    })

    it('locked vault writes no plain text', () => {
      setVaultKey(key)
      q.convertAccountToSecure(acc)
      q.setAccountSecureFlag(acc, true)
      setVaultKey(null)
      q.upsertSieveAccount(acc, { state: 'error', state_detail: 'sunucu metni' }, 1)
      expect(raw().state_detail).toBeNull()
    })

    it('converts both ways', () => {
      q.upsertSieveAccount(acc, { state: 'error', state_detail: 'sunucu metni' }, 1)
      setVaultKey(key)
      q.convertAccountToSecure(acc)
      expect(raw()).toMatchObject({ detail_enc: 1 })
      q.convertAccountToLive(acc)
      expect(raw()).toMatchObject({ state_detail: 'sunucu metni', detail_enc: 0 })
    })
  })

  it('watch since is pruned with the watched list', () => {
    q.addSieveWatched(acc, ['A', 'B'], 5)
    q.addSieveWatched(acc, ['B', 'C'], 9)
    expect(q.sieveWatchedPaths(acc)).toEqual(['A', 'B', 'C'])
    expect(q.sieveWatchSince(acc)).toEqual({ A: 5, B: 5, C: 9 })
    q.upsertSieveAccount(acc, { watched_json: '["C"]' }, 1)
    expect(q.sieveWatchSince(acc)).toEqual({ C: 9 })
  })
})
