// Mailin göndereninin belirlediği URL'lere (uzak resimler, tek-tık abonelik iptali) sync sürecinden
// istek atılır. Saldırgan bir mail bunları iç ağa yönlendirebilir: mail sunucusunun yönetim API'si,
// güvenlik duvarı arayüzü, bulut meta-veri (169.254.169.254)… Bu modül yalnız genel
// internete, standart portlara gider. IP denetimi bağlantının kendi DNS çözümlemesinde (lookup kancası)
// yapılır — ayrı bir ön denetim DNS rebinding ile atlatılabilirdi.
import { lookup as dnsLookup, type LookupAddress } from 'dns'
import { request as httpRequest, type IncomingHttpHeaders } from 'http'
import { request as httpsRequest } from 'https'
import { BlockList, isIP } from 'net'
import { t } from '../../shared/i18n'

const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) blocked.addSubnet(net, prefix, 'ipv4')
// Bilinçli olarak engellenmeyenler: 192.0.0.0/24 ve 198.18.0.0/15 — bazı ağların DNS'i/VPN'leri (Clash/Surge
// "fake-IP") genel alan adlarını bu aralıklara çözer; engellemek tüm uzak resimleri kırar, iç hizmet taşımazlar.
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  // IPv4 taşıyan geçiş adresleri: 6to4, Teredo, IPv4 uyumlu; fec0 eski site-local
  ['2002::', 16], ['2001::', 32], ['::', 96], ['fec0::', 10],
  // IPv4 çevrilmiş (SIIT); 5f00 SRv6, 3fff belge aralığı
  ['::ffff:0:0:0', 96], ['5f00::', 16], ['3fff::', 20]
] as const) blocked.addSubnet(net, prefix, 'ipv6')

// ayrı liste: BlockList eşlemeli aralığı IPv4 sorgusuyla da eşleştirir, ortak listede tüm IPv4 engellenirdi
const mappedRange = new BlockList()
mappedRange.addSubnet('::ffff:0:0', 96, 'ipv6')

/** IPv4 eşlemeli adresin IPv4 hali; noktalı ve onaltılık yazım (::ffff:7f00:1) aynı denetime girer */
function mappedIpv4(address: string): string | null {
  if (!mappedRange.check(address, 'ipv6')) return null
  const groups = address.split(':')
  const tail = groups[groups.length - 1]
  if (tail.includes('.')) return tail
  const hi = parseInt(groups[groups.length - 2], 16)
  const lo = parseInt(tail, 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

/** Genel internet dışı (iç ağ, loopback, link-local, CGNAT, ULA, çok-noktaya, belge aralıkları…) mi? */
export function isBlockedAddress(address: string): boolean {
  const v = isIP(address)
  if (v === 4) return blocked.check(address, 'ipv4')
  if (v === 6) {
    const mapped = mappedIpv4(address)
    if (mapped) return blocked.check(mapped, 'ipv4')
    return blocked.check(address, 'ipv6')
  }
  return true // IP değil → güvenli tarafta kal
}

/** Bir isteğin ağ istisnaları. Verilmezse yalnız genel internet, 80 ve 443. */
export interface NetPolicy {
  /** İç adrese çözülmesine izin verilenler. Küçük harf `host` (port `allowedPorts`a tabi) ya da `host:port` (yalnız o port).
   *  Yönlendirme atlamasında istisna yalnız ilk atlamanın adında kalındıysa ve zincirde genel adres görülmediyse geçerli:
   *  başka iç ada ya da genel adresten iç adrese yönlendirme her zaman reddedilir. */
  allowPrivateHosts?: ReadonlySet<string> | 'all'
  allowedPorts?: ReadonlySet<number> | 'any'
  insecureTls?: boolean
}

/** Webhook adresini kullanıcı yazar. Masaüstünde kendi ağındaki hizmet olabilir; sunucuda iç ağ kapalı, port serbest (n8n ve benzerleri standart dışı port kullanır) */
export function webhookNetPolicy(mode: 'desktop' | 'server'): NetPolicy {
  return mode === 'desktop' ? { allowPrivateHosts: 'all', allowedPorts: 'any' } : { allowedPorts: 'any' }
}

/** Genel internetteki DAV sunucularının portları */
export const PUBLIC_DAV_PORTS: ReadonlySet<number> = new Set([80, 443, 8443])

export interface SafeFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Sessizlik sınırı (soket) */
  timeoutMs?: number
  /** Tüm istek için duvar saati sınırı, yönlendirmeler dahil: damla damla yanıt `timeoutMs`i hiç doldurmaz */
  deadlineMs?: number
  maxBytes?: number
  maxRedirects?: number
  net?: NetPolicy
  /** 'manual': 3xx yanıtı izlenmeden döner */
  redirect?: 'follow' | 'manual'
  /** yalnız testler: port kısıtını kaldır (IP denetimi yine geçerli) */
  allowAnyPort?: boolean
}

export interface SafeResponse {
  status: number
  ok: boolean
  headers: IncomingHttpHeaders
  body: Buffer
}

class BlockedError extends Error {}

/** Kimliğin başka kökene taşınabildiği alanlar: sağlayıcı istemciyi kendi alt alanına yönlendirir (caldav → p52-caldav).
 *  Alan adı sezgisi kullanılmaz: github.io gibi paylaşılan soneklerde komşu site de "aynı alan" görünür. */
export const AUTH_REDIRECT_DOMAINS = ['icloud.com']

const hostOf = (u: URL): string => u.hostname.replace(/^\[|\]$/g, '').toLowerCase()

const portOf = (u: URL): number => Number(u.port || (u.protocol === 'https:' ? 443 : 80))

function listed(net: NetPolicy | undefined, host: string, port: number): boolean {
  const allow = net?.allowPrivateHosts
  return !!allow && allow !== 'all' && (allow.has(host) || allow.has(`${host}:${port}`))
}

function portAllowed(u: URL, host: string, opts: SafeFetchOptions): boolean {
  const { net, allowAnyPort } = opts
  if (allowAnyPort || net?.allowedPorts === 'any') return true
  const allow = net?.allowPrivateHosts
  if (allow && allow !== 'all' && allow.has(`${host}:${portOf(u)}`)) return true
  if (net?.allowedPorts) return net.allowedPorts.has(portOf(u))
  return !u.port || u.port === '80' || u.port === '443'
}

const authHeaderName = (headers: Record<string, string> | undefined): string | undefined =>
  Object.keys(headers ?? {}).find((k) => k.toLowerCase() === 'authorization')

const inAuthDomain = (host: string): boolean => AUTH_REDIRECT_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))

