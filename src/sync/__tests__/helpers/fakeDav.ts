// Testler için bellek içi CalDAV/CardDAV sunucusu: gerçek sunucu yok, yalnız 127.0.0.1'de http. Temel yollar
// (PROPFIND, sync-collection, multiget, GET/PUT/DELETE, kimlik denetimi) çalışır; sıra dışı yanıtlar `override` ile.
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'

export interface FakeDavRequest {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: string
}
export interface FakeDavReply {
  status: number
  body?: string
  headers?: Record<string, string>
}
type Override = FakeDavReply | ((r: FakeDavRequest) => FakeDavReply | null)

const XML = { 'content-type': 'application/xml; charset=utf-8' }
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const multi = (body: string): string => `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:R="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/">${body}</D:multistatus>`
const ok = (props: string): string => `<D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`

export class FakeDav {
  readonly requests: FakeDavRequest[] = []
  readonly objects = new Map<string, { etag: string; data: string }>()
  /** Beklenen kimlik başlıkları; null ise kimlik istenmez */
  accept: string[] | null = null
  /** 401'de gönderilen şema */
  challenge = 'Basic realm="fake"'
  /** Verilirse her PROPFIND öz kaydı bu adresleri bildirir */
  homes: { principal?: string; calendar?: string; addressbook?: string } | null = null
  /** yol → koleksiyon; ana dizinin depth 1 listesinde görünür */
  readonly collections = new Map<string, { type: 'calendar' | 'addressbook'; name: string; readOnly?: boolean; color?: string }>()
  /** Sunucu sync-collection desteklemez, sync-token vermez */
  noSyncToken = false
  /** Yanıt gecikmesi (ms) ve aynı anda açık isteklerin tepe sayısı */
  latency = 0
  peak = 0
  private open = 0
  /** Her PUT'tan önce sorulur: yanıt dönerse nesne yazılmaz */
  onPut: ((path: string) => FakeDavReply | null) | null = null
  /** OPTIONS DAV başlığına eklenenler */
  davExtra = ''
  private readonly overrides = new Map<string, Override[]>()
  private readonly log: { rev: number; href: string; removed: boolean }[] = []
  private rev = 1
  private server!: Server

  static async start(): Promise<FakeDav> {
    const d = new FakeDav()
    d.server = createServer((q, r) => {
      const chunks: Buffer[] = []
      q.on('data', (c: Buffer) => chunks.push(c))
      q.on('end', () => d.handle({ method: q.method!, path: q.url!, headers: q.headers, body: Buffer.concat(chunks).toString() }, r))
    })
    await new Promise<void>((r) => d.server.listen(0, '127.0.0.1', () => r()))
    return d
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  get token(): string {
    return `tok-${this.rev}`
  }

  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise((r) => this.server.close(r))
  }

  /** Bir sonraki eşleşen isteğe verilecek yanıt (işlev null dönerse varsayılan yol işler). Sırayla tüketilir. */
  override(method: string, path: string, reply: Override): void {
    const k = `${method} ${path}`
    this.overrides.set(k, [...(this.overrides.get(k) ?? []), reply])
  }

  seed(href: string, data: string): string {
    this.rev++
    const etag = `"e${this.rev}"`
    this.objects.set(href, { etag, data })
    this.log.push({ rev: this.rev, href, removed: false })
    return etag
  }

  drop(href: string): void {
    this.rev++
    this.objects.delete(href)
    this.log.push({ rev: this.rev, href, removed: true })
  }

  private handle(r: FakeDavRequest, res: ServerResponse): void {
    this.requests.push(r)
    this.peak = Math.max(this.peak, ++this.open)
    const reply = this.reply(r)
    setTimeout(() => {
      this.open--
      res.writeHead(reply.status, reply.headers ?? {})
      res.end(reply.body)
    }, this.latency)
  }

  private reply(r: FakeDavRequest): FakeDavReply {
    const queue = this.overrides.get(`${r.method} ${r.path}`)
    if (queue?.length) {
      const o = queue.shift()!
      const v = typeof o === 'function' ? o(r) : o
      if (v) return v
    }
    if (this.accept && !this.accept.includes(r.headers.authorization ?? '')) return { status: 401, headers: { 'www-authenticate': this.challenge } }
    switch (r.method) {
      case 'OPTIONS':
        return { status: 200, headers: { dav: `1, 3, calendar-access, addressbook${this.davExtra}`, allow: 'OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT' } }
      case 'PROPFIND':
        return { status: 207, headers: XML, body: this.listing(r.path, r.headers.depth === '0') }
      case 'REPORT':
        if (r.body.includes('sync-collection')) return this.noSyncToken ? { status: 501 } : this.sync(r)
        return this.multiget(r)
      case 'GET': {
        const o = this.objects.get(r.path)
        return o ? { status: 200, headers: { etag: o.etag }, body: o.data } : { status: 404 }
      }
      case 'PUT': {
        const refused = this.onPut?.(r.path)
        if (refused) return refused
        const cur = this.objects.get(r.path)
        if (r.headers['if-none-match'] === '*' && cur) return { status: 412 }
        if (r.headers['if-match'] && r.headers['if-match'] !== cur?.etag) return { status: 412 }
        return { status: cur ? 204 : 201, headers: { etag: this.seed(r.path, r.body) } }
      }
      case 'DELETE': {
        const cur = this.objects.get(r.path)
        if (!cur) return { status: 404 }
        if (r.headers['if-match'] && r.headers['if-match'] !== cur.etag) return { status: 412 }
        this.drop(r.path)
        return { status: 204 }
      }
      default:
        return { status: 405 }
    }
  }

