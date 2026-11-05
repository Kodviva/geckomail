// Mail sunucusu otomatik keşfi (Thunderbird sırasına yakın). Uygulama başkalarının kendi
// sunucularıyla da kullanılacak: gömülü tablo yalnız büyük sağlayıcıları bilir, kurumsal/kendi
// sunucusu olan alan adlarında "mail.<alan>" tahmini çoğu zaman yanlış (ör. alan adı başka bir
// sunucuda barınıyor). Sıra:
//   1. gömülü tablo  2. https autoconfig.<alan>  3. https <alan>/.well-known  4. DNS SRV (RFC 6186)
//   5. MX: bilinen sağlayıcı → MX sunucusunun autoconfig'i → MX sunucusu  6. Thunderbird ISPDB
//   7. http autoconfig.<alan> (yalnız sonuç alan adı/MX ile tutarlıysa — araya giren sahte sunucu vermesin)
//   8. mail.<alan>
// Bulunan IMAP sunucusu giriş yapmadan sınanır: karşılama satırı okunur, düzgün LOGOUT ile kapanır
// (yarım bağlantı sunucuda "port taraması" sayılıp IP'yi engelletebilir).
import { promises as dns } from 'dns'
import { connect as netConnect } from 'net'
import { connect as tlsConnect } from 'tls'
import { resolveMailServers, type MailServers } from '../shared/mailProviders'
import type { DiscoveredServers } from '../shared/rpc'
import { safeFetch } from './net/safeFetch'
import { t } from '../shared/i18n'

export interface DiscoverDeps {
  fetchText(url: string): Promise<string | null>
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>
  resolveSrv(name: string): Promise<{ name: string; port: number; priority: number; weight: number }[]>
  probeImap(host: string, port: number, tls: boolean): Promise<boolean>
}

type Candidate = Omit<DiscoveredServers, 'verified'>

// MX alan adı → bilinen sağlayıcı (Google Workspace, Microsoft 365 … özel alan adıyla)
const MX_PROVIDERS: [RegExp, string][] = [
  [/(^|\.)(google\.com|googlemail\.com)$/, 'gmail.com'],
  [/(^|\.)outlook\.com$/, 'outlook.com'],
  [/(^|\.)(zoho\.com|zoho\.eu)$/, 'zoho.com'],
  [/(^|\.)yandex\.(net|ru|com)$/, 'yandex.com'],
  [/(^|\.)icloud\.com$/, 'icloud.com']
]

const tlsFor = (port: number, socketType?: string): 'tls' | 'starttls' =>
  socketType ? (/^ssl$/i.test(socketType) ? 'tls' : 'starttls') : port === 993 || port === 465 ? 'tls' : 'starttls'

