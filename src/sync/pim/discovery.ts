// CalDAV/CardDAV keşfi. Yanlış parola sunucuda IP engeli yaratır: parola ancak aday kimliksiz isteğe Basic ile 401 verdiyse
// gider, kimlikli ilk ret keşfi bitirir. Sunucunun bildirdiği adres başka kökene çıkarsa kimlik oraya taşınmaz.
import { promises as dnsPromises } from 'dns'
import { safeFetch, sameTrust, type NetPolicy } from '../net/safeFetch'
import { DavAuthError, DavClient, type DavAuth } from './davClient'
import { propfindBody } from './davXml'

const REQUEST_MS = 10_000
const TOTAL_MS = 30_000

export type DavRole = 'calendar' | 'addressbook'

export interface DiscoverInput {
  email?: string
  hostHints?: string[]
  url?: string
  auth: DavAuth
  basic: boolean
  net: NetPolicy
  resolveSrv?: typeof dnsPromises.resolveSrv
  /** Kullanıcının adını görüp onayladığı sunucu: DNS'ten gelse de parola gidebilir */
  confirmedHost?: string
  /** yalnız testler: sahte sunucu düz http */
  scheme?: 'http'
}

export interface DiscoverResult {
  caldavHome: string | null
  carddavHome: string | null
  principal: string | null
  serverSchedules: boolean
  /** Bulunan sunucu posta düzeni dışında: parola gitmedi, kullanıcı adresi onaylamalı */
  confirmHost?: string
}

export function googleDavUrls(email: string): { caldav: string; carddav: string } {
  return {
    caldav: `https://apidata.googleusercontent.com/caldav/v2/${encodeURIComponent(email)}/user`,
    carddav: 'https://www.googleapis.com/.well-known/carddav'
  }
}

/** Parola bu adrese gidebilir mi: https ya da yöneticinin/masaüstü kullanıcısının izin verdiği özel ad */
export function passwordAllowed(url: string, net: NetPolicy): boolean {
  const u = new URL(url)
  if (u.protocol === 'https:') return true
  const allow = net.allowPrivateHosts
  if (allow === 'all') return true
  const port = u.port || '80'
  return !!allow && (allow.has(u.hostname) || allow.has(`${u.hostname}:${port}`))
}

function basicChallenge(header: string | string[] | undefined): boolean {
  const v = Array.isArray(header) ? header.join(', ') : header ?? ''
  return /(^|,\s*)basic(\s|,|$)/i.test(v)
}

/** Kimliksiz ön istek: parolanın gönderilmesine yalnız Basic meydan okuması izin verir */
async function challenged(url: string, net: NetPolicy): Promise<boolean> {
  const res = await safeFetch(url, {
    method: 'PROPFIND', net, timeoutMs: REQUEST_MS, maxBytes: 1_000_000,
    headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' }, body: propfindBody(['current-user-principal'])
  })
  return res.status === 401 && basicChallenge(res.headers['www-authenticate'])
}

/** Sunucunun verdiği adres, kimlik başka kökene gitmeyecekse */
function sameTrustUrl(base: string, href: string | null): string | null {
  if (!href) return null
  try {
    const to = new URL(href, base)
    return sameTrust(new URL(base), to) ? to.toString() : null
  } catch {
    return null
  }
}

/** current-user-principal → calendar-home-set / addressbook-home-set */
export async function findHome(client: DavClient, url: string, role: DavRole): Promise<{ home: string | null; principal: string | null }> {
  const prop = role === 'calendar' ? 'calendar-home-set' : 'addressbook-home-set'
  const pick = (r: { calendarHome: string | null; addressbookHome: string | null } | undefined): string | null =>
    (role === 'calendar' ? r?.calendarHome : r?.addressbookHome) ?? null
  const [self] = await client.propfind(url, 0, ['current-user-principal', prop])
  const principal = sameTrustUrl(url, self?.principal ?? null)
  const direct = sameTrustUrl(url, pick(self))
  if (direct || !principal) return { home: direct, principal }
  const [p] = await client.propfind(principal, 0, [prop])
  return { home: sameTrustUrl(principal, pick(p)), principal }
}

interface Candidate {
  calendar: string[]
  addressbook: string[]
}

const paths = (origin: string): Candidate => ({
  calendar: [`${origin}/.well-known/caldav`, `${origin}/dav/cal`],
  addressbook: [`${origin}/.well-known/carddav`, `${origin}/dav/card`]
})

async function srvHost(resolve: typeof dnsPromises.resolveSrv, name: string): Promise<string | null> {
  const list = await resolve(name).catch(() => [])
  const best = [...list].sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0]
  if (!best || !best.name || best.name === '.') return null
  const host = best.name.replace(/\.$/, '')
  return best.port === 443 ? host : `${host}:${best.port}`
}

