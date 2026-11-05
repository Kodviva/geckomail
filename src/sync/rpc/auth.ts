// RPC — Giriş, kullanıcılar ve gruplar. Yetki kapısı (giriş / yönetici) RpcSession.handle'da; hesap düzeyi kontroller burada.
import type { GroupInfo, SessionUser, UserInfo, UserRole } from '../../shared/rpc'
import { hashPassword, verifyPassword } from '../auth/password'
import { clearLoginBiometric, getLoginBiometricBlob, loginBiometricUser, setLoginBiometric } from '../auth/loginBiometric'
import type { RpcSession } from '../rpcSession'
import { tProcess } from '../sessionLocale'
import { type Handler } from './common'
import { t } from '../../shared/i18n'

const RESET_NOTICE = 'passwordResetByAdminAt'
const SET_BY_ADMIN = 'password_set_by_admin'

/** Belirteç özeti arayüze çıkmaz: liste XSS'e açık olsa da oturum tutamağı yalnız bu kullanıcının kendi satırlarında geçerlidir */
const sessionHandle = (idHash: string): string => idHash.slice(0, 16)

/** Kısa ad: tarayıcı · işletim sistemi. Sıra önemli: Chrome adı Safari'yi, Edge adı Chrome'u da içerir */
function sessionLabel(userAgent: string | null): string {
  const ua = userAgent ?? ''
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ''
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  return [browser, os].filter(Boolean).join(' · ') || '—'
}

function cookieSessionUser(s: RpcSession): number {
  if (!s.webSessionId || s.ticket) throw new Error(t('sync.perm.browserRequired'))
  return s.currentUser!.id
}

