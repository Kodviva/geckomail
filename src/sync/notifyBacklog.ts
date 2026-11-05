// Kaçan bildirim kuyruğu: masaüstü ajanı uykudan ya da kopuştan dönünce `seq` ile kaçırdığını ister. İçerik yalnız bellekte
// durur, diske yazılmaz; sunucu yeniden başlayınca boşalır. Sıra numarası saatten başlar: yeniden başlatmadan sonra
// ajanın elindeki eski değer yeni ögeleri gizlemesin. Kasa hesabının metni kuyruğa yazılmaz: kuyruk kasa kilitlendikten
// sonra da okunur.
import type { ServerNotify } from '../shared/pushTypes'

export const NOTIFY_BACKLOG_MAX = 50
export const NOTIFY_BACKLOG_TTL_MS = 24 * 3600_000

interface Entry { item: ServerNotify; at: number }
interface UserLog { seq: number; entries: Entry[] }

/** Metin ve metinden türeyen etiket gider: kasa hesabının ögesi açıldığında içerik göstermez, eylem de taşımaz */
export const maskNotify = (item: ServerNotify): ServerNotify => ({ ...item, title: '', body: '', tag: `masked:${item.seq}`, actions: [] })

export class NotifyBacklog {
  private readonly users = new Map<number, UserLog>()
  private readonly firstSeq: number

  constructor(private readonly now: () => number = Date.now) {
    this.firstSeq = now()
  }

  /** Dönen öge içeriği taşır (açık oturumlara gider). `masked`: kuyrukta metin ve metinden türeyen etiket kalmaz */
  push(userId: number, raw: Omit<ServerNotify, 'seq'>, masked = false): ServerNotify {
    const log = this.log(userId)
    const item: ServerNotify = { ...raw, seq: ++log.seq }
    log.entries.push({ item: masked ? maskNotify(item) : item, at: this.now() })
    if (log.entries.length > NOTIFY_BACKLOG_MAX) log.entries.splice(0, log.entries.length - NOTIFY_BACKLOG_MAX)
    return item
  }

  /** `truncated`: sıra numaraları ardışık, `afterSeq` sonrası beklenen öge düşmüş (üst sınır, süre, forget, yeniden başlatma) */
  since(userId: number, afterSeq: number): { items: ServerNotify[]; lastSeq: number; truncated: boolean } {
    const log = this.log(userId)
    const oldest = this.now() - NOTIFY_BACKLOG_TTL_MS
    log.entries = log.entries.filter((e) => e.at >= oldest)
    const items = log.entries.filter((e) => e.item.seq > afterSeq).map((e) => e.item)
    return { items, lastSeq: log.seq, truncated: items.length < log.seq - afterSeq }
  }

  /** Kullanıcı iptal edildi: içerik bellekte kalmasın. Sıra numarası kalır, geri giderse ajanın `afterSeq`'i yeni ögeleri gizlerdi */
  forget(userId: number): void {
    const log = this.users.get(userId)
    if (log) log.entries = []
  }

  private log(userId: number): UserLog {
    let log = this.users.get(userId)
    if (!log) {
      log = { seq: this.firstSeq, entries: [] }
      this.users.set(userId, log)
    }
    return log
  }
}
