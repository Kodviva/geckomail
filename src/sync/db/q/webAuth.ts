// Sorgular — Web girişi (sunucu modu): çerezli oturumlar, giriş denemeleri ve kullanıcının TOTP durumu.
import type { QCtx } from './ctx'

export type SessionKind = 'web' | 'mobile'

export interface WebSessionRow {
  id_hash: string
  user_id: number
  created_at: number
  last_seen_at: number
  expires_at: number
  ip: string | null
  user_agent: string | null
  kind: SessionKind
}

export interface PasskeyRow {
  id: string
  user_id: number
  public_key: Buffer
  counter: number
  transports: string | null
  name: string
  created_at: number
  last_used_at: number | null
}

export function webAuthQueries(c: QCtx) {
  const { prep } = c
  return {
    insertWebSession(s: { idHash: string; userId: number; now: number; expiresAt: number; ip: string | null; userAgent: string | null; kind?: SessionKind }): void {
      prep(
        `INSERT INTO web_sessions (id_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(s.idHash, s.userId, s.now, s.now, s.expiresAt, s.ip, s.userAgent, s.kind ?? 'web')
    },

    getWebSession(idHash: string): WebSessionRow | undefined {
      return prep(`SELECT * FROM web_sessions WHERE id_hash = ?`).get(idHash) as WebSessionRow | undefined
    },

    listWebSessionsForUser(userId: number, now: number): WebSessionRow[] {
      return prep(`SELECT * FROM web_sessions WHERE user_id = ? AND expires_at >= ? ORDER BY last_seen_at DESC`).all(userId, now) as WebSessionRow[]
    },

    touchWebSession(idHash: string, now: number): void {
      prep(`UPDATE web_sessions SET last_seen_at = ? WHERE id_hash = ?`).run(now, idHash)
    },

    extendWebSession(idHash: string, expiresAt: number): void {
      prep(`UPDATE web_sessions SET expires_at = ? WHERE id_hash = ?`).run(expiresAt, idHash)
    },

    deleteWebSession(idHash: string): void {
      prep(`DELETE FROM web_sessions WHERE id_hash = ?`).run(idHash)
    },

    /** kullanıcının oturumlarını siler (keepIdHash dışında); silinen kimlikler (açık soketleri kapatmak için) */
    deleteWebSessionsForUser(userId: number, keepIdHash?: string): string[] {
      return c.db.transaction(() => {
        const ids = (prep(`SELECT id_hash FROM web_sessions WHERE user_id = ? AND id_hash IS NOT ?`).all(userId, keepIdHash ?? null) as { id_hash: string }[]).map((r) => r.id_hash)
        prep(`DELETE FROM web_sessions WHERE user_id = ? AND id_hash IS NOT ?`).run(userId, keepIdHash ?? null)
        return ids
      })()
    },

    /** süresi ya da boşta süresi dolmuş oturumları siler; silinen kimlikler */
    /** pushIdleMs: push cihazı olan oturumun boşta sınırı */
    deleteExpiredWebSessions(now: number, idleMs: number, pushIdleMs: number): { idHash: string; userId: number }[] {
      const rows = prep(
        `DELETE FROM web_sessions WHERE expires_at < ? OR last_seen_at < ?
           OR (last_seen_at < ? AND NOT EXISTS (SELECT 1 FROM push_devices d WHERE d.web_session_id = web_sessions.id_hash))
         RETURNING id_hash, user_id`
      ).all(now, now - pushIdleMs, now - idleMs) as { id_hash: string; user_id: number }[]
      return rows.map((r) => ({ idHash: r.id_hash, userId: r.user_id }))
    },

    webSessionHasPush(idHash: string): boolean {
      return prep(`SELECT 1 FROM push_devices WHERE web_session_id = ? LIMIT 1`).get(idHash) !== undefined
    },

    /** ok: 1 giriş tamam, 0 başarısız (kilide sayılır), 2 sayılmayan ara sonuç */
    recordWebLoginAttempt(ts: number, ip: string, username: string, ok: 0 | 1 | 2): void {
      prep(`INSERT INTO web_login_attempts (ts, ip, username, ok) VALUES (?, ?, ?, ?)`).run(ts, ip, username, ok)
    },

    /** `since`ten bu yana başarısız deneme sayısı: IP'ye göre ve kullanıcı adına göre ayrı ayrı */
    webLoginFailuresSince(since: number, ip: string, username: string): { byIp: number; byUser: number } {
      const r = prep(
        `SELECT COALESCE(SUM(ip = ?), 0) AS byIp, COALESCE(SUM(username = ?), 0) AS byUser
         FROM web_login_attempts WHERE ts >= ? AND ok = 0 AND (ip = ? OR username = ?)`
      ).get(ip, username, since, ip, username) as { byIp: number; byUser: number }
      return r
    },

    /** kullanıcı adının (WebAuth anahtarı: kırpılmış, küçük harf) tüm deneme kayıtları; silinen satır sayısı */
    deleteWebLoginAttemptsForUser(username: string): number {
      return prep(`DELETE FROM web_login_attempts WHERE username = ?`).run(username).changes
    },

    pruneWebLoginAttempts(before: number): void {
      prep(`DELETE FROM web_login_attempts WHERE ts < ?`).run(before)
    },

    /** onaylanmamış yeni sır: etkin değil, son adım sıfırlanır */
    setTotpPending(userId: number, secretEnc: Buffer): void {
      prep(`UPDATE users SET totp_secret_enc = ?, totp_enabled = 0, totp_last_step = NULL WHERE id = ?`).run(secretEnc, userId)
    },

    enableTotp(userId: number, step: number): void {
      prep(`UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?`).run(step, userId)
    },

    /** Adımı tek SQL ile sahiplenir: yalnız sır duruyorsa ve adım son kabul edilenden yeniyse.
     *  Eşzamanlı iki istek aynı kodu kullanırsa yalnız biri true alır. */
    claimTotpStep(userId: number, step: number): boolean {
      return (
        prep(
          `UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_secret_enc IS NOT NULL AND (totp_last_step IS NULL OR totp_last_step < ?)`
        ).run(step, userId, step).changes === 1
      )
    },

    clearTotp(userId: number): void {
      prep(`UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?`).run(userId)
    },

    insertPasskey(p: { id: string; userId: number; publicKey: Buffer; counter: number; transports: string | null; name: string; now: number }): boolean {
      return (
        prep(
          `INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
        ).run(p.id, p.userId, p.publicKey, p.counter, p.transports, p.name, p.now).changes === 1
      )
    },

    getPasskey(id: string): PasskeyRow | undefined {
      return prep(`SELECT * FROM passkeys WHERE id = ?`).get(id) as PasskeyRow | undefined
    },

    listPasskeys(userId: number): PasskeyRow[] {
      return prep(`SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at, id`).all(userId) as PasskeyRow[]
    },

    /** Kullanımı tek SQL ile sahiplenir: sayaç okunduğu gibi duruyorsa. Eşzamanlı aynı imza yalnız bir kez geçer. */
    claimPasskeyUse(id: string, expected: number, counter: number, now: number): boolean {
      return prep(`UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ? AND counter = ?`).run(counter, now, id, expected).changes === 1
    },

    /** Hesap temizliği (parola/2FA sıfırlama): kullanıcının bütün anahtarları; silinen sayısı */
    deletePasskeysForUser(userId: number): number {
      return prep(`DELETE FROM passkeys WHERE user_id = ?`).run(userId).changes
    },

    /** Yalnız kullanıcının kendi anahtarı silinir */
    deletePasskey(userId: number, id: string): boolean {
      return prep(`DELETE FROM passkeys WHERE id = ? AND user_id = ?`).run(id, userId).changes === 1
    }
  }
}
