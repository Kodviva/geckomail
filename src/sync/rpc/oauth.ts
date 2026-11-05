// RPC — OAuth2 hesap bağlama (Gmail / Microsoft 365). Masaüstünde akış sync sürecinde: yerel yönlendirme
// sunucusu + PKCE; tarayıcıyı main açar (izinli alan adlarıyla). Sunucu modunda (web) dönüş sunucunun
// /oauth/callback adresine gelir (hub.webOAuth, server/oauthWeb.ts). Yenileme belirteci şifreli saklanır,
// istemciye gitmez.
import type { PimConnectStatus } from '../../shared/pim'
import type { OAuthClientsInfo } from '../../shared/rpc'
import type { AccountRow } from '../db/queries'
import {
  cancelFlow, dropAccessToken, OAUTH_PROVIDERS, oauthClientsFrom, providerOfAuthType, startFlow, waitFlow, type OAuthProviderId, type TokenSet
} from '../oauth'
import type { OAuthFlowResult } from '../rpcHub'
import type { RpcSession } from '../rpcSession'
import type { Handler } from './common'
import { emitPimChanged } from './pimAuth'
import { connectAccountSource, ensureAccountSource } from './pimSources'
import { t } from '../../shared/i18n'

const providerArg = (params: unknown): OAuthProviderId => {
  const p = (params as { provider?: string }).provider
  if (p !== 'google' && p !== 'microsoft') throw new Error(t('sync.oauth.invalidProvider'))
  return p
}

function clientsInfo(s: RpcSession): OAuthClientsInfo {
  const get = (k: string) => s.deps.q.prefGet(k)
  const clients = oauthClientsFrom(get)
  return {
    googleClientId: get('oauth_google_client_id') || '',
    googleHasSecret: !!get('oauth_google_client_secret'),
    microsoftClientId: get('oauth_microsoft_client_id') || '',
    googleReady: !!clients('google'),
    microsoftReady: !!clients('microsoft')
  }
}

export const oauthHandlers: Record<string, Handler> = {
  async oauthGetClients(s: RpcSession, _params: unknown) {
    return clientsInfo(s)
  },

  async oauthSetClients(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const p = params as { googleClientId?: string; googleClientSecret?: string; microsoftClientId?: string }
    const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max)
    const ok = (v: string) => !v || /^[A-Za-z0-9._-]+$/.test(v)
    const gid = clean(p.googleClientId, 200)
    const mid = clean(p.microsoftClientId, 100)
    if (!ok(gid) || !ok(mid)) throw new Error(t('sync.oauth.invalidClientId'))
    if (p.googleClientId !== undefined) q.prefSet('oauth_google_client_id', gid)
    if (p.microsoftClientId !== undefined) q.prefSet('oauth_microsoft_client_id', mid)
    // boş gizli anahtar = değiştirme; silmek için tek boşluk değil, istemci kimliğini temizleyin
    if (p.googleClientSecret) q.prefSet('oauth_google_client_secret', clean(p.googleClientSecret, 200))
    if (!gid && p.googleClientId !== undefined) q.prefSet('oauth_google_client_secret', '')
    return clientsInfo(s)
  },

  async oauthStart(s: RpcSession, params: unknown) {
    const provider = providerArg(params)
    const web = webFlows(s)
    const client = oauthClientsFrom((k) => s.deps.q.prefGet(k))(provider)
    if (!client) throw new Error(t('sync.oauth.noClientSettings', { provider: OAUTH_PROVIDERS[provider].label }))
    const hint = String((params as { email?: string }).email ?? '').trim().toLowerCase()
    const loginHint = /^[^@\s]+@[^@\s]+$/.test(hint) ? hint : undefined
    const pim = (params as { pim?: unknown }).pim === true
    const rawId = (params as { accountId?: unknown }).accountId
    const accountId = typeof rawId === 'number' && Number.isInteger(rawId) ? rawId : undefined
    if (pim) pimAccount(s, provider, accountId)
    const extraScopes = pim ? OAUTH_PROVIDERS[provider].pimScopes : undefined
    if (!web) return startFlow(provider, client, loginHint, fetch, extraScopes)
    // web: hesap denetimi (beklenen e-posta, yeniden yetkilendirilen hesap) başlangıçta saklanır, dönüşte uygulanır
    if (accountId != null) s.assertCanManage(accountId)
    return web.flows.start({
      owner: web.owner, provider, client, loginHint, extraScopes,
      finish: (tok) => (pim ? finishPim(s, provider, tok, accountId) : applyTokens(s, provider, tok, loginHint, accountId))
    })
  },

  async oauthCancel(s: RpcSession, params: unknown) {
    const flowId = String((params as { flowId?: string }).flowId ?? '')
    const web = webFlows(s)
    if (web) web.flows.cancel(web.owner, flowId)
    else cancelFlow(flowId)
    return null
  },

  /** Kullanıcı tarayıcıda izin verene kadar bekler; hesabı ekler ya da (varsa) OAuth'a geçirir. Web'de
   *  istemci 'oauth:done' olayını bekler; bu yöntem yalnız aynı oturumun akışının sonucunu döndürür. */
  async oauthFinish(s: RpcSession, params: unknown) {
    const { flowId, provider: pArg, expectedEmail, accountId, pim } = params as {
      flowId: string
      provider: OAuthProviderId
      expectedEmail?: string
      accountId?: number
      pim?: boolean
    }
    const provider = providerArg({ provider: pArg })
    const web = webFlows(s)
    if (web) return web.flows.wait(web.owner, String(flowId))
    const tok = await waitFlow(String(flowId))
    return pim === true ? finishPim(s, provider, tok, accountId) : applyTokens(s, provider, tok, expectedEmail, accountId)
  }
}

