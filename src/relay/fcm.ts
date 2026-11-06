// FCM HTTP v1 iletimi: servis hesabından RS256 JWT, oauth2.googleapis.com'dan erişim belirteci (50 dakika önbellek). Yalnız
// veri mesajı: notification alanı yok, içerik cihazda çözülür. Adresler sabittir; servis hesabı dosyasındaki token_uri kullanılmaz.
import { createPrivateKey, sign, type KeyObject } from 'crypto'
import { validDeviceToken, type RelayResult } from '../shared/relayProtocol'
import { logDeliveryFailure } from './providerLog'
import type { RelayDevice } from './store'

export const FCM_BASE = 'https://fcm.googleapis.com'
export const OAUTH_BASE = 'https://oauth2.googleapis.com'
const OAUTH_AUD = `${OAUTH_BASE}/token`
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const TOKEN_CACHE_MS = 50 * 60_000
const ASSERTION_TTL_S = 3600
const REQUEST_MS = 15_000

export interface FcmServiceAccount {
  projectId: string
  clientEmail: string
  key: KeyObject
}

export interface FcmOptions {
  account: FcmServiceAccount
  now?: () => number
  fetch?: typeof fetch
  /** yalnız testler: yerel sahte sunucu */
  bases?: { fcm: string; oauth: string }
}

/** Servis hesabı JSON'u; biçim hatasında hata kodu (içerik yazılmaz) */
export function parseServiceAccount(text: string): FcmServiceAccount {
  const j = JSON.parse(text) as { project_id?: unknown; client_email?: unknown; private_key?: unknown }
  if (typeof j.project_id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(j.project_id) || typeof j.client_email !== 'string' || typeof j.private_key !== 'string') {
    throw new Error('gecko.relay.fcm.account')
  }
  return { projectId: j.project_id, clientEmail: j.client_email, key: createPrivateKey(j.private_key) }
}

export const fcmBody = (token: string, c: string): string =>
  JSON.stringify({ message: { token, data: { c }, android: { priority: 'HIGH', ttl: '86400s' } } })

/** 400 INVALID_ARGUMENT yük için de gelir: yalnız hatalı alan belirteçse cihaz düşer */
function invalidToken(text: string): boolean {
  try {
    const { error } = JSON.parse(text) as { error?: { status?: string; details?: { fieldViolations?: { field?: string }[] }[] } }
    return error?.status === 'INVALID_ARGUMENT' && !!error.details?.some((d) => d.fieldViolations?.some((v) => v.field === 'message.token'))
  } catch {
    return false
  }
}

/** Hata gövdesinin kodu: ayrıntıdaki errorCode (UNREGISTERED gibi), yoksa genel durum */
function fcmReason(text: string): string {
  try {
    const { error } = JSON.parse(text) as { error?: { status?: unknown; details?: { errorCode?: unknown }[] } }
    const code = error?.details?.find((d) => typeof d.errorCode === 'string')?.errorCode
    return String(code ?? error?.status ?? '')
  } catch {
    return ''
  }
}

export function createFcm(o: FcmOptions): (d: RelayDevice, c: string) => Promise<RelayResult> {
  const now = o.now ?? Date.now
  const doFetch = o.fetch ?? fetch
  const bases = o.bases ?? { fcm: FCM_BASE, oauth: OAUTH_BASE }
  let cached: { value: string; at: number } | null = null

  const assertion = (): string => {
    const enc = (v: object): string => Buffer.from(JSON.stringify(v)).toString('base64url')
    const iat = Math.floor(now() / 1000)
    const data = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: o.account.clientEmail, scope: SCOPE, aud: OAUTH_AUD, iat, exp: iat + ASSERTION_TTL_S })}`
    return `${data}.${sign('sha256', Buffer.from(data), o.account.key).toString('base64url')}`
  }

  const accessToken = async (): Promise<string | null> => {
    if (cached && now() - cached.at < TOKEN_CACHE_MS) return cached.value
    const r = await doFetch(`${bases.oauth}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion() }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_MS)
    })
    if (!r.ok) {
      logDeliveryFailure('fcm-oauth', r.status, '')
      return null
    }
    const { access_token: value } = (await r.json()) as { access_token?: unknown }
    if (typeof value !== 'string') return null
    cached = { value, at: now() }
    return value
  }

  return async (d, c) => {
    if (!validDeviceToken('android', d.token)) return 'gone'
    try {
      const bearer = await accessToken()
      if (!bearer) return 'retry'
      const r = await doFetch(`${bases.fcm}/v1/projects/${o.account.projectId}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: fcmBody(d.token, c),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_MS)
      })
      if (r.ok) return 'ok'
      if (r.status === 401) cached = null
      const text = await r.text()
      logDeliveryFailure('fcm', r.status, fcmReason(text))
      if (r.status === 404 && text.includes('UNREGISTERED')) return 'gone'
      if (r.status === 400 && invalidToken(text)) return 'gone'
      return 'retry'
    } catch (e) {
      logDeliveryFailure('fcm', 0, (e as Error).name) // ileti adres içerebilir
      return 'retry'
    }
  }
}
