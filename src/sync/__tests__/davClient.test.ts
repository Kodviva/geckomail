import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configFromEnv } from '../../server/config'
import { PUBLIC_DAV_PORTS } from '../net/safeFetch'
import { DavAuthError, DavClient, pimNetPolicy, type DavAuth } from '../pim/davClient'
import { FakeDav } from './helpers/fakeDav'

// Genel adın gerçek DNS'i testte sorulmaz
vi.mock('dns', async (orig) => {
  const dns = await orig<typeof import('dns')>()
  return {
    ...dns,
    lookup: (host: string, o: object, cb: (...a: unknown[]) => void) =>
      host.endsWith('.example.com') ? cb(null, [{ address: '8.8.8.8', family: 4 }]) : dns.lookup(host, o as never, cb as never)
  }
})

const fixture = (n: string): string => readFileSync(join(__dirname, 'fixtures', 'dav', `${n}.xml`), 'utf8')
const NET = { allowPrivateHosts: new Set(['127.0.0.1']), allowedPorts: 'any' as const }
const basic: DavAuth = { header: async () => 'Basic dTpw' }

describe('DavClient', () => {
  let dav: FakeDav
  let client: DavClient
  const XML = { 'content-type': 'application/xml' }

  beforeEach(async () => {
    dav = await FakeDav.start()
    client = new DavClient({ auth: { header: async () => null }, net: NET })
  })
  afterEach(() => dav.close())

  describe('parses namespaced multistatus', () => {
    for (const name of ['stalwart', 'radicale', 'google', 'sabre']) {
      it(name, async () => {
        dav.override('PROPFIND', '/dav/cal/is/', { status: 207, headers: XML, body: fixture(name) })
        const list = await client.propfind(`${dav.url}/dav/cal/is/`, 1, ['displayname', 'resourcetype', 'getctag', 'sync-token', 'calendar-color', 'getetag'])
        expect(list).toHaveLength(2)
        expect(list[0]).toMatchObject({
          href: '/dav/cal/is/', displayName: 'İş & Toplantı', ctag: 'ctag-1', syncToken: 'http://example.test/ns/sync/7', color: '#FF0000FF'
        })
        expect(list[0].resourceTypes).toEqual(expect.arrayContaining(['collection', 'calendar']))
        expect(list[1]).toMatchObject({ href: '/dav/cal/is/a.ics', etag: '"e1"', resourceTypes: [] })
      })
    }
  })

  it('PROPFIND gövdesi istenen özellikleri ve Depth başlığını taşır', async () => {
    await client.propfind(`${dav.url}/x/`, 0, ['displayname', 'calendar-home-set'])
    const r = dav.requests[0]
    expect(r.method).toBe('PROPFIND')
    expect(r.headers.depth).toBe('0')
    expect(r.body).toMatch(/displayname/)
    expect(r.body).toMatch(/calendar-home-set/)
  })

  describe('sync token invalid returns token-invalid', () => {
    for (const status of [403, 409]) {
      it(String(status), async () => {
        dav.override('REPORT', '/c/', { status, headers: XML, body: '<D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>' })
        expect(await client.syncCollection(`${dav.url}/c/`, 'eski')).toBe('token-invalid')
      })
    }
  })

  it('sync desteklenmiyorsa unsupported', async () => {
    dav.override('REPORT', '/c/', { status: 501 })
    expect(await client.syncCollection(`${dav.url}/c/`, null)).toBe('unsupported')
    dav.override('REPORT', '/c/', { status: 403, headers: XML, body: '<D:error xmlns:D="DAV:"><D:supported-report/></D:error>' })
    expect(await client.syncCollection(`${dav.url}/c/`, null)).toBe('unsupported')
  })

  it('sync akışı: değişen, silinen ve yeni belirteç', async () => {
    dav.seed('/c/a.ics', 'A')
    const b = dav.seed('/c/b.ics', 'B')
    const first = await client.syncCollection(`${dav.url}/c/`, null)
    if (typeof first === 'string') throw new Error(first)
    expect(first.changed).toHaveLength(2)
    expect(first.truncated).toBe(false)
    dav.drop('/c/a.ics')
    const next = await client.syncCollection(`${dav.url}/c/`, first.token)
    if (typeof next === 'string') throw new Error(next)
    expect(next).toMatchObject({ changed: [], removed: ['/c/a.ics'], token: dav.token })
    expect(first.changed).toContainEqual({ href: '/c/b.ics', etag: b })
  })

  it('507 marks truncated', async () => {
    dav.override('REPORT', '/c/', {
      status: 207, headers: XML,
      body: `<D:multistatus xmlns:D="DAV:">
        <D:response><D:href>/c/a.ics</D:href><D:propstat><D:prop><D:getetag>"1"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
        <D:response><D:href>/c/</D:href><D:status>HTTP/1.1 507 Insufficient Storage</D:status></D:response>
        <D:sync-token>t2</D:sync-token></D:multistatus>`
    })
    expect(await client.syncCollection(`${dav.url}/c/`, 't1')).toEqual({ changed: [{ href: '/c/a.ics', etag: '"1"' }], removed: [], token: 't2', truncated: true })
  })

  it('404 in sync means removed', async () => {
    dav.override('REPORT', '/c/', {
      status: 207, headers: XML,
      body: `<multistatus xmlns="DAV:"><response><href>/c/gone.ics</href><status>HTTP/1.1 404 Not Found</status></response><sync-token>t9</sync-token></multistatus>`
    })
    expect(await client.syncCollection(`${dav.url}/c/`, 't8')).toEqual({ changed: [], removed: ['/c/gone.ics'], token: 't9', truncated: false })
  })

  it('multiget kalanı döner, olmayanı atlar', async () => {
    dav.seed('/c/a.ics', 'BEGIN:VCALENDAR & <x>')
    const list = await client.multiget(`${dav.url}/c/`, 'calendar', ['/c/a.ics', '/c/yok.ics'])
    expect(list).toEqual([{ href: '/c/a.ics', etag: dav.objects.get('/c/a.ics')!.etag, data: 'BEGIN:VCALENDAR & <x>' }])
    expect(dav.requests.at(-1)!.body).toMatch(/calendar-multiget/)
    dav.seed('/k/a.vcf', 'BEGIN:VCARD')
    expect(await client.multiget(`${dav.url}/k/`, 'addressbook', ['/k/a.vcf'])).toHaveLength(1)
    expect(dav.requests.at(-1)!.body).toMatch(/addressbook-multiget/)
    expect(await client.multiget(`${dav.url}/k/`, 'addressbook', [])).toEqual([])
  })

  it('options DAV ve Allow başlıklarını ayrıştırır', async () => {
    expect(await client.options(`${dav.url}/`)).toEqual({
      dav: ['1', '3', 'calendar-access', 'addressbook'], allow: ['OPTIONS', 'GET', 'PUT', 'DELETE', 'PROPFIND', 'REPORT']
    })
  })

  it('get: var olan nesne ve 404', async () => {
    const etag = dav.seed('/c/a.ics', 'X')
    expect(await client.get(`${dav.url}/c/a.ics`)).toEqual({ href: `${dav.url}/c/a.ics`, etag, data: 'X' })
    expect(await client.get(`${dav.url}/c/yok.ics`)).toBeNull()
  })

  it('put 412 returns conflict', async () => {
    dav.seed('/c/a.ics', 'X')
    expect(await client.put(`${dav.url}/c/a.ics`, 'Y', 'text/calendar', { ifMatch: '"baska"' })).toBe('conflict')
    expect(await client.put(`${dav.url}/c/a.ics`, 'Y', 'text/calendar', { ifNoneMatch: '*' })).toBe('conflict')
    expect(dav.objects.get('/c/a.ics')!.data).toBe('X')
  })

  it('put başlıkları ve dönen etag', async () => {
    const res = await client.put(`${dav.url}/c/n.ics`, 'Y', 'text/calendar; charset=utf-8', { ifNoneMatch: '*' })
    expect(res).toEqual({ etag: dav.objects.get('/c/n.ics')!.etag })
    expect(dav.requests[0].headers['if-none-match']).toBe('*')
    expect(dav.requests[0].headers['content-type']).toBe('text/calendar; charset=utf-8')
  })

  it('put without etag header returns null etag', async () => {
    dav.override('PUT', '/c/n.ics', { status: 201 })
    expect(await client.put(`${dav.url}/c/n.ics`, 'Y', 'text/calendar', {})).toEqual({ etag: null })
  })

  it('delete: ok, gone, conflict', async () => {
    const etag = dav.seed('/c/a.ics', 'X')
    expect(await client.delete(`${dav.url}/c/a.ics`, '"eski"')).toBe('conflict')
    expect(await client.delete(`${dav.url}/c/a.ics`, etag)).toBe('ok')
    expect(await client.delete(`${dav.url}/c/a.ics`)).toBe('gone')
  })

  it('CDATA içindeki DOCTYPE metni yanıtı düşürmez', async () => {
    const body = '<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/c/</href><propstat><prop><displayname><![CDATA[<!DOCTYPE x>]]></displayname></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>'
    dav.override('PROPFIND', '/c/', { status: 207, headers: XML, body })
    expect((await client.propfind(`${dav.url}/c/`, 0, ['displayname']))[0].displayName).toBe('<!DOCTYPE x>')
    dav.override('PROPFIND', '/c/', { status: 207, headers: XML, body: `<![CDATA[x]]>${'<!DOCTYPE y>'}<multistatus xmlns="DAV:"/>` })
    await expect(client.propfind(`${dav.url}/c/`, 0, ['displayname'])).rejects.toThrow(/XML/)
  })

  it('doctype rejected', async () => {
    dav.override('PROPFIND', '/c/', { status: 207, headers: XML, body: '<?xml version="1.0"?><!DOCTYPE lol [<!ENTITY a "b">]><multistatus xmlns="DAV:"/>' })
    await expect(client.propfind(`${dav.url}/c/`, 0, ['displayname'])).rejects.toThrow(/XML/)
    dav.override('PROPFIND', '/c/', { status: 207, headers: XML, body: '<!dOcTyPe x><multistatus xmlns="DAV:"/>' })
    await expect(client.propfind(`${dav.url}/c/`, 0, ['displayname'])).rejects.toThrow(/XML/)
  })

  it('bozuk XML hata verir, kilitlenmez', async () => {
    dav.override('PROPFIND', '/c/', { status: 207, headers: XML, body: '<multistatus xmlns="DAV:"><response>' })
    await expect(client.propfind(`${dav.url}/c/`, 0, ['displayname'])).rejects.toThrow(/XML/)
  })

  it('bearer refreshed once on 401', async () => {
    dav.accept = ['Bearer yeni']
    const forced: (boolean | undefined)[] = []
    const auth: DavAuth = { header: async (force) => (forced.push(force), force ? 'Bearer yeni' : 'Bearer eski') }
    const c = new DavClient({ auth, net: NET })
    await c.propfind(`${dav.url}/c/`, 0, ['displayname'])
    expect(forced).toEqual([undefined, true])
    expect(dav.requests).toHaveLength(2)
  })

  it('bearer ikinci 401de durur', async () => {
    dav.accept = ['Bearer hic']
    const c = new DavClient({ auth: { header: async () => 'Bearer x' }, net: NET })
    await expect(c.propfind(`${dav.url}/c/`, 0, ['displayname'])).rejects.toBeInstanceOf(DavAuthError)
    expect(dav.requests).toHaveLength(2)
  })

  it('basic 401 throws without retry', async () => {
    dav.accept = ['Basic baska']
    let calls = 0
    const c = new DavClient({ auth: { header: async () => (calls++, 'Basic dTpw') }, net: NET })
    const err = await c.propfind(`${dav.url}/c/`, 0, ['displayname']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DavAuthError)
    expect((err as DavAuthError).status).toBe(401)
    expect(calls).toBe(1)
    expect(dav.requests).toHaveLength(1)
  })

  it('403 DavAuthError', async () => {
    dav.override('PROPFIND', '/c/', { status: 403 })
    const err = await client.propfind(`${dav.url}/c/`, 0, ['displayname']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DavAuthError)
    expect((err as DavAuthError).status).toBe(403)
  })

  it('basic over public http refused', async () => {
    const pub = new DavClient({ auth: basic, net: {} })
    await expect(pub.propfind('http://dav.example.com/c/', 0, ['displayname'])).rejects.toThrow(/http/i)
    // adı listede olmayan özel adres de reddedilir, istek hiç gitmez
    const other = new DavClient({ auth: basic, net: { allowPrivateHosts: new Set(['baska']), allowedPorts: 'any' } })
    await expect(other.propfind(`${dav.url}/c/`, 0, ['displayname'])).rejects.toThrow()
    expect(dav.requests).toHaveLength(0)
    // izinli ad çalışır
    await new DavClient({ auth: basic, net: NET }).propfind(`${dav.url}/c/`, 0, ['displayname'])
    expect(dav.requests[0].headers.authorization).toBe('Basic dTpw')
  })

  it('bearer de genel httpde gönderilmez', async () => {
    const c = new DavClient({ auth: { header: async () => 'Bearer x' }, net: { allowPrivateHosts: 'all', allowedPorts: 'any' } })
    await expect(c.propfind('http://dav.example.com/c/', 0, ['displayname'])).rejects.toThrow(/http/i)
  })

  it('sunucu hatası DavHttpError olur', async () => {
    dav.override('PROPFIND', '/c/', { status: 500 })
    await expect(client.propfind(`${dav.url}/c/`, 0, ['displayname'])).rejects.toMatchObject({ status: 500 })
  })
})

