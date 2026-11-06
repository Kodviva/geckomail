// Sorgular — Klasörler ve mesaj başlıkları: liste, konuşma, işaretleme, erteleme, akıllı görünümler.
import type { AttachmentRow, FolderKind, ListParams, MessageRow, SmartView, ThreadMember } from '../../../shared/rpc'
import { encryptText } from '../../vault/crypto'
import { getVaultKey } from '../../vault/state'
import { t } from '../../../shared/i18n'
import { rowToMessage, type FolderRow, type HeaderInput } from './types'
import type { QCtx } from './ctx'

export function messagesQueries(c: QCtx) {
  const { db, prep } = c
  return {
    // specialUse: sunucu bu klasörü SPECIAL-USE (\\Sent, \\Trash…) ile işaretledi mi. undefined = bilinmiyor
    // (kullanıcı/uygulama oluşturdu) → mevcut değer korunur.
    upsertFolder(accountId: number, path: string, kind: FolderKind, specialUse?: boolean): number {
      prep(
        `INSERT INTO folders (account_id, path, kind, special_use) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, path) DO UPDATE SET kind = excluded.kind,
           special_use = CASE WHEN ? IS NULL THEN folders.special_use ELSE excluded.special_use END`
      ).run(accountId, path, kind, specialUse ? 1 : 0, specialUse === undefined ? null : 1)
      const r = prep(`SELECT id FROM folders WHERE account_id = ? AND path = ?`).get(accountId, path) as { id: number }
      return r.id
    },

    getFolders(accountId: number): FolderRow[] {
      return prep(`SELECT * FROM folders WHERE account_id = ?`).all(accountId) as FolderRow[]
    },

    getFolderByKind(accountId: number, kind: FolderKind): FolderRow | undefined {
      // çiftlerde sunucunun işaretlediği kazanır; eşitlikte en eski kayıt (deterministik)
      return prep(`SELECT * FROM folders WHERE account_id = ? AND kind = ? ORDER BY special_use DESC, id ASC LIMIT 1`).get(accountId, kind) as
        | FolderRow
        | undefined
    },

    /** Klasörü ve mesajlarını (ON DELETE CASCADE; konuşma özeti tetikleyicilerle) siler */
    deleteFolder(folderId: number): void {
      prep(`DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE folder_id = ?)`).run(folderId)
      prep(`DELETE FROM folders WHERE id = ?`).run(folderId)
    },

    getFolderById(id: number): FolderRow | undefined {
      return prep(`SELECT * FROM folders WHERE id = ?`).get(id) as FolderRow | undefined
    },

    updateFolderSync(
      id: number,
      f: Partial<{
        uidvalidity: number
        last_seen_uidnext: number
        highest_modseq: number | null
        backfill_low_uid: number
        last_deep_flag_sync_at: number
        last_seen_exists: number
      }>
    ): void {
      const keys = Object.keys(f)
      if (!keys.length) return
      const sets = keys.map((k) => `${k} = ?`).join(', ')
      db.prepare(`UPDATE folders SET ${sets} WHERE id = ?`).run(...keys.map((k) => (f as Record<string, unknown>)[k]), id)
    },

    resetFolder(id: number): void {
      // uidvalidity değişti: yerel kopya geçersiz
      c.q.tx(() => {
        const ids = prep(`SELECT id FROM messages WHERE folder_id = ?`).all(id) as { id: number }[]
        for (const m of ids) c.q.ftsDelete(m.id)
        prep(`DELETE FROM messages WHERE folder_id = ?`).run(id)
        prep(
          `UPDATE folders SET uidvalidity = NULL, last_seen_uidnext = NULL, highest_modseq = NULL, backfill_low_uid = NULL, last_seen_exists = NULL WHERE id = ?`
        ).run(id)
      })
    },

    upsertHeader(h: HeaderInput): { id: number; isNew: boolean } {
      const existing = prep(`SELECT id FROM messages WHERE folder_id = ? AND uid = ?`).get(h.folderId, h.uid) as
        | { id: number }
        | undefined
      if (existing) {
        prep(`UPDATE messages SET seen = ?, flagged = ?, answered = ? WHERE id = ?`).run(
          h.seen ? 1 : 0, h.flagged ? 1 : 0, h.answered ? 1 : 0, existing.id
        )
        return { id: existing.id, isNew: false }
      }
      // konuşma kökü: ebeveyn yerelde varsa onun kökü; yoksa ebeveynin kimliği
      // (ebeveyn sonradan gelirse kendi kimliği kök olduğundan aynı köke oturur)
      let threadRoot = h.messageId
      if (h.inReplyTo) {
        const parent = prep(`SELECT thread_root FROM messages WHERE account_id = ? AND message_id = ? LIMIT 1`).get(
          h.accountId, h.inReplyTo
        ) as { thread_root: string | null } | undefined
        threadRoot = parent?.thread_root ?? h.inReplyTo
      }
      // kasa hesabı: içerik kolonları şifreli yazılır, enc=1. message_id/thread_root düz kalır (threading gerekli).
      const secure = c.secure.ids.has(h.accountId)
      const r = prep(
        `INSERT INTO messages (folder_id, account_id, folder_kind, uid, message_id, in_reply_to, thread_root, subject, from_name, from_addr, to_json, date, size, seen, flagged, answered, has_attachments, list_unsubscribe, list_unsubscribe_post, enc, rules_eligible, auto_forwarded, smime_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        h.folderId, h.accountId, h.folderKind, h.uid, h.messageId, h.inReplyTo, threadRoot,
        c.encForAccount(h.accountId, h.subject), c.encForAccount(h.accountId, h.fromName), c.encForAccount(h.accountId, h.fromAddr),
        c.encForAccount(h.accountId, h.toJson), h.date, h.size, h.seen ? 1 : 0, h.flagged ? 1 : 0, h.answered ? 1 : 0,
        h.hasAttachments ? 1 : 0, h.listUnsubscribe, h.listUnsubscribePost, secure ? 1 : 0, h.rulesEligible ? 1 : 0, h.autoForwarded ? 1 : 0, h.smimeKind ?? null
      )
      const id = Number(r.lastInsertRowid)
      if (!threadRoot) prep(`UPDATE messages SET thread_root = ? WHERE id = ?`).run(`local-${id}`, id)
      return { id, isNew: true }
    },

    updateFlagsByUid(folderId: number, uid: number, seen: boolean, flagged: boolean, answered: boolean): boolean {
      const r = prep(`UPDATE messages SET seen = ?, flagged = ?, answered = ? WHERE folder_id = ? AND uid = ?`).run(
        seen ? 1 : 0, flagged ? 1 : 0, answered ? 1 : 0, folderId, uid
      )
      return r.changes > 0
    },

    listMessages(p: ListParams): MessageRow[] {
      const where: string[] = ['hidden = 0', 'snooze_until = 0']
      const args: unknown[] = []
      if (p.folderId) {
        where.push('folder_id = ?')
        args.push(p.folderId)
      } else {
        where.push('folder_kind = ?')
        args.push(p.folderKind)
        if (p.accountIds && p.accountIds.length) {
          where.push(`account_id IN (${p.accountIds.map(() => '?').join(',')})`)
          args.push(...p.accountIds)
        }
      }
      if (p.unreadOnly) where.push('seen = 0')
      if (p.cursor) {
        where.push('(date < ? OR (date = ? AND id < ?))')
        args.push(p.cursor.date, p.cursor.date, p.cursor.id)
      }
      args.push(Math.min(p.limit, 2000))
      const rows = prep(
        `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY date DESC, id DESC LIMIT ?`
      ).all(...args) as Record<string, unknown>[]
      return rows.map(rowToMessage)
    },

    // Ertele: seçili mesajları `until`'e kadar gizle (0 = ertelemeyi kaldır). Yalnız yerel.
    snoozeMessages(ids: number[], until: number): void {
      if (!ids.length) return
      prep(`UPDATE messages SET snooze_until = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(until, ...ids)
    },

    // Zamanı gelen ertelenmiş mailleri gelen kutusuna geri getir + okunmamış yap (dikkat çeksin,
    // rozet artsın). Yalnız yerel; eski mail zaten hot-set'te olmadığından poll seen'i geri ezmez.
    resurfaceSnoozed(now: number): number {
      const r = prep(`UPDATE messages SET snooze_until = 0, seen = 0 WHERE snooze_until > 0 AND snooze_until <= ?`).run(now)
      return r.changes
    },

    // Akıllı posta kutuları (P2-3): liste bölmesinde Yıldızlı / Ertelenen / Ekli görünümleri.
    // Güvenli hesaplarda içerik rowToMessage ile çözülür/kilitli işaretlenir.
    listSmart(view: SmartView, accountIds: number[] | null, unreadOnly = false): (MessageRow & { snoozeUntil?: number })[] {
      const where: string[] =
        view === 'snoozed'
          ? ['snooze_until > 0']
          : view === 'starred'
            ? ['flagged = 1', 'hidden = 0', 'snooze_until = 0']
            : ['has_attachments = 1', 'hidden = 0', 'snooze_until = 0', `folder_kind NOT IN ('trash', 'junk')`]
      const args: unknown[] = []
      if (accountIds && accountIds.length) {
        where.push(`account_id IN (${accountIds.map(() => '?').join(',')})`)
        args.push(...accountIds)
      }
      if (unreadOnly) where.push('seen = 0')
      const order = view === 'snoozed' ? 'snooze_until ASC' : 'date DESC, id DESC'
      const rows = prep(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`).all(...args) as Record<string, unknown>[]
      return rows.map((r) => (view === 'snoozed' ? { ...rowToMessage(r), snoozeUntil: Number(r.snooze_until) } : rowToMessage(r)))
    },

    // Ekler tarayıcısı: son eklerin listesi (mesajla join'li). enc=0 → yalnız kasa-dışı
    // hesaplar; subject/from düz metin döner, ciphertext çözmeye gerek yok.
    listAttachments(accountIds: number[] | null, limit: number): AttachmentRow[] {
      const where = ['m.enc = 0', 'a.filename IS NOT NULL', `a.filename != ''`]
      const args: unknown[] = []
      if (accountIds && accountIds.length) {
        where.push(`m.account_id IN (${accountIds.map(() => '?').join(',')})`)
        args.push(...accountIds)
      }
      args.push(limit)
      return prep(
        `SELECT a.id AS id, a.message_id AS messageId, a.filename AS filename, a.mime AS mime, a.size AS size,
                m.subject AS subject, m.from_name AS fromName, m.from_addr AS fromAddr, m.account_id AS accountId, m.date AS date
         FROM attachments a JOIN messages m ON m.id = a.message_id
         WHERE ${where.join(' AND ')} ORDER BY m.date DESC LIMIT ?`
      ).all(...args) as AttachmentRow[]
    },

    // Konuşma görünümü: her thread'in en yeni mesajı + sayaçlar. Kaynak thread_summary (R26, tetikleyicilerle
    // güncel): özet satırları tarih indeksinden sırayla okunur, farklı konuşma sayısı sayfaya ulaşınca
    // durulur. Aynı konuşma birden çok klasör/hesapta olabilir (catch-all) — sayaçlar toplanır.
    listThreads(p: ListParams): (MessageRow & { threadCount: number; threadUnread: number })[] {
      const where: string[] = []
      const args: unknown[] = []
      if (p.folderId) {
        where.push('folder_id = ?')
        args.push(p.folderId)
      } else {
        where.push('folder_kind = ?')
        args.push(p.folderKind)
        if (p.accountIds && p.accountIds.length) {
          where.push(`account_id IN (${p.accountIds.map(() => '?').join(',')})`)
          args.push(...p.accountIds)
        }
      }
      const limit = Math.min(p.limit, 2000)
      const scan = [...where]
      const scanArgs = [...args]
      if (p.unreadOnly) scan.push('unread > 0')
      if (p.cursor) {
        scan.push('latest_date < ?')
        scanArgs.push(p.cursor.date)
      }
      const roots: string[] = []
      const seen = new Set<string>()
      for (const r of prep(
        `SELECT thread_root FROM thread_summary WHERE ${scan.join(' AND ')} ORDER BY latest_date DESC`
      ).iterate(...scanArgs) as IterableIterator<{ thread_root: string }>) {
        if (seen.has(r.thread_root)) continue
        seen.add(r.thread_root)
        roots.push(r.thread_root)
        if (roots.length >= limit) break
      }
      if (!roots.length) return []
      const out: (MessageRow & { threadCount: number; threadUnread: number })[] = []
      // IN listesi SQLite değişken sınırının altında kalsın diye parçalı
      for (let i = 0; i < roots.length; i += 500) {
        const chunk = roots.slice(i, i + 500)
        const rows = prep(
          `SELECT m.*, s.mdate AS mdate, s.cnt AS thread_count, s.unread AS thread_unread
           FROM (SELECT latest_id, MAX(latest_date) AS mdate, SUM(cnt) AS cnt, SUM(unread) AS unread
                 FROM thread_summary WHERE ${where.join(' AND ')} AND thread_root IN (${chunk.map(() => '?').join(',')})
                 GROUP BY thread_root) s
           JOIN messages m ON m.id = s.latest_id`
        ).all(...args, ...chunk) as Record<string, unknown>[]
        for (const r of rows)
          out.push({ ...rowToMessage(r), threadCount: r.thread_count as number, threadUnread: r.thread_unread as number })
      }
      return out.sort((x, y) => y.date - x.date || y.id - x.id)
    },

    getThread(threadRoot: string, folderKind: FolderKind): MessageRow[] {
      // aynı konuşma birden çok klasörde olabilir (Sent yanıtları) — inbox görünümünde sent'i de göster
      const kinds = folderKind === 'inbox' ? ['inbox', 'sent'] : [folderKind]
      const rows = prep(
        `SELECT * FROM messages WHERE thread_root = ? AND hidden = 0 AND folder_kind IN (${kinds.map(() => '?').join(',')}) ORDER BY date ASC LIMIT 100`
      ).all(threadRoot, ...kinds) as Record<string, unknown>[]
      return rows.map(rowToMessage)
    },

    /** Konunun kapsamı getThread ile aynı, sınırsız ve yalnız kimlikler: taşıma konuyu bütün almalı (getThread görünüm için) */
    getThreadMembers(threadRoot: string, folderKind: FolderKind): ThreadMember[] {
      const kinds = folderKind === 'inbox' ? ['inbox', 'sent'] : [folderKind]
      const rows = prep(
        `SELECT id, account_id, folder_id FROM messages WHERE thread_root = ? AND hidden = 0 AND folder_kind IN (${kinds.map(() => '?').join(',')})`
      ).all(threadRoot, ...kinds) as { id: number; account_id: number; folder_id: number }[]
      return rows.map((r) => ({ id: r.id, accountId: r.account_id, folderId: r.folder_id }))
    },

    /** Boşta gövde indeksleme (R27) adayları: son günlerin küçük, gövdesi çekilmemiş gelen mailleri.
     *  Kasa hesapları hariç (gövdeleri aranmaz). idx_msgs_account sırasıyla okunur. */
    bodyPrefetchCandidates(accountId: number, since: number, maxSize: number, limit: number): (MessageRow & { folderPath: string })[] {
      const rows = prep(
        `SELECT m.*, f.path AS folder_path FROM messages m
         JOIN folders f ON f.id = m.folder_id
         LEFT JOIN bodies b ON b.message_id = m.id
         WHERE m.account_id = ? AND m.folder_kind = 'inbox' AND m.date > ? AND m.hidden = 0 AND m.enc = 0
           AND b.message_id IS NULL AND m.size > 0 AND m.size <= ?
         ORDER BY m.date DESC LIMIT ?`
      ).all(accountId, since, maxSize, limit) as Record<string, unknown>[]
      return rows.map((r) => ({ ...rowToMessage(r), folderPath: r.folder_path as string }))
    },

    getMessage(id: number): (MessageRow & { folderPath?: string }) | undefined {
      const r = prep(
        `SELECT m.*, f.path AS folder_path FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?`
      ).get(id) as Record<string, unknown> | undefined
      if (!r) return undefined
      return { ...rowToMessage(r), folderPath: r.folder_path as string }
    },

    getMessages(ids: number[]): (MessageRow & { folderPath: string })[] {
      if (!ids.length) return []
      const rows = prep(
        `SELECT m.*, f.path AS folder_path FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id IN (${ids.map(() => '?').join(',')})`
      ).all(...ids) as Record<string, unknown>[]
      return rows.map((r) => ({ ...rowToMessage(r), folderPath: r.folder_path as string }))
    },

    setSeenLocal(ids: number[], seen: boolean): void {
      if (!ids.length) return
      prep(`UPDATE messages SET seen = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(seen ? 1 : 0, ...ids)
    },

    setFlaggedLocal(ids: number[], flagged: boolean): void {
      if (!ids.length) return
      prep(`UPDATE messages SET flagged = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(flagged ? 1 : 0, ...ids)
    },

    markAllSeenLocal(accountIds: number[] | null, folderKind: FolderKind): void {
      if (accountIds && accountIds.length) {
        prep(
          `UPDATE messages SET seen = 1 WHERE folder_kind = ? AND seen = 0 AND account_id IN (${accountIds.map(() => '?').join(',')})`
        ).run(folderKind, ...accountIds)
      } else {
        prep(`UPDATE messages SET seen = 1 WHERE folder_kind = ? AND seen = 0`).run(folderKind)
      }
    },

    isMessageHidden(id: number): boolean {
      return (prep(`SELECT hidden FROM messages WHERE id = ?`).get(id) as { hidden: number } | undefined)?.hidden === 1
    },

    setHidden(ids: number[], hidden: boolean): void {
      if (!ids.length) return
      prep(`UPDATE messages SET hidden = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(hidden ? 1 : 0, ...ids)
    },

    deleteMessagesLocal(ids: number[]): void {
      if (!ids.length) return
      c.q.tx(() => {
        for (const id of ids) c.q.ftsDelete(id)
        prep(`DELETE FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
      })
    },

    setPreview(messageId: number, preview: string): void {
      // enc=1 (kasa mesajı) ise önizleme de şifreli tutulur
      const row = prep(`SELECT enc FROM messages WHERE id = ?`).get(messageId) as { enc: number } | undefined
      let val = preview
      if (row?.enc === 1) {
        const key = getVaultKey()
        if (!key) throw new Error(t('sync.vault.lockedCannotWritePreview'))
        val = encryptText(key, preview)
      }
      prep(`UPDATE messages SET preview = ? WHERE id = ?`).run(val, messageId)
    },

    setHasAttachments(messageId: number, has: boolean): void {
      prep(`UPDATE messages SET has_attachments = ? WHERE id = ?`).run(has ? 1 : 0, messageId)
    },

    // Kurallar motorunun bekleyen yeni postası — yalnız rules_eligible (gerçekten yeni gelen; ilk
    // senkron/backfill/sıfırlama değil). Gelen Kutusu ve Sieve'in taşıdığı izlenen klasörler; kullanıcının
    // kendi sunucu filtresiyle başka klasöre giden mail görülmez. İşaret satırdadır: id yeniden kullanılır
    // (AUTOINCREMENT yok), bu yüzden "son işlenen id" tutulmaz.
    pendingRuleMessages(accountId: number, limit: number, watchedFolderPaths: string[] = []): (MessageRow & { folderPath: string; folderKind: string })[] {
      const watched = watchedFolderPaths.length ? ` OR f.path IN (${watchedFolderPaths.map(() => '?').join(',')})` : ''
      const rows = prep(
        `SELECT m.*, f.path AS folder_path FROM messages m JOIN folders f ON f.id = m.folder_id
         WHERE m.account_id = ? AND (m.folder_kind = 'inbox'${watched}) AND m.hidden = 0 AND m.rules_eligible = 1
         ORDER BY m.id ASC LIMIT ?`
      ).all(accountId, ...watchedFolderPaths, limit) as Record<string, unknown>[]
      return rows.map((r) => ({ ...rowToMessage(r), folderPath: r.folder_path as string, folderKind: r.folder_kind as string }))
    },

    /** Tur bitti: kuyrukta atlanan satırlar (gizli, izlenmeyen klasör) dahil bu noktaya kadar olanlar yeniden görülmez */
    markRulesProcessed(accountId: number, upToId: number): void {
      prep(`UPDATE messages SET rules_eligible = 0 WHERE account_id = ? AND rules_eligible = 1 AND id <= ?`).run(accountId, upToId)
    },

    newMailCountsSince(sinceTs: number, accountIds: number[] | null): { accountId: number; count: number }[] {
      let sql = `SELECT account_id AS a, COUNT(*) AS n FROM messages WHERE folder_kind = 'inbox' AND date > ? AND hidden = 0`
      const args: unknown[] = [sinceTs]
      if (accountIds && accountIds.length) {
        sql += ` AND account_id IN (${accountIds.map(() => '?').join(',')})`
        args.push(...accountIds)
      }
      sql += ` GROUP BY account_id`
      return (prep(sql).all(...args) as { a: number; n: number }[]).map((r) => ({ accountId: r.a, count: r.n }))
    },

    // Duvar panosu sparkline'ı için saat-bazlı sayım — boşluk doldurma shared/volume.ts'de (saf, test edilebilir)
    getHourlyMessageCounts(sinceTs: number, accountIds: number[] | null): { hour: number; count: number }[] {
      let sql = `SELECT (date / 3600000) * 3600000 AS hour, COUNT(*) AS n FROM messages WHERE folder_kind = 'inbox' AND hidden = 0 AND date > ?`
      const args: unknown[] = [sinceTs]
      if (accountIds && accountIds.length) {
        sql += ` AND account_id IN (${accountIds.map(() => '?').join(',')})`
        args.push(...accountIds)
      }
      sql += ` GROUP BY hour ORDER BY hour ASC`
      return (prep(sql).all(...args) as { hour: number; n: number }[]).map((r) => ({ hour: r.hour, count: r.n }))
    },

    // Çapraz-hesap olay korelasyonu için ham veri — gruplama shared/incident.ts'de (saf, test edilebilir)
    getRecentInboxMessages(sinceMs: number, limit: number): { id: number; accountId: number; subject: string | null; date: number }[] {
      return prep(
        `SELECT id, account_id AS accountId, subject, date FROM messages
         WHERE folder_kind = 'inbox' AND hidden = 0 AND date > ? ORDER BY date DESC LIMIT ?`
      ).all(sinceMs, limit) as { id: number; accountId: number; subject: string | null; date: number }[]
    },

    // Sessizlik/patlama alarmı için ham zaman damgaları — istatistik hesabı shared/anomaly.ts'de (saf, test edilebilir)
    getRecentMessageDates(accountId: number, sinceMs: number): number[] {
      return (
        prep(`SELECT date FROM messages WHERE account_id = ? AND folder_kind = 'inbox' AND date > ?`).all(
          accountId,
          sinceMs
        ) as { date: number }[]
      ).map((r) => r.date)
    },

    /** Klasördeki UID'lerin Message-ID'leri (taşınan iletiyi hedefte tanımak için) */
    messageIdsByUids(accountId: number, folderPath: string, uids: number[]): { uid: number; messageId: string | null }[] {
      if (!uids.length) return []
      return (
        prep(
          `SELECT m.uid, m.message_id FROM messages m JOIN folders f ON f.id = m.folder_id
           WHERE m.account_id = ? AND f.path = ? AND m.uid IN (${uids.map(() => '?').join(',')})`
        ).all(accountId, folderPath, ...uids) as { uid: number; message_id: string | null }[]
      ).map((r) => ({ uid: r.uid, messageId: r.message_id }))
    },

    uidsInWindow(folderId: number, lowUid: number): { id: number; uid: number }[] {
      return prep(`SELECT id, uid FROM messages WHERE folder_id = ? AND uid >= ?`).all(folderId, lowUid) as {
        id: number
        uid: number
      }[]
    },

    windowLowUid(folderId: number, windowSize: number): number | null {
      const r = prep(
        `SELECT uid FROM messages WHERE folder_id = ? ORDER BY uid DESC LIMIT 1 OFFSET ?`
      ).get(folderId, windowSize - 1) as { uid: number } | undefined
      if (r) return r.uid
      const min = prep(`SELECT MIN(uid) AS u FROM messages WHERE folder_id = ?`).get(folderId) as { u: number | null }
      return min.u
    },

    folderMessageCount(folderId: number): number {
      const r = prep(`SELECT COUNT(*) AS n FROM messages WHERE folder_id = ?`).get(folderId) as { n: number }
      return r.n
    }
  }
}
