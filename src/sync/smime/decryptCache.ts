// Çözülmüş içerik yalnız RAM'dedir: gövde tablosu ileti başına, anahtar kişi başına olduğundan diske yazmak anahtarı olmayan
// üyeye içeriği açardı. Kilitleme, çıkış ve kimlik silme burayı temizler. Sıfırlama en iyi çabadır: JS dizeleri silinemez.
import type { SmimeInfo } from '../../shared/smime'
import type { SigResult } from './cms'

const MAX_BYTES = 64 * 1024 * 1024
const TTL_MS = 15 * 60_000

export interface DecryptedAttachment {
  index: number
  filename: string | null
  mime: string | null
  contentId: string | null
  content: Buffer
}

export interface DecryptedBody {
  textPlain: string | null
  html: string | null
  info: SmimeInfo
  attachments: DecryptedAttachment[]
  /** matematiksel geçerli imzacılar: "Bu sertifikayı kaydet" düğmesi için, içerik taşımaz */
  signers: SigResult[]
}

const SWEEP_MS = 60_000

interface Entry {
  body: DecryptedBody
  bytes: number
  expires: number
}

const sizeOf = (b: DecryptedBody): number =>
  Buffer.byteLength(b.textPlain ?? '') + Buffer.byteLength(b.html ?? '') + b.attachments.reduce((n, a) => n + a.content.length, 0)

function wipe(b: DecryptedBody): void {
  for (const a of b.attachments) a.content.fill(0)
}

export class DecryptedCache {
  private readonly maxBytes: number
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly entries = new Map<string, Entry>()
  private total = 0
  private epoch = 0
  private readonly userEpoch = new Map<number, number>()
  private readonly timer: ReturnType<typeof setInterval>

  constructor(o: { maxBytes?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxBytes = o.maxBytes ?? MAX_BYTES
    this.ttlMs = o.ttlMs ?? TTL_MS
    this.now = o.now ?? Date.now
    // kimsenin yeniden okumadığı düz metin süresi dolunca da gider: sunucuda kasa haftalarca açık kalır
    this.timer = setInterval(() => this.sweep(), SWEEP_MS)
    this.timer.unref?.()
  }

  sweep(): void {
    const now = this.now()
    for (const [k, e] of this.entries) if (now >= e.expires) this.drop(k, e)
  }

  stop(): void {
    clearInterval(this.timer)
  }

  private drop(key: string, e: Entry): void {
    this.entries.delete(key)
    this.total -= e.bytes
    wipe(e.body)
  }

  get(userId: number, messageId: number): DecryptedBody | null {
    const key = `${userId}:${messageId}`
    const e = this.entries.get(key)
    if (!e) return null
    if (this.now() >= e.expires) {
      this.drop(key, e)
      return null
    }
    return e.body
  }

  set(userId: number, messageId: number, b: DecryptedBody): void {
    const key = `${userId}:${messageId}`
    const prev = this.entries.get(key)
    if (prev) this.drop(key, prev)
    const bytes = sizeOf(b)
    if (bytes > this.maxBytes) return
    for (const [k, e] of this.entries) {
      if (this.total + bytes <= this.maxBytes) break
      this.drop(k, e) // Map ekleme sırası: en eski önce
    }
    this.entries.set(key, { body: b, bytes, expires: this.now() + this.ttlMs })
    this.total += bytes
  }

  /** Çözüm başlamadan alınır: araya kilit veya çıkış girdiyse sonuç kaydedilmez */
  stamp(userId: number): string {
    return `${this.epoch}:${this.userEpoch.get(userId) ?? 0}`
  }

  setIfCurrent(userId: number, messageId: number, stamp: string, b: DecryptedBody): boolean {
    if (stamp !== this.stamp(userId)) {
      wipe(b)
      return false
    }
    this.set(userId, messageId, b)
    return true
  }

  clear(): void {
    this.epoch++
    for (const [k, e] of this.entries) this.drop(k, e)
  }

  clearUser(userId: number): void {
    this.userEpoch.set(userId, (this.userEpoch.get(userId) ?? 0) + 1)
    const prefix = `${userId}:`
    for (const [k, e] of this.entries) if (k.startsWith(prefix)) this.drop(k, e)
  }
}
