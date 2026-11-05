import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetPolicy } from '../net/safeFetch'
import { pimNetPolicy, type DavAuth } from '../pim/davClient'
import { discoverDav, discoverGoogle, googleDavUrls, hostTrusted, passwordAllowed } from '../pim/discovery'
import { FakeDav } from './helpers/fakeDav'

const HEADER = 'Basic dTpw'
const basic: DavAuth = { header: async () => HEADER }
const net = (...hosts: string[]): NetPolicy => ({ allowPrivateHosts: new Set(hosts), allowedPorts: 'any' })
const hostOf = (d: FakeDav): string => new URL(d.url).host
const authed = (d: FakeDav): number => d.requests.filter((r) => r.headers.authorization).length
const noSrv = (async () => []) as never

describe('DAV keşfi', () => {
  let dav: FakeDav
  let other: FakeDav

  beforeEach(async () => {
    dav = await FakeDav.start()
    other = await FakeDav.start()
    for (const d of [dav, other]) {
      d.accept = [HEADER]
      d.homes = { principal: '/dav/pal/a/', calendar: '/dav/cal/a/', addressbook: '/dav/card/a/' }
    }
  })
  afterEach(async () => {
    await dav.close()
    await other.close()
  })

  const run = (over: Partial<Parameters<typeof discoverDav>[0]> = {}) =>
    discoverDav({ hostHints: [hostOf(dav)], auth: basic, basic: true, net: net(hostOf(dav), hostOf(other)), scheme: 'http', resolveSrv: noSrv, ...over })

  it('stalwart well-known 307', async () => {
    dav.override('PROPFIND', '/.well-known/caldav', { status: 307, headers: { location: '/dav/cal' } })
    dav.override('PROPFIND', '/.well-known/caldav', { status: 307, headers: { location: '/dav/cal' } })
    const r = await run()
    expect(r).toMatchObject({ caldavHome: `${dav.url}/dav/cal/a/`, carddavHome: `${dav.url}/dav/card/a/`, principal: `${dav.url}/dav/pal/a/` })
  })

  it('falls back to /dav/cal when well-known proxied away', async () => {
    dav.override('PROPFIND', '/.well-known/caldav', { status: 404 })
    dav.override('PROPFIND', '/.well-known/carddav', { status: 200, body: '<html>posta</html>' })
    const r = await run()
    expect(r.caldavHome).toBe(`${dav.url}/dav/cal/a/`)
    expect(r.carddavHome).toBe(`${dav.url}/dav/card/a/`)
    expect(dav.requests.some((q) => q.path === '/dav/cal' && q.headers.authorization)).toBe(true)
    // ön istek yanıt vermeyen adaya parola gitmez
    expect(dav.requests.filter((q) => q.path === '/.well-known/caldav' && q.headers.authorization)).toHaveLength(0)
  })

  it('I9 posta düzeni dışındaki SRV hedefine parola gitmez, onaylanınca gider', async () => {
    const srv = (async () => [{ name: 'localhost.', port: Number(new URL(other.url).port), priority: 0, weight: 0 }]) as never
    const hints = [hostOf(dav)]
    dav.override('PROPFIND', '/.well-known/caldav', { status: 404 })
    const blocked = await discoverDav({ email: 'a@firma.invalid', hostHints: [], auth: basic, basic: true, net: { allowPrivateHosts: 'all', allowedPorts: 'any' }, scheme: 'http', resolveSrv: srv })
    expect(blocked).toMatchObject({ caldavHome: null, confirmHost: 'localhost' })
    expect(authed(other)).toBe(0)
    expect(hints).toHaveLength(1)
    const ok = await discoverDav({ email: 'a@firma.invalid', hostHints: [], confirmedHost: 'localhost', auth: basic, basic: true, net: { allowPrivateHosts: 'all', allowedPorts: 'any' }, scheme: 'http', resolveSrv: srv })
    expect(ok.caldavHome).toContain('/dav/cal/a/')
    expect(authed(other)).toBeGreaterThan(0)
  })

  it('I9 alan adı altındaki ana makine ve imap adı güvenilir', () => {
    expect(hostTrusted('https://dav.firma.example/x', { email: 'a@firma.example' })).toBe(true)
    expect(hostTrusted('https://firma.example.evil.test/', { email: 'a@firma.example' })).toBe(false)
    expect(hostTrusted('https://mx.host.test:8443/', { email: 'a@firma.example', hostHints: ['MX.host.test'] })).toBe(true)
  })

  it('srv preferred', async () => {
    const resolveSrv = vi.fn(async (name: string) => [
      { name: `${new URL(other.url).hostname}.`, port: Number(new URL(other.url).port), priority: 0, weight: 0 },
      { name: 'yedek.example.com', port: 443, priority: 5, weight: 0 }
    ].filter(() => name.startsWith('_caldavs') || name.startsWith('_carddavs')))
    const r = await run({ email: 'a@firma.example.com', resolveSrv: resolveSrv as never })
    expect(resolveSrv).toHaveBeenCalledWith('_caldavs._tcp.firma.example.com')
    expect(r.caldavHome).toBe(`${other.url}/dav/cal/a/`)
    expect(dav.requests).toHaveLength(0)
  })

  it('password only after Basic challenge on https', async () => {
    await run()
    const first = dav.requests[0]
    expect(first.headers.authorization).toBeUndefined()
    expect(dav.requests.slice(1).some((r) => r.headers.authorization === HEADER)).toBe(true)
    expect(passwordAllowed('https://posta.example.com/', {})).toBe(true)
    expect(passwordAllowed('http://posta.example.com/', {})).toBe(false)
    expect(passwordAllowed('http://posta.example.com/', net('baska.example.com'))).toBe(false)
    expect(passwordAllowed('http://posta.example.com:8080/', net('posta.example.com:8080'))).toBe(true)
  })

  it('Basic istemeyen sunucuya parola gitmez', async () => {
    dav.challenge = 'Bearer realm="x"'
    expect(await run()).toMatchObject({ caldavHome: null, carddavHome: null })
    expect(authed(dav)).toBe(0)
    dav.challenge = 'Negotiate, Basic realm="x"'
    dav.requests.length = 0
    expect((await run()).caldavHome).toBe(`${dav.url}/dav/cal/a/`)
  })

  it('401 stops discovery, next host gets no password', async () => {
    dav.accept = ['Basic baska']
    await expect(run({ hostHints: [hostOf(dav), hostOf(other)] })).rejects.toThrow()
    expect(authed(dav)).toBe(1)
    expect(other.requests).toHaveLength(0)
  })

  it('google urls', () => {
    expect(googleDavUrls('kisi+x@gmail.com')).toEqual({
      caldav: 'https://apidata.googleusercontent.com/caldav/v2/kisi%2Bx%40gmail.com/user', carddav: 'https://www.googleapis.com/.well-known/carddav'
    })
  })

  it('auto-schedule detected', async () => {
    expect((await run()).serverSchedules).toBe(false)
    dav.davExtra = ', calendar-auto-schedule'
    expect((await run()).serverSchedules).toBe(true)
  })

  it('private host blocked in server mode', async () => {
    const r = await discoverDav({ url: `${dav.url}/dav/`, auth: basic, basic: true, net: pimNetPolicy('server', null, { ics: false }) })
    expect(r).toMatchObject({ caldavHome: null, carddavHome: null })
    expect(dav.requests).toHaveLength(0)
  })

  it('elle verilen adres önce denenir', async () => {
    dav.override('PROPFIND', '/benim/', { status: 401, headers: { 'www-authenticate': 'Basic realm="x"' } })
    const r = await discoverDav({ url: `${dav.url}/benim/`, auth: basic, basic: true, net: net(hostOf(dav)) })
    expect(r.caldavHome).toBe(`${dav.url}/dav/cal/a/`)
    expect(dav.requests[0].path).toBe('/benim/')
  })

  it('sunucunun bildirdiği başka köken kimliği taşımaz', async () => {
    dav.homes = { principal: `${other.url}/pal/`, calendar: `${other.url}/cal/`, addressbook: `${other.url}/card/` }
    expect(await run()).toMatchObject({ caldavHome: null, carddavHome: null })
    expect(other.requests).toHaveLength(0)
  })

  it('kimlikli OAuth keşfinde ön istek yok, kimlik reddi fırlar', async () => {
    const bearer: DavAuth = { header: async () => 'Bearer x' }
    dav.accept = ['Bearer x']
    expect((await discoverDav({ url: `${dav.url}/`, auth: bearer, basic: false, net: net(hostOf(dav)) })).caldavHome).toBeTruthy()
    expect(dav.requests[0].headers.authorization).toBe('Bearer x')
  })

  it('Google: kapsam reddi fırlar, bağlanmaz', async () => {
    await expect(discoverGoogle('a@gmail.com', { header: async () => null }, { allowPrivateHosts: new Set(['nowhere']) })).rejects.toThrow()
  }, 20_000)
})
