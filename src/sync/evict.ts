// LRU önbellek tahliyesi: catchall kutuları sınırsız büyümesin
import { unlinkSync } from 'fs'
import type { Queries } from './db/queries'
import type { Database } from 'better-sqlite3'

const BODY_BUDGET = 1_000_000_000 // ~1GB
const ATTACH_BUDGET = 2_000_000_000 // ~2GB

export function evictCaches(db: Database, q: Queries, budgets = { body: BODY_BUDGET, attach: ATTACH_BUDGET }): void {
  const BODY = budgets.body
  const ATTACH = budgets.attach
  // gövdeler: en eski erişilenden başlayarak bütçeye in (uzunluk kayıtta saklı — metin okunmaz)
  const bodyTotal = (db.prepare(`SELECT COALESCE(SUM(text_bytes), 0) AS n FROM bodies`).get() as { n: number }).n
  if (bodyTotal > BODY) {
    let freed = 0
    const need = bodyTotal - BODY
    const rows = db
      .prepare(`SELECT message_id, text_bytes AS sz FROM bodies ORDER BY last_access_at ASC LIMIT 2000`)
      .all() as { message_id: number; sz: number }[]
    const del = db.prepare(`DELETE FROM bodies WHERE message_id = ?`)
    q.tx(() => {
      for (const r of rows) {
        if (freed >= need) break
        del.run(r.message_id)
        freed += r.sz
      }
    })
  }

  // ekler: aynı içerik (hash adlı dosya) birden çok mesajda paylaşılır — bütçede bir kez sayılır, silinince
  // o yolu gösteren tüm satırlar birlikte "diskte yok" olur (tıklanınca yeniden iner). Önceden bir satır
  // için dosya silinip diğerleri kırık yolla kalıyordu.
  const attTotal = (
    db
      .prepare(`SELECT COALESCE(SUM(sz), 0) AS n FROM (SELECT MAX(COALESCE(size, 0)) AS sz FROM attachments WHERE disk_path IS NOT NULL GROUP BY disk_path)`)
      .get() as { n: number }
  ).n
  if (attTotal > ATTACH) {
    let freed = 0
    const need = attTotal - ATTACH
    const paths = db
      .prepare(
        `SELECT disk_path, MAX(COALESCE(size, 0)) AS sz, MAX(COALESCE(last_access_at, 0)) AS last FROM attachments
         WHERE disk_path IS NOT NULL GROUP BY disk_path ORDER BY last ASC LIMIT 2000`
      )
      .all() as { disk_path: string; sz: number }[]
    const clear = db.prepare(`UPDATE attachments SET disk_path = NULL WHERE disk_path = ?`)
    for (const r of paths) {
      if (freed >= need) break
      try {
        unlinkSync(r.disk_path)
      } catch {
        /* dosya zaten yoksa sorun değil */
      }
      clear.run(r.disk_path)
      freed += r.sz
    }
  }
}

// 67 gürültülü mailbox'ın otomasyon aktivitesi sınırsız birikmesin — 30 gün yeterli
// ("dün gece niye tetiklendi" sorusuna cevap verir, DB'yi şişirmez).
export function trimRuleLog(db: Database, maxAgeMs = 30 * 24 * 3600_000): void {
  db.prepare(`DELETE FROM rule_log WHERE ts < ?`).run(Date.now() - maxAgeMs)
}
