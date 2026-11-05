// Web giriş akışı (saf durum makinesi): kullanıcı adı + parola → gerekirse TOTP kodu ya da zorunlu 2FA
// kurulumu (QR) → giriş. Kimlik bilgileri burada saklanmaz; her adımda çağıran (WebLogin bileşeni) verir.
import type { SessionUser } from '../../shared/rpc'
import type { WebLoginResult, WebSetupBeginResult } from './webAuth'

export type FlowError = 'bad' | 'locked' | 'network' | 'totpBad' | 'passkey' | 'browser'

export type FlowView =
  | { kind: 'credentials'; error?: FlowError }
  | { kind: 'totp'; error?: FlowError }
  | { kind: 'setup'; otpauthUri: string; secretBase32: string; error?: FlowError }
  | { kind: 'done'; user: SessionUser }

export interface FlowApi {
  login(i: { username: string; password: string; totp?: string }): Promise<WebLoginResult>
  setupBegin(i: { username: string; password: string }): Promise<WebSetupBeginResult>
  setupConfirm(i: { username: string; password: string; code: string }): Promise<WebLoginResult>
}

export interface FlowInput {
  username: string
  password: string
  code: string
}

/** Kod alanı boşluklu yazılabilir ("123 456"); sunucuya yalnız 6 rakam gider */
export const normalizeCode = (code: string): string => code.replace(/\s+/g, '')
const isCode = (code: string): boolean => /^[0-9]{6}$/.test(code)

/** Kimlik bilgisi sorunu (parola değişti, kilit): akış baştan başlar */
const restart = (error: FlowError): FlowView => ({ kind: 'credentials', error })

async function beginSetup(i: FlowInput, api: FlowApi, retried = false): Promise<FlowView> {
  const cred = { username: i.username, password: i.password }
  const s = await api.setupBegin(cred)
  if (s.ok) return { kind: 'setup', otpauthUri: s.otpauthUri, secretBase32: s.secretBase32 }
  if (s.reason !== 'notRequired') return restart(s.reason)
  // bu arada 2FA etkinleşti ya da zorunluluk kalktı: normal giriş bir kez daha denenir
  if (retried) return restart('network')
  return fromLogin(await api.login(cred), i, api, true)
}

function fromLogin(r: WebLoginResult, i: FlowInput, api: FlowApi, retried = false): FlowView | Promise<FlowView> {
  if (r.ok) return { kind: 'done', user: r.user }
  switch (r.reason) {
    case 'totpRequired':
      return { kind: 'totp' }
    case 'totpSetupRequired':
      return retried ? restart('network') : beginSetup(i, api, true)
    case 'totpBad':
      return restart('bad') // kodsuz istekte beklenmez
    default:
      return restart(r.reason)
  }
}

/** Görünen ekranda "gönder": yeni ekranı döndürür. Hata, kullanıcının düzeltebileceği ekranda gösterilir. */
export async function flowSubmit(view: FlowView, i: FlowInput, api: FlowApi): Promise<FlowView> {
  const cred = { username: i.username, password: i.password }
  if (view.kind === 'credentials') {
    const r = await api.login(cred)
    if (!r.ok && r.reason === 'totpSetupRequired') return beginSetup(i, api)
    return fromLogin(r, i, api)
  }
  if (view.kind === 'totp') {
    const code = normalizeCode(i.code)
    if (!isCode(code)) return { kind: 'totp', error: 'totpBad' }
    const r = await api.login({ ...cred, totp: code })
    if (r.ok) return { kind: 'done', user: r.user }
    if (r.reason === 'totpBad' || r.reason === 'network') return { kind: 'totp', error: r.reason }
    // yönetici 2FA'yı sıfırladı ve zorunlu: kurulum
    if (r.reason === 'totpSetupRequired') return beginSetup(i, api)
    if (r.reason === 'totpRequired') return { kind: 'totp', error: 'totpBad' }
    return restart(r.reason)
  }
  if (view.kind === 'setup') {
    const code = normalizeCode(i.code)
    if (!isCode(code)) return { ...view, error: 'totpBad' }
    const r = await api.setupConfirm({ ...cred, code })
    if (r.ok) return { kind: 'done', user: r.user }
    if (r.reason === 'totpBad' || r.reason === 'network') return { ...view, error: r.reason }
    // başka yoldan etkinleşti: kodla normal giriş
    if (r.reason === 'totpRequired') return { kind: 'totp' }
    return restart(r.reason === 'totpSetupRequired' ? 'network' : r.reason)
  }
  return view
}