/** Thunderbird autoconfig XML'i (config-v1.1) → IMAP + SMTP. Bağımlılıksız, yalnız gereken alanlar. */
export function parseAutoconfig(xml: string, email: string): Omit<Candidate, 'source'> | null {
  const [local, domain] = [email.split('@')[0], email.split('@')[1] ?? '']
  const fill = (v: string) => v.replace(/%EMAILADDRESS%/g, email).replace(/%EMAILLOCALPART%/g, local).replace(/%EMAILDOMAIN%/g, domain)
  const block = (tag: string, type: string): string[] =>
    [...xml.matchAll(new RegExp(`<${tag}[^>]*type=["']${type}["'][^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => m[1])
  const field = (b: string, f: string) => new RegExp(`<${f}>\\s*([^<]*?)\\s*</${f}>`, 'i').exec(b)?.[1] ?? ''
  const pick = (blocks: string[]) => {
    const parsed = blocks
      .map((b) => ({ host: fill(field(b, 'hostname')), port: Number(field(b, 'port')), socket: field(b, 'socketType'), user: fill(field(b, 'username')) }))
      .filter((x) => /^[a-z0-9.-]+$/i.test(x.host) && x.port > 0 && x.port < 65536 && !/^plain$/i.test(x.socket))
    // şifreli bağlantı tercih: SSL, sonra STARTTLS
    return parsed.find((x) => /^ssl$/i.test(x.socket)) ?? parsed[0] ?? null
  }
  const imap = pick(block('incomingServer', 'imap'))
  const smtp = pick(block('outgoingServer', 'smtp'))
  if (!imap || !smtp) return null
  const label = /<displayShortName>\s*([^<]*?)\s*<\/displayShortName>/i.exec(xml)?.[1] || undefined
  return {
    imapHost: imap.host.toLowerCase(), imapPort: imap.port, imapTls: tlsFor(imap.port, imap.socket),
    smtpHost: smtp.host.toLowerCase(), smtpPort: smtp.port, smtpTls: tlsFor(smtp.port, smtp.socket),
    username: imap.user || email,
    label
  }
}

const fromStatic = (m: MailServers, email: string, source: string): Candidate => ({
  imapHost: m.imapHost, imapPort: m.imapPort, imapTls: tlsFor(m.imapPort),
  smtpHost: m.smtpHost, smtpPort: m.smtpPort, smtpTls: tlsFor(m.smtpPort),
  username: email, label: m.label, appPassword: m.appPassword, source
})

const registrable = (host: string) => host.replace(/\.$/, '').split('.').slice(-2).join('.')

export async function discover(email: string, deps: DiscoverDeps = defaultDeps): Promise<DiscoveredServers> {
  const addr = email.trim().toLowerCase()
  const domain = addr.split('@')[1]
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error(t('sync.discover.invalidEmail'))

  const known = resolveMailServers(addr)
  // tablo güvenilir kaynak: sınamaya gerek yok
  if (known.label) return { ...fromStatic(known, addr, t('sync.discover.src.known')), verified: true }

  const q = `?emailaddress=${encodeURIComponent(addr)}`
  const xmlFrom = async (url: string) => {
    const xml = await deps.fetchText(url)
    return xml ? parseAutoconfig(xml, addr) : null
  }
  // bağımsız sorgular paralel (sırayla yapıldığında yanıtsız alan adında ~40 sn sürüyordu);
  // öncelik sırası aşağıda korunur
  const [wellKnownA, wellKnownB, imapsSrv, subsSrv, subSrv, mxRaw, ispdb, httpXml] = await Promise.all([
    xmlFrom(`https://autoconfig.${domain}/mail/config-v1.1.xml${q}`),
    xmlFrom(`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml${q}`),
    deps.resolveSrv(`_imaps._tcp.${domain}`).catch(() => []),
    deps.resolveSrv(`_submissions._tcp.${domain}`).catch(() => []),
    deps.resolveSrv(`_submission._tcp.${domain}`).catch(() => []),
    deps.resolveMx(domain).catch(() => []),
    xmlFrom(`https://autoconfig.thunderbird.net/v1.1/${domain}`), // yalnız alan adı gider
    xmlFrom(`http://autoconfig.${domain}/mail/config-v1.1.xml${q}`)
  ])

  const candidates: Candidate[] = []
  const add = (c: Omit<Candidate, 'source'> | null, source: string) => c && candidates.push({ ...c, source })

  // 2–3: alan adının kendi autoconfig'i (https)
  add(wellKnownA ?? wellKnownB, t('sync.discover.src.autoconfig'))

  // 4: SRV (RFC 6186)
  const valid = <T extends { name: string }>(xs: T[]) => xs.filter((r) => r.name && r.name !== '.')
  const best = <T extends { priority: number; weight: number }>(xs: T[]) => [...xs].sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0]
  const i = best(valid(imapsSrv))
  const sub = best(valid([...subsSrv, ...subSrv]))
  if (i) {
    add(
      {
        imapHost: i.name.toLowerCase(), imapPort: i.port, imapTls: 'tls',
        smtpHost: (sub?.name ?? i.name).toLowerCase(), smtpPort: sub?.port ?? 465, smtpTls: sub ? tlsFor(sub.port) : 'tls',
        username: addr
      },
      t('sync.discover.src.srv')
    )
  }

  // 5: MX
  const mxHosts = [...mxRaw].sort((a, b) => a.priority - b.priority).map((m) => m.exchange.replace(/\.$/, '').toLowerCase()).filter(Boolean)
  if (mxHosts.length) {
    const mx = mxHosts[0]
    const provider = MX_PROVIDERS.find(([re]) => re.test(mx))?.[1]
    if (provider) {
      const p = resolveMailServers(`x@${provider}`)
      candidates.push(fromStatic(p, addr, t('sync.discover.src.mxProvider', { provider: p.label ?? '' })))
    } else {
      add(await xmlFrom(`https://${mx}/mail/config-v1.1.xml${q}`), t('sync.discover.src.mxAutoconfig'))
      add({ imapHost: mx, imapPort: 993, imapTls: 'tls', smtpHost: mx, smtpPort: 465, smtpTls: 'tls', username: addr }, t('sync.discover.src.mx'))
    }
  }

  // 6: Thunderbird ISPDB
  add(ispdb, t('sync.discover.src.ispdb'))

  // 7: şifresiz autoconfig — yalnız alan adı ya da MX ile tutarlı sunucuya işaret ediyorsa
  if (httpXml) {
    const trusted = new Set([domain, ...mxHosts.map(registrable)])
    if (trusted.has(registrable(httpXml.imapHost)) && trusted.has(registrable(httpXml.smtpHost))) add(httpXml, t('sync.discover.src.autoconfigHttp'))
  }

  // 8: tahmin
  candidates.push({ ...fromStatic(known, addr, t('sync.discover.src.guess', { host: 'mail.' + domain })) })

  // ilk yanıt veren aday (en fazla 2 deneme); hiçbiri yanıtlamazsa ilk aday doğrulanmamış olarak döner
  const unique = candidates.filter((c, i) => candidates.findIndex((x) => x.imapHost === c.imapHost && x.imapPort === c.imapPort) === i)
  for (const c of unique.slice(0, 2)) {
    if (await deps.probeImap(c.imapHost, c.imapPort, c.imapTls === 'tls').catch(() => false)) return { ...c, verified: true }
  }
  return { ...unique[0], verified: false }
}

