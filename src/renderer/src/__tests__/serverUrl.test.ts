import { describe, expect, it, vi } from 'vitest'
import { parseServerUrl, probeServer } from '../serverUrl'

const rel = { dev: false }
const dev = { dev: true }

describe('parseServerUrl', () => {
  it('posta.example.com → https origin', () => {
    expect(parseServerUrl('posta.example.com', rel)).toEqual({ ok: true, origin: 'https://posta.example.com' })
    expect(parseServerUrl('  https://posta.example.com:8443  ', rel)).toEqual({ ok: true, origin: 'https://posta.example.com:8443' })
    expect(parseServerUrl('POSTA.Example.COM', rel)).toEqual({ ok: true, origin: 'https://posta.example.com' })
  })

  it('path stripped', () => {
    expect(parseServerUrl('https://posta.example.com/gelen?x=1#y', rel)).toEqual({ ok: true, origin: 'https://posta.example.com' })
    expect(parseServerUrl('posta.example.com/app/', rel)).toEqual({ ok: true, origin: 'https://posta.example.com' })
  })

  it('idn normalized', () => {
    expect(parseServerUrl('posta.örnek.com', rel)).toEqual({ ok: true, origin: 'https://posta.xn--rnek-4qa.com' })
  })

  it('empty and invalid', () => {
    expect(parseServerUrl('   ', rel)).toEqual({ ok: false, reason: 'empty' })
    for (const v of ['ftp://x.com', 'capacitor://localhost', 'javascript:alert(1)', 'a b.com', 'https://', 'file:///etc/passwd']) {
      expect(parseServerUrl(v, rel), v).toEqual({ ok: false, reason: 'invalid' })
    }
  })

  it('http rejected in release', () => {
    for (const v of ['http://posta.example.com', 'http://localhost:8080', 'http://127.0.0.1']) {
      expect(parseServerUrl(v, rel), v).toEqual({ ok: false, reason: 'insecure' })
    }
  })

  it('http localhost allowed in dev', () => {
    expect(parseServerUrl('http://localhost:8080', dev)).toEqual({ ok: true, origin: 'http://localhost:8080' })
    expect(parseServerUrl('http://127.0.0.1:8080', dev)).toEqual({ ok: true, origin: 'http://127.0.0.1:8080' })
    expect(parseServerUrl('http://posta.example.com', dev)).toEqual({ ok: false, reason: 'insecure' })
  })

  it('userinfo rejected', () => {
    expect(parseServerUrl('https://ali:gizli@posta.example.com', rel)).toEqual({ ok: false, reason: 'credentials' })
    expect(parseServerUrl('ali@posta.example.com', rel)).toEqual({ ok: false, reason: 'credentials' })
  })
})

describe('probeServer', () => {
  const res = (status: number, body: string): typeof fetch => vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch

  it('GeckoMail sunucusu ok, kimlik bilgisi göndermez, yönlendirme izlemez', async () => {
    const f = res(200, '{"product":"geckomail","api":1,"push":true}')
    expect(await probeServer('https://posta.example.com', f)).toBe('ok')
    expect(f).toHaveBeenCalledWith('https://posta.example.com/api/mobile/hello', expect.objectContaining({ credentials: 'omit', redirect: 'error' }))
  })

  it('non gecko json → notGecko', async () => {
    expect(await probeServer('https://a.example', res(200, '{"product":"baska"}'))).toBe('notGecko')
    expect(await probeServer('https://a.example', res(200, '<html>'))).toBe('notGecko')
    expect(await probeServer('https://a.example', res(500, 'x'))).toBe('notGecko')
  })

  it('404 → tooOld', async () => {
    expect(await probeServer('https://a.example', res(404, '{}'))).toBe('tooOld')
  })

  it('ağ hatası → unreachable', async () => {
    const f = vi.fn(async () => { throw new TypeError('ağ') }) as unknown as typeof fetch
    expect(await probeServer('https://a.example', f)).toBe('unreachable')
  })
})
