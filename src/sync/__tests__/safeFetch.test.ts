import { createServer, request as httpRequest, type IncomingMessage, type RequestListener, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '../../shared/i18n'
import { isBlockedAddress, PUBLIC_DAV_PORTS, safeFetch } from '../net/safeFetch'
import { pimNetPolicy } from '../pim/davClient'

// Testte gerçek DNS ve sertifika yok: genel adlar (*.icloud.com dahil) 8.8.8.8'e çözülür; genel adlara
// giden istek yine yerel sunucuya iner (adres denetimi çözülen adresi görür), https düz http'ye iner
vi.mock('dns', async (orig) => {
  const dns = await orig<typeof import('dns')>()
  return {
    ...dns,
    lookup: (host: string, o: object, cb: (...a: unknown[]) => void) => {
      if (/\.(icloud\.com|github\.io|public\.test)$/.test(host)) return cb(null, [{ address: '8.8.8.8', family: 4 }])
      return dns.lookup(host, o as never, cb as never)
    }
  }
})
vi.mock('http', async (orig) => {
  const http = await orig<typeof import('http')>()
  return {
    ...http,
    request: (u: URL, o: object, cb: (r: IncomingMessage) => void) =>
      /\.(icloud\.com|github\.io|public\.test)$/.test(u.hostname) ? http.request(new URL(u.href.replace(u.hostname, '127.0.0.1')), { ...o, lookup: undefined }, cb) : http.request(u, o, cb)
  }
})
vi.mock('https', async (orig) => ({
  ...(await orig<typeof import('https')>()),
  request: (u: URL, o: object, cb: (r: IncomingMessage) => void) => httpRequest(new URL(u.href.replace(/^https:/, 'http:')), o, cb)
}))

describe('isBlockedAddress', () => {
  it('iç ağ, loopback, link-local, CGNAT, ULA ve özel amaçlı adresleri engeller', () => {
    for (const a of [
      '127.0.0.1', '10.20.30.40', '10.20.30.1', '172.16.5.4', '192.168.1.45', '169.254.169.254', '100.64.0.1',
      '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1',
      '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1'
    ]) expect(isBlockedAddress(a), a).toBe(true)
  })
  it('genel adreslere izin verir', () => {
    for (const a of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isBlockedAddress(a), a).toBe(false)
    }
  })
  it('IPv4 eşlemeli onaltılık, SIIT, SRv6 ve belge aralıkları engellenir; genel eşlemeli adres geçer', () => {
    for (const a of ['::ffff:7f00:1', '::ffff:a00:1', '::ffff:0:7f00:1', '5f00::1', '3fff::1']) expect(isBlockedAddress(a), a).toBe(true)
    expect(isBlockedAddress('::ffff:808:808')).toBe(false)
    expect(isBlockedAddress('8.8.8.8')).toBe(false)
  })
  it('blocks 2002:7f00:1::', () => expect(isBlockedAddress('2002:7f00:1::')).toBe(true))
  it('blocks ::7f00:1', () => expect(isBlockedAddress('::7f00:1')).toBe(true))
  it('Teredo ve eski site-local aralıkları engellenir', () => {
    expect(isBlockedAddress('2001::1')).toBe(true)
    expect(isBlockedAddress('fec0::1')).toBe(true)
  })
})

