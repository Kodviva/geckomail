import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'

const DAY = 86_400_000
const NOW = Date.now()
const ONE_CLICK = { lu: '<https://x.co/u?id=1>, <mailto:u@x.co>', lup: 'List-Unsubscribe=One-Click' }

describe('abonelik özeti (R29)', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let a1: number
  let a2: number
  let uid = 1
  const add = (acc: number, from: string, o: { lu?: string | null; lup?: string | null; age?: number; seen?: number; enc?: number } = {}) => {
    const f = q.upsertFolder(acc, 'INBOX', 'inbox')
    return Number(
      db
        .prepare(
          `INSERT INTO messages (folder_id, account_id, folder_kind, uid, from_addr, from_name, date, seen, list_unsubscribe, list_unsubscribe_post, enc)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(f, acc, 'inbox', uid++, from, 'Bülten', NOW - (o.age ?? 1) * DAY, o.seen ?? 1, o.lu === undefined ? ONE_CLICK.lu : o.lu, o.lup === undefined ? ONE_CLICK.lup : o.lup, o.enc ?? 0)
        .lastInsertRowid
    )
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-subs-'))
    db = openDb(dir)
    q = makeQueries(db)
    const acc = (email: string) =>
      q.insertAccount({ email, displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    a1 = acc('a@t.co')
    a2 = acc('b@t.co')
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('göndericiye göre gruplar (büyük/küçük harf), sayar, tek-tık desteğini ve aralığı tanır', () => {
    add(a1, 'News@Shop.co', { seen: 0 })
    add(a2, 'news@shop.co')
    add(a1, 'news@shop.co', { age: 200 }) // aralık dışı
    add(a1, 'promo@mailto-only.co', { lu: '<mailto:u@x.co>', lup: null })
    add(a1, 'friend@x.co', { lu: null, lup: null }) // liste değil
    add(a1, 'secret@vault.co', { enc: 1 }) // kasa hariç
    const list = q.subscriptionSenders(null, NOW - 90 * DAY)
    expect(list.map((r) => [r.addr, r.count, r.unread, r.accounts, r.oneClick])).toEqual([
      ['news@shop.co', 2, 1, 2, true],
      ['promo@mailto-only.co', 1, 0, 1, false]
    ])
    expect(q.subscriptionSenders([a2], NOW - 90 * DAY).map((r) => r.count)).toEqual([1])
  })

  it('tek-tık mesaj seçimi izinli hesaplarla sınırlı', () => {
    const m1 = add(a1, 'n@s.co', { age: 3 })
    const m2 = add(a2, 'n@s.co', { age: 1 })
    add(a1, 'n@s.co', { age: 0, lu: '<mailto:x@y>', lup: null }) // en yeni ama tek-tık değil
    expect(q.latestOneClickFrom('N@S.CO', null)).toBe(m2)
    expect(q.latestOneClickFrom('n@s.co', [a1])).toBe(m1)
    expect(q.latestOneClickFrom('yok@s.co', null)).toBeNull()
  })

  it('iptal kaydı: sonrasında gelen mailler sayılır; başarısızlık ayrı gösterilir', () => {
    add(a1, 'n@s.co', { age: 5 })
    q.recordUnsubscribe('N@s.co', true, null, NOW - 3 * DAY)
    add(a1, 'n@s.co', { age: 1 })
    add(a1, 'f@s.co')
    q.recordUnsubscribe('f@s.co', false, 'Sunucu 500 döndürdü')
    const byAddr = Object.fromEntries(q.subscriptionSenders(null, NOW - 90 * DAY).map((r) => [r.addr, r]))
    expect(byAddr['n@s.co']).toMatchObject({ unsubscribedAt: NOW - 3 * DAY, sinceUnsubscribed: 1, unsubscribeError: null })
    expect(byAddr['f@s.co']).toMatchObject({ unsubscribedAt: null, unsubscribeError: 'Sunucu 500 döndürdü', sinceUnsubscribed: 0 })
  })
})
