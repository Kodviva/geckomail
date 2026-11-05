import { describe, expect, it } from 'vitest'
import { accountDiff, normalizeBaseUrl, StalwartAdmin } from '../stalwartAdmin'

type Call = { url: string; init: RequestInit }

function fakeFetch(handler: (url: string, body: { methodCalls?: [string, Record<string, unknown>, string][] } | null) => { status?: number; json: unknown }) {
  const calls: Call[] = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const body = init.body ? JSON.parse(String(init.body)) : null
    const r = handler(url, body)
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.json } as Response
  }) as unknown as typeof fetch
  return { f, calls }
}

const SESSION = { username: 'api-agent@kodviva.com', primaryAccounts: { 'urn:stalwart:jmap': 'cr' } }

describe('Stalwart yönetim istemcisi', () => {
  it('oturum: Bearer anahtar, yönetim hesabı kimliği; anahtar URL/başlık dışında görünmez', async () => {
    const { f, calls } = fakeFetch(() => ({ json: SESSION }))
    const s = await new StalwartAdmin('https://mx.test', 'k'.repeat(42), f).session()
    expect(s).toEqual({ username: 'api-agent@kodviva.com', accountId: 'cr' })
    expect(calls[0].url).toBe('https://mx.test/jmap/session')
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${'k'.repeat(42)}`)
    expect(calls[0].init.redirect).toBe('error')
  })

  it('yönetim yetkisi yoksa ve 401 durumunda anlaşılır hata', async () => {
    const noMgmt = fakeFetch(() => ({ json: { username: 'x', primaryAccounts: {} } }))
    await expect(new StalwartAdmin('https://mx.test', 'k', noMgmt.f).session()).rejects.toThrow('yönetim yetkisi')
    const unauth = fakeFetch(() => ({ status: 401, json: {} }))
    await expect(new StalwartAdmin('https://mx.test', 'k', unauth.f).session()).rejects.toThrow('reddetti')
  })

  it('engelli IP listesi: query + get zinciri, accountId eklenir', async () => {
    const { f, calls } = fakeFetch((url, body) => {
      if (url.endsWith('/session')) return { json: SESSION }
      const [[m1, a1], [m2, a2]] = body!.methodCalls!
      expect([m1, m2]).toEqual(['x:BlockedIp/query', 'x:BlockedIp/get'])
      expect(a1).toMatchObject({ accountId: 'cr', filter: { address: '1.2.3.4' }, calculateTotal: true })
      expect(a2).toMatchObject({ '#ids': { resultOf: 'q', name: 'x:BlockedIp/query', path: '/ids' } })
      return {
        json: {
          methodResponses: [
            ['x:BlockedIp/query', { ids: ['a'], total: 970 }, 'q'],
            ['x:BlockedIp/get', { list: [{ id: 'a', address: '1.2.3.4', reason: 'portScanning', createdAt: '2026-07-25T06:31:04Z', expiresAt: null, extra: 1 }] }, 'g']
          ]
        }
      }
    })
    const r = await new StalwartAdmin('https://mx.test', 'k', f).blocked({ address: '1.2.3.4' })
    expect(r).toEqual({ total: 970, items: [{ id: 'a', address: '1.2.3.4', reason: 'portScanning', createdAt: '2026-07-25T06:31:04Z', expiresAt: null }] })
    expect(calls).toHaveLength(2)
  })

  it('izin ekleme hatası ve silme sonuçları raporlanır; JMAP method error fırlatır', async () => {
    let mode = 'create'
    const { f } = fakeFetch((url) => {
      if (url.endsWith('/session')) return { json: SESSION }
      if (mode === 'create') return { json: { methodResponses: [['x:AllowedIp/set', { notCreated: { n1: { type: 'invalidProperties', description: 'bad address' } } }, 's']] } }
      if (mode === 'destroy') return { json: { methodResponses: [['x:BlockedIp/set', { destroyed: ['a', 'b'] }, 's']] } }
      return { json: { methodResponses: [['error', { type: 'forbidden', description: 'no permission' }, 's']] } }
    })
    const c = new StalwartAdmin('https://mx.test', 'k', f)
    await expect(c.allow('1.2.3.4', 'x', null)).rejects.toThrow('bad address')
    mode = 'destroy'
    expect(await c.unblock(['a', 'b'])).toBe(2)
    mode = 'err'
    await expect(c.unblock(['a'])).rejects.toThrow('forbidden no permission')
  })

  it('adres normalizasyonu ve hesap uyumu', () => {
    expect(normalizeBaseUrl(' https://mx.example.test/jmap/ ')).toBe('https://mx.example.test')
    expect(normalizeBaseUrl('http://10.20.30.40:18080')).toBe('http://10.20.30.40:18080')
    expect(() => normalizeBaseUrl('ftp://x')).toThrow()
    expect(() => normalizeBaseUrl('https://u:p@x.co')).toThrow()
    expect(accountDiff(['A@x.co', 'b@x.co'], ['a@x.co', 'c@x.co'])).toEqual({ onServerNotInApp: ['b@x.co'], inAppNotOnServer: ['c@x.co'] })
  })
})

describe('sağlayıcı algılama ve adres önerisi', () => {
  it('Stalwart yönetim oturumu algılanır; desteklenmeyen sunucuda anlaşılır hata', async () => {
    const { detectProvider } = await import('../serverProvider')
    const ok = fakeFetch(() => ({ json: SESSION }))
    expect((await detectProvider('https://mx.test', 'k', ok.f)).name).toBe('Stalwart')
    const other = fakeFetch(() => ({ status: 404, json: {} }))
    await expect(detectProvider('https://imap.gmail.test', 'k', other.f)).rejects.toThrow('Desteklenen bir yönetim API')
  })

  it('en yaygın IMAP sunucusundan öneri; hesap yoksa null', async () => {
    const { suggestAdminUrl } = await import('../serverProvider')
    expect(suggestAdminUrl(['mail.a.co', 'MAIL.A.CO', 'imap.b.co'])).toBe('https://mail.a.co')
    expect(suggestAdminUrl([])).toBeNull()
  })
})
