// Oran sınırları yalnız bellekte: süreç yeniden başlayınca sıfırlanır (kabul). IP yazılmaz; açılışta üretilen rastgele tuzla
// özetlenir, tuz diske inmez. Sabit pencere: basit, belleği sınırlı.
import { createHash, randomBytes } from 'crypto'
import { isIPv6 } from 'net'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const IP_PER_MINUTE = 300
export const NEW_ENGINES_PER_HOUR = 20
/** Bütün IP'ler toplamı: dağıtık kayıt depoyu sınırsız büyütemesin; kayıtlı motorlar etkilenmez */
export const GLOBAL_NEW_ENGINES_PER_HOUR = 600
export const PUSH_PER_MINUTE = 120
export const REGISTER_PER_HOUR = 60
export const MAX_DEVICES = 2000

/** IPv6 müşterisi bütün bir /64'ü elinde tutar: sınır adres değil önek başınadır. IPv4 ve eşlenmiş adresler olduğu gibi kalır */
export function ipRateKey(ip: string): string {
  const addr = ip.split('%')[0]
  if (!isIPv6(addr)) return ip
  const canonical = new URL(`http://[${addr}]`).hostname.slice(1, -1) // küçük harf, noktalı kuyruk onaltılık
  if (canonical.startsWith('::ffff:')) return canonical
  const [head, tail] = canonical.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const full = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  return `${full.slice(0, 4).join(':')}::/64`
}

interface Bucket { start: number; count: number; windowMs: number }

export class Limits {
  private readonly buckets = new Map<string, Bucket>()
  private readonly salt = randomBytes(32)
  private lastSweep = 0

  constructor(private readonly now: () => number = Date.now) {}

  ip(ip: string): number {
    return this.hit(`i:${this.hashIp(ip)}`, IP_PER_MINUTE, MINUTE)
  }

  /** Önce IP: IP sınırına takılan istek genel tavanı tüketmez */
  newEngine(ip: string): number {
    return this.hit(`n:${this.hashIp(ip)}`, NEW_ENGINES_PER_HOUR, HOUR) || this.hit('g:new-engine', GLOBAL_NEW_ENGINES_PER_HOUR, HOUR)
  }

  push(engine: string): number {
    return this.hit(`p:${engine}`, PUSH_PER_MINUTE, MINUTE)
  }

  register(engine: string): number {
    return this.hit(`r:${engine}`, REGISTER_PER_HOUR, HOUR)
  }

  /** Bellekteki sayaç anahtarları: IP düz hâliyle bulunmaz */
  keys(): string[] {
    return [...this.buckets.keys()]
  }

  private hashIp(ip: string): string {
    return createHash('sha256').update(this.salt).update(ipRateKey(ip)).digest('base64url')
  }

  /** 0: geçti; sayı: kaç saniye sonra denenebilir (Retry-After) */
  private hit(key: string, max: number, windowMs: number): number {
    const now = this.now()
    this.sweep(now)
    const b = this.buckets.get(key)
    if (!b || now - b.start >= b.windowMs) {
      this.buckets.set(key, { start: now, count: 1, windowMs })
      return 0
    }
    if (b.count >= max) return Math.max(1, Math.ceil((b.start + b.windowMs - now) / 1000))
    b.count++
    return 0
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < MINUTE) return
    this.lastSweep = now
    for (const [k, b] of this.buckets) if (now - b.start >= b.windowMs) this.buckets.delete(k)
  }
}
