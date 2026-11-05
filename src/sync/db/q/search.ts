// Sorgular — Tam metin arama (FTS5) ve kişi önerileri.
import type { MessageRow } from '../../../shared/rpc'
import {
  foldForIndex, ftsMatch, ftsNegMatch, htmlToText, makeSnippet, matchRanges, parseSearch
} from '../../../shared/searchQuery'
import { rowToMessage } from './types'
import type { QCtx } from './ctx'

export function searchQueries(c: QCtx) {
  const { db, prep } = c
  return {
    ftsUpsert(messageId: number, subject: string | null, fromText: string | null, toText: string | null, bodyText: string | null): void {
      prep(`DELETE FROM messages_fts WHERE rowid = ?`).run(messageId)
      // kasa mesajları indekslenmez — şifreli metin aranamaz, düz eklenirse sızardı (bilinçli: aramada çıkmazlar)
      const owner = prep(`SELECT account_id FROM messages WHERE id = ?`).get(messageId) as { account_id: number } | undefined
      if (owner && c.secure.ids.has(owner.account_id)) return
      prep(`INSERT INTO messages_fts (rowid, subject, from_text, to_text, body_text) VALUES (?, ?, ?, ?, ?)`).run(
        messageId, foldForIndex(subject ?? ''), foldForIndex(fromText ?? ''), foldForIndex(toText ?? ''), bodyText ? foldForIndex(bodyText.slice(0, 100_000)) : ''
      )
    },

    /** FTS'i mesaj + önbellekli gövdeden yeniden yazar (R27: ı katlaması ve HTML gövde metni sonradan
     *  geldi — eski satırlar parça parça tazelenir). Son işlenen id'yi döndürür; bitince null. */
    ftsReindexBatch(afterId: number, batch: number): number | null {
      const rows = prep(
        `SELECT m.id, m.subject, m.from_name, m.from_addr, m.to_json, b.text_plain, b.html
         FROM messages m LEFT JOIN bodies b ON b.message_id = m.id
         WHERE m.id > ? AND m.enc = 0 ORDER BY m.id LIMIT ?`
      ).all(afterId, batch) as { id: number; subject: string | null; from_name: string | null; from_addr: string | null; to_json: string | null; text_plain: string | null; html: string | null }[]
      if (!rows.length) return null
      const del = prep(`DELETE FROM messages_fts WHERE rowid = ?`)
      const ins = prep(`INSERT INTO messages_fts (rowid, subject, from_text, to_text, body_text) VALUES (?, ?, ?, ?, ?)`)
      db.transaction(() => {
        for (const r of rows) {
          const body = r.text_plain?.trim() ? r.text_plain : r.html ? htmlToText(r.html) : ''
          del.run(r.id)
          ins.run(
            r.id,
            foldForIndex(r.subject ?? ''),
            foldForIndex(`${r.from_name ?? ''} ${r.from_addr ?? ''}`),
            foldForIndex(r.to_json ?? ''),
            foldForIndex(body.slice(0, 100_000))
          )
        }
      })()
      return rows[rows.length - 1].id
    },

    ftsDelete(messageId: number): void {
      prep(`DELETE FROM messages_fts WHERE rowid = ?`).run(messageId)
    },

    // Compose otomatik-tamamlama: en sık yazışılan gönderen adresleri (yalnız okunur; enc=0 → kasa hariç).
    // Tek sorgu; renderer sonucu önbellekleyip tuş başına istemci tarafında süzer.
    getContacts(accountIds: number[] | null, limit: number): { addr: string; name: string | null }[] {
      const where = ['enc = 0', 'from_addr IS NOT NULL', "from_addr != ''"]
      const args: unknown[] = []
      if (accountIds && accountIds.length) {
        where.push(`account_id IN (${accountIds.map(() => '?').join(',')})`)
        args.push(...accountIds)
      }
      args.push(limit)
      return prep(
        `SELECT from_addr AS addr, from_name AS name FROM messages
         WHERE ${where.join(' AND ')} GROUP BY LOWER(from_addr) ORDER BY COUNT(*) DESC LIMIT ?`
      ).all(...args) as { addr: string; name: string | null }[]
    },

    // Arama (R27): sözdizimi src/shared/searchQuery.ts. Metin terimi varsa alaka (bm25: konu > gönderen >
    // alıcı > gövde) yakınlıkla harmanlanır; yoksa ya da sort='date' ise tarih sırası. Gövdesi önbellekte
    // olan sonuçlarda önizleme yerine eşleşmenin çevresi (snippet) döner.
    ftsSearch(query: string, accountIds: number[] | null, limit: number, opts: { sort?: 'relevance' | 'date'; now?: number } = {}): MessageRow[] {
      const now = opts.now ?? Date.now()
      const p = parseSearch(query, now)
      const match = ftsMatch(p)
      const neg = ftsNegMatch(p)
      // enc=0: kasa mesajları aramada hiç çıkmaz (FTS'e de girmiyorlar; bu, doğrudan-tarama yolunda da emniyet)
      const where: string[] = ['m.hidden = 0', 'm.enc = 0']
      const args: unknown[] = []
      if (match) args.push(match) // MATCH ilk parametre olacak
      if (accountIds && accountIds.length) {
        where.push(`m.account_id IN (${accountIds.map(() => '?').join(',')})`)
        args.push(...accountIds)
      }
      const like = (v: string) => `%${v.replace(/[\\%_]/g, (c) => '\\' + c)}%`
      if (p.from) {
        where.push(`(m.from_addr LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\')`)
        args.push(like(p.from), like(p.from))
      }
      if (p.account) {
        where.push(`m.account_id IN (SELECT id FROM accounts WHERE email LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')`)
        args.push(like(p.account), like(p.account))
      }
      if (p.group) {
        where.push(`m.account_id IN (SELECT a.id FROM accounts a JOIN groups g ON g.id = a.group_id WHERE g.name LIKE ? ESCAPE '\\')`)
        args.push(like(p.group))
      }
      if (p.folderKind) {
        where.push('m.folder_kind = ?')
        args.push(p.folderKind)
      }
      if (p.after !== null) {
        where.push('m.date >= ?')
        args.push(p.after)
      }
      if (p.before !== null) {
        where.push('m.date < ?')
        args.push(p.before)
      }
      if (p.unread !== null) where.push(p.unread ? 'm.seen = 0' : 'm.seen = 1')
      if (p.flagged) where.push('m.flagged = 1')
      if (p.attach) where.push('m.has_attachments = 1')
      if (neg) {
        where.push('m.id NOT IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)')
        args.push(neg)
      }
      // yalnız dışlama ya da boş sorgu tüm kutuyu döndürmesin
      const userFilter =
        !!(p.from || p.account || p.group || p.folderKind || p.flagged || p.attach) || p.after !== null || p.before !== null || p.unread !== null
      if (!match && !userFilter) return []
      const byRelevance = !!match && opts.sort !== 'date'
      // bm25 negatif (küçük = iyi); 90 günlük yakınlık çarpanı eskileri sıfıra, yani geriye yaklaştırır
      const order = byRelevance
        ? `bm25(messages_fts, 8.0, 4.0, 2.0, 1.0) / (1.0 + MAX(0, ? - m.date) / 7776000000.0), m.date DESC`
        : 'm.date DESC'
      if (byRelevance) args.push(now)
      const sql = match
        ? `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ? AND ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`
        : `SELECT m.* FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.date DESC LIMIT ?`
      args.push(limit)
      const rows = (prep(sql).all(...args) as Record<string, unknown>[]).map(rowToMessage)
      const terms = [...p.terms, ...p.phrases]
      if (terms.length) {
        const body = prep(`SELECT text_plain, html FROM bodies WHERE message_id = ?`)
        for (const r of rows) {
          if (matchRanges(`${r.subject ?? ''} ${r.preview ?? ''}`, terms).length) continue
          const b = body.get(r.id) as { text_plain: string | null; html: string | null } | undefined
          if (!b) continue
          const text = b.text_plain?.trim() ? b.text_plain : htmlToText(b.html ?? '')
          const snip = makeSnippet(text.slice(0, 200_000), terms)
          if (snip) r.preview = snip
        }
      }
      return rows
    }
  }
}
