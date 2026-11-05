// Web OAuth akışı (sunucu modu): her kurulum kendi Google/Microsoft istemcisini kullanır, yönlendirme adresi
// `${publicOrigin}/oauth/callback`. Yetkilendirme kodu + PKCE; doğrulayıcı sunucuda state ile durur, istemciye
// gitmez. state 32 rastgele bayt, akışı başlatan web oturumuna (çerez oturumu) bağlı, 10 dk geçerli, tek
// kullanımlık. Kod değiş tokuşu sunucuda; sonuç yalnız o oturuma 'oauth:done' olayıyla gider.
//
// Sağlayıcıdan dönüş siteler arası bir gezinmedir: SameSite=Strict oturum çerezi hiçbir tarayıcıda gelmez
// (WebKit aynı kökenden kendine yenilenen sayfada da göndermez). Bu yüzden akış açılır pencerede değil uygulama
// sayfasında tamamlanır:
//  1. GET /oauth/callback (çerezsiz): kod, onu getiren tarayıcıya verilen tek seferlik işaret çereziyle (gm_oauth)
//     saklanır; "pencereyi kapatabilirsiniz" sayfası döner; sahibi oturuma 'oauth:returned' gider.
//  2. Uygulama (Strict çerezi taşıyan aynı kökenli sayfa) POST /oauth/complete { state } gönderir: oturum sahibi,
//     işaret ve yönetici rolü tutarsa kod değiş tokuş edilir, hesap eklenir, 'oauth:done' yayılır.
// Akış ancak sahibinin oturum çereziyle VE kodu getiren tarayıcının işaretiyle tamamlanır: başkasının state'iyle
// gelen kod (OAuth CSRF) ne o tarayıcının oturumuna ne state'in sahibine bağlanabilir.
import { randomBytes, timingSafeEqual } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import type { PimConnectStatus } from '../shared/pim'
import type { SessionUser } from '../shared/rpc'
import { detectLocale, dirOf, intlTag, t, tFor, type Locale } from '../shared/i18n'
import {
  buildAuthUrl, exchangeCode, OAUTH_PROVIDERS, pkcePair, type OAuthClient, type OAuthProviderDef, type OAuthProviderId, type TokenSet
} from '../sync/oauth'
import type { WebOAuthFlows } from '../sync/rpcHub'
import { securityHeaders, WEB_CSP } from './securityHeaders'

export const OAUTH_CALLBACK_PATH = '/oauth/callback'
export const OAUTH_COMPLETE_PATH = '/oauth/complete'
export const OAUTH_STATE_TTL_MS = 10 * 60_000
const NONCE_COOKIE = 'gm_oauth'
const SWEEP_MS = 30_000

type Result = { email: string; added: boolean; pimStatus?: PimConnectStatus }
export type OAuthDone = { ok: boolean; error?: string; flowId?: string; email?: string; added?: boolean; pimStatus?: PimConnectStatus }
/** POST /oauth/complete sonucu: ok → 204; diğerleri 400 { reason } */
export type CompleteOutcome = 'ok' | 'denied' | 'failed' | 'invalid' | 'stale'

interface Pending {
  state: string
  flowId: string
  owner: string
  def: OAuthProviderDef
  client: OAuthClient
  verifier: string
  expiresAt: number
  finish(tok: TokenSet & { email: string }): Promise<Result>
  resolve(r: Result): void
  reject(e: Error): void
  result: Promise<Result>
  /** Sağlayıcı dönüşünde saklanan kod/hata ve onu getiren tarayıcının işareti */
  stash?: { code: string | null; error: string | null; nonce: string }
}

export interface WebOAuth extends WebOAuthFlows {
  /** GET /oauth/callback */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** POST /oauth/complete (aynı köken ve JSON denetimi çağıranda); yanıtla gönderilecek gm_oauth temizliği dahil */
  complete(req: IncomingMessage, body: Record<string, unknown>): Promise<{ outcome: CompleteOutcome; setCookie: string }>
  /** Oturuma yeni soket açıldı: kodu saklanmış (sağlayıcıdan dönmüş) akışlar yeniden 'oauth:returned' olur */
  resendReturned(owner: string): void
  close(): void
}

const b64url = (n: number): string => randomBytes(n).toString('base64url')
const STATE_RE = /^[A-Za-z0-9_-]{43}$/

