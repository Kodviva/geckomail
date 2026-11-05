// RPC — İki aşamalı doğrulama (TOTP): her girişli kullanıcı kendi hesabı için; yönetici sıfırlaması ayrı.
// Sır yalnız twoFactorBegin yanıtında döner; DB'de deps.encrypt ile şifreli (base32 metni) durur.
import { base32Decode, base32Encode, newTotpSecret, otpauthUri, verifyTotp } from '../auth/totp'
import type { RpcSession } from '../rpcSession'
import { type Handler } from './common'
import { t } from '../../shared/i18n'

const CODE_MAX_FAILS = 5
const CODE_WINDOW_MS = 15 * 60_000

/** Kod doğruysa adım sayacı (adım atomik olarak sahiplenilmiş); yanlış, eskimiş ya da daha önce
 *  kullanılmışsa null. 15 dk'da 5 yanlış koddan sonra kod denetlenmeden reddedilir. Deneme await'ten
 *  ÖNCE canlı diziye geçici hata olarak yazılır: eşzamanlı istekler sınırı aşamaz, güncelleme kaybolmaz. */
async function checkCode(s: RpcSession, code: unknown): Promise<number | null> {
  const userId = s.currentUser!.id
  const now = s.hub.now()
  let live = s.hub.totpFailures.get(userId)
  if (!live) s.hub.totpFailures.set(userId, (live = []))
  while (live.length && live[0] <= now - CODE_WINDOW_MS) live.shift()
  if (live.length >= CODE_MAX_FAILS) {
    throw new Error(t('sync.auth.lockedOut', { count: Math.ceil((live[0] + CODE_WINDOW_MS - now) / 1000) }))
  }
  live.push(now)
  const step = await matchCode(s, code, now)
  // aynı kod eşzamanlı iki istekte: yalnız biri adımı sahiplenir
  if (step == null || !s.deps.q.claimTotpStep(userId, step)) return null
  // başarı: yalnız bu denemenin geçici kaydı silinir (eşzamanlı diğer denemelerinki kalır)
  const cur = s.hub.totpFailures.get(userId)
  const i = cur?.indexOf(now) ?? -1
  if (cur && i >= 0) cur.splice(i, 1)
  return step
}

async function matchCode(s: RpcSession, code: unknown, now: number): Promise<number | null> {
  const row = s.deps.q.getUserById(s.currentUser!.id)
  if (!row?.totp_secret_enc) return null
  const [plain] = await s.deps.decrypt([new Uint8Array(row.totp_secret_enc)])
  if (!plain) return null
  let secret: Buffer
  try {
    secret = base32Decode(plain)
  } catch {
    return null
  }
  return verifyTotp(secret, String(code ?? ''), Math.floor(now / 1000))
}

export const twoFactorHandlers: Record<string, Handler> = {
  async twoFactorStatus(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    const row = q.getUserById(s.currentUser!.id)
    return { enabled: !!row?.totp_enabled, required: q.prefGet('require2fa') === '1' }
  },

  async twoFactorBegin(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    const row = q.getUserById(s.currentUser!.id)
    if (!row) throw new Error(t('sync.auth.userNotFound'))
    // etkin sır kodsuz ezilmesin (oturumu ele geçiren 2FA'yı sessizce değiştiremez)
    if (row.totp_enabled) throw new Error(t('sync.2fa.alreadyEnabled'))
    const secret = newTotpSecret()
    const secretBase32 = base32Encode(secret)
    const [enc] = await s.deps.encrypt([secretBase32])
    q.setTotpPending(row.id, Buffer.from(enc))
    return { otpauthUri: otpauthUri(secret, row.username), secretBase32 }
  },

  async twoFactorConfirm(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { code } = (params ?? {}) as { code?: string }
    const row = q.getUserById(s.currentUser!.id)
    if (!row) throw new Error(t('sync.auth.userNotFound'))
    if (row.totp_enabled) throw new Error(t('sync.2fa.alreadyEnabled'))
    if (!row.totp_secret_enc) throw new Error(t('sync.2fa.notStarted'))
    const step = await checkCode(s, code)
    if (step == null) throw new Error(t('sync.2fa.badCode'))
    q.enableTotp(row.id, step)
    return null
  },

  async twoFactorDisable(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { code } = (params ?? {}) as { code?: string }
    if (q.prefGet('require2fa') === '1') throw new Error(t('sync.2fa.requiredByAdmin'))
    const row = q.getUserById(s.currentUser!.id)
    if (!row?.totp_enabled) throw new Error(t('sync.2fa.notEnabled'))
    if ((await checkCode(s, code)) == null) throw new Error(t('sync.2fa.badCode'))
    q.clearTotp(row.id)
    s.hub.revokeUser(row.id)
    return null
  },

  // yönetici: telefonunu kaybeden kullanıcının 2FA'sını kaldırır (zorunluysa sonraki girişte yeniden kurar)
  async resetUserTwoFactor(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { userId } = params as { userId: number }
    if (!q.getUserById(userId)) throw new Error(t('sync.auth.userNotFound'))
    q.clearTotp(userId)
    const passkeysRemoved = q.deletePasskeysForUser(userId)
    s.hub.revokeUser(userId)
    return { passkeysRemoved }
  }
}
