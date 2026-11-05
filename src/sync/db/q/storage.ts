// Sorgular — Gövde/ek önbelleği ve işlem kuyruğu.
import { decryptText, encryptText } from '../../vault/crypto'
import { getVaultKey } from '../../vault/state'
import { t } from '../../../shared/i18n'
import { type OpRow } from './types'
import { OP_SEAL, type QCtx } from './ctx'

export function storageQueries(c: QCtx) {
  const { prep } = c
  const markRunning = (rows: OpRow[]): OpRow[] => {
    if (rows.length) c.prep(`UPDATE op_queue SET state = 'running' WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows.map((r) => r.id))
    return rows
  }
  return {
    getBodyRow(messageId: number): { text_plain: string | null; html: string | null } | undefined {
      const r = prep(`SELECT text_plain, html, enc FROM bodies WHERE message_id = ?`).get(messageId) as
        | { text_plain: string | null; html: string | null; enc: number }
        | undefined
      if (!r) return undefined
      prep(`UPDATE bodies SET last_access_at = ? WHERE message_id = ?`).run(Date.now(), messageId)
      if (r.enc !== 1) return { text_plain: r.text_plain, html: r.html }
      // kasa gövdesi: anahtar yoksa (kilitli) undefined → çağıran "kasa kilitli" gösterir
      const key = getVaultKey()
      if (!key) return undefined
      try {
        return {
          text_plain: r.text_plain ? decryptText(key, r.text_plain) : null,
          html: r.html ? decryptText(key, r.html) : null
        }
      } catch {
        return undefined
      }
    },

    saveBody(messageId: number, textPlain: string | null, html: string | null, rawSize: number): void {
      // mesajın hesabı kasa ise gövde şifreli yazılır, bodies.enc=1
      const owner = prep(`SELECT account_id FROM messages WHERE id = ?`).get(messageId) as { account_id: number } | undefined
      const secure = owner ? c.secure.ids.has(owner.account_id) : false
      let tp = textPlain
      let h = html
      if (secure) {
        const key = getVaultKey()
        if (!key) throw new Error(t('sync.vault.lockedCannotWriteBody'))
        tp = textPlain == null ? null : encryptText(key, textPlain)
        h = html == null ? null : encryptText(key, html)
      }
      prep(
        `INSERT INTO bodies (message_id, text_plain, html, fetched_at, last_access_at, raw_size, enc, text_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET text_plain = excluded.text_plain, html = excluded.html, fetched_at = excluded.fetched_at, last_access_at = excluded.last_access_at, enc = excluded.enc, text_bytes = excluded.text_bytes`
      ).run(messageId, tp, h, Date.now(), Date.now(), rawSize, secure ? 1 : 0, (tp?.length ?? 0) + (h?.length ?? 0))
    },

    attachmentsFor(messageId: number) {
      return prep(`SELECT * FROM attachments WHERE message_id = ? ORDER BY id`).all(messageId) as {
        id: number
        message_id: number
        part_id: string | null
        filename: string | null
        mime: string | null
        size: number | null
        content_id: string | null
        disk_path: string | null
      }[]
    },

    getAttachment(id: number) {
      return prep(`SELECT * FROM attachments WHERE id = ?`).get(id) as
        | {
            id: number
            message_id: number
            part_id: string | null
            filename: string | null
            mime: string | null
            size: number | null
            content_id: string | null
            disk_path: string | null
          }
        | undefined
    },

    insertAttachment(a: {
      messageId: number
      partId: string | null
      filename: string | null
      mime: string | null
      size: number | null
      contentId: string | null
      diskPath: string | null
    }): number {
      const r = prep(
        `INSERT INTO attachments (message_id, part_id, filename, mime, size, content_id, disk_path, fetched_at, last_access_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(a.messageId, a.partId, a.filename, a.mime, a.size, a.contentId, a.diskPath, Date.now(), Date.now())
      return Number(r.lastInsertRowid)
    },

    clearAttachments(messageId: number): void {
      prep(`DELETE FROM attachments WHERE message_id = ?`).run(messageId)
    },

    setAttachmentPath(id: number, diskPath: string): void {
      prep(`UPDATE attachments SET disk_path = ?, fetched_at = ?, last_access_at = ? WHERE id = ?`).run(
        diskPath, Date.now(), Date.now(), id
      )
    },

    enqueueOp(accountId: number, kind: string, payload: unknown, o: { seal?: boolean } = {}): number {
      const r = prep(
        `INSERT INTO op_queue (account_id, kind, payload_json, created_at, not_before) VALUES (?, ?, ?, ?, 0)`
      ).run(accountId, kind, c.sealOp(accountId, JSON.stringify(c.withUidValidity(accountId, payload)), o.seal), Date.now())
      return Number(r.lastInsertRowid)
    },

    enqueueOpDelayed(accountId: number, kind: string, payload: unknown, notBefore: number, o: { seal?: boolean } = {}): number {
      const r = prep(
        `INSERT INTO op_queue (account_id, kind, payload_json, created_at, not_before) VALUES (?, ?, ?, ?, ?)`
      ).run(accountId, kind, c.sealOp(accountId, JSON.stringify(c.withUidValidity(accountId, payload)), o.seal), Date.now(), notBefore)
      return Number(r.lastInsertRowid)
    },

    /** sendMail tekrar koruması: kimliğin bu kullanıcıdaki kaydı (eski kayıtlar önce budanır) */
    sendIdRecord(id: string, userId: number, olderThan: number): { contentHash: string; failed: boolean } | null {
      prep(`DELETE FROM send_ids WHERE created_at < ?`).run(olderThan)
      const r = prep(
        `SELECT s.content_hash AS hash, o.state AS state FROM send_ids s
         LEFT JOIN op_queue o ON o.id = s.op_id AND o.kind = 'smtp_send' AND o.created_at <= s.created_at
         WHERE s.id = ? AND s.user_id = ?`
      ).get(id, userId) as { hash: string; state: string | null } | undefined
      // op_queue.id geri dönüşümlüdür (AUTOINCREMENT yok): biten işlemin kimliğini sonraki işlem alabilir. Kayıt işlemden
      // hemen sonra yazıldığından kendi işlemi kayıttan eski; tür ve zamanı tutan satır yoksa işlem gönderilmiştir (iptal
      // kaydı siler)
      return r ? { contentHash: r.hash, failed: r.state === 'failed' } : null
    },

    /** Yeni gönderim: aynı kimliğin önceki kaydının yerini alır (başka kullanıcının kaydına dokunulmaz) */
    recordSendId(id: string, userId: number, contentHash: string, opId: number): void {
      prep(
        `INSERT INTO send_ids (id, user_id, created_at, content_hash, op_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, content_hash = excluded.content_hash, op_id = excluded.op_id
         WHERE user_id = excluded.user_id`
      ).run(id, userId, Date.now(), contentHash, opId)
    },

    /** İptal edilen işlem gönderilmedi: aynı kimlikle yeniden deneme yeni gönderimdir. İşlem satırı silinmeden çağrılır:
     *  kimliği geri dönüşümle alan yeni işlemin iptali, eski (gönderilmiş) işlemin kaydını silmesin */
    forgetSendIdForOp(opId: number): void {
      prep(
        `DELETE FROM send_ids WHERE op_id = ?
           AND created_at >= (SELECT created_at FROM op_queue WHERE id = ? AND kind = 'smtp_send')`
      ).run(opId, opId)
    },

    // Kilitliyken mühürlü satır sınırı doldurmaz: açılamayan satırlar LIMIT'ten önce elenir, düz işler durmaz
    dueOps(now: number, limit: number): OpRow[] {
      return c.openOps(
        prep(
          `SELECT id, account_id, kind, payload_json, attempts FROM op_queue
           WHERE state = 'pending' AND not_before <= ? AND kind != 'call_webhook' AND (? OR payload_json NOT LIKE '${OP_SEAL}%')
           ORDER BY id LIMIT ?`
        ).all(now, getVaultKey() ? 1 : 0, limit) as OpRow[]
      )
    },

    // call_webhook ayrı bir bütçe/eşzamanlılık şeridi ile drain edilir — IMAP/SMTP'den bağımsız.
    dueWebhookOps(now: number, limit: number): OpRow[] {
      return c.openOps(
        prep(
          `SELECT id, account_id, kind, payload_json, attempts FROM op_queue
           WHERE state = 'pending' AND not_before <= ? AND kind = 'call_webhook' AND (? OR payload_json NOT LIKE '${OP_SEAL}%')
           ORDER BY id LIMIT ?`
        ).all(now, getVaultKey() ? 1 : 0, limit) as OpRow[]
      )
    },

    /** Sahiplenme: seçilen satırlar aynı adımda 'running' olur; Geri Al ve iptal işlenmekte olanı silemez.
     *  Mühürlü ve kasa kilitliyse açılamayan satır sahiplenilmez, beklemede kalır */
    claimDueOps(now: number, limit: number): OpRow[] {
      return c.q.tx(() => markRunning(c.q.dueOps(now, limit)))
    },

    claimDueWebhookOps(now: number, limit: number): OpRow[] {
      return c.q.tx(() => markRunning(c.q.dueWebhookOps(now, limit)))
    },

    /** Sahiplenilip çalıştırılamayan satırlar sıraya döner */
    opRelease(ids: number[]): void {
      if (!ids.length) return
      prep(`UPDATE op_queue SET state = 'pending' WHERE state = 'running' AND id IN (${ids.map(() => '?').join(',')})`).run(...ids)
    },

    /** Açılışta: önceki süreç işlerken kapandıysa op kaybolmaz */
    resetRunningOps(): number {
      return prep(`UPDATE op_queue SET state = 'pending' WHERE state = 'running'`).run().changes
    },

    opDone(id: number): void {
      prep(`DELETE FROM op_queue WHERE id = ?`).run(id)
    },

    opRetry(id: number, error: string, notBefore: number): void {
      prep(`UPDATE op_queue SET state = 'pending', attempts = attempts + 1, last_error = ?, not_before = ? WHERE id = ?`).run(
        error, notBefore, id
      )
    },

    // op payload'unu yerinde güncelle (ör. SMTP kimliği/tarihi ilk denemede sabitlenir)
    opSetPayload(id: number, payload: unknown): void {
      // mühürlü satır mühürlü kalır: S/MIME op'u kasa dışı hesapta da olabilir
      const r = prep(`SELECT account_id, payload_json FROM op_queue WHERE id = ?`).get(id) as { account_id: number; payload_json: string } | undefined
      prep(`UPDATE op_queue SET payload_json = ? WHERE id = ?`).run(c.sealOp(r?.account_id ?? 0, JSON.stringify(payload), r?.payload_json.startsWith(OP_SEAL)), id)
    },

    // governor ertelemesi (soğuma/hız): deneme hakkı yakmadan ileri at
    opDefer(id: number, reason: string, notBefore: number): void {
      prep(`UPDATE op_queue SET state = 'pending', last_error = ?, not_before = ? WHERE id = ?`).run(reason, notBefore, id)
    },

    /** Giden kutusu (R12): bekleyen/başarısız op'lar — mühürlü olanlar açılabiliyorsa açık, değilse locked */
    listOps(accountIds: number[] | null, limit = 300): (OpRow & { state: string; not_before: number | null; last_error: string | null; created_at: number; locked: boolean })[] {
      const where = accountIds ? `AND account_id IN (${accountIds.map(() => '?').join(',') || 'NULL'})` : ''
      const rows = prep(
        `SELECT id, account_id, kind, payload_json, attempts, state, not_before, last_error, created_at FROM op_queue
         WHERE state IN ('pending', 'running', 'failed') ${where} ORDER BY state = 'failed', id DESC LIMIT ?`
      ).all(...(accountIds ?? []), limit) as (OpRow & { state: string; not_before: number | null; last_error: string | null; created_at: number })[]
      return rows.map((row) => {
        // arayüz için işlenmekte olan da bekliyor sayılır (iptal isteğini sunucu reddeder)
        const r = row.state === 'running' ? { ...row, state: 'pending' } : row
        if (!r.payload_json.startsWith('vault:')) return { ...r, locked: false }
        const opened = c.openOps([r])
        return opened.length ? { ...(opened[0] as typeof r), locked: false } : { ...r, payload_json: '{}', locked: true }
      })
    },

    getOp(id: number): (OpRow & { state: string }) | undefined {
      const r = prep(`SELECT id, account_id, kind, payload_json, attempts, state FROM op_queue WHERE id = ?`).get(id) as
        | (OpRow & { state: string })
        | undefined
      if (!r) return undefined
      const opened = c.openOps([r])
      return opened.length ? (opened[0] as typeof r) : undefined
    },

    /** yeniden dene: deneme sayacı sıfır, hemen */
    opResetForRetry(id: number): void {
      prep(`UPDATE op_queue SET state = 'pending', attempts = 0, not_before = 0, last_error = NULL WHERE id = ?`).run(id)
    },

    /** iptal edilen taşıma/silme op'unun iyimser gizlediği mesajları geri göster */
    unhideByFolderUids(accountId: number, folderPath: string, uids: number[]): void {
      if (!uids.length) return
      prep(
        `UPDATE messages SET hidden = 0 WHERE account_id = ? AND folder_id = (SELECT id FROM folders WHERE account_id = ? AND path = ?)
         AND uid IN (${uids.map(() => '?').join(',')})`
      ).run(accountId, accountId, folderPath, ...uids)
    },

    pruneFailedOps(before: number): number {
      return prep(`DELETE FROM op_queue WHERE state = 'failed' AND created_at < ?`).run(before).changes
    },

    opFailed(id: number, error: string): void {
      prep(`UPDATE op_queue SET state = 'failed', last_error = ? WHERE id = ?`).run(error, id)
    },

    deletePendingOps(ids: number[]): number {
      if (!ids.length) return 0
      const r = prep(`DELETE FROM op_queue WHERE state = 'pending' AND id IN (${ids.map(() => '?').join(',')})`).run(
        ...ids
      )
      return r.changes
    }
  }
}
