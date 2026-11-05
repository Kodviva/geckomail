import { createHash } from 'crypto'
import { request } from 'http'
import { describe, expect, it } from 'vitest'
import {
  accessTokenFor, buildAuthUrl, cancelFlow, emailFromIdToken, initOAuth, OAUTH_PROVIDERS, OAuthGrantError, oauthBearer, pkcePair, refreshAccessToken, startFlow, TokenCache, waitFlow, xoauth2
} from '../oauth'

const idToken = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

function tokenFetch(responses: Record<string, unknown>[] | ((body: URLSearchParams) => Record<string, unknown>), status = 200) {
  const bodies: URLSearchParams[] = []
  let i = 0
  const f = (async (_url: string, init: RequestInit) => {
    const b = new URLSearchParams(String(init.body))
    bodies.push(b)
    const json = typeof responses === 'function' ? responses(b) : responses[Math.min(i++, responses.length - 1)]
    return { ok: status < 400 && !('error' in json), status: 'error' in json ? 400 : status, json: async () => json } as Response
  }) as unknown as typeof fetch
  return { f, bodies }
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((res, rej) => {
    request(url, (r) => {
      let body = ''
      r.on('data', (d) => (body += d))
      r.on('end', () => res({ status: r.statusCode ?? 0, body }))
    })
      .on('error', rej)
      .end()
  })
}

describe('OAuth yardımcıları', () => {
  it('PKCE: S256(verifier) = challenge, base64url', () => {
    const { verifier, challenge } = pkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge)
  })

  it('yetki adresi: PKCE, state, kapsam, sağlayıcıya özel parametreler, login_hint', () => {
    const u = new URL(buildAuthUrl(OAUTH_PROVIDERS.google, { clientId: 'cid' }, 'http://127.0.0.1:5/callback', 'st', 'ch', 'a@gmail.com'))
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: 'cid', response_type: 'code', redirect_uri: 'http://127.0.0.1:5/callback', state: 'st',
      code_challenge: 'ch', code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', login_hint: 'a@gmail.com',
      scope: 'https://mail.google.com/ openid email'
    })
  })

  it('id_token e-postası (Google email, Microsoft preferred_username); bozuk belirteç undefined', () => {
    expect(emailFromIdToken(idToken({ email: 'A@Gmail.com' }))).toBe('a@gmail.com')
    expect(emailFromIdToken(idToken({ preferred_username: 'x@outlook.com' }))).toBe('x@outlook.com')
    expect(emailFromIdToken('bozuk')).toBeUndefined()
  })

  it('XOAUTH2 SASL dizgesi', () => {
    expect(Buffer.from(xoauth2('a@b.co', 'TOK'), 'base64').toString()).toBe('user=a@b.co\x01auth=Bearer TOK\x01\x01')
  })

  it('OAUTHBEARER SASL dizgesi (RFC 7628)', () => {
    expect(Buffer.from(oauthBearer('a@b.co', 'h.test', 4190, 'TOK'), 'base64').toString()).toBe('n,a=a@b.co,\x01host=h.test\x01port=4190\x01auth=Bearer TOK\x01\x01')
    // GS2 adında virgül ve eşittir kaçırılır
    expect(Buffer.from(oauthBearer('a,b=c@d', 'h', 1, 'T'), 'base64').toString()).toContain('n,a=a=2Cb=3Dc@d,')
  })
})

describe('erişim belirteci önbelleği', () => {
  it('geçerliyken önbellekten; eşzamanlı istekler tek yenileme; süresine az kala yeniler', async () => {
    const { f, bodies } = tokenFetch([{ access_token: 'A1', expires_in: 3600 }, { access_token: 'A2', expires_in: 3600 }])
    let now = 1_000_000
    const c = new TokenCache(() => ({ clientId: 'cid' }), undefined, f, () => now)
    const [x, y] = await Promise.all([c.get(1, 'google', 'R'), c.get(1, 'google', 'R')])
    expect([x, y]).toEqual(['A1', 'A1'])
    expect(bodies).toHaveLength(1)
    expect(Object.fromEntries(bodies[0])).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'R', client_id: 'cid' })
    expect(await c.get(1, 'google', 'R')).toBe('A1')
    now += 3600_000 - 60_000 // 1 dk kaldı
    expect(await c.get(1, 'google', 'R')).toBe('A2')
  })

  it('döndürülen yenileme belirteci bildirilir', async () => {
    const { f } = tokenFetch([{ access_token: 'A', expires_in: 3600, refresh_token: 'R2' }])
    const rotated: [number, string][] = []
    await new TokenCache(() => ({ clientId: 'c' }), (id, r) => rotated.push([id, r]), f).get(7, 'microsoft', 'R1')
    expect(rotated).toEqual([[7, 'R2']])
  })

  it('geri alınmış izin OAuthGrantError (auth sayılır); istemci yoksa da', async () => {
    const { f } = tokenFetch([{ error: 'invalid_grant' }])
    const err = await new TokenCache(() => ({ clientId: 'c' }), undefined, f).get(1, 'google', 'R').catch((e) => e)
    expect(err).toBeInstanceOf(OAuthGrantError)
    expect(err.authenticationFailed).toBe(true)
    await expect(new TokenCache(() => null).get(1, 'google', 'R')).rejects.toThrow('istemcisi tanımlı değil')
  })
})