describe('pimNetPolicy', () => {
  it('masaüstü DAV doğrudan adreste açık', () => {
    expect(pimNetPolicy('desktop', null, { ics: false })).toEqual({ allowPrivateHosts: 'all', allowedPorts: 'any' })
  })
  it('sunucu DAV yalnız listedeki adlar ve genel DAV portları', () => {
    const p = pimNetPolicy('server', { davPrivateHosts: ['dav.ic'] }, { ics: false })
    expect(p.allowedPorts).toBe(PUBLIC_DAV_PORTS)
    expect([...(p.allowPrivateHosts as Set<string>)]).toEqual(['dav.ic'])
  })
  it('ICS hiçbir yerde istisna almaz', () => {
    expect(pimNetPolicy('server', { davPrivateHosts: ['dav.ic'] }, { ics: true })).toEqual({})
    expect(pimNetPolicy('desktop', null, { ics: true })).toEqual({})
  })
})

describe('GECKO_DAV_PRIVATE_HOSTS', () => {
  const base = { GECKO_PUBLIC_ORIGIN: 'https://posta.example.com' }
  it('virgüllü liste küçük harfe iner, boşluk ve boş öğe atılır', () => {
    expect(configFromEnv({ ...base, GECKO_DAV_PRIVATE_HOSTS: ' Dav.Local , ,radicale ' }).davPrivateHosts).toEqual(['dav.local', 'radicale'])
  })
  it('tanımsızsa boş', () => expect(configFromEnv(base).davPrivateHosts).toEqual([]))
  it('host:port kabul edilir', () => {
    expect(configFromEnv({ ...base, GECKO_DAV_PRIVATE_HOSTS: 'Dav.Local:5232,radicale' }).davPrivateHosts).toEqual(['dav.local:5232', 'radicale'])
  })
  it('ad olmayan değer ve geçersiz port reddedilir', () => {
    for (const v of ['http://x/', 'x:0', 'x:70000', 'x:']) expect(() => configFromEnv({ ...base, GECKO_DAV_PRIVATE_HOSTS: v }), v).toThrow('GECKO_DAV_PRIVATE_HOSTS')
  })
})
