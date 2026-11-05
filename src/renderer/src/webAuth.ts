// Web istemcisinin oturumu (yalnız sunucu modu): giriş/çıkış HTTP uç noktalarıyla, belirteç yalnız HttpOnly
// çerezde — burada hiçbir sır saklanmaz. WebSocket bağlantısı aynı çerezle kimlik kazanır. Mobil uygulamada giriş ve çıkış
// yerel eklentidedir: uzun ömürlü belirteç JS'e girmez.
import type { SessionUser } from '../../shared/rpc'
import { apiFetch, resetApiClient } from './apiFetch'
import { nativeBridge } from './platform/nativeBridge'

export type WebLoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: 'bad' | 'locked' | 'totpRequired' | 'totpBad' | 'totpSetupRequired' | 'network' }

const REASONS = new Set(['bad', 'locked', 'totpRequired', 'totpBad', 'totpSetupRequired'])

const post = (path: string, body?: unknown): Promise<Response> =>
  apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {})
  })

/** Giriş biçimli yanıt (çerez + {user}); /api/login ve /api/2fa/setup/confirm ortak */
async function loginLike(path: string, body: unknown): Promise<WebLoginResult> {
  let res: Response
  let data: { user?: SessionUser; reason?: string } = {}
  try {
    res = await post(path, body)
    data = (await res.json().catch(() => ({}))) as typeof data
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (res.ok && data.user) return { ok: true, user: data.user }
  // 400/403/5xx vb. tanınmayan yanıt: kullanıcıya "hatalı bilgi" değil bağlantı sorunu gösterilir
  const reason = REASONS.has(data.reason ?? '') ? (data.reason as Exclude<WebLoginResult, { ok: true }>['reason']) : 'network'
  return { ok: false, reason }
}

export async function webLogin(i: { username: string; password: string; totp?: string }): Promise<WebLoginResult> {
  const native = nativeBridge()
  if (!native) return loginLike('/api/login', { username: i.username, password: i.password, ...(i.totp ? { totp: i.totp } : {}) })
  try {
    const r = await native.plugin.login({ username: i.username, password: i.password, ...(i.totp ? { totp: i.totp } : {}) })
    if (r.ok) resetApiClient()
    return r
  } catch {
    return { ok: false, reason: 'network' }
  }
}

export type WebSetupBeginResult =
  | { ok: true; otpauthUri: string; secretBase32: string }
  | { ok: false; reason: 'bad' | 'locked' | 'notRequired' | 'network' | 'browser' }

/** Zorunlu 2FA kurulumu (giriş totpSetupRequired döndüğünde): parola yeniden gönderilir, sır yalnız bu yanıtta.
 *  Mobilde kurulum tarayıcıdadır (S4): sunucuya gidilmez */
export async function webSetupBegin(i: { username: string; password: string }): Promise<WebSetupBeginResult> {
  if (nativeBridge()) return { ok: false, reason: 'browser' }
  let res: Response
  let data: { otpauthUri?: unknown; secretBase32?: unknown; reason?: string } = {}
  try {
    res = await post('/api/2fa/setup/begin', { username: i.username, password: i.password })
    data = (await res.json().catch(() => ({}))) as typeof data
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (res.ok && typeof data.otpauthUri === 'string' && typeof data.secretBase32 === 'string')
    return { ok: true, otpauthUri: data.otpauthUri, secretBase32: data.secretBase32 }
  const r = data.reason
  return { ok: false, reason: r === 'bad' || r === 'locked' || r === 'notRequired' ? r : 'network' }
}

/** Bekleyen sırrı kodla onaylar; başarıda giriş gibi oturum çerezi gelir */
export const webSetupConfirm = (i: { username: string; password: string; code: string }): Promise<WebLoginResult> =>
  loginLike('/api/2fa/setup/confirm', { username: i.username, password: i.password, code: i.code })

export type WebMeResult = { user: SessionUser } | { user: null; setupRequired: boolean }

/** Çerezdeki oturum geçerliyse kullanıcı; 401'de user null (setupRequired: sunucuda hiç kullanıcı yok).
 *  Ağ/sunucu hatasında fırlatır (geçici kopuş çıkış sayılmaz). */
export async function webMe(): Promise<WebMeResult> {
  const res = await apiFetch('/api/me')
  if (res.status === 401) {
    const body = (await res.json().catch(() => ({}))) as { setupRequired?: unknown }
    return { user: null, setupRequired: body.setupRequired === true }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { user?: SessionUser }
  if (!body.user) throw new Error('HTTP 200: user yok')
  return { user: body.user }
}

/** Sunucu oturumu kapattıysa (çerez silindi) true; ağ hatası/5xx false — çağıran kullanıcıyı içeride tutar */
export async function webLogout(): Promise<boolean> {
  const native = nativeBridge()
  if (native) {
    // ağ yoksa eklenti yerelde kapatır, sunucudaki kapanışı bağlantı gelince yapar
    try {
      await native.plugin.logout()
      resetApiClient()
      return true
    } catch {
      return false
    }
  }
  try {
    const res = await post('/api/logout')
    return res.ok
  } catch {
    return false
  }
}
