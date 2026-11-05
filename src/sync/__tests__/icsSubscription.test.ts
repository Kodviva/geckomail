import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'http'
import type { AddressInfo } from 'net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { EventOccurrence, PimSourceInfo } from '../../shared/pim'
import { syncBatch } from '../pim/apply'
import { pimNetPolicy } from '../pim/davClient'
import { normalizeFeedUrl } from '../pim/icsBackend'
import { calendarHandlers as h } from '../rpc/calendar'
import { pimSourcesHandlers } from '../rpc/pimSources'
import { buildGateWorker, hangingWorker, removeGateWorkers } from './helpers/gateWorker'
import { pimHarness, type PimHarness } from './helpers/pimHarness'

const FROM = Date.UTC(2027, 0, 1)
const TO = Date.UTC(2027, 1, 1)
const event = (uid: string): string => ['BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z', 'DTSTART:20270105T100000Z', 'DTEND:20270105T110000Z', `SUMMARY:${uid}`, 'END:VEVENT'].join('\r\n')
const feed = (...uids: string[]): string => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN', ...uids.map(event), 'END:VCALENDAR', ''].join('\r\n')

describe('iCal aboneliği', () => {
  let worker: string
  let t: PimHarness
  let srv: Server
  let base: string
  let hits: IncomingMessage[]
  let reply: (q: IncomingMessage, r: ServerResponse) => void
  
  beforeAll(() => {
    worker = buildGateWorker()
  })
  afterAll(removeGateWorkers)
  beforeEach(async () => {
    t = await pimHarness(worker)
    hits = []
    reply = (_q, r) => r.writeHead(200, { etag: '"v1"', 'content-type': 'text/calendar' }).end(feed('a', 'b'))
    srv = createServer((q, r) => {
      hits.push(q)
      reply(q, r)
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    srv.closeAllConnections()
    await new Promise((r) => srv.close(r))
    await t.close()
  })

  const add = (url = `${base}/gizli-belirtec.ics`, user = t.viewer) => h.addIcsSubscription(t.session(user), { url, name: 'Tatiller', color: '#123456' }) as Promise<{ sourceId: number }>
  const titles = async (user = t.viewer): Promise<string[]> => ((await h.listEvents(t.session(user), { from: FROM, to: TO, tz: 'UTC' })) as EventOccurrence[]).map((o) => o.title).sort()
  const again = async (sourceId: number): Promise<void> => {
    t.db.prepare(`UPDATE pim_sources SET next_sync_at = 0 WHERE id = ?`).run(sourceId)
    await t.hub.pim.syncNow(sourceId)
  }
  const row = (id: number) => t.q.getPimSource(id)!

  it('abonelik salt okunur, olaylar yalnız sahibine görünür', async () => {
    const { sourceId } = await add()
    await again(sourceId)
    expect(await titles()).toEqual(['a', 'b'])
    expect(await titles(t.admin)).toEqual([])
    const cols = await pimSourcesHandlers.listPimCollections(t.session(t.viewer), { type: 'calendar' }) as { sourceId: number; readOnly: boolean; canWrite: boolean; name: string; color: string }[]
    expect(cols.find((c) => c.sourceId === sourceId)).toMatchObject({ readOnly: true, canWrite: false, name: 'Tatiller', color: '#123456' })
  })

  it('webcal normalized', () => {
    expect(normalizeFeedUrl('webcal://takvim.example.com/a.ics')).toBe('https://takvim.example.com/a.ics')
    expect(normalizeFeedUrl('WEBCALS://x.example.com/a')).toBe('https://x.example.com/a')
    expect(normalizeFeedUrl('https://x.example.com/a')).toBe('https://x.example.com/a')
    expect(() => normalizeFeedUrl('ftp://x.example.com/a')).toThrow()
    expect(() => normalizeFeedUrl('https://k:p@x.example.com/a')).toThrow()
  })

  it('304 keeps data', async () => {
    const { sourceId } = await add()
    await again(sourceId)
    reply = (q, r) => {
      expect(q.headers['if-none-match']).toBe('"v1"')
      r.writeHead(304).end()
    }
    await again(sourceId)
    expect(await titles()).toEqual(['a', 'b'])
    expect(row(sourceId).status).toBe('ok')
  })

  it('değişen akış eskileri siler', async () => {
    const { sourceId } = await add()
    await again(sourceId)
    reply = (_q, r) => r.writeHead(200, { etag: '"v2"' }).end(feed('b', 'c'))
    await again(sourceId)
    expect(await titles()).toEqual(['b', 'c'])
    expect(row(sourceId).ics_etag).toBe('"v2"')
  })

  it('subscription redirect to internal blocked', async () => {
    t.hub.deps.pimNet = () => ({ allowPrivateHosts: new Set(['127.0.0.1']), allowedPorts: 'any' })
    reply = (q, r) => (q.url === '/ic' ? r.writeHead(200).end(feed('gizli')) : r.writeHead(302, { location: `${base.replace('127.0.0.1', 'localhost')}/ic` }).end())
    await expect(add()).rejects.toThrow()
    expect(hits.map((q) => q.url)).toEqual(['/gizli-belirtec.ics'])
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM pim_sources WHERE kind = 'ics'`).get()).toEqual({ n: 0 })
  })

  it('private ip rejected in server mode', async () => {
    t.hub.deps.pimNet = (o) => pimNetPolicy('server', { davPrivateHosts: ['127.0.0.1'] }, o)
    await expect(add()).rejects.toThrow()
    expect(hits).toEqual([])
  })

  it('oversized feed keeps old events', async () => {
    const { sourceId } = await add()
    await again(sourceId)
    reply = (_q, r) => r.writeHead(200).end('x'.repeat(5_000_100))
    await again(sourceId)
    expect(row(sourceId).status).toBe('error')
    expect(await titles()).toEqual(['a', 'b'])
  })

  it('empty feed keeps old events', async () => {
    const { sourceId } = await add()
    await again(sourceId)
    for (const body of [feed(), '<html>bakım</html>']) {
      reply = (_q, r) => r.writeHead(200).end(body)
      await again(sourceId)
      expect(row(sourceId).status).toBe('error')
      expect(await titles()).toEqual(['a', 'b'])
    }
  })

  it('sunucu hatası eski veriyi korur, sonra düzelir', async () => {
    const { sourceId } = await add()
    await again(sourceId)
    reply = (_q, r) => r.writeHead(500).end()
    await again(sourceId)
    expect(row(sourceId)).toMatchObject({ status: 'error', fail_count: 1 })
    reply = (_q, r) => r.writeHead(200).end(feed('a'))
    await again(sourceId)
    expect(row(sourceId).status).toBe('ok')
  })

  it('url not returned by listPimSources', async () => {
    const { sourceId } = await add()
    const list = (await pimSourcesHandlers.listPimSources(t.session(t.viewer), {})) as PimSourceInfo[]
    expect(JSON.stringify(list)).not.toContain('gizli-belirtec')
    expect(list.find((s) => s.id === sourceId)).toMatchObject({ kind: 'ics', label: '127.0.0.1', personal: true })
    expect(row(sourceId).ics_url_enc!.toString()).toBe(`enc:${base}/gizli-belirtec.ics`)
    expect(row(sourceId).caldav_url).toBeNull()
  })

  it('limit 50 per user', async () => {
    for (let i = 0; i < 50; i++) await add(`${base}/${i}.ics`)
    await expect(add(`${base}/son.ics`)).rejects.toThrow()
    await expect(add(`${base}/baska.ics`, t.manager)).resolves.toMatchObject({ sourceId: expect.any(Number) })
  })

  it('takılan nesne ertelenince akış doğrulayıcısı saklanmaz', async () => {
    const { sourceId } = await add()
    const c = t.q.listPimCollectionsByType('calendar').find((x) => x.source_id === sourceId)!
    const batch = syncBatch({ ...t.hub.pimDeps(), gateWorker: hangingWorker() }, c)
    batch.sink.replaceAll(Array.from({ length: 7 }, (_, i) => ({ remoteId: `h${i}`, etag: null, data: `BEGIN:VCALENDAR\r\nUID:h${i}\r\nHANG\r\n` })))
    batch.sink.setState({ feedEtag: '"yeni"', feedLastModified: null })
    await expect(batch.commit()).rejects.toThrow()
    expect(row(sourceId).ics_etag).not.toBe('"yeni"')
  }, 15_000)
})