/** Yönlendirmede güven sınırı kalkmıyor mu: aynı köken ya da https ile AUTH_REDIRECT_DOMAINS */
export const sameTrust = (from: URL, to: URL): boolean =>
  from.origin === to.origin || (to.protocol === 'https:' && inAuthDomain(hostOf(from)) && inAuthDomain(hostOf(to)))

function assertBodyHop(from: URL, to: URL): void {
  if (from.protocol === 'https:' && to.protocol === 'http:') throw new BlockedError(t('pim.net.insecureRedirect'))
  if (!sameTrust(from, to)) throw new BlockedError(t('pim.net.bodyRedirect'))
}

/** Yönlendirmede kimlik: https'ten http'ye hiç gitmez; yalnız aynı kökende, ya da https ile AUTH_REDIRECT_DOMAINS içinde kalır */
function headersForHop(from: URL, to: URL, headers: Record<string, string> | undefined): Record<string, string> | undefined {
  const name = authHeaderName(headers)
  if (!headers || !name) return headers
  if (from.protocol === 'https:' && to.protocol === 'http:') throw new BlockedError(t('pim.net.insecureRedirect'))
  if (sameTrust(from, to)) return headers
  const { [name]: _dropped, ...rest } = headers
  return rest
}

const localNets = new BlockList()
for (const [net, prefix] of [['10.0.0.0', 8], ['127.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) localNets.addSubnet(net, prefix, 'ipv4')
localNets.addAddress('::1', 'ipv6')

/** Loopback ya da RFC1918: düz http'de kimliğin ağa çıkmadığı adresler */
function isLocalAddress(address: string): boolean {
  return localNets.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')
}

function resolveHost(host: string): Promise<LookupAddress[]> {
  const family = isIP(host)
  if (family) return Promise.resolve([{ address: host, family }])
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs as LookupAddress[])))
  })
}

// Her bağlantının DNS çözümlemesi buradan geçer: iç ağ adresine çözülürse bağlantı hiç kurulmaz
function guardedLookup(
  hostname: string,
  options: object,
  cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
): void {
  dnsLookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err, '')
    const list = addrs as LookupAddress[]
    const bad = list.find((a) => isBlockedAddress(a.address))
    if (bad || !list.length) return cb(new BlockedError(t('sync.net.blockedInternal', { host: hostname })) as NodeJS.ErrnoException, '')
    const all = (options as { all?: boolean }).all
    if (all) cb(null, list)
    else cb(null, list[0].address, list[0].family)
  })
}