const defaultDeps: DiscoverDeps = {
  async fetchText(url) {
    try {
      const r = await safeFetch(url, { timeoutMs: 4000, maxBytes: 64_000, maxRedirects: 2, headers: { accept: 'application/xml,text/xml' } })
      return r.ok ? r.body.toString('utf-8') : null
    } catch {
      return null
    }
  },
  resolveMx: (d) => dns.resolveMx(d),
  resolveSrv: (n) => dns.resolveSrv(n),
  probeImap(host, port, tls) {
    return new Promise((resolve) => {
      let buf = ''
      let done = false
      const finish = (ok: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        sock.end()
        setTimeout(() => sock.destroy(), 1000)
        resolve(ok)
      }
      const sock = tls ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port })
      const timer = setTimeout(() => finish(false), 4000)
      sock.setEncoding('utf-8')
      sock.on('data', (d: string) => {
        buf += d
        if (/^\* OK/m.test(buf) && !buf.includes('a1 ')) {
          // karşılama geldi: kibarca çık (sunucu yarım bağlantıyı tarama saymasın)
          sock.write('a1 LOGOUT\r\n')
          buf += 'a1 '
        }
        if (/^a1 OK/m.test(buf) || /\* BYE/.test(buf)) finish(true)
      })
      sock.on('error', () => finish(false))
      sock.on('close', () => finish(/^\* OK/m.test(buf)))
    })
  }
}

// Toplu içe aktarma: alan adı başına bir kez keşif (önizleme + içe aktarma aynı sonucu kullanır)
const CACHE_MS = 10 * 60_000
const cache = new Map<string, { at: number; result: Promise<DiscoveredServers | null> }>()

export function discoverCached(email: string, deps: DiscoverDeps = defaultDeps): Promise<DiscoveredServers | null> {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  const hit = cache.get(domain)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result
  const result = discover(email, deps).catch(() => null)
  cache.set(domain, { at: Date.now(), result })
  return result
}

/** Sunucusu verilmemiş satırları keşifle doldurur (en fazla 40 alan adı, 4'er paralel). */
export async function fillDiscovered<T extends { email: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; needsDiscovery?: boolean }>(
  rows: T[],
  deps: DiscoverDeps = defaultDeps
): Promise<T[]> {
  const domains = [...new Set(rows.filter((r) => r.needsDiscovery).map((r) => r.email.split('@')[1]))].slice(0, 40)
  const found = new Map<string, DiscoveredServers | null>()
  for (let i = 0; i < domains.length; i += 4) {
    const batch = domains.slice(i, i + 4)
    const res = await Promise.all(batch.map((d) => discoverCached(`x@${d}`, deps)))
    batch.forEach((d, j) => found.set(d, res[j]))
  }
  return rows.map((r) => {
    const f = r.needsDiscovery ? found.get(r.email.split('@')[1]) : null
    return f ? { ...r, imapHost: f.imapHost, imapPort: f.imapPort, smtpHost: f.smtpHost, smtpPort: f.smtpPort, needsDiscovery: false } : r
  })
}
