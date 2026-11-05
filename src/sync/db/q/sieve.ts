// Sorgular — Sunucu tarafı filtreler: hesap durumu ve tatil yanıtı.
import { t } from '../../../shared/i18n'
import { SIEVE_PUBLIC_DETAILS, type SieveState, type SieveVacation } from '../../../shared/sieve'
import { decryptText, encryptText } from '../../vault/crypto'
import { getVaultKey } from '../../vault/state'
import type { QCtx } from './ctx'

export interface SieveAccountRow {
  account_id: number
  enabled: number
  host: string | null
  port: number | null
  tls: string | null
  caps_json: string | null
  caps_at: number | null
  state: SieveState
  state_detail: string | null
  script_hash: string | null
  deployed_at: number | null
  consent_script: string | null
  consent_at: number | null
  wrapper_of: string | null
  watched_json: string
  updated_at: number
}

// Yama anahtarları SQL'e girer: yalnız bu liste
const PATCHABLE = new Set<string>([
  'enabled', 'host', 'port', 'tls', 'caps_json', 'caps_at', 'state', 'state_detail', 'script_hash', 'deployed_at',
  'consent_script', 'consent_at', 'wrapper_of', 'watched_json', 'detail_enc'
])

const watchSinceKey = (accountId: number): string => `sieve_watch_since:${accountId}`

type StoredRow = SieveAccountRow & { detail_enc?: number }

/** Mühürlü ayrıntı kilitliyken okunmaz: boş görünür, düz metin hiç dolaşmaz */
function openRow({ detail_enc: sealed, ...row }: StoredRow): SieveAccountRow {
  if (!sealed || row.state_detail === null) return row
  const key = getVaultKey()
  return { ...row, state_detail: key ? decryptText(key, row.state_detail) : null }
}

export function sieveQueries(c: QCtx) {
  const { prep } = c

  /** Sunucu metni kasa hesabında düz durmaz. Kilitliyken mühürlenemez: yazılmaz, durum adı yeter */
  const sealDetail = (accountId: number, v: string | null): { state_detail: string | null; detail_enc: number } => {
    if (v === null || !c.secure.ids.has(accountId) || SIEVE_PUBLIC_DETAILS.has(v)) return { state_detail: v, detail_enc: 0 }
    const key = getVaultKey()
    return key ? { state_detail: encryptText(key, v), detail_enc: 1 } : { state_detail: null, detail_enc: 0 }
  }

  const watchSince = (accountId: number): Record<string, number> => {
    try {
      const v = JSON.parse(c.q.prefGet(watchSinceKey(accountId)) ?? '{}') as unknown
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {}
    } catch {
      return {}
    }
  }

  return {
    getSieveAccount(accountId: number): SieveAccountRow | undefined {
      const row = prep(`SELECT * FROM sieve_accounts WHERE account_id = ?`).get(accountId) as StoredRow | undefined
      return row && openRow(row)
    },

    upsertSieveAccount(accountId: number, patch: Partial<SieveAccountRow>, now: number): void {
      const sealed = patch.state_detail === undefined ? {} : sealDetail(accountId, patch.state_detail)
      const entries = Object.entries({ ...patch, ...sealed }).filter(([k, v]) => PATCHABLE.has(k) && v !== undefined)
      const keys = entries.map(([k]) => k)
      prep(
        `INSERT INTO sieve_accounts (account_id, ${[...keys, 'updated_at'].join(', ')}) VALUES (?, ${[...keys, 'updated_at'].map(() => '?').join(', ')})
         ON CONFLICT(account_id) DO UPDATE SET ${[...keys, 'updated_at'].map((k) => `${k} = excluded.${k}`).join(', ')}`
      ).run(accountId, ...entries.map(([, v]) => v), now)
      if (patch.watched_json === undefined) return
      // izlemeden çıkan klasörün başlangıcı silinir: yeniden girerse yeni dağıtımın zamanı geçerli olur
      const paths = c.q.sieveWatchedPaths(accountId)
      const kept = Object.entries(watchSince(accountId)).filter(([path]) => paths.includes(path))
      c.q.prefSet(watchSinceKey(accountId), JSON.stringify(Object.fromEntries(kept)))
    },

    listSieveAccounts(): SieveAccountRow[] {
      return (prep(`SELECT * FROM sieve_accounts ORDER BY account_id`).all() as StoredRow[]).map(openRow)
    },

    /** Betik etkinleşmeden önce: yeni klasörün izlenme başlangıcı, var olanın başlangıcı korunur */
    addSieveWatched(accountId: number, paths: string[], since: number): void {
      const list = c.q.sieveWatchedPaths(accountId)
      const map = watchSince(accountId)
      for (const path of paths) {
        if (!list.includes(path)) list.push(path)
        map[path] ??= since
      }
      c.q.prefSet(watchSinceKey(accountId), JSON.stringify(map))
      c.q.upsertSieveAccount(accountId, { watched_json: JSON.stringify(list) }, Date.now())
    },

    sieveWatchSince(accountId: number): Record<string, number> {
      return watchSince(accountId)
    },

    /** Kasa hesabında konu ve gövde mühürlü: kilitliyken atar, boş tatil gibi görünmesin */
    getSieveVacation(accountId: number): SieveVacation | null {
      const r = prep(`SELECT enabled, subject, body, days, start_date, end_date, enc FROM sieve_vacation WHERE account_id = ?`).get(accountId) as
        | { enabled: number; subject: string; body: string; days: number; start_date: string | null; end_date: string | null; enc: number }
        | undefined
      if (!r) return null
      const key = getVaultKey()
      if (r.enc && !key) throw new Error(t('sync.vault.locked'))
      const open = (v: string): string => (r.enc ? decryptText(key!, v) : v)
      return { enabled: !!r.enabled, subject: open(r.subject), body: open(r.body), days: r.days, startDate: r.start_date, endDate: r.end_date }
    },

    setSieveVacation(accountId: number, v: SieveVacation, now: number): void {
      prep(
        `INSERT INTO sieve_vacation (account_id, enabled, subject, body, days, start_date, end_date, enc, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET enabled = excluded.enabled, subject = excluded.subject, body = excluded.body,
           days = excluded.days, start_date = excluded.start_date, end_date = excluded.end_date, enc = excluded.enc, updated_at = excluded.updated_at`
      ).run(
        accountId, v.enabled ? 1 : 0, c.encForAccount(accountId, v.subject), c.encForAccount(accountId, v.body), v.days, v.startDate, v.endDate,
        c.secure.ids.has(accountId) ? 1 : 0, now
      )
    },

    /** Sunucu taşımalarının hedef klasörleri; satır yoksa ya da değer bozuksa boş */
    sieveWatchedPaths(accountId: number): string[] {
      const r = prep(`SELECT watched_json FROM sieve_accounts WHERE account_id = ?`).get(accountId) as { watched_json: string } | undefined
      if (!r) return []
      try {
        const v = JSON.parse(r.watched_json) as unknown
        return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []
      } catch {
        return []
      }
    }
  }
}
