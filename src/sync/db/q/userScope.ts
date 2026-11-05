// Sorgular — Kişiye ait veri (§10.1): bildirim tercihleri ve hesap başına imza kullanıcıya bağlı.
import type { QCtx } from './ctx'

export function userScopeQueries(c: QCtx) {
  const { prep } = c
  return {
    userPrefGet(userId: number, key: string): string | null {
      const r = prep(`SELECT value FROM user_prefs WHERE user_id = ? AND key = ?`).get(userId, key) as { value: string } | undefined
      return r?.value ?? null
    },

    userPrefSet(userId: number, key: string, value: string): void {
      prep(`INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`).run(
        userId, key, value
      )
    },

    /** önce kişinin imzası, yoksa hesabın varsayılanı */
    getSignatureFor(userId: number, accountId: number): string | null {
      const r = prep(
        `SELECT COALESCE(us.signature, a.signature) AS signature FROM accounts a
         LEFT JOIN user_signatures us ON us.account_id = a.id AND us.user_id = ? WHERE a.id = ?`
      ).get(userId, accountId) as { signature: string | null } | undefined
      return r?.signature ?? null
    },

    /** hesap listesi için: kişinin tüm imzaları tek sorguda (accountId → imza) */
    userSignatureMap(userId: number): Map<number, string> {
      const rows = prep(`SELECT account_id, signature FROM user_signatures WHERE user_id = ?`).all(userId) as { account_id: number; signature: string }[]
      return new Map(rows.map((r) => [r.account_id, r.signature]))
    },

    /** null = kişisel imzayı sil (hesabın varsayılanına dön) */
    setUserSignature(userId: number, accountId: number, signature: string | null): void {
      if (signature == null) {
        prep(`DELETE FROM user_signatures WHERE user_id = ? AND account_id = ?`).run(userId, accountId)
        return
      }
      prep(
        `INSERT INTO user_signatures (user_id, account_id, signature) VALUES (?, ?, ?)
         ON CONFLICT(user_id, account_id) DO UPDATE SET signature = excluded.signature`
      ).run(userId, accountId, signature)
    },

    /** masaüstünde girişli oturum yokken bildirim tercihleri bu kullanıcıdan okunur */
    firstAdminId(): number | null {
      const r = prep(`SELECT id FROM users WHERE role = 'admin' AND enabled = 1 ORDER BY id LIMIT 1`).get() as { id: number } | undefined
      return r?.id ?? null
    }
  }
}
