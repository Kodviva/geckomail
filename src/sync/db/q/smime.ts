// Sorgular — S/MIME kimlikleri, alıcı sertifikaları, güven kökleri, CRL önbelleği ve ileti durumu.
// userId alan her sorgu WHERE user_id = ? içerir: kimlik yalnız sahibinindir (K10).
import type { SmimeInfo, SmimeKind } from '../../../shared/smime'
import { createHash } from 'node:crypto'
import { decryptText } from '../../vault/crypto'
import { getVaultKey } from '../../vault/state'
import type { SmimeAnchorRow, SmimeContactCertRow, SmimeCrlRow, SmimeIdentityRow } from './types'
import type { QCtx } from './ctx'

const addr = (email: string): string => email.trim().toLowerCase()

export interface CrlSetState {
  size: number | null
  der_sha256: string | null
  set_generation: number | null
  set_key: string | null
  set_scope: string | null
}

export function smimeQueries(c: QCtx) {
  const { prep } = c
  return {
    listIdentities(userId: number): SmimeIdentityRow[] {
      return prep(`SELECT * FROM smime_identities WHERE user_id = ? ORDER BY email, not_after DESC`).all(userId) as SmimeIdentityRow[]
    },

    getIdentity(userId: number, id: number): SmimeIdentityRow | undefined {
      return prep(`SELECT * FROM smime_identities WHERE user_id = ? AND id = ?`).get(userId, id) as SmimeIdentityRow | undefined
    },

    identitiesForEmail(userId: number, email: string): SmimeIdentityRow[] {
      return prep(`SELECT * FROM smime_identities WHERE user_id = ? AND email = ? ORDER BY not_after DESC`).all(userId, addr(email)) as SmimeIdentityRow[]
    },

    insertIdentity(i: {
      userId: number
      email: string
      fingerprint: string
      certDer: Buffer
      chainDer: string
      keyEnc: string
      notBefore: number
      notAfter: number
      canSign: boolean
      canEncrypt: boolean
    }): number {
      const r = prep(
        `INSERT INTO smime_identities (user_id, email, fingerprint, cert_der, chain_der, key_enc, not_before, not_after, can_sign, can_encrypt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(i.userId, addr(i.email), i.fingerprint, i.certDer, i.chainDer, i.keyEnc, i.notBefore, i.notAfter, i.canSign ? 1 : 0, i.canEncrypt ? 1 : 0, Date.now())
      return Number(r.lastInsertRowid)
    },

    deleteIdentity(userId: number, id: number): boolean {
      return prep(`DELETE FROM smime_identities WHERE user_id = ? AND id = ?`).run(userId, id).changes > 0
    },

    contactCerts(userId: number, email: string): SmimeContactCertRow[] {
      return prep(`SELECT * FROM smime_contact_certs WHERE user_id = ? AND email = ? ORDER BY not_after DESC`).all(userId, addr(email)) as SmimeContactCertRow[]
    },

    listContactCerts(userId: number): SmimeContactCertRow[] {
      return prep(`SELECT * FROM smime_contact_certs WHERE user_id = ? ORDER BY email, not_after DESC`).all(userId) as SmimeContactCertRow[]
    },

    upsertContactCert(i: {
      userId: number
      email: string
      fingerprint: string
      certDer: Buffer
      chainDer: string
      notAfter: number
      capabilities: string | null
      source: 'auto' | 'manual'
    }): void {
      const now = Date.now()
      // elle kaydedilmiş sertifika otomatik görülünce 'auto'ya düşmez; yetenek listesi yoksa eskisi korunur
      prep(
        `INSERT INTO smime_contact_certs (user_id, email, fingerprint, cert_der, chain_der, not_after, capabilities, source, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, email, fingerprint) DO UPDATE SET
           chain_der = excluded.chain_der, not_after = excluded.not_after,
           capabilities = COALESCE(excluded.capabilities, capabilities),
           source = CASE WHEN excluded.source = 'manual' THEN 'manual' ELSE source END,
           last_seen_at = excluded.last_seen_at`
      ).run(i.userId, addr(i.email), i.fingerprint, i.certDer, i.chainDer, i.notAfter, i.capabilities, i.source, now, now)
    },

    deleteContactCert(userId: number, id: number): boolean {
      return prep(`DELETE FROM smime_contact_certs WHERE user_id = ? AND id = ?`).run(userId, id).changes > 0
    },

    listAnchors(): SmimeAnchorRow[] {
      return prep(`SELECT * FROM smime_trust_anchors ORDER BY created_at, fingerprint`).all() as SmimeAnchorRow[]
    },

    addAnchor(a: { fingerprint: string; certDer: Buffer; label: string; addedBy: number | null }): void {
      prep(
        `INSERT INTO smime_trust_anchors (fingerprint, cert_der, label, added_by, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (fingerprint) DO UPDATE SET label = excluded.label`
      ).run(a.fingerprint, a.certDer, a.label, a.addedBy, Date.now())
    },

    removeAnchor(fingerprint: string): boolean {
      return prep(`DELETE FROM smime_trust_anchors WHERE fingerprint = ?`).run(fingerprint).changes > 0
    },

    getCrl(url: string): SmimeCrlRow | undefined {
      return prep(`SELECT * FROM smime_crls WHERE url = ?`).get(url) as SmimeCrlRow | undefined
    },

    /** DER'siz durum: gönderim yolu 10 MB'lık satırı okumaz */
    crlSetState(url: string): CrlSetState | undefined {
      return prep(`SELECT length(der) AS size, der_sha256, set_generation, set_key, set_scope FROM smime_crls WHERE url = ?`).get(url) as CrlSetState | undefined
    },

    crlSerialListed(url: string, generation: number, serial: Uint8Array): boolean {
      return !!prep(`SELECT 1 FROM smime_crl_serials WHERE url = ? AND generation = ? AND serial = ?`).get(url, generation, serial)
    },

    /** Yeni nesil: yarım kalmış nesillerin de üstünde, tamamlanan küme hiç değişmez */
    nextCrlGeneration(url: string): number {
      const r = prep(
        `SELECT MAX(COALESCE((SELECT MAX(generation) FROM smime_crl_serials WHERE url = ?), 0), COALESCE((SELECT set_generation FROM smime_crls WHERE url = ?), 0)) + 1 AS n`
      ).get(url, url) as { n: number }
      return r.n
    },

    addCrlSerials(url: string, generation: number, serials: Uint8Array[]): void {
      const add = prep(`INSERT OR IGNORE INTO smime_crl_serials (url, generation, serial) VALUES (?, ?, ?)`)
      c.q.tx(() => {
        for (const s of serials) add.run(url, generation, s)
      })
    },

    /** Tek adımda geçer: okuyucu ya eski nesli ya yeniyi görür. Yalnız daha eski nesiller silinir */
    commitCrlSet(url: string, generation: number, key: string, scope: string): void {
      c.q.tx(() => {
        prep(`UPDATE smime_crls SET set_generation = ?, set_key = ?, set_scope = ? WHERE url = ?`).run(generation, key, scope, url)
        prep(`DELETE FROM smime_crl_serials WHERE url = ? AND generation < ?`).run(url, generation)
      })
    },

    /** Başarısız çekim yalnız last_error_at yazar: elde kalan liste silinmez. */
    putCrl(r: { url: string; der: Buffer | null; thisUpdate: number | null; nextUpdate: number | null; fetchedAt: number | null; lastErrorAt: number | null }): void {
      prep(
        `INSERT INTO smime_crls (url, der, der_sha256, this_update, next_update, fetched_at, last_error_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (url) DO UPDATE SET
           der = COALESCE(excluded.der, der), der_sha256 = COALESCE(excluded.der_sha256, der_sha256), this_update = COALESCE(excluded.this_update, this_update),
           next_update = COALESCE(excluded.next_update, next_update), fetched_at = COALESCE(excluded.fetched_at, fetched_at),
           last_error_at = excluded.last_error_at`
      ).run(r.url, r.der, r.der ? createHash('sha256').update(r.der).digest('hex') : null, r.thisUpdate, r.nextUpdate, r.fetchedAt, r.lastErrorAt)
    },

    /** Kasa hesabında kilitliyken veya çözülemezse null. */
    getMessageSmime(id: number): SmimeInfo | null {
      const r = prep(`SELECT s.info AS info, m.enc AS enc FROM message_smime s JOIN messages m ON m.id = s.message_id WHERE s.message_id = ?`).get(id) as
        | { info: string; enc: number }
        | undefined
      if (!r) return null
      try {
        if (r.enc !== 1) return JSON.parse(r.info) as SmimeInfo
        const key = getVaultKey()
        return key ? (JSON.parse(decryptText(key, r.info)) as SmimeInfo) : null
      } catch {
        return null
      }
    },

    setMessageSmime(id: number, info: SmimeInfo): void {
      const m = prep(`SELECT account_id FROM messages WHERE id = ?`).get(id) as { account_id: number } | undefined
      if (!m) return
      prep(`INSERT INTO message_smime (message_id, info) VALUES (?, ?) ON CONFLICT (message_id) DO UPDATE SET info = excluded.info`).run(
        id, c.encForAccount(m.account_id, JSON.stringify(info))
      )
    },

    setSmimeKind(id: number, kind: SmimeKind | null): void {
      prep(`UPDATE messages SET smime_kind = ? WHERE id = ?`).run(kind, id)
    }
  }
}