async function candidates(i: DiscoverInput): Promise<Candidate[]> {
  if (i.url) {
    const generic = paths(new URL(i.url).origin)
    return [{ calendar: [i.url, ...generic.calendar], addressbook: [i.url, ...generic.addressbook] }]
  }
  const scheme = i.scheme ?? 'https'
  const domain = i.email?.split('@')[1]?.toLowerCase()
  const out: Candidate[] = []
  if (domain) {
    const resolve = i.resolveSrv ?? dnsPromises.resolveSrv
    const [cal, card] = await Promise.all([srvHost(resolve, `_caldavs._tcp.${domain}`), srvHost(resolve, `_carddavs._tcp.${domain}`)])
    if (cal || card) {
      out.push({
        calendar: cal ? paths(`${scheme}://${cal}`).calendar : [],
        addressbook: card ? paths(`${scheme}://${card}`).addressbook : []
      })
    }
  }
  const hosts = [...(i.hostHints ?? []), ...(domain ? [domain, `mail.${domain}`] : [])]
  for (const h of new Set(hosts.map((x) => x.toLowerCase()))) out.push(paths(`${scheme}://${h}`))
  return out
}

/** Hesap keşfinde parola yalnız posta sunucusuna ve e-posta alan adının altına gider: SRV imzasız DNS'tir, alan adının web sitesi üçüncü taraf olabilir */
export function hostTrusted(url: string, i: Pick<DiscoverInput, 'email' | 'hostHints' | 'confirmedHost'>): boolean {
  const host = new URL(url).hostname.toLowerCase()
  const domain = i.email?.split('@')[1]?.toLowerCase()
  if (i.confirmedHost?.toLowerCase() === host || (domain && (host === domain || host.endsWith(`.${domain}`)))) return true
  return (i.hostHints ?? []).some((h) => h.toLowerCase().replace(/:\d+$/, '') === host)
}

/** Adayın bu rol için ana dizini. Kimlik hatası dışındaki her sorun adayı eler. */
async function tryUrl(i: DiscoverInput, client: DavClient, url: string, role: DavRole, unconfirmed: Set<string>): Promise<{ home: string | null; principal: string | null } | null> {
  try {
    if (i.basic && !(passwordAllowed(url, i.net) && (await challenged(url, i.net)))) return null
    // elle yazılan adres zaten kullanıcının onayıdır
    if (i.basic && !i.url && !hostTrusted(url, i)) {
      unconfirmed.add(new URL(url).hostname.toLowerCase())
      return null
    }
    const found = await findHome(client, url, role)
    return found.home ? found : null
  } catch (e) {
    if (e instanceof DavAuthError) throw e
    return null
  }
}

async function schedules(client: DavClient, home: string): Promise<boolean> {
  try {
    return (await client.options(home)).dav.some((d) => d.toLowerCase() === 'calendar-auto-schedule')
  } catch (e) {
    if (e instanceof DavAuthError) throw e
    return false
  }
}

const NOTHING: DiscoverResult = { caldavHome: null, carddavHome: null, principal: null, serverSchedules: false }

export async function discoverDav(i: DiscoverInput): Promise<DiscoverResult> {
  const deadline = Date.now() + TOTAL_MS
  const client = new DavClient({ auth: i.auth, net: i.net, timeoutMs: REQUEST_MS })
  const unconfirmed = new Set<string>()
  for (const c of await candidates(i)) {
    const found: Record<DavRole, string | null> = { calendar: null, addressbook: null }
    let principal: string | null = null
    for (const role of ['calendar', 'addressbook'] as const) {
      for (const url of c[role]) {
        if (Date.now() > deadline) return NOTHING
        const r = await tryUrl(i, client, url, role, unconfirmed)
        if (!r) continue
        found[role] = r.home
        principal ??= r.principal
        break
      }
    }
    if (found.calendar || found.addressbook) {
      return { caldavHome: found.calendar, carddavHome: found.addressbook, principal, serverSchedules: found.calendar ? await schedules(client, found.calendar) : false }
    }
  }
  const [confirmHost] = unconfirmed
  return confirmHost ? { ...NOTHING, confirmHost } : NOTHING
}

/** Google adresleri sabit. carddav yönlendirmesi kalıcı önbelleğe alınmaz: `DiscoverResult.carddavHome` well-known adresidir,
 *  ana dizin her eşitlemede ondan çözülür. Kimlik hatası fırlar: kapsam reddi burada görünür. */
export async function discoverGoogle(email: string, auth: DavAuth, net: NetPolicy): Promise<DiscoverResult> {
  const urls = googleDavUrls(email)
  const client = new DavClient({ auth, net, timeoutMs: REQUEST_MS })
  const cal = await findHome(client, urls.caldav, 'calendar')
  const card = await findHome(client, urls.carddav, 'addressbook')
  return { caldavHome: cal.home, carddavHome: card.home ? urls.carddav : null, principal: cal.principal, serverSchedules: cal.home ? await schedules(client, cal.home) : false }
}
