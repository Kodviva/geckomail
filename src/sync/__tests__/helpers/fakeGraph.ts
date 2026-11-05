// Testler için bellek içi Microsoft Graph: gerçek hizmet yok, yalnız 127.0.0.1'de http. Temel uçlar çalışır; sıra dışı yanıtlar `on` ile.
import { createServer, type IncomingHttpHeaders, type Server } from 'http'
import type { AddressInfo } from 'net'
import type { GraphEvent } from '../../pim/graphMap'

export interface GraphRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown> | null
}
export interface GraphReply {
  status: number
  body?: unknown
  headers?: Record<string, string>
}
type Handler = (r: GraphRequest) => GraphReply | null

export const graphEvent = (id: string, o: Record<string, unknown> = {}): GraphEvent & Record<string, unknown> => ({
  id, iCalUId: `uid-${id}`, subject: id, type: 'singleInstance', start: { dateTime: '2026-11-10T10:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-10T11:00:00.0000000', timeZone: 'UTC' },
  isAllDay: false, isCancelled: false, isReminderOn: false, changeKey: `ck-${id}`, '@odata.etag': `W/"${id}-1"`, ...o
})
export const graphContact = (id: string, o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, displayName: id, emailAddresses: [{ name: id, address: `${id}@x.co` }], parentFolderId: 'kok', '@odata.etag': `W/"${id}-1"`, ...o
})

export class FakeGraph {
  readonly requests: GraphRequest[] = []
  /** Kabul edilen erişim belirteçleri; null ise denetlenmez */
  accept: string[] | null = null
  calendars: Record<string, unknown>[] = [{ id: 'takvim', name: 'Takvim', canEdit: true, isDefaultCalendar: true, hexColor: '#112233' }]
  contactFolders: Record<string, unknown>[] = []
  /** Takvim kimliği → sunucudaki olaylar; ilk delta bunları verir */
  events = new Map<string, Record<string, unknown>[]>([['takvim', []]])
  contacts: Record<string, unknown>[] = []
  /** Sonraki artımlı delta turunun değişiklikleri */
  changes: Record<string, unknown>[] = []
  pageSize = 100
  private readonly handlers: { method: string; path: RegExp; fn: Handler; once: boolean }[] = []
  private round = 0
  private server!: Server

  static async start(): Promise<FakeGraph> {
    const g = new FakeGraph()
    g.server = createServer((q, r) => {
      const chunks: Buffer[] = []
      q.on('data', (c: Buffer) => chunks.push(c))
      q.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        const reply = g.handle({ method: q.method!, url: q.url!, headers: q.headers, body: raw ? JSON.parse(raw) : null })
        r.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers })
        r.end(reply.body === undefined ? undefined : JSON.stringify(reply.body))
      })
    })
    await new Promise<void>((r) => g.server.listen(0, '127.0.0.1', () => r()))
    return g
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise((r) => this.server.close(r))
  }

  /** Eşleşen isteğe verilecek yanıt; `once` ilk eşleşmede tükenir */
  on(method: string, path: RegExp, fn: Handler | GraphReply, once = true): void {
    this.handlers.push({ method, path, fn: typeof fn === 'function' ? fn : () => fn, once })
  }

  private handle(r: GraphRequest): GraphReply {
    this.requests.push(r)
    if (this.accept && !this.accept.includes(r.headers.authorization ?? '')) return { status: 401, body: { error: { code: 'InvalidAuthenticationToken' } } }
    const i = this.handlers.findIndex((h) => h.method === r.method && h.path.test(r.url))
    if (i >= 0) {
      const h = this.handlers[i]
      const v = h.fn(r)
      if (h.once) this.handlers.splice(i, 1)
      if (v) return v
    }
    return this.route(r)
  }

  private page(url: string, all: Record<string, unknown>[]): GraphReply {
    const u = new URL(url, this.url)
    const skip = Number(u.searchParams.get('skip') ?? 0)
    const value = all.slice(skip, skip + this.pageSize)
    const more = skip + this.pageSize < all.length
    if (more) {
      u.searchParams.set('skip', String(skip + this.pageSize))
      return { status: 200, body: { value, '@odata.nextLink': `${this.url}${u.pathname}${u.search}` } }
    }
    u.search = ''
    u.searchParams.set('deltatoken', `t${++this.round}`)
    return { status: 200, body: { value, '@odata.deltaLink': `${this.url}${u.pathname}${u.search}` } }
  }

  private route(r: GraphRequest): GraphReply {
    const { pathname: path, searchParams: q } = new URL(r.url, this.url)
    if (r.method === 'GET') {
      if (path === '/v1.0/me') return { status: 200, body: { id: 'ben' } }
      if (path === '/v1.0/me/contactFolders') return { status: 200, body: { value: this.contactFolders } }
      if (path === '/v1.0/me/contacts') return { status: 200, body: { value: this.contacts.slice(0, 1).map((c) => ({ parentFolderId: c.parentFolderId })) } }
      if (path === '/v1.0/me/calendars') return { status: 200, body: { value: this.calendars } }
      const contactDelta = /^\/v1\.0\/me\/contactFolders\/[^/]+\/contacts\/delta$/.test(path)
      const calDelta = /^\/v1\.0\/me\/(calendars\/([^/]+)\/)?calendarView\/delta$/.exec(path)
      if (contactDelta || calDelta) {
        if (q.has('deltatoken')) {
          const value = this.changes
          this.changes = []
          return this.page(r.url, value)
        }
        return this.page(r.url, contactDelta ? this.contacts : (this.events.get(calDelta![2] ?? 'takvim') ?? []))
      }
      const view = /^\/v1\.0\/me\/calendars\/([^/]+)\/calendarView$/.exec(path)
      if (view) return { status: 200, body: { value: this.events.get(view[1]) ?? [] } }
      const instances = /^\/v1\.0\/me\/events\/([^/]+)\/instances$/.exec(path)
      if (instances) return { status: 200, body: { value: [graphEvent(`${instances[1]}-1`, { seriesMasterId: instances[1], type: 'occurrence' })] } }
      const one = /^\/v1\.0\/me\/events\/([^/]+)$/.exec(path)
      if (one) return { status: 200, body: graphEvent(one[1]) }
    }
    if (r.method === 'POST' && path.endsWith('/events')) return { status: 201, body: graphEvent('yeni', { subject: r.body?.subject, ...(r.body?.recurrence ? { type: 'seriesMaster' } : {}) }) }
    if (r.method === 'POST' && path.endsWith('/contacts')) return { status: 201, body: graphContact('kyeni', r.body ?? {}) }
    if (r.method === 'POST' && /\/(accept|decline|tentativelyAccept)$/.test(path)) return { status: 202 }
    if (r.method === 'PATCH') {
      const id = path.split('/').pop()!
      if (path.includes('/contacts/')) return { status: 200, body: graphContact(id, r.body ?? {}) }
      const stored = [...this.events.values()].flat().find((e) => e.id === id)
      return { status: 200, body: graphEvent(id, { ...stored, subject: r.body?.subject }) }
    }
    if (r.method === 'DELETE') return { status: 204 }
    return { status: 404, body: { error: { code: 'ErrorItemNotFound' } } }
  }
}