export const authHandlers: Record<string, Handler> = {
  async login(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { username, password } = params as { username: string; password: string }
    const now = Date.now()
    if (now < s.loginLockedUntil) {
      throw new Error(t('sync.auth.lockedOut', { count: Math.ceil((s.loginLockedUntil - now) / 1000) }))
    }
    const row = q.getUserByUsername(username.trim())
    if (!row || !row.enabled || !verifyPassword(password, row.password_hash)) {
      // 5 ardışık hatadan sonra 30 sn, her yeni hatada iki katı (en fazla 15 dk)
      s.loginFailures++
      if (s.loginFailures >= 5) {
        s.loginLockedUntil = now + Math.min(30_000 * 2 ** (s.loginFailures - 5), 15 * 60_000)
      }
      throw new Error(t('sync.auth.badCredentials'))
    }
    s.loginFailures = 0
    s.loginLockedUntil = 0
    const user = s.buildSessionUser(row)
    s.currentUser = user
    q.touchLastLogin(row.id)
    return { user }
  },

  async logout(s: RpcSession, _params: unknown) {
    if (s.currentUser) s.hub.smimeCache.clearUser(s.currentUser.id)
    s.currentUser = null
    // aynı bağlantıda giren başka kullanıcı önceki oturumun işlemini geri alamaz
    s.undoState.clear()
    s.moveUndo.clear()
    return null
  },

  async getLoginBiometric(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    // public: Login ekranı Touch ID butonunu göstermeli mi + hangi kullanıcı için
    return { username: loginBiometricUser(q) }
  },

  async loginBiometric(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    // public: Touch ID renderer'da yapıldı, buraya başarıdan sonra gelinir.
    // GÜVENLİK: Touch ID kanıtı renderer tarafında; bu handler yalnız kaydı çözüp oturum açar.
    // Güvenlik, paketli sürümde devTools'un kapalı olmasına + renderer güvenine dayanır (kasa-biyometriyle aynı model).
    const username = loginBiometricUser(q)
    const blobB64 = getLoginBiometricBlob(q)
    if (!username || !blobB64) throw new Error(t('sync.auth.touchIdNotSetUp'))
    const [password] = await s.deps.decrypt([new Uint8Array(Buffer.from(blobB64, 'base64'))])
    // boş çözme = geçici safeStorage hatası (Keychain kilitli/taşınmış) → kaydı SİLME, tekrar denenebilsin
    if (!password) throw new Error(t('sync.auth.touchIdDecryptFailed'))
    const row = q.getUserByUsername(username)
    if (!row) {
      clearLoginBiometric(q) // kullanıcı silinmiş → orphan kaydı temizle
      throw new Error(t('sync.auth.userNotFound'))
    }
    if (!row.enabled) throw new Error(t('sync.auth.userDisabled')) // temizleme; yeniden etkinleşince çalışsın
    if (!verifyPassword(password, row.password_hash)) {
      clearLoginBiometric(q) // şifre değişmiş → kaydı temizle, şifreyle yeniden etkinleştir
      throw new Error(t('sync.auth.touchIdInvalid'))
    }
    const user = s.buildSessionUser(row)
    s.currentUser = user
    q.touchLastLogin(row.id)
    return { user }
  },

  async enableLoginBiometric(s: RpcSession, params: unknown) {
    const { q } = s.deps
    // giriş yapılıyken: şifreyi doğrula, safeStorage ile şifrele, sakla
    const { password } = params as { password: string }
    const row = q.getUserByUsername(s.currentUser!.username)
    if (!row || !verifyPassword(password, row.password_hash)) throw new Error(t('sync.auth.wrongPassword'))
    const [blob] = await s.deps.encrypt([password])
    setLoginBiometric(q, row.username, Buffer.from(blob).toString('base64'))
    return { ok: true }
  },

  async disableLoginBiometric(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    clearLoginBiometric(q)
    return null
  },

  async bootstrapAdmin(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { username, password } = params as { username: string; password: string }
    if (!username.trim() || password.length < 8) throw new Error(t('sync.auth.credentialsRequired'))
    const created = q.tx(() => {
      if (q.userCount() > 0) throw new Error(t('sync.auth.alreadySetUp'))
      const id = q.insertUser({ username: username.trim(), passwordHash: hashPassword(password), role: 'admin' })
      return { id, username: username.trim() }
    })
    const user: SessionUser = {
      id: created.id, username: created.username, role: 'admin', permittedGroupIds: [], manageableGroupIds: []
    }
    s.currentUser = user
    q.touchLastLogin(created.id)
    return { user }
  },

  async getUsers(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    return q.getUsers().map(
      (r) =>
        ({
          id: r.id, username: r.username, role: r.role, enabled: !!r.enabled,
          createdAt: r.created_at, lastLoginAt: r.last_login_at, permissions: q.getUserPermissions(r.id),
          twoFactorEnabled: !!r.totp_enabled
        }) satisfies UserInfo
    )
  },

  async createUser(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { username, password, role } = params as { username: string; password: string; role: UserRole }
    if (!username.trim() || password.length < 8) throw new Error(t('sync.auth.credentialsRequired'))
    if (q.getUserByUsername(username.trim())) throw new Error(t('sync.auth.usernameTaken'))
    const id = q.insertUser({ username: username.trim(), passwordHash: hashPassword(password), role })
    const row = q.getUserById(id)!
    return {
      id: row.id, username: row.username, role: row.role, enabled: !!row.enabled,
      createdAt: row.created_at, lastLoginAt: row.last_login_at, permissions: [], twoFactorEnabled: false
    } satisfies UserInfo
  },

  async updateUser(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { userId, patch } = params as { userId: number; patch: { role?: UserRole; enabled?: boolean } }
    const target = q.getUserById(userId)
    if (!target) throw new Error(t('sync.auth.userNotFound'))
    const wouldDemote = target.role === 'admin' && patch.role === 'member'
    const wouldDisable = target.role === 'admin' && patch.enabled === false
    if ((wouldDemote || wouldDisable) && q.countEnabledAdmins(userId) === 0)
      throw new Error(t('sync.auth.lastAdminDemote'))
    const fields: Record<string, unknown> = {}
    if (patch.role) fields.role = patch.role
    if ('enabled' in patch) fields.enabled = patch.enabled ? 1 : 0
    q.updateUserFields(userId, fields)
    // devre dışı bırakma ya da rol değişimi: açık web oturumları eski yetkiyle yaşamasın
    if (patch.enabled === false || (patch.role && patch.role !== target.role)) s.hub.revokeUser(userId)
    // kendi rolünü/durumunu değiştirdi — bellekteki oturumu canlı yamalamak yerine yeniden girişe zorla
    if (s.currentUser!.id === userId) s.currentUser = null
    return null
  },

  async deleteUser(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { userId } = params as { userId: number }
    const target = q.getUserById(userId)
    if (target?.role === 'admin' && q.countEnabledAdmins(userId) === 0) throw new Error(t('sync.auth.lastAdminDelete'))
    // silmeden önce: web_sessions satırları CASCADE ile gitmeden iptal edilen oturum kimlikleri alınabilsin
    if (target) s.hub.revokeUser(userId)
    q.deleteUser(userId)
    if (s.currentUser!.id === userId) s.currentUser = null
    return null
  },

  async listSessions(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    const userId = cookieSessionUser(s)
    const pushLabel = new Map(q.listPushDevices(userId).map((d) => [d.web_session_id, d.label]))
    return q.listWebSessionsForUser(userId, s.hub.now()).map((r) => ({
      id: sessionHandle(r.id_hash), kind: r.kind, label: pushLabel.get(r.id_hash) || sessionLabel(r.user_agent), lastSeenAt: r.last_seen_at, current: r.id_hash === s.webSessionId
    }))
  },

  async revokeSession(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const userId = cookieSessionUser(s)
    const { id } = params as { id: string }
    const row = q.listWebSessionsForUser(userId, s.hub.now()).find((r) => sessionHandle(r.id_hash) === id && r.id_hash !== s.webSessionId)
    if (!row) return { ok: false }
    s.hub.endWebSessions?.([row.id_hash])
    return { ok: true }
  },

  async revokeOtherSessions(s: RpcSession, _params: unknown) {
    const ids = s.deps.q.listWebSessionsForUser(cookieSessionUser(s), s.hub.now()).map((r) => r.id_hash).filter((id) => id !== s.webSessionId)
    s.hub.endWebSessions?.(ids)
    return { count: ids.length }
  },

  async getSecurityNotice(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    const v = q.userPrefGet(s.currentUser!.id, RESET_NOTICE)
    return { passwordResetAt: v ? Number(v) : null, mustChangePassword: q.userPrefGet(s.currentUser!.id, SET_BY_ADMIN) === '1' }
  },

  // sıfırlanan parolayla giren yönetici uyarıyı kapatamaz: önce parola değişmeli (K1: caydırır, parolayı da değiştireni durduramaz)
  async ackSecurityNotice(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    if (q.userPrefGet(s.currentUser!.id, SET_BY_ADMIN) === '1') throw new Error(t('sync.auth.ackNeedsPasswordChange'))
    q.userPrefSet(s.currentUser!.id, RESET_NOTICE, '')
    return { ok: true }
  },

  async changeOwnPassword(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { currentPassword, newPassword } = params as { currentPassword: string; newPassword: string }
    const userId = s.currentUser!.id
    const now = Date.now()
    if (now < s.loginLockedUntil) throw new Error(t('sync.auth.lockedOut', { count: Math.ceil((s.loginLockedUntil - now) / 1000) }))
    const row = q.getUserById(userId)
    if (!row || typeof currentPassword !== 'string' || !verifyPassword(currentPassword, row.password_hash)) {
      s.loginFailures++
      if (s.loginFailures >= 5) s.loginLockedUntil = now + Math.min(30_000 * 2 ** (s.loginFailures - 5), 15 * 60_000)
      throw new Error(t('sync.auth.wrongPassword'))
    }
    s.loginFailures = 0
    if (typeof newPassword !== 'string' || newPassword.length < 8) throw new Error(t('sync.auth.passwordTooShort'))
    q.updateUserFields(userId, { password_hash: hashPassword(newPassword) })
    q.userPrefSet(userId, SET_BY_ADMIN, '')
    // eski parolayla açık kalan başka oturumlar (ve onlara bağlı push cihazları) düşer; parolayı değiştiren oturum kalır
    s.hub.revokeUser(userId, s.webSessionId ?? undefined)
    return { ok: true }
  },

  async resetUserPassword(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { userId, newPassword } = params as { userId: number; newPassword: string }
    if (newPassword.length < 8) throw new Error(t('sync.auth.passwordTooShort'))
    if (!q.getUserById(userId)) throw new Error(t('sync.auth.userNotFound'))
    q.updateUserFields(userId, { password_hash: hashPassword(newPassword) })
    // kasa paylaşımlı: yönetici yeni parolayla girip üyenin anahtarını kullanabilir, bu engellenemez (K1). Üye bilir: oturumlar
    // düşmeden önce bildirim, sonraki girişte onaylanana dek uyarı
    if (userId !== s.currentUser!.id) {
      q.userPrefSet(userId, RESET_NOTICE, String(s.hub.now()))
      q.userPrefSet(userId, SET_BY_ADMIN, '1')
      s.hub.securityAlert?.(userId, tProcess('sync.auth.adminResetTitle'), tProcess('sync.auth.adminResetBody'))
    }
    // ele geçirilmiş hesabın temizliği: passkey'ler kalırsa saldırgan yeni parolaya gerek duymadan girer
    const passkeysRemoved = q.deletePasskeysForUser(userId)
    s.hub.revokeUser(userId)
    return { passkeysRemoved }
  },

  async getGroups(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    return q.getGroups().map((g) => ({ id: g.id, name: g.name, color: g.color, accountCount: g.account_count }) satisfies GroupInfo)
  },

  async createGroup(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { name, color } = params as { name: string; color: string }
    if (!name.trim()) throw new Error(t('sync.auth.groupNameEmpty'))
    const id = q.insertGroup(name.trim(), color)
    return { id, name: name.trim(), color, accountCount: 0 } satisfies GroupInfo
  },

  async updateGroup(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { groupId, patch } = params as { groupId: number; patch: { name?: string; color?: string } }
    const fields: Record<string, unknown> = {}
    if (patch.name) fields.name = patch.name
    if (patch.color) fields.color = patch.color
    q.updateGroupFields(groupId, fields)
    return null
  },

  async deleteGroup(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { groupId } = params as { groupId: number }
    q.deleteGroup(groupId)
    s.deps.sieve?.scheduleAll()
    s.hub.refreshUserSessions()
    s.broadcast('counts:changed', {})
    return null
  },

  async setAccountGroup(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { accountId, groupId } = params as { accountId: number; groupId: number | null }
    q.setAccountGroup(accountId, groupId)
    s.deps.sieve?.scheduleAll()
    s.broadcast('counts:changed', {})
    return null
  },

  async setGroupPermission(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { userId, groupId, canView, canManage } = params as {
      userId: number; groupId: number; canView: boolean; canManage: boolean
    }
    q.setGroupPermission(userId, groupId, canView, canManage)
    s.hub.refreshUserSessions(userId)
    s.hub.sendToUser(userId, 'counts:changed', {}) // açık sekme ve çevrimdışı kopya hemen küçülür
    return null
  }
}