export function cookieValue(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i >= 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

/** Sabit süreli karşılaştırma (uzunluk farkı erken döner; işaret uzunluğu sabit, sır değil) */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Accept-Language'ten desteklenen dil; yoksa İngilizce */
function localeOf(req: IncomingMessage): Locale {
  const raw = String(req.headers['accept-language'] ?? '').slice(0, 256)
  return detectLocale(raw.split(',').map((p) => p.split(';')[0].trim()).filter(Boolean))
}

export function createWebOAuth(o: {
  publicOrigin: string
  https: boolean
  /** İsteğin çerez oturumu (yoksa null) */
  session(req: IncomingMessage): { user: SessionUser; sessionId: string } | null
  /** Sahibi web oturumuna: kod döndü ('oauth:returned') */
  returned(owner: string, flowId: string): void
  /** Sonucu akışın sahibi web oturumuna iletir ('oauth:done') */
  notify(owner: string, data: OAuthDone): void
  now?: () => number
  /** yalnız testler: sağlayıcı uç noktaları yerel sahte sunucuya */
  providers?: Partial<Record<OAuthProviderId, Partial<OAuthProviderDef>>>
}): WebOAuth {
  const now = o.now ?? Date.now
  const redirectUri = o.publicOrigin + OAUTH_CALLBACK_PATH
  const byState = new Map<string, Pending>()
  const byFlow = new Map<string, Pending>()

  const drop = (p: Pending): void => {
    byState.delete(p.state)
    byFlow.delete(p.flowId)
  }
  const fail = (p: Pending, error: string, notify = true): void => {
    drop(p)
    p.reject(new Error(error))
    if (notify) o.notify(p.owner, { ok: false, flowId: p.flowId, error })
  }
  const sweep = (): void => {
    const n = now()
    // Map yinelenirken geçerli öğeyi silmek güvenli
    for (const p of byState.values()) if (p.expiresAt <= n) fail(p, t('sync.oauth.webFlowTimeout'))
  }
  const timer = setInterval(sweep, SWEEP_MS)
  timer.unref()

  // işaret çerezi /oauth/ altında: dönüş (callback) koyar, tamamlama (complete) okur ve her yanıtta temizler
  const nonceCookie = (v: string, maxAge: number): string =>
    `${NONCE_COOKIE}=${v}; HttpOnly${o.https ? '; Secure' : ''}; SameSite=Lax; Path=/oauth/; Max-Age=${maxAge}`

  const page = (res: ServerResponse, status: number, loc: Locale, kind: 'returned' | 'invalid' | 'stale', cookie?: string): void => {
    const title = kind === 'returned' ? 'returnedTitle' : 'invalidTitle'
    const body = { returned: 'returnedBody', invalid: 'invalidBody', stale: 'staleBody' }[kind]
    const html =
      `<!doctype html><html lang="${intlTag(loc)}" dir="${dirOf(loc)}"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">` +
      `<title>GeckoMail</title></head>` +
      `<body style="font:15px -apple-system,system-ui,sans-serif;background:#141814;color:#e8ece4;display:grid;place-items:center;min-height:100vh;margin:0">` +
      `<main style="text-align:center;max-width:420px;padding:16px"><h1 style="font-size:20px;margin:0 0 8px">${esc(tFor(loc, `sync.oauth.page.${title}`))}</h1>` +
      `<p style="color:#9aa394">${esc(tFor(loc, `sync.oauth.page.${body}`))}</p></main></body></html>`
    const h: Record<string, string> = {
      ...securityHeaders({ https: o.https, api: true }),
      'Content-Security-Policy': WEB_CSP,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(html))
    }
    if (cookie) h['Set-Cookie'] = cookie
    res.writeHead(status, h).end(html)
  }

  /** Akışı tüketir (tek kullanım), kodu sunucuda değiş tokuş eder, hesabı ekler; sonuç sahibine olayla */
  const finishFlow = async (p: Pending, user: SessionUser, code: string | null, error: string | null): Promise<CompleteOutcome> => {
    drop(p)
    if (error || !code) {
      // sağlayıcının hata kodu yalnız güvenli karakterlerle iletiye girer; yalnız access_denied "reddedildi" sayılır
      const e = (error ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
      if (e === 'access_denied') {
        fail(p, t('sync.oauth.denied'))
        return 'denied'
      }
      fail(p, t('sync.oauth.authError', { error: e || t('sync.oauth.noCode') }))
      return 'failed'
    }
    // OAuth yöntemleri yönetici yetkisi ister: rol bu arada değiştiyse tamamlanmaz
    if (user.role !== 'admin') {
      fail(p, t('sync.perm.adminRequired'))
      return 'failed'
    }
    try {
      const tok = await exchangeCode(p.def, p.client, code, redirectUri, p.verifier)
      const r = await p.finish(tok)
      p.resolve(r)
      o.notify(p.owner, { ok: true, flowId: p.flowId, email: r.email, added: r.added, ...(r.pimStatus ? { pimStatus: r.pimStatus } : {}) })
      return 'ok'
    } catch (e) {
      fail(p, String((e as Error).message ?? e))
      return 'failed'
    }
  }

  return {
    start({ owner, provider, client, loginHint, extraScopes, finish }) {
      sweep()
      // oturum başına tek bekleyen akış: yenisi eskisini (sessizce; istemci zaten bırakmıştır) düşürür
      for (const p of byState.values()) if (p.owner === owner) fail(p, t('sync.oauth.cancelled'), false)
      const def: OAuthProviderDef = { ...OAUTH_PROVIDERS[provider], ...o.providers?.[provider] }
      const { verifier, challenge } = pkcePair()
      const state = b64url(32)
      const flowId = b64url(12)
      let resolve!: (r: Result) => void
      let reject!: (e: Error) => void
      const result = new Promise<Result>((res, rej) => {
        resolve = res
        reject = rej
      })
      result.catch(() => {}) // bekleyen oauthFinish yoksa işlenmemiş ret olmasın
      const p: Pending = { state, flowId, owner, def, client, verifier, expiresAt: now() + OAUTH_STATE_TTL_MS, finish, resolve, reject, result }
      byState.set(state, p)
      byFlow.set(flowId, p)
      return { flowId, url: buildAuthUrl(def, client, redirectUri, state, challenge, loginHint, extraScopes) }
    },

    cancel(owner, flowId) {
      const p = byFlow.get(flowId)
      if (p && p.owner === owner) fail(p, t('sync.oauth.cancelled'), false)
    },

    wait(owner, flowId) {
      sweep()
      const p = byFlow.get(flowId)
      if (!p || p.owner !== owner) return Promise.reject(new Error(t('sync.oauth.flowNotFound')))
      return p.result
    },

    async handle(req, res) {
      sweep()
      const loc = localeOf(req)
      const u = new URL(req.url ?? '/', 'http://localhost')
      const state = u.searchParams.get('state') ?? ''
      const code = u.searchParams.get('code')
      const error = u.searchParams.get('error')
      const p = STATE_RE.test(state) ? byState.get(state) : undefined
      // bilinmeyen, kullanılmış ya da süresi dolmuş
      if (!p) return page(res, 400, loc, 'stale')
      // Kod bir kez saklanır. Bilinçli sınır: canlı state'i bilen biri (state sırdır; yalnız sahibinin tarayıcısı ve
      // sağlayıcı görür) önce çerezsiz istek atarak kodu kendi işaretiyle saklatıp bu akışı tıkayabilir — yalnız
      // hizmet engeli; kod ele geçmez, hesap bağlanamaz, kullanıcı yeniden dener.
      if ((code == null && error == null) || p.stash) return page(res, 400, loc, 'invalid')
      const nonce = b64url(24)
      p.stash = { code, error, nonce }
      // olay sayfa yazıldıktan sonra: uygulama pencereyi kapatırken pencerede tercihen sağlayıcının (başka kökenli)
      // sayfası kalmamış olsun. Tarayıcının sayfaya geçtiğinin garantisi değil: istemci kapatmayı yineler (web.ts).
      // yanıt yazılamadan kopan bağlantıda ('finish' gelmez) de: akış asılı kalmasın, olay bir kez
      let told = false
      const tell = (): void => {
        if (told) return
        told = true
        o.returned(p.owner, p.flowId)
      }
      res.once('finish', tell)
      res.once('close', tell)
      page(res, 200, loc, 'returned', nonceCookie(nonce, OAUTH_STATE_TTL_MS / 1000))
    },

    async complete(req, body) {
      sweep()
      const out = (outcome: CompleteOutcome) => ({ outcome, setCookie: nonceCookie('', 0) })
      const state = typeof body.state === 'string' ? body.state : ''
      const p = STATE_RE.test(state) ? byState.get(state) : undefined
      if (!p) return out('stale')
      const sess = o.session(req)
      const nonce = cookieValue(req, NONCE_COOKIE)
      // başka oturum, işaretsiz ya da yanlış işaret: akışa dokunulmaz
      if (!sess || sess.sessionId !== p.owner || !p.stash || !nonce || !sameSecret(nonce, p.stash.nonce)) return out('invalid')
      return out(await finishFlow(p, sess.user, p.stash.code, p.stash.error))
    },

    resendReturned(owner) {
      for (const p of byState.values()) if (p.owner === owner && p.stash) o.returned(owner, p.flowId)
    },

    close() {
      clearInterval(timer)
    }
  }
}
