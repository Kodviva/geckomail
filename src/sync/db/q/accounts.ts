// Sorgular — Hesaplar, kasa bayrağı, gözlemlenebilirlik, işlem/yedek yardımcıları ve tercihler.
import type { AccountInfo, AccountStatus } from '../../../shared/rpc'
import { foldForIndex } from '../../../shared/searchQuery'
import { SIEVE_PUBLIC_DETAILS } from '../../../shared/sieve'
import { decryptText, encryptText } from '../../vault/crypto'
import { getVaultKey } from '../../vault/state'
import { t } from '../../../shared/i18n'
import { colorFor, type AccountRow, type OpRow } from './types'
import type { QCtx } from './ctx'

export function accountsQueries(c: QCtx) {
  const { db, prep } = c
  return {
    refreshSecureAccounts(): void {
      c.secure.ids = new Set<number>(
        (prep(`SELECT id FROM accounts WHERE secure = 1`).all() as { id: number }[]).map((r) => r.id)
      )
    },

    isAccountSecure(accountId: number): boolean {
      return c.secure.ids.has(accountId)
    },

    getSecureAccountIds(): number[] {
      return [...c.secure.ids]
    },

    setAccountSecureFlag(accountId: number, secure: boolean): void {
      prep(`UPDATE accounts SET secure = ? WHERE id = ?`).run(secure ? 1 : 0, accountId)
      c.q.refreshSecureAccounts()
    },

    // Kasa hesaplarının diske inmiş ek dosya yollarını döndürür ve DB kaydını temizler (çağıran
    // dosyaları siler). Kilitleme anında kritik eklerin diskte düz kalmasını önler.
    takeSecureAttachmentPaths(): string[] {
      const rows = prep(
        `SELECT a.id, a.disk_path FROM attachments a
         JOIN messages m ON m.id = a.message_id
         JOIN accounts ac ON ac.id = m.account_id
         WHERE ac.secure = 1 AND a.disk_path IS NOT NULL`
      ).all() as { id: number; disk_path: string }[]
      if (rows.length) {
        const upd = prep(`UPDATE attachments SET disk_path = NULL, fetched_at = NULL WHERE id = ?`)
        db.transaction(() => {
          for (const r of rows) upd.run(r.id)
        })()
      }
      return rows.map((r) => r.disk_path)
    },

    // canlı→kasa: hesabın mevcut düz içeriğini/gövdesini kasa anahtarıyla şifreler, enc=1, FTS'ten çıkarır.
    convertAccountToSecure(accountId: number): void {
      const key = getVaultKey()
      if (!key) throw new Error(t('sync.vault.locked'))
      const e = (v: string | null): string | null => (v == null ? null : encryptText(key, v))
      db.transaction(() => {
        const msgs = prep(
          `SELECT id, subject, from_name, from_addr, to_json, preview FROM messages WHERE account_id = ? AND enc = 0`
        ).all(accountId) as { id: number; subject: string | null; from_name: string | null; from_addr: string | null; to_json: string | null; preview: string | null }[]
        const infos = prep(`SELECT message_id, info FROM message_smime WHERE message_id IN (SELECT id FROM messages WHERE account_id = ? AND enc = 0)`).all(accountId) as { message_id: number; info: string }[]
        const iupd = prep(`UPDATE message_smime SET info = ? WHERE message_id = ?`)
        for (const i of infos) iupd.run(e(i.info), i.message_id)
        const upd = prep(`UPDATE messages SET subject=?, from_name=?, from_addr=?, to_json=?, preview=?, enc=1 WHERE id=?`)
        const delFts = prep(`DELETE FROM messages_fts WHERE rowid = ?`)
        for (const m of msgs) {
          upd.run(e(m.subject), e(m.from_name), e(m.from_addr), e(m.to_json), e(m.preview), m.id)
          delFts.run(m.id)
        }
        const bodies = prep(
          `SELECT message_id, text_plain, html FROM bodies WHERE enc = 0 AND message_id IN (SELECT id FROM messages WHERE account_id = ?)`
        ).all(accountId) as { message_id: number; text_plain: string | null; html: string | null }[]
        const bupd = prep(`UPDATE bodies SET text_plain=?, html=?, enc=1 WHERE message_id=?`)
        for (const b of bodies) bupd.run(e(b.text_plain), e(b.html), b.message_id)
        const vac = prep(`SELECT subject, body FROM sieve_vacation WHERE account_id = ? AND enc = 0`).get(accountId) as { subject: string; body: string } | undefined
        if (vac) prep(`UPDATE sieve_vacation SET subject=?, body=?, enc=1 WHERE account_id=?`).run(e(vac.subject), e(vac.body), accountId)
        const detail = prep(`SELECT state_detail FROM sieve_accounts WHERE account_id = ? AND detail_enc = 0`).get(accountId) as { state_detail: string | null } | undefined
        if (detail?.state_detail != null && !SIEVE_PUBLIC_DETAILS.has(detail.state_detail)) {
          prep(`UPDATE sieve_accounts SET state_detail=?, detail_enc=1 WHERE account_id=?`).run(e(detail.state_detail), accountId)
        }
      })()
    },

    // kasa→canlı: içeriği/gövdeyi çöz, enc=0, FTS'i yeniden kur.
    convertAccountToLive(accountId: number): void {
      const key = getVaultKey()
      if (!key) throw new Error(t('sync.vault.locked'))
      const d = (v: string | null): string | null => (v == null ? null : decryptText(key, v))
      db.transaction(() => {
        const msgs = prep(
          `SELECT id, subject, from_name, from_addr, to_json, preview FROM messages WHERE account_id = ? AND enc = 1`
        ).all(accountId) as { id: number; subject: string | null; from_name: string | null; from_addr: string | null; to_json: string | null; preview: string | null }[]
        const infos = prep(`SELECT message_id, info FROM message_smime WHERE message_id IN (SELECT id FROM messages WHERE account_id = ? AND enc = 1)`).all(accountId) as { message_id: number; info: string }[]
        const iupd = prep(`UPDATE message_smime SET info = ? WHERE message_id = ?`)
        for (const i of infos) iupd.run(d(i.info), i.message_id)
        const upd = prep(`UPDATE messages SET subject=?, from_name=?, from_addr=?, to_json=?, preview=?, enc=0 WHERE id=?`)
        const plain = new Map<number, { subject: string | null; from: string; to: string | null }>()
        for (const m of msgs) {
          const s = d(m.subject)
          const fn = d(m.from_name)
          const fa = d(m.from_addr)
          const tj = d(m.to_json)
          upd.run(s, fn, fa, tj, d(m.preview), m.id)
          plain.set(m.id, { subject: s, from: `${fn ?? ''} ${fa ?? ''}`, to: tj })
        }
        const bodies = prep(
          `SELECT message_id, text_plain, html FROM bodies WHERE enc = 1 AND message_id IN (SELECT id FROM messages WHERE account_id = ?)`
        ).all(accountId) as { message_id: number; text_plain: string | null; html: string | null }[]
        const bupd = prep(`UPDATE bodies SET text_plain=?, html=?, enc=0 WHERE message_id=?`)
        const bodyText = new Map<number, string | null>()
        for (const b of bodies) {
          const tp = d(b.text_plain)
          bupd.run(tp, d(b.html), b.message_id)
          bodyText.set(b.message_id, tp)
        }
        const vac = prep(`SELECT subject, body FROM sieve_vacation WHERE account_id = ? AND enc = 1`).get(accountId) as { subject: string; body: string } | undefined
        if (vac) prep(`UPDATE sieve_vacation SET subject=?, body=?, enc=0 WHERE account_id=?`).run(d(vac.subject), d(vac.body), accountId)
        const detail = prep(`SELECT state_detail FROM sieve_accounts WHERE account_id = ? AND detail_enc = 1`).get(accountId) as { state_detail: string } | undefined
        if (detail) prep(`UPDATE sieve_accounts SET state_detail=?, detail_enc=0 WHERE account_id=?`).run(d(detail.state_detail), accountId)
        // FTS yeniden indeksle (artık düz metin) — secure kontrolü olmadan doğrudan yaz
        const insFts = prep(`INSERT INTO messages_fts (rowid, subject, from_text, to_text, body_text) VALUES (?, ?, ?, ?, ?)`)
        const delFts = prep(`DELETE FROM messages_fts WHERE rowid = ?`)
        for (const [id, p] of plain) {
          delFts.run(id)
          const bt = bodyText.get(id)
          insFts.run(id, foldForIndex(p.subject ?? ''), foldForIndex(p.from), foldForIndex(p.to ?? ''), bt ? foldForIndex(bt.slice(0, 100_000)) : '')
        }
      })()
    },

    tx<T>(fn: () => T): T {
      return db.transaction(fn)()
    },

    // SQLite'ın online-backup API'si: canlı/açık bir DB'yi güvenle kopyalar (WAL ortasında bile) —
    // ham dosya kopyalama gibi bozuk bir anlık görüntü riski taşımaz.
    async backupTo(destPath: string): Promise<void> {
      await db.backup(destPath)
    },

    insertAccount(a: {
      email: string
      displayName: string | null
      imapHost: string
      imapPort: number
      smtpHost: string
      smtpPort: number
      passwordEnc: Buffer
      /** 'password' (varsayılan) | 'oauth:google' | 'oauth:microsoft' */
      authType?: string
    }): number {
      // SMTP 587 = STARTTLS gönderim portu (implicit TLS değil). Aksi halde nodemailer secure:true ile
      // el sıkışamaz → Outlook/iCloud gibi 587'li sağlayıcılarda gönderim sessizce başarısız olur.
      const smtpTls = a.smtpPort === 587 ? 'starttls' : 'tls'
      const r = prep(
        `INSERT INTO accounts (email, display_name, imap_host, imap_port, smtp_host, smtp_port, smtp_tls, password_enc, color, created_at, password_changed_at, auth_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(a.email, a.displayName, a.imapHost, a.imapPort, a.smtpHost, a.smtpPort, smtpTls, a.passwordEnc, colorFor(a.email), Date.now(), Date.now(), a.authType ?? 'password')
      return Number(r.lastInsertRowid)
    },

    /** OAuth yeniden yetkilendirme / şifreden OAuth'a geçiş: sır + kimlik türü + sağlayıcı sunucuları */
    setAccountOAuth(accountId: number, a: { authType: string; secretEnc: Buffer; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number }): void {
      prep(
        `UPDATE accounts SET auth_type = ?, password_enc = ?, password_changed_at = ?, imap_host = ?, imap_port = ?, imap_tls = 'tls',
           smtp_host = ?, smtp_port = ?, smtp_tls = ? WHERE id = ?`
      ).run(a.authType, a.secretEnc, Date.now(), a.imapHost, a.imapPort, a.smtpHost, a.smtpPort, a.smtpPort === 587 ? 'starttls' : 'tls', accountId)
    },

    accountExists(email: string): boolean {
      return !!prep(`SELECT 1 FROM accounts WHERE email = ?`).get(email)
    },

    updateAccountPassword(email: string, passwordEnc: Buffer): number | undefined {
      const r = prep(`SELECT id FROM accounts WHERE email = ?`).get(email) as { id: number } | undefined
      if (!r) return undefined
      prep(`UPDATE accounts SET password_enc = ?, password_changed_at = ? WHERE id = ?`).run(passwordEnc, Date.now(), r.id)
      return r.id
    },

    getAccountRows(): AccountRow[] {
      return prep(`SELECT * FROM accounts ORDER BY email`).all() as AccountRow[]
    },

    getAccountRow(id: number): AccountRow | undefined {
      return prep(`SELECT * FROM accounts WHERE id = ?`).get(id) as AccountRow | undefined
    },

    // tek seferlik: eski parlak/rastgele paleti yeni kürasyonlu aileyle değiştir (index.ts'de prefs bayrağıyla korunur)
    recolorAllAccounts(): void {
      const rows = prep(`SELECT id, email FROM accounts`).all() as { id: number; email: string }[]
      const upd = prep(`UPDATE accounts SET color = ? WHERE id = ?`)
      for (const r of rows) upd.run(colorFor(r.email), r.id)
    },

    getAccountInfos(): AccountInfo[] {
      const unread = new Map<number, number>()
      for (const r of prep(
        `SELECT account_id AS a, COUNT(*) AS n FROM messages WHERE seen = 0 AND folder_kind = 'inbox' AND hidden = 0 GROUP BY account_id`
      ).all() as { a: number; n: number }[]) {
        unread.set(r.a, r.n)
      }
      const rows = prep(
        `SELECT a.*, g.name AS group_name FROM accounts a LEFT JOIN groups g ON g.id = a.group_id ORDER BY a.email`
      ).all() as (AccountRow & { group_name: string | null })[]
      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        displayName: r.display_name,
        color: r.color,
        starred: !!r.starred,
        enabled: !!r.enabled,
        status: r.enabled ? r.status : 'disabled',
        statusDetail: r.status_detail,
        lastSuccessAt: r.last_success_at,
        unread: unread.get(r.id) ?? 0,
        signature: r.signature,
        mySignature: r.signature,
        groupId: r.group_id,
        groupName: r.group_name,
        secure: !!r.secure,
        authType: (r.auth_type as AccountInfo['authType']) ?? 'password'
      }))
    },

    updateAccountStatus(id: number, status: AccountStatus, detail: string | null, success: boolean): void {
      const now = Date.now()
      const prev = prep(`SELECT status FROM accounts WHERE id = ?`).get(id) as { status: string } | undefined
      // status_since yalnız durum değişince ilerler ("ne zamandan beri" anlamlı kalsın)
      prep(
        `UPDATE accounts SET status = ?, status_detail = ?,
           status_since = CASE WHEN status IS ? THEN status_since ELSE ? END,
           last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END WHERE id = ?`
      ).run(status, detail, status, now, success ? 1 : 0, now, id)
      if (prev && prev.status !== status) {
        prep(`INSERT INTO account_status_log (account_id, ts, status, detail) VALUES (?, ?, ?, ?)`).run(id, now, status, detail)
      }
    },

    accountStatusHistory(id: number, limit = 20): { ts: number; status: AccountStatus; detail: string | null }[] {
      return prep(`SELECT ts, status, detail FROM account_status_log WHERE account_id = ? ORDER BY ts DESC LIMIT ?`).all(id, limit) as {
        ts: number
        status: AccountStatus
        detail: string | null
      }[]
    },

    recordLoginAttempt(host: string, accountId: number | null, lane: 'imap' | 'smtp' | 'sieve', result: string): void {
      prep(`INSERT INTO login_attempts (ts, host, account_id, lane, result) VALUES (?, ?, ?, ?, ?)`).run(Date.now(), host, accountId, lane, result)
    },

    /** host başına sonuç sayıları (since sonrası) — auto-ban eşiğine yakınlık için */
    loginStats(since: number): { host: string; result: string; n: number }[] {
      return prep(`SELECT host, result, COUNT(*) AS n FROM login_attempts WHERE ts >= ? GROUP BY host, result`).all(since) as {
        host: string
        result: string
        n: number
      }[]
    },

    /** son başarısız login'ler (tanı paneli) */
    recentLoginFailures(limit = 20): { ts: number; host: string; accountId: number | null; lane: string; result: string }[] {
      return prep(
        `SELECT ts, host, account_id AS accountId, lane, result FROM login_attempts WHERE result != 'ok' ORDER BY ts DESC LIMIT ?`
      ).all(limit) as { ts: number; host: string; accountId: number | null; lane: string; result: string }[]
    },

    pruneObservability(before: number): void {
      prep(`DELETE FROM login_attempts WHERE ts < ?`).run(before)
      prep(`DELETE FROM account_status_log WHERE ts < ?`).run(before)
    },

    setAccountEnabled(id: number, enabled: boolean): void {
      prep(`UPDATE accounts SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id)
    },

    setAccountStarred(id: number, starred: boolean): void {
      prep(`UPDATE accounts SET starred = ? WHERE id = ?`).run(starred ? 1 : 0, id)
    },

    updateAccountFields(
      id: number,
      f: Partial<{
        display_name: string | null
        color: string
        signature: string | null
        imap_host: string
        imap_port: number
        smtp_host: string
        smtp_port: number
        imap_tls: string
        smtp_tls: string
        allow_invalid_certs: number
        password_enc: Buffer
        password_changed_at: number
      }>
    ): void {
      const keys = Object.keys(f)
      if (!keys.length) return
      db.prepare(`UPDATE accounts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
        ...keys.map((k) => (f as Record<string, unknown>)[k]), id
      )
    },

    /** Hesabı ve artıklarını sil; bekleyen gönderimlerin giden-kutusu ek dosya yollarını döndürür (çağıran siler). */
    deleteAccount(id: number): string[] {
      const outboxFiles: string[] = []
      c.q.tx(() => {
        // op_queue'da FK yok: bekleyen op'lar hesap silinince sahipsiz kalıyordu
        const smtpOps = c.openOps(
          prep(`SELECT id, account_id, kind, payload_json, attempts FROM op_queue WHERE account_id = ? AND kind = 'smtp_send'`).all(id) as OpRow[]
        )
        for (const r of smtpOps) {
          try {
            for (const a of (JSON.parse(r.payload_json) as { attachments?: { path: string }[] }).attachments ?? []) outboxFiles.push(a.path)
          } catch {
            /* bozuk payload */
          }
        }
        prep(`DELETE FROM op_queue WHERE account_id = ?`).run(id)
        prep(`DELETE FROM prefs WHERE key IN (?, ?)`).run(`rules_watermark:${id}`, `folders_listed_${id}`)
        for (const f of prep(`SELECT id FROM folders WHERE account_id = ?`).all(id) as { id: number }[]) {
          prep(`DELETE FROM prefs WHERE key = ?`).run(`full_uid_check_${f.id}`)
        }
        prep(`DELETE FROM prefs WHERE key = 'sync_anchor_account' AND value = ?`).run(String(id))
        prep(`DELETE FROM login_attempts WHERE account_id = ?`).run(id)
        // FTS satırları FK cascade'e dahil değil — önce onları temizle
        prep(`DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE account_id = ?)`).run(id)
        prep(`DELETE FROM accounts WHERE id = ?`).run(id) // folders→messages→bodies/attachments cascade
      })
      return outboxFiles
    },

    getAllPrefs(): Record<string, string> {
      const out: Record<string, string> = {}
      for (const r of prep(`SELECT key, value FROM prefs`).all() as { key: string; value: string }[]) out[r.key] = r.value
      return out
    },

    prefGet(key: string): string | null {
      const r = prep(`SELECT value FROM prefs WHERE key = ?`).get(key) as { value: string } | undefined
      return r?.value ?? null
    },

    prefSet(key: string, value: string): void {
      prep(`INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
        key, value
      )
    }
  }
}