  private listing(path: string, selfOnly: boolean): string {
    const href = (tag: string, v: string | undefined): string => (v ? `<${tag}><D:href>${esc(v)}</D:href></${tag}>` : '')
    const mine = this.collections.get(path)
    const kindTag = (c: { type: string }): string => (c.type === 'calendar' ? '<C:calendar/>' : '<R:addressbook/>')
    const homeProps = this.homes
      ? href('D:current-user-principal', this.homes.principal) + href('C:calendar-home-set', this.homes.calendar) + href('R:addressbook-home-set', this.homes.addressbook)
      : ''
    const token = this.noSyncToken ? '' : `<D:sync-token>${this.token}</D:sync-token>`
    const self = `<D:response><D:href>${esc(path)}</D:href>${ok(`<D:resourcetype><D:collection/>${mine ? kindTag(mine) : ''}</D:resourcetype>${token}<CS:getctag>${this.rev}</CS:getctag>${homeProps}`)}</D:response>`
    if (selfOnly) return multi(self)
    const lists = [...this.collections].filter(([p]) => p !== path && p.startsWith(path)).map(([p, c]) => {
      const privileges = c.readOnly ? '<D:current-user-privilege-set><D:privilege><D:read/></D:privilege></D:current-user-privilege-set>' : ''
      return `<D:response><D:href>${esc(p)}</D:href>${ok(`<D:resourcetype><D:collection/>${kindTag(c)}</D:resourcetype><D:displayname>${esc(c.name)}</D:displayname>${c.color ? `<A:calendar-color xmlns:A="http://apple.com/ns/ical/">${c.color}</A:calendar-color>` : ''}${privileges}`)}</D:response>`
    })
    const kids = mine ? [...this.objects].filter(([h]) => h.startsWith(path)).map(([h, o]) => `<D:response><D:href>${esc(h)}</D:href>${ok(`<D:getetag>${esc(o.etag)}</D:getetag><D:resourcetype/>`)}</D:response>`) : []
    const plain = !mine && !this.collections.size ? [...this.objects].filter(([h]) => h.startsWith(path)).map(([h, o]) => `<D:response><D:href>${esc(h)}</D:href>${ok(`<D:getetag>${esc(o.etag)}</D:getetag><D:resourcetype/>`)}</D:response>`) : []
    return multi(self + lists.join('') + kids.join('') + plain.join(''))
  }

  private sync(r: FakeDavRequest): FakeDavReply {
    const given = /<D:sync-token>([^<]*)<\/D:sync-token>/.exec(r.body)?.[1] ?? ''
    if (given && !/^tok-\d+$/.test(given)) return { status: 403, headers: XML, body: '<D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>' }
    const since = given ? Number(given.slice(4)) : 0
    const latest = new Map(this.log.filter((l) => l.rev > since).map((l) => [l.href, l]))
    const items = [...latest.values()].filter((l) => l.href.startsWith(r.path)).map((l) =>
      l.removed
        ? `<D:response><D:href>${esc(l.href)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`
        : `<D:response><D:href>${esc(l.href)}</D:href>${ok(`<D:getetag>${esc(this.objects.get(l.href)?.etag ?? '')}</D:getetag>`)}</D:response>`
    )
    return { status: 207, headers: XML, body: multi(`${items.join('')}<D:sync-token>${this.token}</D:sync-token>`) }
  }

  private multiget(r: FakeDavRequest): FakeDavReply {
    const card = r.body.includes('addressbook-multiget')
    const hrefs = [...r.body.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1].replace(/&amp;/g, '&'))
    const items = hrefs.map((h) => {
      const o = this.objects.get(h)
      if (!o) return `<D:response><D:href>${esc(h)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`
      const tag = card ? 'R:address-data' : 'C:calendar-data'
      return `<D:response><D:href>${esc(h)}</D:href>${ok(`<D:getetag>${esc(o.etag)}</D:getetag><${tag}>${esc(o.data)}</${tag}>`)}</D:response>`
    })
    return { status: 207, headers: XML, body: multi(items.join('')) }
  }
}
