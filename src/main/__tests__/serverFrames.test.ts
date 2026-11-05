// Sunucu kullanıcı denetiminde bir sistem değildir: her çerçeve düşmandır. Ana süreç düşmez, bildirim alanları sınırdan temiz geçer.
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import { parseServerNotify, ServerLink } from '../serverLink'

const good = { title: 'T', body: 'B', accountId: 3, messageId: 7, level: 'normal', tag: 't', count: 1, actions: ['read', 'reply'], seq: 1 }

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('koşul gerçekleşmedi')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('parseServerNotify', () => {
  it('temiz bildirim aynen geçer', () => {
    expect(parseServerNotify(good)).toEqual(good)
  })
  it('kimlik yalnız güvenli tam sayı ya da null', () => {
    for (const bad of ['1"/><action content="x"/>', 1.5, -1, Number.MAX_SAFE_INTEGER + 1, {}, [1], NaN]) {
      expect(parseServerNotify({ ...good, messageId: bad })).toBeNull()
      expect(parseServerNotify({ ...good, accountId: bad })).toBeNull()
    }
    expect(parseServerNotify({ ...good, messageId: null, accountId: null })).toMatchObject({ messageId: null, accountId: null })
  })
  it('eylemler izin listesine süzülür, yinelenen düşer', () => {
    expect(parseServerNotify({ ...good, actions: ['read', 'read', 'gecko:read" activationType="protocol', 1, 'archive'] })?.actions).toEqual(['read', 'archive'])
    expect(parseServerNotify({ ...good, actions: 'read' })?.actions).toEqual([])
    expect(parseServerNotify({ ...good, actions: undefined })?.actions).toEqual([])
  })
  it('metin türü ve uzunluğu sınırlı', () => {
    expect(parseServerNotify({ ...good, title: 5 })).toBeNull()
    expect(parseServerNotify({ ...good, body: null })).toBeNull()
    expect(parseServerNotify({ ...good, tag: {} })).toBeNull()
    const long = parseServerNotify({ ...good, title: 'a'.repeat(100_000), body: 'b'.repeat(100_000), tag: 'c'.repeat(100_000) })!
    expect(long.title.length).toBeLessThanOrEqual(512)
    expect(long.body.length).toBeLessThanOrEqual(4096)
    expect(long.tag.length).toBeLessThanOrEqual(256)
  })
  it('seviye, sıra ve kötü biçim', () => {
    expect(parseServerNotify({ ...good, level: 'x' })).toBeNull()
    expect(parseServerNotify({ ...good, seq: 'x' })).toBeNull()
    for (const bad of [null, undefined, 5, 'x', []]) expect(parseServerNotify(bad)).toBeNull()
  })
})