/** Sunucu modunda web akışları ve oturum sahibi; masaüstünde null. Sunucu modunda web akışı yoksa
 *  (ör. HTTP katmanı kurulmadı) geri döngü akışına düşülmez: hata. */
function webFlows(s: RpcSession): { flows: NonNullable<RpcSession['hub']['webOAuth']>; owner: string } | null {
  if (s.hub.mode !== 'server') return null
  const flows = s.hub.webOAuth
  if (!flows || !s.webSessionId) throw new Error(t('sync.server.desktopOnly'))
  return { flows, owner: s.webSessionId }
}

/** Kişi ve takvim bağlanabilecek hesap: var olan, kasada olmayan, aynı sağlayıcıya OAuth ile bağlı ve yönetilebilir */
function pimAccount(s: RpcSession, provider: OAuthProviderId, accountId: number | undefined): AccountRow {
  const row = accountId == null ? undefined : s.deps.q.getAccountRow(accountId)
  if (!row) throw new Error(t('sync.err.accountNotFound'))
  s.assertCanManage(row.id)
  if (row.secure) throw new Error(t('sync.oauth.vaultAccount'))
  if (providerOfAuthType(row.auth_type) !== provider) throw new Error(t('sync.oauth.invalidProvider'))
  return row
}

/** Google izin ekranında kapsam tek tek kapatılabilir. Microsoft dönüşü yalnız ilk kaynağı gösterir: orada kanıt Graph denemesidir. */
function googleConsentComplete(granted: string | undefined): boolean {
  if (!granted) return true
  const have = new Set(granted.split(/\s+/))
  const { scopes, pimScopes } = OAUTH_PROVIDERS.google
  return [scopes[0], ...pimScopes].every((x) => have.has(x))
}

/** "Kişi ve takvimi bağla" dönüşü. Eksik izinli yenileme belirteci saklanmaz: posta kapsamı kapatılmış olabilir, eski belirteç çalışır. */
async function finishPim(s: RpcSession, provider: OAuthProviderId, tok: TokenSet & { email: string }, accountId: number | undefined): Promise<OAuthFlowResult> {
  const row = pimAccount(s, provider, accountId)
  if (row.email.toLowerCase() !== tok.email) throw new Error(t('sync.oauth.accountMismatch', { account: row.email, email: tok.email }))
  if (provider === 'google' && !googleConsentComplete(tok.scope)) {
    emitPimChanged(s.hub, ensureAccountSource(s, row, 'needs_reauth', tok.scope ?? null), 'sources')
    return { email: tok.email, added: false, pimStatus: 'needsConsent' }
  }
  if (provider === 'microsoft') s.deps.q.markMailScopeExplicit(row.id)
  const applied = await applyTokens(s, provider, tok, row.email, row.id)
  const pimStatus: PimConnectStatus = await connectAccountSource(s, row, tok.scope ?? null)
  return { ...applied, pimStatus }
}

/** Alınan belirteçlerle hesabı ekler ya da (varsa) OAuth'a geçirir; masaüstü ve web akışı ortak. */
async function applyTokens(
  s: RpcSession, provider: OAuthProviderId, tok: TokenSet & { email: string }, expectedEmail?: string, accountId?: number
): Promise<{ email: string; added: boolean }> {
  const { q, scheduler, creds, encrypt } = s.deps
  const def = OAUTH_PROVIDERS[provider]
  const email = tok.email
  const expect = expectedEmail?.trim().toLowerCase()
  if (expect && expect !== email) throw new Error(t('sync.oauth.wrongAccount', { email, expected: expect }))
  const [enc] = await encrypt([tok.refreshToken!])
  const authType = `oauth:${provider}`
  const existingId = accountId ?? q.getAccountIdByEmail(email)
  if (existingId != null) {
    const row = q.getAccountRow(existingId)
    if (!row) throw new Error(t('sync.err.accountNotFound'))
    if (row.email.toLowerCase() !== email) throw new Error(t('sync.oauth.accountMismatch', { account: row.email, email }))
    if (row.secure) throw new Error(t('sync.oauth.vaultAccount'))
    s.assertCanManage(existingId)
    q.setAccountOAuth(existingId, {
      authType, secretEnc: Buffer.from(enc),
      imapHost: def.imap.host, imapPort: def.imap.port, smtpHost: def.smtp.host, smtpPort: def.smtp.port
    })
    creds.set(existingId, tok.refreshToken!)
    dropAccessToken(existingId)
    // yeni belirteç: reddedilmiş kaynak bir kez daha denenir, izin yoksa yine durur
    q.clearPimNeedsReauth(existingId)
    scheduler.reloadAccounts()
    scheduler.retryAccount(existingId)
    s.deps.sieve?.onCredentialsChanged(existingId)
    s.broadcast('counts:changed', {})
    return { email, added: false }
  }
  const id = q.insertAccount({
    email, displayName: null,
    imapHost: def.imap.host, imapPort: def.imap.port, smtpHost: def.smtp.host, smtpPort: def.smtp.port,
    passwordEnc: Buffer.from(enc), authType
  })
  creds.set(id, tok.refreshToken!)
  scheduler.reloadAccounts()
  scheduler.pollAllSoon()
  s.broadcast('counts:changed', {})
  return { email, added: true }
}
