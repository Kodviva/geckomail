// WebDAV XML: istek gövdeleri ve multistatus ayrıştırma. Sunucular aynı ad alanına farklı önekler verir
// (D:, d:, varsayılan), bu yüzden öğeler yerel adla okunur. DTD hiç işlenmez: entity saldırısına kapı açılmaz.
import { DOMParser } from '@xmldom/xmldom'
import { t } from '../../shared/i18n'

const NS = 'xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:R="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/"'
const HEAD = '<?xml version="1.0" encoding="utf-8"?>'

const PROP_TAGS = {
  displayname: 'D:displayname',
  resourcetype: 'D:resourcetype',
  getetag: 'D:getetag',
  getctag: 'CS:getctag',
  'sync-token': 'D:sync-token',
  'current-user-principal': 'D:current-user-principal',
  'current-user-privilege-set': 'D:current-user-privilege-set',
  'calendar-home-set': 'C:calendar-home-set',
  'addressbook-home-set': 'R:addressbook-home-set',
  'supported-calendar-component-set': 'C:supported-calendar-component-set',
  'calendar-color': 'A:calendar-color'
} as const

export type DavProp = keyof typeof PROP_TAGS

/** Multistatus'un tek girdisi; yalnız 200 propstat'ların değerleri okunur */
export interface DavResource {
  href: string
  /** Yanıt düzeyinde durum (404, 507…); propstat kullanan girdide null */
  status: number | null
  /** 200 dışı propstat durumları (sync yanıtında silinmeyi anlamak için) */
  failedStatuses: number[]
  etag: string | null
  displayName: string | null
  ctag: string | null
  syncToken: string | null
  color: string | null
  resourceTypes: string[]
  privileges: string[]
  components: string[]
  principal: string | null
  calendarHome: string | null
  addressbookHome: string | null
  data: string | null
}

export class DavXmlError extends Error {
  constructor() {
    super(t('pim.err.badXml'))
    this.name = 'DavXmlError'
  }
}

export const escXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function propfindBody(props: DavProp[]): string {
  return `${HEAD}<D:propfind ${NS}><D:prop>${props.map((p) => `<${PROP_TAGS[p]}/>`).join('')}</D:prop></D:propfind>`
}

export function syncCollectionBody(token: string | null): string {
  return `${HEAD}<D:sync-collection ${NS}><D:sync-token>${escXml(token ?? '')}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>`
}

export function multigetBody(type: 'calendar' | 'addressbook', hrefs: string[]): string {
  const [root, data] = type === 'calendar' ? ['C:calendar-multiget', 'C:calendar-data'] : ['R:addressbook-multiget', 'R:address-data']
  return `${HEAD}<${root} ${NS}><D:prop><D:getetag/><${data}/></D:prop>${hrefs.map((h) => `<D:href>${escXml(h)}</D:href>`).join('')}</${root}>`
}

/** CDATA içindeki metin işaretleme değildir: etkinlik açıklamasındaki "<!DOCTYPE" yanıtı düşürmesin */
function withoutCdata(xml: string): string {
  const out: string[] = []
  let at = 0
  for (;;) {
    const start = xml.indexOf('<![CDATA[', at)
    const end = start < 0 ? -1 : xml.indexOf(']]>', start)
    if (end < 0) return out.join('') + xml.slice(at)
    out.push(xml.slice(at, start))
    at = end + 3
  }
}

/** Hata gövdesi dahil tüm yanıtlar buradan geçer; DOCTYPE görülürse ayrıştırılmaz */
function parseRoot(xml: string): Element {
  if (/<!doctype/i.test(withoutCdata(xml))) throw new DavXmlError()
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    const root = doc.documentElement
    if (!root) throw new DavXmlError()
    return root as unknown as Element
  } catch {
    throw new DavXmlError()
  }
}

function kids(el: Element, name?: string): Element[] {
  const out: Element[] = []
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!name || (n as Element).localName === name)) out.push(n as Element)
  }
  return out
}

const kid = (el: Element, name: string): Element | null => kids(el, name)[0] ?? null
const text = (el: Element | null): string | null => el?.textContent?.trim() || null
const statusOf = (el: Element | null): number | null => {
  const m = /\s(\d{3})(?:\s|$)/.exec(`${text(el) ?? ''} `)
  return m ? Number(m[1]) : null
}
const hrefIn = (el: Element | null): string | null => (el ? text(kid(el, 'href')) : null)

function resourceOf(el: Element): DavResource {
  const r: DavResource = {
    href: text(kid(el, 'href')) ?? '', status: statusOf(kid(el, 'status')), failedStatuses: [], etag: null, displayName: null, ctag: null,
    syncToken: null, color: null, resourceTypes: [], privileges: [], components: [], principal: null, calendarHome: null, addressbookHome: null, data: null
  }
  for (const ps of kids(el, 'propstat')) {
    const code = statusOf(kid(ps, 'status'))
    if (code !== 200) {
      if (code != null) r.failedStatuses.push(code)
      continue
    }
    const prop = kid(ps, 'prop')
    if (!prop) continue
    for (const p of kids(prop)) {
      switch (p.localName) {
        case 'getetag': r.etag = text(p); break
        case 'displayname': r.displayName = text(p); break
        case 'getctag': r.ctag = text(p); break
        case 'sync-token': r.syncToken = text(p); break
        case 'calendar-color': r.color = text(p); break
        case 'resourcetype': r.resourceTypes = kids(p).map((k) => k.localName!); break
        case 'current-user-privilege-set': r.privileges = kids(p, 'privilege').flatMap((k) => kids(k).map((x) => x.localName!)); break
        case 'supported-calendar-component-set': r.components = kids(p, 'comp').map((k) => k.getAttribute('name') ?? '').filter(Boolean); break
        case 'current-user-principal': r.principal = hrefIn(p); break
        case 'calendar-home-set': r.calendarHome = hrefIn(p); break
        case 'addressbook-home-set': r.addressbookHome = hrefIn(p); break
        // gövde boşlukları korunur: satır sonları içerik
        case 'calendar-data':
        case 'address-data': r.data = p.textContent; break
      }
    }
  }
  return r
}

export function parseMultistatus(xml: string): { responses: DavResource[]; syncToken: string | null } {
  const root = parseRoot(xml)
  if (root.localName !== 'multistatus') throw new DavXmlError()
  return { responses: kids(root, 'response').map(resourceOf), syncToken: text(kid(root, 'sync-token')) }
}

/** Hata gövdesindeki koşul adları (`<D:error><D:valid-sync-token/></D:error>`); XML değilse boş */
export function errorConditions(xml: string): string[] {
  try {
    const root = parseRoot(xml)
    return root.localName === 'error' ? kids(root).map((k) => k.localName!) : []
  } catch {
    return []
  }
}
