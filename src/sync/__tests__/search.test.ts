import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'

const DAY = 86_400_000
const NOW = new Date(2026, 8, 30, 12).getTime()

describe('arama (R27)', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let a1: number
  let a2: number
  let uid = 1

  const add = (acc: number, o: { subject: string; from?: string; to?: string; body?: string; html?: string; ageDays?: number; seen?: number; kind?: string; att?: number }) => {
    const folder = q.upsertFolder(acc, o.kind === 'archive' ? 'Archive' : 'INBOX', (o.kind ?? 'inbox') as 'inbox')
    const id = Number(
      db
        .prepare(
          `INSERT INTO messages (folder_id, account_id, folder_kind, uid, subject, from_addr, from_name, to_json, date, seen, has_attachments, preview, thread_root)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(folder, acc, o.kind ?? 'inbox', uid++, o.subject, o.from ?? 'x@y.co', null, o.to ?? '', NOW - (o.ageDays ?? 1) * DAY, o.seen ?? 1, o.att ?? 0, 'önizleme', `<r${uid}>`).lastInsertRowid
    )
    if (o.body !== undefined || o.html !== undefined) db.prepare(`INSERT INTO bodies (message_id, text_plain, html) VALUES (?,?,?)`).run(id, o.body ?? null, o.html ?? null)
    q.ftsUpsert(id, o.subject, o.from ?? 'x@y.co', o.to ?? '', o.body ?? null)
    return id
  }
  const s = (query: string, sort?: 'relevance' | 'date') => q.ftsSearch(query, null, 50, { now: NOW, sort }).map((r) => r.id)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-search-'))
    db = openDb(dir)
    q = makeQueries(db)
    const acc = (email: string) =>
      q.insertAccount({ email, displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    a1 = acc('destek@firma.co')
    a2 = acc('satis@firma.co')
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('ı/i katlaması: "kapi" "Kapı"yı, "KAPI" "kapı"yı bulur', () => {
    const m = add(a1, { subject: 'Kapı kodu' })
    expect(s('kapi')).toEqual([m])
    expect(s('KAPI')).toEqual([m])
    expect(s('kapı')).toEqual([m])
  })

  it('alaka: konuda geçen gövdede geçenden önce; tarih sırası seçilebilir', () => {
    const inBody = add(a1, { subject: 'Haftalık rapor', body: 'ekte yedekleme sonuçları', ageDays: 1 })
    const inSubject = add(a1, { subject: 'Yedekleme başarısız', ageDays: 3 })
    expect(s('yedekleme')).toEqual([inSubject, inBody])
    expect(s('yedekleme', 'date')).toEqual([inBody, inSubject])
  })

  it('operatörler: from, to, konu, hesap, in, tarih, okunmamış, ekli, dışlama', () => {
    const a = add(a1, { subject: 'Fatura Eylül', from: 'muhasebe@x.co', to: 'ali@firma.co', seen: 0, att: 1, ageDays: 2 })
    const b = add(a2, { subject: 'Fatura Ağustos', from: 'banka@y.co', ageDays: 40, kind: 'archive' })
    const c = add(a1, { subject: 'Fatura reklam', from: 'kampanya@z.co', ageDays: 5 })
    expect(s('fatura from:muhasebe')).toEqual([a])
    expect(s('fatura to:ali')).toEqual([a])
    expect(s('konu:ağustos')).toEqual([b])
    expect(s('fatura hesap:satis')).toEqual([b])
    expect(s('fatura in:arşiv')).toEqual([b])
    expect(new Set(s('fatura sonra:30g'))).toEqual(new Set([a, c]))
    expect(s('fatura önce:30g')).toEqual([b])
    expect(s('okunmamış')).toEqual([a])
    expect(s('ekli')).toEqual([a])
    expect(new Set(s('fatura -reklam'))).toEqual(new Set([a, b]))
  })

  it('boş ya da yalnız dışlama sorgusu tüm kutuyu döndürmez', () => {
    add(a1, { subject: 'bir' })
    expect(s('')).toEqual([])
    expect(s('-bir')).toEqual([])
  })

  it('gövde eşleşmesinde önizleme yerine eşleşme çevresi gelir; HTML gövde de aranır', () => {
    const m = add(a1, { subject: 'Bilgi', body: 'Merhaba. ' + 'dolgu '.repeat(60) + 'Son ödeme tarihi 5 Ekim. ' + 'son '.repeat(10) })
    const [row] = q.ftsSearch('ödeme', null, 10, { now: NOW })
    expect(row.id).toBe(m)
    expect(row.preview).toContain('ödeme tarihi')
    const h = add(a1, { subject: 'Bülten', html: '<p>Kampanya <b>kodunuz</b>: GECKO</p>' })
    q.ftsReindexBatch(0, 100)
    expect(s('kodunuz')).toEqual([h])
  })

  it('LIKE jokerleri kullanıcı girdisinde etkisiz', () => {
    add(a1, { subject: 'a', from: 'abc@x.co' })
    expect(s('from:%')).toEqual([])
    expect(s('from:a_c')).toEqual([])
  })

  it('ön-çekme adayları: yeni, küçük, gövdesiz, görünür, kasa dışı', () => {
    const ok = add(a1, { subject: 'küçük' })
    db.prepare(`UPDATE messages SET size = 2000 WHERE id = ?`).run(ok)
    const big = add(a1, { subject: 'büyük' })
    db.prepare(`UPDATE messages SET size = 900000 WHERE id = ?`).run(big)
    const old = add(a1, { subject: 'eski', ageDays: 30 })
    db.prepare(`UPDATE messages SET size = 2000 WHERE id = ?`).run(old)
    const hasBody = add(a1, { subject: 'gövdeli', body: 'x' })
    db.prepare(`UPDATE messages SET size = 2000 WHERE id = ?`).run(hasBody)
    const hidden = add(a1, { subject: 'gizli' })
    db.prepare(`UPDATE messages SET size = 2000, hidden = 1 WHERE id = ?`).run(hidden)
    const list = q.bodyPrefetchCandidates(a1, NOW - 14 * DAY, 64 * 1024, 10)
    expect(list.map((m) => m.id)).toEqual([ok])
    expect(list[0].folderPath).toBe('INBOX')
  })
})