describe('yerel yönlendirme akışı', () => {
  it('izin → kod takası (PKCE doğrulayıcıyla) → e-posta ve yenileme belirteci', async () => {
    const { f, bodies } = tokenFetch(() => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, id_token: idToken({ email: 'ali@gmail.com' }) }))
    const { flowId, url } = await startFlow('google', { clientId: 'cid', clientSecret: 'sec' }, 'ali@gmail.com', f)
    const u = new URL(url)
    const redirect = u.searchParams.get('redirect_uri')!
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    // yanlış state: reddedilir, akış sürer
    expect((await get(`${redirect}?code=x&state=baska`)).status).toBe(400)
    const ok = await get(`${redirect}?code=KOD&state=${u.searchParams.get('state')}`)
    expect(ok.body).toContain('Bağlandı')
    const t = await waitFlow(flowId)
    expect(t).toMatchObject({ email: 'ali@gmail.com', refreshToken: 'RT', accessToken: 'AT' })
    const b = Object.fromEntries(bodies[0])
    expect(b).toMatchObject({ grant_type: 'authorization_code', code: 'KOD', redirect_uri: redirect, client_secret: 'sec' })
    expect(createHash('sha256').update(b.code_verifier).digest('base64url')).toBe(u.searchParams.get('code_challenge'))
  })

  it('Microsoft: localhost yönlendirmesi; reddedilen izin anlaşılır hata', async () => {
    const { flowId, url } = await startFlow('microsoft', { clientId: 'cid' }, undefined, tokenFetch([{}]).f)
    const u = new URL(url)
    const redirect = u.searchParams.get('redirect_uri')!
    expect(redirect).toMatch(/^http:\/\/localhost:\d+\/callback$/)
    await get(`${redirect.replace('localhost', '127.0.0.1')}?error=access_denied&state=${u.searchParams.get('state')}`)
    await expect(waitFlow(flowId)).rejects.toThrow('İzin verilmedi')
  })

  it('iptal bekleyeni hemen sonlandırır', async () => {
    const { flowId } = await startFlow('google', { clientId: 'cid' }, undefined, tokenFetch([{}]).f)
    const p = waitFlow(flowId)
    cancelFlow(flowId)
    await expect(p).rejects.toThrow('iptal')
  })
})

