// RPC — S/MIME kimlikleri, alıcı sertifikaları ve güven kökleri. Kimlik yalnız sahibinindir (K10): her sorgu oturumun
// kullanıcısıyla süzülür, yönetici de başkasının anahtarını kullanamaz. Hata metinleri t() üretir; pkijs metni ve parola dışarı çıkmaz.
import { X509Certificate } from 'node:crypto'
import { SMIME_P12_MAX_BYTES, type SmimeContactCertInfo, type SmimeIdentityInfo, type SmimeSigState } from '../../shared/smime'
import { t } from '../../shared/i18n'
import type { SmimeIdentityRow } from '../db/q/types'
import type { RpcSession } from '../rpcSession'
import { parseCert, sameAddress, type ParsedCert } from '../smime/certInfo'
import { SmimeFormatError, SmimeP12PasswordError } from '../smime/errors'
import { decodeChain, encodeChain, ownEncryptCert, resolveRecipients } from '../smime/identity'
import { buildP12, MAX_P12_PASSWORD, parseP12, type P12Contents } from '../smime/p12'
import { evaluateChain, type ChainVerdict } from '../smime/trust'
import { decrypt, encrypt } from '../vault/crypto'
import { getVaultStatus, verifyVaultPassphraseAsync } from '../vault/manager'
import { getVaultKey } from '../vault/state'
import { checkVaultPassphrase } from '../vault/throttle'
import type { Handler } from './common'

const MIN_RSA_BITS = 2048
const MIN_EXPORT_PASSWORD = 12
const MAX_LABEL = 120
const MAX_ADDRESSES = 500
const MAX_BASE64 = Math.ceil(SMIME_P12_MAX_BYTES / 3) * 4 + 8

const CHAIN_STATE: Record<ChainVerdict['state'], SmimeSigState> = {
  ok: 'verified', untrusted: 'untrusted', expired: 'expired', weak: 'weak_algorithm', revoked: 'revoked'
}

function requireVaultKey(s: RpcSession): Buffer {
  const status = getVaultStatus(s.deps.q)
  if (status === 'none') throw new Error(t('sync.smime.vaultNone'))
  const key = getVaultKey()
  if (!key) throw new Error(t('sync.smime.vaultLocked'))
  return key
}

async function chainState(s: RpcSession, c: ParsedCert, chain: Uint8Array[]): Promise<SmimeSigState> {
  const { smimeTrust, smimeCrl } = s.deps
  if (!smimeTrust || !smimeCrl) return 'untrusted'
  const v = await evaluateChain({ leaf: c.der, extra: chain, at: s.hub.now(), purpose: c.canSign ? 'sign' : 'encrypt' }, smimeTrust, smimeCrl, s.hub.now)
  return CHAIN_STATE[v.state]
}

async function identityInfo(s: RpcSession, row: SmimeIdentityRow): Promise<SmimeIdentityInfo> {
  const c = parseCert(new Uint8Array(row.cert_der))
  return {
    id: row.id, email: row.email, subject: c.subject, issuer: c.issuer, fingerprint: row.fingerprint, notBefore: row.not_before, notAfter: row.not_after,
    canSign: !!row.can_sign, canEncrypt: !!row.can_encrypt, chainState: await chainState(s, c, decodeChain(row.chain_der))
  }
}

async function readP12(p12Base64: unknown, password: unknown): Promise<P12Contents> {
  if (typeof p12Base64 !== 'string' || typeof password !== 'string') throw new Error(t('sync.smime.p12Invalid'))
  if (p12Base64.length > MAX_BASE64) throw new Error(t('sync.smime.p12TooLarge'))
  try {
    return await parseP12(Buffer.from(p12Base64, 'base64'), password)
  } catch (e) {
    throw new Error(t(e instanceof SmimeP12PasswordError ? 'sync.smime.p12WrongPassword' : 'sync.smime.p12Invalid'))
  }
}