describe('safeFetch ağ politikası', () => {
  const open: { close(): void; closeAllConnections(): void }[] = []
  afterEach(() => {
    for (const s of open.splice(0)) {
      s.closeAllConnections()
      s.close()
    }
  })
  const seen: { method: string; url: string; auth: string | undefined; body: string }[] = []
  afterEach(() => void seen.splice(0))
  const serve = async (fn: (q: IncomingMessage, r: ServerResponse) => void): Promise<number> => {
    const listener: RequestListener = (q, r) => {
      const chunks: Buffer[] = []
      q.on('data', (c: Buffer) => chunks.push(c))
      q.on('end', () => {
        seen.push({ method: q.method!, url: q.url!, auth: q.headers.authorization, body: Buffer.concat(chunks).toString() })
        fn(q, r)
      })
    }
    const srv = createServer(listener)
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    open.push(srv)
    return (srv.address() as AddressInfo).port
  }
  const redirect = (to: string, status = 302) => (_q: IncomingMessage, r: ServerResponse) => {
    r.writeHead(status, { location: to })
    r.end()
  }
  const okay = (_q: IncomingMessage, r: ServerResponse) => r.end('ok')
  const hosts = new Set(['localhost', '127.0.0.1'])
  const local = { allowPrivateHosts: hosts, allowedPorts: 'any' as const }
  const auth = { authorization: 'Bearer gizli' }
  const INTERNAL = /ç ağ adresine istek engellendi/

  it('drops authorization on cross-origin redirect', async () => {
    const target = await serve(okay)
    const from = await serve(redirect(`https://b.public.test:${target}/b`))
    const res = await safeFetch(`https://a.public.test:${from}/a`, { headers: auth, allowAnyPort: true })
    expect(res.status).toBe(200)
    expect(seen.map((s) => s.auth)).toEqual(['Bearer gizli', undefined])
  })

  it('Authorization adı büyük harfli olsa da düşer', async () => {
    const target = await serve(okay)
    const from = await serve(redirect(`https://b.public.test:${target}/b`))
    await safeFetch(`https://a.public.test:${from}/a`, { headers: { Authorization: 'Basic x' }, allowAnyPort: true })
    expect(seen[1].auth).toBeUndefined()
  })

  it('aynı kökende authorization kalır', async () => {
    const port = await serve((q, r) => (q.url === '/a' ? redirect('/b')(q, r) : okay(q, r)))
    await safeFetch(`https://a.public.test:${port}/a`, { headers: auth, allowAnyPort: true })
    expect(seen.map((s) => s.auth)).toEqual(['Bearer gizli', 'Bearer gizli'])
  })

  it('github.io sibling loses authorization', async () => {
    const target = await serve(okay)
    const from = await serve(redirect(`https://bob.github.io:${target}/b`))
    await safeFetch(`https://alice.github.io:${from}/a`, { headers: auth, allowAnyPort: true })
    expect(seen.map((s) => s.auth)).toEqual(['Bearer gizli', undefined])
  })

  it('icloud redirect keeps authorization on https only', async () => {
    const icloud = { allowPrivateHosts: 'all' as const, allowedPorts: 'any' as const }
    const port = await serve((q, r) => (q.url === '/a' ? redirect(`https://p52-caldav.icloud.com:${portRef()}/b`)(q, r) : okay(q, r)))
    const portRef = () => port
    await safeFetch(`https://caldav.icloud.com:${port}/a`, { headers: auth, net: icloud })
    expect(seen.map((s) => s.auth)).toEqual(['Bearer gizli', 'Bearer gizli'])
    // hedef https değilse kimlik taşınmaz
    seen.splice(0)
    const plain = await serve((q, r) => (q.url === '/a' ? redirect(`http://p52-caldav.icloud.com:${plainRef()}/b`)(q, r) : okay(q, r)))
    const plainRef = () => plain
    await expect(safeFetch(`https://caldav.icloud.com:${plain}/a`, { headers: auth, net: icloud })).rejects.toThrow(/güvensiz/i)
    expect(seen).toHaveLength(1)
    seen.splice(0)
    // genel adrese düz http üzerinden kimlik hiç gitmez
    await expect(safeFetch(`http://caldav.icloud.com:${plain}/a`, { headers: auth, net: icloud })).rejects.toThrow(/http/i)
    expect(seen).toHaveLength(0)
  })

  it('https to http with auth refused', async () => {
    const target = await serve(okay)
    const from = await serve(redirect(`http://localhost:${target}/b`))
    await expect(safeFetch(`https://localhost:${from}/a`, { headers: auth, net: local })).rejects.toThrow(/güvensiz/i)
    expect(seen).toHaveLength(1)
    // kimliksiz istek için eski davranış: izlenir
    seen.splice(0)
    expect((await safeFetch(`https://localhost:${from}/a`, { net: local })).status).toBe(200)
    expect(seen).toHaveLength(2)
  })

  it('bearer over public http refused', async () => {
    const port = await serve(okay)
    for (const net of [undefined, {}, local]) {
      await expect(safeFetch(`http://a.public.test:${port}/`, { headers: auth, allowAnyPort: true, net })).rejects.toThrow(/http/i)
    }
    await expect(safeFetch(`http://a.public.test:${port}/`, { headers: { authorization: 'Basic x' }, allowAnyPort: true })).rejects.toThrow(/http/i)
    expect(seen).toHaveLength(0)
  })

  it('all does not allow auth over public http', async () => {
    const port = await serve(okay)
    await expect(safeFetch(`http://a.public.test:${port}/`, { headers: auth, net: { allowPrivateHosts: 'all', allowedPorts: 'any' } })).rejects.toThrow(/http/i)
    expect(seen).toHaveLength(0)
  })

  it('all: http kimliği geri döngüye gider', async () => {
    const port = await serve(okay)
    await safeFetch(`http://localhost:${port}/`, { headers: auth, net: { allowPrivateHosts: 'all', allowedPorts: 'any' } })
    expect(seen[0].auth).toBe('Bearer gizli')
  })

  it('listed host http kimliği alır', async () => {
    const port = await serve(okay)
    await safeFetch(`http://localhost:${port}/`, { headers: auth, net: { allowPrivateHosts: new Set([`localhost:${port}`]) } })
    expect(seen[0].auth).toBe('Bearer gizli')
  })

  it('auth dropped on redirect to public http', async () => {
    const target = await serve(okay)
    const from = await serve(redirect(`http://a.public.test:${target}/b`))
    const res = await safeFetch(`http://localhost:${from}/a`, { headers: auth, net: local })
    expect(res.status).toBe(200)
    expect(seen.map((s) => s.auth)).toEqual(['Bearer gizli', undefined])
  })

  for (const status of [301, 302, 307, 308]) {
    it(`PROPFIND keeps method and body across ${status}`, async () => {
      const port = await serve((q, r) => (q.url === '/a' ? redirect('/b', status)(q, r) : okay(q, r)))
      await safeFetch(`http://127.0.0.1:${port}/a`, { method: 'PROPFIND', body: '<x/>', net: local })
      expect(seen.map((s) => [s.method, s.url, s.body])).toEqual([['PROPFIND', '/a', '<x/>'], ['PROPFIND', '/b', '<x/>']])
    })
  }

  it('mevcut POST davranışı: 302 GET olur, gövde düşer', async () => {
    const port = await serve((q, r) => (q.url === '/a' ? redirect('/b')(q, r) : okay(q, r)))
    await safeFetch(`http://127.0.0.1:${port}/a`, { method: 'POST', body: 'x=1', net: local })
    expect(seen.map((s) => [s.method, s.body])).toEqual([['POST', 'x=1'], ['GET', '']])
  })

  it('PROPFIND keeps body on same origin 307', async () => {
    const port = await serve((q, r) => (q.url === '/a' ? redirect(`https://a.public.test:${portRef()}/b`, 307)(q, r) : okay(q, r)))
    const portRef = () => port
    await safeFetch(`https://a.public.test:${port}/a`, { method: 'PROPFIND', body: '<x/>', allowAnyPort: true })
    expect(seen.map((s) => [s.method, s.body])).toEqual([['PROPFIND', '<x/>'], ['PROPFIND', '<x/>']])
  })

  it('body not sent across origin on redirect', async () => {
    const target = await serve(okay)
    for (const [method, status] of [['PUT', 307], ['PROPFIND', 301], ['REPORT', 308], ['POST', 307]] as const) {
      const from = await serve(redirect(`https://b.public.test:${target}/b`, status))
      await expect(safeFetch(`https://a.public.test:${from}/a`, { method, body: 'gizli', allowAnyPort: true })).rejects.toThrow(/gövde/i)
    }
    expect(seen.every((s) => s.url === '/a')).toBe(true)
  })

  it('body icloud alt alanına https ile gider', async () => {
    const port = await serve((q, r) => (q.url === '/a' ? redirect(`https://p52-caldav.icloud.com:${portRef()}/b`, 307)(q, r) : okay(q, r)))
    const portRef = () => port
    await safeFetch(`https://caldav.icloud.com:${port}/a`, { method: 'PUT', body: 'x', net: { allowPrivateHosts: 'all', allowedPorts: 'any' } })
    expect(seen.map((s) => s.body)).toEqual(['x', 'x'])
  })

  it('body refused on https to http', async () => {
    const port = await serve((q, r) => (q.url === '/a' ? redirect(`http://localhost:${portRef()}/b`, 307)(q, r) : okay(q, r)))
    const portRef = () => port
    await expect(safeFetch(`https://localhost:${port}/a`, { method: 'PUT', body: 'gizli', net: local })).rejects.toThrow(/güvensiz/i)
    expect(seen).toHaveLength(1)
  })

  it('tek tık abonelik: POST 302 başka kökene GET olur, gövde gitmez', async () => {
    const target = await serve(okay)
    const from = await serve(redirect(`https://b.public.test:${target}/b`))
    expect((await safeFetch(`https://a.public.test:${from}/a`, { method: 'POST', body: 'List-Unsubscribe=One-Click', allowAnyPort: true })).status).toBe(200)
    expect(seen.map((s) => [s.method, s.body])).toEqual([['POST', 'List-Unsubscribe=One-Click'], ['GET', '']])
  })

  it('allowPrivateHosts only named host', async () => {
    const port = await serve(okay)
    const net = { allowPrivateHosts: new Set(['localhost']), allowedPorts: 'any' as const }
    expect((await safeFetch(`http://localhost:${port}/`, { net })).status).toBe(200)
    await expect(safeFetch(`http://127.0.0.1:${port}/`, { net })).rejects.toThrow(INTERNAL)
    await expect(safeFetch(`http://localhost:${port}/`, { net: { allowPrivateHosts: new Set(['baska']), allowedPorts: 'any' } })).rejects.toThrow(INTERNAL)
    expect(seen).toHaveLength(1)
  })

  it('redirect from allowed to private other host blocked', async () => {
    const target = await serve(okay)
    const from = await serve(redirect(`http://127.0.0.1:${target}/iç`))
    await expect(safeFetch(`http://localhost:${from}/a`, { net: local })).rejects.toThrow(INTERNAL)
    expect(seen).toHaveLength(1)
  })

  it('listed host aynı adda yönlendirme izlenir', async () => {
    const port = await serve((q, r) => (q.url === '/a' ? redirect('/b')(q, r) : okay(q, r)))
    expect((await safeFetch(`http://localhost:${port}/a`, { net: { allowPrivateHosts: new Set(['localhost']), allowedPorts: 'any' } })).status).toBe(200)
    expect(seen).toHaveLength(2)
  })

  it('public redirect to listed private host blocked', async () => {
    const target = await serve(okay)
    const from = await serve(redirect(`http://localhost:${target}/iç`))
    await expect(safeFetch(`http://a.public.test:${from}/a`, { net: local })).rejects.toThrow(INTERNAL)
    expect(seen).toHaveLength(1)
  })

  it('port 5232 blocked by default', async () => {
    await expect(safeFetch('https://dav.example.com:5232/')).rejects.toThrow(/port/)
    await expect(safeFetch('https://dav.example.com:5232/', { net: {} })).rejects.toThrow(/port/)
    await expect(safeFetch('https://dav.example.com:5232/', { net: { allowedPorts: PUBLIC_DAV_PORTS } })).rejects.toThrow(/port/)
  })

  it('listed host wrong port blocked', async () => {
    const port = await serve(okay)
    await expect(safeFetch(`http://localhost:${port}/`, { net: { allowPrivateHosts: new Set(['localhost']), allowedPorts: PUBLIC_DAV_PORTS } })).rejects.toThrow(/port/)
    await expect(safeFetch(`http://localhost:${port}/`, { net: { allowPrivateHosts: new Set(['localhost']) } })).rejects.toThrow(/port/)
    await expect(safeFetch(`http://localhost:${port}/`, { net: { allowPrivateHosts: new Set(['localhost:1']), allowedPorts: PUBLIC_DAV_PORTS } })).rejects.toThrow(/port/)
    expect(seen).toHaveLength(0)
  })

  it('host:port girdisi yalnız o portu açar', async () => {
    const port = await serve(okay)
    expect((await safeFetch(`http://localhost:${port}/`, { net: { allowPrivateHosts: new Set([`localhost:${port}`]), allowedPorts: PUBLIC_DAV_PORTS } })).status).toBe(200)
  })

  it('PUBLIC_DAV_PORTS 80, 443, 8443', () => expect([...PUBLIC_DAV_PORTS].sort()).toEqual([443, 80, 8443].sort()))

  it('desktop ics to private blocked', async () => {
    const port = await serve(okay)
    const net = pimNetPolicy('desktop', null, { ics: true })
    await expect(safeFetch(`http://localhost:${port}/`, { net })).rejects.toThrow(/port/)
    await expect(safeFetch(`http://localhost:${port}/`, { net, allowAnyPort: true })).rejects.toThrow(INTERNAL)
    expect(seen).toHaveLength(0)
  })

  it('desktop dav public to private redirect blocked', async () => {
    const target = await serve(okay)
    const from = await serve(redirect(`http://localhost:${target}/iç`))
    await expect(safeFetch(`http://a.public.test:${from}/a`, { net: pimNetPolicy('desktop', null, { ics: false }) })).rejects.toThrow(INTERNAL)
    expect(seen).toHaveLength(1)
  })

  it('desktop dav direct private host ok', async () => {
    const port = await serve(okay)
    expect((await safeFetch(`http://localhost:${port}/`, { net: pimNetPolicy('desktop', null, { ics: false }) })).status).toBe(200)
    expect((await safeFetch(`http://127.0.0.1:${port}/`, { net: pimNetPolicy('desktop', null, { ics: false }) })).status).toBe(200)
  })

  it('all: zincir aynı iç adda kalabilir, başka iç ada gidemez', async () => {
    const net = pimNetPolicy('desktop', null, { ics: false })
    const same = await serve((req, res) => (req.url === '/a' ? redirect('/b')(req, res) : okay(req, res)))
    expect((await safeFetch(`http://localhost:${same}/a`, { net })).status).toBe(200)
    const target = await serve(okay)
    const from = await serve(redirect(`http://127.0.0.1:${target}/b`))
    await expect(safeFetch(`http://localhost:${from}/a`, { net })).rejects.toThrow(INTERNAL)
  })

  it('genel atlamadan sonra ilk ada dönülemez', async () => {
    const target = await serve(okay)
    const middle = await serve(redirect(`http://localhost:${target}/geri`))
    const first = await serve(redirect(`http://a.public.test:${middle}/ara`))
    const net = { allowPrivateHosts: new Set(['localhost']), allowedPorts: 'any' as const }
    await expect(safeFetch(`http://localhost:${first}/a`, { net })).rejects.toThrow(INTERNAL)
    await expect(safeFetch(`http://localhost:${first}/a`, { net: pimNetPolicy('desktop', null, { ics: false }) })).rejects.toThrow(INTERNAL)
  })

  it('adreste kullanıcı bilgisi her atlamada reddedilir', async () => {
    const port = await serve(okay)
    await expect(safeFetch(`http://kim:parola@a.public.test:${port}/`, { allowAnyPort: true })).rejects.toThrow(t('pim.net.urlCredentials'))
    const from = await serve(redirect(`http://kim:parola@a.public.test:${port}/`))
    await expect(safeFetch(`http://a.public.test:${from}/`, { allowAnyPort: true })).rejects.toThrow(t('pim.net.urlCredentials'))
    expect(seen.filter((r) => r.auth)).toHaveLength(0)
  })

  it('gövdesiz DELETE başka kökene yönlenmez', async () => {
    const port = await serve(okay)
    const from = await serve(redirect(`http://a.public.test:${port}/sil`))
    await expect(safeFetch(`http://a.public.test:${from}/`, { method: 'DELETE', allowAnyPort: true })).rejects.toThrow(t('pim.net.bodyRedirect'))
    expect(seen.filter((r) => r.url === '/sil')).toHaveLength(0)
  })

  it('politikayla açılan soket politikasız istekte yeniden kullanılmaz', async () => {
    const port = await serve(okay)
    await safeFetch(`http://localhost:${port}/`, { net: local })
    await expect(safeFetch(`http://localhost:${port}/`, { allowAnyPort: true })).rejects.toThrow(INTERNAL)
  })

  it('politikasız, kimliksiz istek eskisi gibi lookup kancasından geçer', async () => {
    const port = await serve(okay)
    expect((await safeFetch(`http://a.public.test:${port}/`, { allowAnyPort: true })).status).toBe(200)
    await expect(safeFetch(`http://localhost:${port}/`, { allowAnyPort: true })).rejects.toThrow(INTERNAL)
  })

  it("redirect: 'manual' yönlendirmeyi izlemez", async () => {
    const port = await serve(redirect('/b'))
    const res = await safeFetch(`http://127.0.0.1:${port}/a`, { redirect: 'manual', net: local })
    expect(res.status).toBe(302)
    expect(seen).toHaveLength(1)
  })
})