describe('kişi ve takvim kapsamları', () => {
  const G = OAUTH_PROVIDERS.google
  const M = OAUTH_PROVIDERS.microsoft
  const url = (p = G, extra?: string[]) => buildAuthUrl(p, { clientId: 'cid' }, 'http://127.0.0.1:5/callback', 'st', 'ch', 'a@gmail.com', extra)
  const tokens = (n: number) => Array.from({ length: n }, (_, i) => ({ access_token: `at${i}`, expires_in: 3600, refresh_token: 'rt' }))

  it('mail flow url unchanged', () => {
    expect(url()).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=cid&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcallback' +
        '&scope=https%3A%2F%2Fmail.google.com%2F+openid+email&state=st&code_challenge=ch&code_challenge_method=S256&login_hint=a%40gmail.com&access_type=offline&prompt=consent'
    )
    expect(url(G, [])).toBe(url())
  })

  it('pim flow adds scopes after mail scopes', () => {
    expect(new URL(url(G, G.pimScopes)).searchParams.get('scope')).toBe(
      'https://mail.google.com/ openid email https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/carddav'
    )
    expect(new URL(url(M, M.pimScopes)).searchParams.get('scope')!.split(' ').slice(-2)).toEqual([
      'https://graph.microsoft.com/Contacts.ReadWrite', 'https://graph.microsoft.com/Calendars.ReadWrite'
    ])
    expect(M.graphScopes).toEqual(M.pimScopes)
  })

  it('refreshAccessToken scope gönderir ve dönen scope okunur', async () => {
    const { f, bodies } = tokenFetch([{ access_token: 'at', expires_in: 3600, scope: 'a b' }])
    const tok = await refreshAccessToken(G, { clientId: 'cid' }, 'rt', f, 'x y')
    expect(bodies[0].get('scope')).toBe('x y')
    expect(tok.scope).toBe('a b')
  })

  it('graph refresh sends scope', async () => {
    const { f, bodies } = tokenFetch(tokens(2))
    const cache = new TokenCache(() => ({ clientId: 'cid' }), undefined, f)
    await cache.get(1, 'microsoft', 'rt', false, 'graph')
    expect(bodies[0].get('scope')).toBe([...M.graphScopes!, 'offline_access'].join(' '))
  })

  it('mail refresh has no scope without pim', async () => {
    const { f, bodies } = tokenFetch(tokens(2))
    let bound = false
    const cache = new TokenCache(() => ({ clientId: 'cid' }), undefined, f, Date.now, () => bound)
    await cache.get(1, 'microsoft', 'rt')
    expect(bodies[0].has('scope')).toBe(false)
    bound = true
    await cache.get(1, 'microsoft', 'rt', true)
    expect(bodies[1].get('scope')).toBe(M.scopes.join(' '))
  })

  it('Google yenilemesi kaynak ayırmaz: tek belirteç, scope yok', async () => {
    const { f, bodies } = tokenFetch(tokens(3))
    const cache = new TokenCache(() => ({ clientId: 'cid' }), undefined, f, Date.now, () => true)
    expect(await cache.get(1, 'google', 'rt')).toBe('at0')
    expect(await cache.get(1, 'google', 'rt', false, 'graph')).toBe('at0')
    expect(bodies).toHaveLength(1)
    expect(bodies[0].has('scope')).toBe(false)
  })

  it('mail and graph tokens cached separately', async () => {
    const { f, bodies } = tokenFetch(tokens(3))
    const cache = new TokenCache(() => ({ clientId: 'cid' }), undefined, f)
    expect(await cache.get(1, 'microsoft', 'rt')).toBe('at0')
    expect(await cache.get(1, 'microsoft', 'rt', false, 'graph')).toBe('at1')
    expect(await cache.get(1, 'microsoft', 'rt')).toBe('at0')
    expect(await cache.get(1, 'microsoft', 'rt', false, 'graph')).toBe('at1')
    expect(bodies).toHaveLength(2)
  })

  it('drop clears both', async () => {
    const { f, bodies } = tokenFetch(tokens(4))
    const cache = new TokenCache(() => ({ clientId: 'cid' }), undefined, f)
    await cache.get(1, 'microsoft', 'rt')
    await cache.get(1, 'microsoft', 'rt', false, 'graph')
    cache.drop(1)
    await cache.get(1, 'microsoft', 'rt')
    await cache.get(1, 'microsoft', 'rt', false, 'graph')
    expect(bodies).toHaveLength(4)
  })

  it('rotation from graph refresh saved', async () => {
    const seen: [number, string][] = []
    const { f } = tokenFetch([{ access_token: 'at', expires_in: 3600, refresh_token: 'yeni' }])
    const cache = new TokenCache(() => ({ clientId: 'cid' }), (id, rt) => seen.push([id, rt]), f)
    await cache.get(7, 'microsoft', 'eski', false, 'graph')
    expect(seen).toEqual([[7, 'yeni']])
  })

  it('accessTokenFor audience önbelleğe, zorlamayı yenilemeye iletir; şifreli hesapta belirteç yok', async () => {
    const { f, bodies } = tokenFetch(tokens(3))
    initOAuth(new TokenCache(() => ({ clientId: 'cid' }), undefined, f))
    const row = { id: 3, auth_type: 'oauth:microsoft' }
    expect(await accessTokenFor(row, 'rt', 'graph')).toBe('at0')
    expect(await accessTokenFor(row, 'rt', 'graph')).toBe('at0')
    expect(await accessTokenFor(row, 'rt', 'graph', true)).toBe('at1')
    expect(bodies[0].get('scope')).toContain('Calendars.ReadWrite')
    await expect(accessTokenFor({ id: 4, auth_type: 'password' }, 'parola', 'mail')).rejects.toThrow()
  })

  it('startFlow ek kapsamları izin adresine koyar', async () => {
    const { flowId, url: u } = await startFlow('google', { clientId: 'cid' }, undefined, fetch, G.pimScopes)
    expect(new URL(u).searchParams.get('scope')).toContain('auth/carddav')
    const r = waitFlow(flowId)
    cancelFlow(flowId)
    await expect(r).rejects.toThrow()
  })
})