// Denetlenen adresler bağlantıda da kullanılır: denetimden sonra DNS başka adrese dönemez
function pinnedLookup(addrs: LookupAddress[]) {
  return (_host: string, options: object, cb: (err: null, address: string | LookupAddress[], family?: number) => void): void => {
    if ((options as { all?: boolean }).all) cb(null, addrs)
    else cb(null, addrs[0].address, addrs[0].family)
  }
}

const DEFAULT_DEADLINE_MS = 120_000

export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const deadline = Date.now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS)
  const maxRedirects = opts.maxRedirects ?? 5
  let current = url
  let method = opts.method ?? 'GET'
  let body = opts.body
  let headers = opts.headers
  let firstHost = ''
  let sawPublic = false
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = new URL(current)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(t('sync.net.badScheme', { scheme: u.protocol }))
    const host = hostOf(u)
    if (!portAllowed(u, host, opts)) throw new Error(t('sync.net.badPort', { port: u.port }))
    // Node kullanıcı bilgisini Basic başlığına çevirir: kimlik politikanın dışından sızardı
    if (u.username || u.password) throw new BlockedError(t('pim.net.urlCredentials'))
    if (hop === 0) firstHost = host
    const named = opts.net?.allowPrivateHosts === 'all' || listed(opts.net, host, portOf(u))
    const allowPrivate: boolean = named && (hop === 0 || (host === firstHost && !sawPublic))
    // doğrudan IP yazılmışsa lookup çağrılmaz — burada denetle
    if (isIP(host) && isBlockedAddress(host) && !allowPrivate) throw new BlockedError(t('sync.net.blockedInternal', { host }))
    const cleartextAuth = u.protocol === 'http:' && !!authHeaderName(headers)
    // politikasız ve kimliksiz istek eski yoldan gider: denetim bağlantının kendi lookup kancasında
    const addrs: LookupAddress[] | null = allowPrivate || cleartextAuth ? await resolveHost(host) : null
    if (addrs) {
      if (!addrs.length || (!allowPrivate && addrs.some((a) => isBlockedAddress(a.address)))) throw new BlockedError(t('sync.net.blockedInternal', { host }))
      if (cleartextAuth && !listed(opts.net, host, portOf(u)) && !addrs.every((a) => isLocalAddress(a.address))) throw new BlockedError(t('pim.net.insecureAuth'))
    }
    // istisnasız atlamada lookup kancası iç adresi zaten reddeder
    sawPublic ||= !addrs || addrs.some((a) => !isBlockedAddress(a.address))
    const res = await once(u, method, opts, body, headers, addrs, deadline)
    if (opts.redirect !== 'manual' && res.status >= 300 && res.status < 400 && res.headers.location) {
      const next = new URL(res.headers.location, u)
      headers = headersForHop(u, next, headers)
      current = next.toString()
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
      }
      // yukarıda GET'e dönen istekte gövde gitmez; gövde ve yan etkili yöntem (DELETE) kimlik gibi korunur
      if (method !== 'GET' && method !== 'HEAD') assertBodyHop(u, next)
      continue
    }
    return res
  }
  throw new Error(t('sync.net.tooManyRedirects'))
}

function once(u: URL, method: string, opts: SafeFetchOptions, body: string | undefined, headers: Record<string, string> | undefined, addrs: LookupAddress[] | null, deadline: number): Promise<SafeResponse> {
  const maxBytes = opts.maxBytes ?? 5_000_000
  const req = u.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const r = req(
      u,
      {
        method,
        headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body).toString() } : {}) },
        lookup: (addrs ? pinnedLookup(addrs) : guardedLookup) as never,
        // ortak havuz adı anahtar alır: bu soket politikasız istekte yeniden kullanılırsa iç ağ engeli atlanırdı
        ...(addrs ? { agent: false } : {}),
        ...(opts.net?.insecureTls ? { rejectUnauthorized: false } : {}),
        timeout: opts.timeoutMs ?? 10_000
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > maxBytes) {
            r.destroy(new Error(t('sync.net.responseTooLarge')))
            return
          }
          chunks.push(c)
        })
        res.on('end', () => {
          const status = res.statusCode ?? 0
          resolve({ status, ok: status >= 200 && status < 300, headers: res.headers, body: Buffer.concat(chunks) })
        })
        res.on('error', reject)
      }
    )
    const wall = setTimeout(() => r.destroy(new Error(t('sync.net.timeout'))), Math.max(0, deadline - Date.now()))
    r.on('close', () => clearTimeout(wall))
    r.on('timeout', () => r.destroy(new Error(t('sync.net.timeout'))))
    r.on('error', reject)
    if (body) r.write(body)
    r.end()
  })
}