function assertImportable(c: ParsedCert, accountEmail: string): void {
  if (!c.emails.some((e) => sameAddress(e, accountEmail))) throw new Error(t('sync.smime.addressMismatch'))
  if (c.rsaBits !== null ? c.rsaBits < MIN_RSA_BITS : c.curve === null) throw new Error(t('sync.smime.weakKey'))
  if (!c.emailEku || (!c.canSign && !c.canEncrypt)) throw new Error(t('sync.smime.badEku'))
}

function anchorCert(input: unknown): ParsedCert {
  if (typeof input !== 'string') throw new Error(t('sync.smime.anchorInvalid'))
  try {
    const der = input.includes('-----BEGIN') ? new X509Certificate(input).raw : Buffer.from(input, 'base64')
    const c = parseCert(der)
    if (!c.ca) throw new SmimeFormatError()
    return c
  } catch {
    throw new Error(t('sync.smime.anchorInvalid'))
  }
}

export const smimeHandlers: Record<string, Handler> = {
  async smimeListIdentities(s: RpcSession, _params: unknown) {
    return Promise.all(s.deps.q.listIdentities(s.currentUser!.id).map((r) => identityInfo(s, r)))
  },

  async smimeImportIdentity(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { accountId, p12Base64, password } = params as { accountId: number; p12Base64: string; password: string }
    s.assertCanManage(accountId)
    const vaultKey = requireVaultKey(s)
    const account = q.getAccountRow(accountId)
    if (!account) throw new Error(t('sync.err.accountNotFound'))
    const p12 = await readP12(p12Base64, password)
    try {
      const c = parseCert(p12.leaf)
      assertImportable(c, account.email)
      const userId = s.currentUser!.id
      const existing = q.listIdentities(userId).find((r) => r.fingerprint === c.fingerprint) // yinelenen içe aktarma etkisizdir
      if (existing) return identityInfo(s, existing)
      // zincir güvenilmez olsa da reddedilmez: kendinden imzalı kimlik imzalayabilir, alıcı "doğrulandı" görmez
      const id = q.insertIdentity({
        userId, email: account.email, fingerprint: c.fingerprint, certDer: Buffer.from(c.der), chainDer: encodeChain(p12.chain),
        keyEnc: encrypt(vaultKey, p12.keyPkcs8).toString('base64'), notBefore: c.notBefore, notAfter: c.notAfter, canSign: c.canSign, canEncrypt: c.canEncrypt
      })
      s.hub.smimeCache.clearUser(userId) // önceki "anahtarınız yok" sonucu kalmasın
      return identityInfo(s, q.getIdentity(userId, id)!)
    } finally {
      p12.keyPkcs8.fill(0)
    }
  },

  async smimeExportIdentity(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { id, vaultPassphrase, exportPassword } = params as { id: number; vaultPassphrase: string; exportPassword: string }
    const vaultKey = requireVaultKey(s)
    const row = q.getIdentity(s.currentUser!.id, Number(id))
    if (!row) throw new Error(t('sync.smime.notFound'))
    if (typeof exportPassword === 'string' && exportPassword.length > MAX_P12_PASSWORD) throw new Error(t('sync.smime.p12Invalid'))
    if (typeof exportPassword !== 'string' || exportPassword.length < MIN_EXPORT_PASSWORD) throw new Error(t('sync.smime.exportPasswordShort', { min: String(MIN_EXPORT_PASSWORD) }))
    const passOk = await checkVaultPassphrase(q, s.currentUser!, s.hub.now(), () => typeof vaultPassphrase === 'string' && verifyVaultPassphraseAsync(q, vaultPassphrase))
    if (!passOk) throw new Error(t('sync.vault.wrongPassphrase'))
    const keyPkcs8 = decrypt(vaultKey, Buffer.from(row.key_enc, 'base64'))
    try {
      const p12 = await buildP12({ keyPkcs8, leaf: new Uint8Array(row.cert_der), chain: decodeChain(row.chain_der) }, exportPassword)
      return { filename: `${row.email.replace(/[^\w.@+-]/g, '_')}.p12`, base64: p12.toString('base64') }
    } finally {
      keyPkcs8.fill(0)
    }
  },

  async smimeRemoveIdentity(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { id, confirmEmail } = params as { id: number; confirmEmail: string }
    const userId = s.currentUser!.id
    const row = q.getIdentity(userId, Number(id))
    if (!row) throw new Error(t('sync.smime.notFound'))
    if (typeof confirmEmail !== 'string' || !sameAddress(confirmEmail, row.email)) throw new Error(t('sync.smime.confirmMismatch'))
    q.deleteIdentity(userId, row.id)
    s.hub.smimeCache.clearUser(userId)
    return { ok: true }
  },

  async smimeListContactCerts(s: RpcSession, _params: unknown) {
    return s.deps.q.listContactCerts(s.currentUser!.id).flatMap((r): SmimeContactCertInfo[] => {
      try {
        return [{ id: r.id, email: r.email, subject: parseCert(new Uint8Array(r.cert_der)).subject, fingerprint: r.fingerprint, notAfter: r.not_after, source: r.source }]
      } catch {
        return []
      }
    })
  },

  async smimeRemoveContactCert(s: RpcSession, params: unknown) {
    s.deps.q.deleteContactCert(s.currentUser!.id, Number((params as { id: number }).id))
    return { ok: true }
  },

  async smimeCheckRecipients(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { accountId, addresses } = params as { accountId: number; addresses: string[] }
    s.assertCanView(accountId)
    const account = q.getAccountRow(accountId)
    if (!account) throw new Error(t('sync.err.accountNotFound'))
    const userId = s.currentUser!.id
    const now = s.hub.now()
    const list = (Array.isArray(addresses) ? addresses : []).filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter(Boolean).slice(0, MAX_ADDRESSES)
    const resolved = resolveRecipients(q, { userId, addresses: list, now })
    const recipients = list.map((address) => ({ address, status: resolved.get(address)!.status }))
    const own = q.identitiesForEmail(userId, account.email).filter((r) => now >= r.not_before && now <= r.not_after)
    const canSign = own.some((r) => r.can_sign)
    const ownEncrypt = ownEncryptCert(q, userId, account.email, now) !== null
    const vault = getVaultStatus(q)
    const blocked = vault === 'none' ? 'vault_none' : vault === 'locked' ? 'vault_locked' : !own.length || !canSign ? 'no_identity' : !ownEncrypt ? 'own_cert_missing' : null
    const ready = vault === 'unlocked'
    return { canSign: ready && canSign, canEncrypt: ready && canSign && ownEncrypt && recipients.every((r) => r.status === 'ok'), blocked, recipients }
  },

  async smimeTrustInfo(s: RpcSession, _params: unknown) {
    const { q, smimeTrust } = s.deps
    if (!smimeTrust) throw new Error(t('sync.smime.unavailable'))
    const anchors = q.listAnchors().flatMap((a) => {
      try {
        const c = parseCert(new Uint8Array(a.cert_der))
        return [{ fingerprint: a.fingerprint, label: a.label, subject: c.subject, notAfter: c.notAfter }]
      } catch {
        return []
      }
    })
    return { ...smimeTrust.bundle(), anchors }
  },

  async smimeAddAnchor(s: RpcSession, params: unknown) {
    const { pemOrDerBase64, label } = params as { pemOrDerBase64: string; label: string }
    const name = String(label ?? '').trim().slice(0, MAX_LABEL)
    if (!name) throw new Error(t('sync.smime.anchorInvalid'))
    const c = anchorCert(pemOrDerBase64)
    s.deps.q.addAnchor({ fingerprint: c.fingerprint, certDer: Buffer.from(c.der), label: name, addedBy: s.currentUser!.id })
    return { ok: true }
  },

  async smimeRemoveAnchor(s: RpcSession, params: unknown) {
    s.deps.q.removeAnchor(String((params as { fingerprint: string }).fingerprint))
    return { ok: true }
  }
}
