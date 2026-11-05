// Sorgu modüllerinin ortak bağlamı: hazırlanmış ifade önbelleği, kasa hesap kimlikleri ve op mühürleme.
// `q` birleşik sorgu nesnesi; modüller birbirini yalnız onun üzerinden çağırır (makeQueries sonunda atanır).
import type { Database, Statement } from 'better-sqlite3'
import { decryptText, encryptText } from '../../vault/crypto'
import { getVaultKey } from '../../vault/state'
import { t } from '../../../shared/i18n'
import type { OpRow } from './types'
import type { Queries } from '../queries'

/** Açık arayüz (ReturnType değil): modüller `c.q` üzerinden birleşik nesneyi görür; çıkarımla
 *  tanımlansaydı Queries ↔ modül dönüş türleri döngüye girerdi. */
export interface QCtx {
  db: Database
  prep(sql: string): Statement
  secure: { ids: Set<number> }
  /** force: hesap kasa dışı olsa da mühürler (S/MIME op'u); anahtar yoksa düz yazmak yerine atar */
  sealOp(accountId: number, json: string, force?: boolean): string
  openOps(rows: OpRow[]): OpRow[]
  withUidValidity(accountId: number, payload: unknown): unknown
  encForAccount(accountId: number, v: string | null): string | null
  q: Queries
}

export const OP_SEAL = 'vault:'

export function createCtx(db: Database): QCtx {
  // Kasa hesabının op payload'u (taslak, ham gönderilen mail, webhook gövdesi: konu/gönderen/önizleme)
  // kasa anahtarıyla mühürlenir (R21) — önceden op_queue'da düz metin kalıyordu (zamanlanmış gönderimde
  // saatlerce). Kasa kilitliyken mühürlü op'lar listelenmez: açılınca kaldığı yerden sürer.
  const sealOp = (accountId: number, json: string, force = false): string => {
    if (!force && !secure.ids.has(accountId)) return json
    const key = getVaultKey()
    if (key) return OP_SEAL + encryptText(key, json)
    if (force) throw new Error(t('sync.vault.locked'))
    return json // kilitliyken içerikli op oluşmaz (şifre/poll yok)
  }
  const openOps = (rows: OpRow[]): OpRow[] =>
    rows.flatMap((r) => {
      if (!r.payload_json.startsWith(OP_SEAL)) return [r]
      const key = getVaultKey()
      if (!key) return [] // kasa kilitli: bekle
      try {
        return [{ ...r, payload_json: decryptText(key, r.payload_json.slice(OP_SEAL.length)) }]
      } catch {
        return []
      }
    })

  // UID'ler yalnız aynı UIDVALIDITY içinde anlamlıdır: op kuyruğa girerken klasörün o anki değeri
  // payload'a yazılır; yürütücü sunucudakiyle karşılaştırır (klasör yeniden oluşturulduysa yanlış
  // mesajı silmek/taşımak yerine iptal eder — R34)
  const withUidValidity = (accountId: number, payload: unknown): unknown => {
    const p = payload as { folderPath?: string; uids?: unknown; uidValidity?: number }
    if (!p || typeof p !== 'object' || !p.folderPath || !Array.isArray(p.uids) || p.uidValidity != null) return payload
    const f = db.prepare(`SELECT uidvalidity FROM folders WHERE account_id = ? AND path = ?`).get(accountId, p.folderPath) as
      | { uidvalidity: number | null }
      | undefined
    return f?.uidvalidity != null ? { ...p, uidValidity: f.uidvalidity } : payload
  }

  const stmt = new Map<string, Statement>()
  // IN (?,?,…) listeleri uzunluğa göre farklı SQL metni üretir: önbellek sınırsız büyümesin
  const STMT_CACHE_MAX = 500
  const prep = (sql: string): Statement => {
    let s = stmt.get(sql)
    if (!s) {
      if (stmt.size >= STMT_CACHE_MAX) stmt.clear()
      s = db.prepare(sql)
      stmt.set(sql, s)
    }
    return s
  }

  // Kasa hesap kimlikleri belleğe önbelleklenir — yazma yolunda her mesajda DB sorgusundan kaçınmak için.
  const secure = { ids: new Set<number>(
    (prep(`SELECT id FROM accounts WHERE secure = 1`).all() as { id: number }[]).map((r) => r.id)
  ) }
  // Kasa hesabına yazarken içerik kolonlarını şifreler; anahtar yoksa (kilitli) atar — kasa senkronu
  // yalnızca vault açıkken çalıştığından bu normalde tetiklenmez, ama bir emniyet.
  const encForAccount = (accountId: number, v: string | null): string | null => {
    if (v == null || !secure.ids.has(accountId)) return v
    const key = getVaultKey()
    if (!key) throw new Error(t('sync.vault.lockedCannotWriteAccount'))
    return encryptText(key, v)
  }


  return {
    db, prep, secure, sealOp, openOps, withUidValidity, encForAccount,
    q: undefined as unknown as Queries
  }
}
