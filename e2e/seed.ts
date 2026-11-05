// Tohum verisi: Playwright düzeneği, mobil yığın (mobile/scripts/e2e-stack.mjs) ve demo aynı satırları yazar
import type Database from 'better-sqlite3'

export interface SeedMail {
  email?: string
  folder?: string
  messages: { subject: string; from?: string; fromName?: string; date?: number; seen?: boolean; preview?: string }[]
}

/** Hesap + klasör + iletiler (doğrudan SQL). IMAP sunucusu yok: eşitleme bağlanamaz, satırlar kalır. */
export function seedMail(db: Database.Database, s: SeedMail): { accountId: number; folderId: number; messageIds: number[] } {
  const now = Date.now()
  return db.transaction(() => {
    const acc = db
      .prepare(
        `INSERT INTO accounts (email, display_name, imap_host, imap_port, smtp_host, smtp_port, password_enc, created_at)
         VALUES (?, ?, '127.0.0.1', 9, '127.0.0.1', 9, ?, ?)`
      )
      .run(s.email ?? 'deneme@example.test', 'Deneme', Buffer.from('yok'), now)
    const accountId = Number(acc.lastInsertRowid)
    const folder = db
      .prepare(`INSERT INTO folders (account_id, path, kind, special_use) VALUES (?, ?, 'inbox', 1)`)
      .run(accountId, s.folder ?? 'INBOX')
    const folderId = Number(folder.lastInsertRowid)
    const ins = db.prepare(
      `INSERT INTO messages (folder_id, account_id, folder_kind, uid, message_id, subject, from_name, from_addr, to_json,
         date, size, seen, preview, thread_root)
       VALUES (?, ?, 'inbox', ?, ?, ?, ?, ?, '[]', ?, 1000, ?, ?, ?)`
    )
    const messageIds = s.messages.map((m, i) => {
      const mid = `<e2e-${accountId}-${i + 1}@example.test>`
      return Number(
        ins.run(folderId, accountId, i + 1, mid, m.subject, m.fromName ?? 'Gönderen', m.from ?? 'gonderen@example.test',
          m.date ?? now - i * 60_000, m.seen ? 1 : 0, m.preview ?? '', mid).lastInsertRowid
      )
    })
    return { accountId, folderId, messageIds }
  })()
}
