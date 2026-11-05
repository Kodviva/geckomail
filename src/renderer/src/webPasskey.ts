// Web passkey (WebAuthn) istemcisi: giriş ve Ayarlar'daki anahtar listesi. Anahtarın gizli kısmı doğrulayıcıda kalır;
// burada hiçbir sır tutulmaz. Giriş akışının kimliği sunucunun HttpOnly gm_pk çerezinde.
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import type { SessionUser } from '../../shared/rpc'
import { apiFetch } from './apiFetch'
import { nativeBridge } from './platform/nativeBridge'

export interface PasskeyInfo {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number | null
}

export type PasskeyLoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: 'cancelled' | 'failed' | 'locked' | 'network' }

export type PasskeyAddResult = 'ok' | 'cancelled' | 'duplicate' | 'failed' | 'bad' | 'locked' | 'totpRequired'

/** Electron penceresi: platform doğrulayıcısı var mı (mac'te imzalı yetki gelene dek yok). Tarayıcıda sorulmaz */
let desktopAuthenticator = false

/** Açılışta bir kez, ilk çizimden önce. Masaüstü dışında iş yapmaz */
export async function initPasskeySupport(): Promise<void> {
  if (!window.geckoDesktop) return
  desktopAuthenticator = await window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false) ?? false
}

/** Eski tarayıcı, güvenli olmayan köken ya da IP adresi (WebAuthn RP ID alan adı ister): passkey arayüzü gösterilmez.
 *  Electron'da doğrulayıcı yoksa düğme yanıltmasın */
export const passkeySupported = (): boolean =>
  !nativeBridge() && typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined' &&
  !/^(\d+\.\d+\.\d+\.\d+|\[.*\])$/.test(window.location?.hostname ?? '') &&
  (!window.geckoDesktop || desktopAuthenticator)

/** Kullanıcı istemi kapattı ya da zaman aşımı: hata gösterilmez */
const isCancel = (e: unknown): boolean => {
  const name = (e as Error | null)?.name
  return name === 'NotAllowedError' || name === 'AbortError'
}

const post = (path: string, body: unknown = {}): Promise<Response> =>
  apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

export async function webPasskeyLogin(): Promise<PasskeyLoginResult> {
  let optionsJSON: Parameters<typeof startAuthentication>[0]['optionsJSON']
  try {
    const res = await post('/api/passkey/login/options')
    if (res.status === 423) return { ok: false, reason: 'locked' }
    if (!res.ok) return { ok: false, reason: 'network' }
    optionsJSON = (await res.json()) as typeof optionsJSON
  } catch {
    return { ok: false, reason: 'network' }
  }
  let response: Awaited<ReturnType<typeof startAuthentication>>
  try {
    response = await startAuthentication({ optionsJSON })
  } catch (e) {
    return { ok: false, reason: isCancel(e) ? 'cancelled' : 'failed' }
  }
  try {
    const res = await post('/api/passkey/login/verify', { response })
    if (res.status === 423) return { ok: false, reason: 'locked' }
    const data = (await res.json().catch(() => ({}))) as { user?: SessionUser }
    if (res.ok && data.user) return { ok: true, user: data.user }
    return { ok: false, reason: res.status === 401 ? 'failed' : 'network' }
  } catch {
    return { ok: false, reason: 'network' }
  }
}

/** Eklemeden önce kimlik yeniden doğrulanır: parola (ve 2FA açıksa kod) yalnız bu istekte gider */
export async function webPasskeyAdd(name: string, proof: { password: string; totp?: string }): Promise<PasskeyAddResult> {
  try {
    const res = await post('/api/passkey/register/options', proof)
    if (res.status === 423) return 'locked'
    if (res.status === 428) return 'totpRequired'
    if (res.status === 401) {
      const { reason } = (await res.json().catch(() => ({}))) as { reason?: string }
      return reason === 'bad' ? 'bad' : 'failed'
    }
    if (!res.ok) return 'failed'
    const optionsJSON = (await res.json()) as Parameters<typeof startRegistration>[0]['optionsJSON']
    const response = await startRegistration({ optionsJSON })
    const done = await post('/api/passkey/register/verify', { response, name })
    if (done.ok) return 'ok'
    return done.status === 409 ? 'duplicate' : 'failed'
  } catch (e) {
    if (isCancel(e)) return 'cancelled'
    // excludeCredentials: bu doğrulayıcıda zaten anahtar var
    return (e as Error | null)?.name === 'InvalidStateError' ? 'duplicate' : 'failed'
  }
}

export async function webPasskeyList(): Promise<PasskeyInfo[]> {
  const res = await apiFetch('/api/passkeys')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return ((await res.json()) as { passkeys: PasskeyInfo[] }).passkeys
}

export async function webPasskeyRemove(id: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return res.ok
  } catch {
    return false
  }
}