describe('düşman çerçeveler', () => {
  let wss: WebSocketServer
  let http: ReturnType<typeof createServer>
  let peer: ServerSocket | null = null
  let backlog: unknown = { items: [], lastSeq: 0, truncated: false }
  let link: ServerLink | null = null
  const events: [string, unknown][] = []
  const of = (name: string) => events.filter(([e]) => e === name).map(([, d]) => d)

  beforeEach(async () => {
    events.length = 0
    backlog = { items: [], lastSeq: 0, truncated: false }
    http = createServer()
    wss = new WebSocketServer({ server: http })
    wss.on('connection', (ws) => {
      peer = ws
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as { id: number; method: string }
        ws.send(JSON.stringify({ id: m.id, ok: true, result: m.method === 'notifyBacklog' ? backlog : { id: 1 } }))
      })
    })
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  })
  afterEach(async () => {
    link?.stop()
    peer?.terminate()
    wss.close()
    await new Promise((r) => http.close(r))
  })

  const start = async (o: Partial<ConstructorParameters<typeof ServerLink>[0]> = {}): Promise<void> => {
    link = new ServerLink({
      origin: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, cookie: async () => 'c', userAgent: 'test', deviceId: 'd', label: 'l',
      onState() {}, onEvent: (e, d) => events.push([e, d]), ...o
    })
    link.start()
    await until(() => of('agent:ready').length === 1)
  }
  const frame = (v: unknown): void => peer!.send(typeof v === 'string' ? v : JSON.stringify(v))
  const marker = async (): Promise<void> => {
    const n = of('counts:changed').length
    frame({ event: 'counts:changed', data: {} })
    await until(() => of('counts:changed').length === n + 1)
  }

  it('bozuk çerçeve süreci düşürmez, bağlantı sürer', async () => {
    await start()
    for (const bad of ['null', '5', '"x"', '[]', '{', '{"event":5}', '{"event":"server:notify","data":null}', '{"id":"x"}']) frame(bad)
    await marker()
    expect(of('server:notify')).toEqual([])
  })

  it('dinleyici fırlatsa da çerçeve döngüsü sürer', async () => {
    await start({ onEvent: (e, d) => { events.push([e, d]); if (e === 'server:notify') throw new Error('patladı') } })
    frame({ event: 'server:notify', data: good })
    await marker()
    expect(of('server:notify').length).toBe(1)
  })

  it('izin listesi dışı ve agent:* olayları düşer', async () => {
    await start()
    frame({ event: 'agent:summary', data: { count: 999, truncated: true } })
    frame({ event: 'agent:ready', data: {} })
    frame({ event: 'keyfi:olay', data: {} })
    await marker()
    expect(of('agent:summary')).toEqual([])
    expect(of('agent:ready').length).toBe(1)
    expect(of('keyfi:olay')).toEqual([])
  })

  it('bildirim sınırdan temiz geçer: kaçan kuyruk dahil', async () => {
    await start()
    frame({ event: 'server:notify', data: { ...good, messageId: '1"/>' } })
    frame({ event: 'server:notify', data: { ...good, seq: 2 } })
    await until(() => of('server:notify').length === 1)
    await marker()
    expect((of('server:notify')[0] as { messageId: number }).messageId).toBe(7)
    backlog = { items: [{ ...good, seq: 3, messageId: 'x' }, { ...good, seq: 4 }, null], lastSeq: 'çok', truncated: 'evet' }
    peer!.terminate()
    await until(() => of('agent:ready').length === 2)
    expect(of('server:notify').map((n) => (n as { seq: number }).seq)).toEqual([2, 4])
  })

  it('kötü kaçan kuyruk yanıtı imleci bozmaz', async () => {
    await start()
    frame({ event: 'server:notify', data: { ...good, seq: 5 } })
    await until(() => of('server:notify').length === 1)
    backlog = 'bozuk'
    peer!.terminate()
    await until(() => of('agent:ready').length === 2)
    backlog = { items: [{ ...good, seq: 6 }], lastSeq: 6, truncated: false }
    peer!.terminate()
    await until(() => of('agent:ready').length === 3)
    expect(of('server:notify').map((n) => (n as { seq: number }).seq)).toEqual([5, 6])
  })

  it('1 MiB üstü çerçeve bağlantıyı keser, olay olmaz', async () => {
    await start()
    const first = peer
    peer!.send(JSON.stringify({ event: 'server:notify', data: { ...good, body: 'x'.repeat(1024 * 1024 + 10) } }))
    await until(() => peer !== first && of('agent:ready').length === 2)
    expect(of('server:notify')).toEqual([])
  })

  it('sel özete döner', async () => {
    await start({ notifyBurst: 3, notifyRefillMs: 60_000, floodSummaryMs: 20 })
    for (let seq = 1; seq <= 10; seq++) frame({ event: 'server:notify', data: { ...good, seq } })
    await until(() => of('agent:summary').length === 1)
    expect(of('server:notify').length).toBe(3)
    expect(of('agent:summary')[0]).toEqual({ count: 7, truncated: false, flood: true })
  })

  it('stop sırasında bekleyen çerez bağlantı açmaz: kullanıcı değişiminde eski soket kalmaz', async () => {
    let release: (v: string) => void = () => {}
    let calls = 0
    const cookie = (): Promise<string> => (++calls === 1 ? new Promise((r) => { release = r }) : Promise.resolve('yeni'))
    link = new ServerLink({
      origin: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, cookie, userAgent: 'test', deviceId: 'd', label: 'l',
      onState() {}, onEvent: (e, d) => events.push([e, d])
    })
    let sockets = 0
    wss.on('connection', () => { sockets++ })
    link.start()
    link.stop()
    link.start()
    await until(() => of('agent:ready').length === 1)
    release('eski')
    await new Promise((r) => setTimeout(r, 100))
    expect(sockets).toBe(1)
  })
})
