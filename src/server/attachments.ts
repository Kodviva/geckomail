// Ekler HTTP üzerinden (sunucu modu web istemcisi): indirme akışı ve gönderim öncesi yükleme. Büyük ek
// WebSocket çerçevesine (JSON/base64) girmez. Çerez doğrulaması ve POST'un aynı köken denetimi http.ts'te;
// burada hesap görme yetkisi, kasa durumu ve dosya işleri.
//   GET  /api/attachment/:messageId/:attachmentId → diskten akış (yoksa IMAP'ten çekilir); tarayıcıda
//        çalıştırılmasın diye her zaman application/octet-stream + attachment
//   HEAD aynı uç, aynı denetimler, gövdesiz: indirme <a download> ile başlar ve hatası sayfaya dönmez, istemci önce sorar
//   GET/HEAD /api/smime-attachment/:messageId/:index → çözülmüş ek, oturum kullanıcısının RAM önbelleğinden; önbellekte yoksa 410,
//        diske yazılmaz, tarayıcı önbelleğine girmez (no-store)
//   POST /api/upload (application/octet-stream, X-Filename) → { uploadId }; geçici dosya dataDir/uploads'ta,
//        yalnız yükleyen oturum sendMail'de kullanabilir, 1 saat sonra silinir
//   DELETE /api/upload/:uploadId → 204; yalnız yükleyen oturum (vazgeçilen ek kotada beklemesin)
import { randomBytes } from 'crypto'
import { chmodSync, createReadStream, createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import type { IncomingMessage, ServerResponse } from 'http'
import { join, resolve, sep } from 'path'
import type { SessionUser } from '../shared/rpc'
import { userCanView } from '../sync/auth/sessionUser'
import { OUTBOX_TOTAL_LIMIT } from '../sync/rpc/common'
import { attachmentOnDisk } from '../sync/rpc/mail'
import type { RpcHub, UploadedFile, UploadRegistry } from '../sync/rpcHub'
import { getVaultStatus } from '../sync/vault/manager'
import { securityHeaders } from './securityHeaders'

/** Tek yükleme en çok gönderim sınırı kadar (ek toplamı 25 MB) */
export const UPLOAD_LIMIT = OUTBOX_TOTAL_LIMIT
export const UPLOAD_TTL_MS = 60 * 60 * 1000
const SWEEP_MS = 5 * 60 * 1000
// oturum başına bekleyen (henüz gönderilmemiş) yüklemeler: diski doldurmaya karşı
const SESSION_PENDING_BYTES = 4 * UPLOAD_LIMIT
const SESSION_PENDING_COUNT = 50
// uploads dizininin tamamı (süren yüklemelerin ayrılan payı dahil): bütün oturumlar birlikte diski dolduramasın
const GLOBAL_BYTES = 2 * 1024 * 1024 * 1024
const FALLBACK_NAME = 'ek'
/** Geri yükleme yüklemesi (backupRoutes.ts) en çok 2 GB. Kendi bütçesi var: ek kotasına da eklerin genel sınırına
 *  da sayılmaz; sunucu genelinde aynı anda bir süren ve en çok bir bekleyen geri yükleme dosyası (boş alan
 *  denetimi backupRoutes'ta) */
export const RESTORE_UPLOAD_LIMIT = 2 * 1024 * 1024 * 1024

/** Görünür ad ≤ max bayt (UTF-8), kod noktası bölünmeden */
function truncateBytes(s: string, max: number): string {
  let out = ''
  let n = 0
  for (const ch of s) {
    const b = Buffer.byteLength(ch)
    if (n + b > max) break
    out += ch
    n += b
  }
  return out
}

/** Yol ayırıcıları, denetim ve yön değiştirme karakterleri ayıklanır */
const CONTROL_RE = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu

/** X-Filename → görünen ad. RFC 5987 (charset'lang'yüzde-kodlu, yalnız UTF-8) ya da düz ASCII. Yalnız ekin
 *  adı olarak kullanılır, diskteki dosya adı değildir. Çözülemeyen/boş ad 'ek'. */
export function displayName(raw: string | string[] | undefined): string {
  let v = (Array.isArray(raw) ? raw[0] : raw) ?? ''
  const m = /^([A-Za-z0-9!#$%&+^_`{}~-]+)'[A-Za-z0-9-]*'(.*)$/.exec(v)
  if (m) {
    if (m[1].toLowerCase() !== 'utf-8') return FALLBACK_NAME
    try {
      v = decodeURIComponent(m[2])
    } catch {
      return FALLBACK_NAME
    }
  }
  v = truncateBytes(v.replace(/[/\\]/g, '').replace(CONTROL_RE, '').trim(), 255)
  return v && v !== '.' && v !== '..' ? v : FALLBACK_NAME
}

/** RFC 6266: ASCII yedek ad + filename*=UTF-8''… (attr-char dışı her şey yüzde kodlu) */
export function contentDisposition(name: string): string {
  const clean = name.replace(/[/\\]/g, '_').replace(CONTROL_RE, '').trim() || FALLBACK_NAME
  const ascii = clean.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  let ext: string
  try {
    ext = encodeURIComponent(clean).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  } catch {
    ext = encodeURIComponent(ascii) // eşsiz vekil (bozuk UTF-16) içeren ad
  }
  return `attachment; filename="${ascii}"; filename*=UTF-8''${ext}`
}

/** attachment: sendMail eki; restore: geri yükleme dosyası (birbirinin yerine kullanılamaz) */
export type UploadPurpose = 'attachment' | 'restore'

interface UploadEntry extends UploadedFile {
  owner: string
  createdAt: number
  purpose?: UploadPurpose
}

/** Bellekteki yükleme kaydı + geçici dizin. Kayıt süreçle yaşar: açılışta dizinde kalan (önceki çalışmanın)
 *  dosyalar sahipsizdir, silinir. */
export class UploadStore implements UploadRegistry {
  private readonly entries = new Map<string, UploadEntry>()
  // süren yüklemelerin ayrılmış payı (sahip → sayı/bayt) ve toplamı; kota denetimi bunları da sayar
  private readonly inflight = new Map<string, { count: number; bytes: number }>()
  private inflightBytes = 0
  // süren geri yükleme yüklemesi (sunucu genelinde bir tane)
  private restoreInflight = false
  private readonly timer: ReturnType<typeof setInterval>

  constructor(
    readonly dir: string,
    private readonly now: () => number,
    sweepMs = SWEEP_MS,
    private readonly globalBytes = GLOBAL_BYTES
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700) // dizin önceden daha geniş izinle açılmışsa
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true })
    this.timer = setInterval(() => this.sweep(), sweepMs)
    this.timer.unref()
  }

  private expired(e: UploadEntry): boolean {
    return this.now() - e.createdAt >= UPLOAD_TTL_MS
  }

  get(id: string, owner: string, purpose: UploadPurpose = 'attachment'): UploadedFile | null {
    const e = this.entries.get(id)
    if (!e || e.owner !== owner || this.expired(e) || (e.purpose ?? 'attachment') !== purpose) return null
    return { path: e.path, size: e.size, filename: e.filename }
  }

  consume(id: string): void {
    this.entries.delete(id)
  }

  /** Oturumun bekleyen (tamamlanmış + süren) yükleme sayısı ve toplam boyutu */
  private pending(owner: string): { count: number; bytes: number } {
    const f = this.inflight.get(owner)
    let count = f?.count ?? 0
    let bytes = f?.bytes ?? 0
    for (const e of this.entries.values()) {
      if (e.owner !== owner || this.expired(e) || (e.purpose ?? 'attachment') !== 'attachment') continue
      count++
      bytes += e.size
    }
    return { count, bytes }
  }

  /** Dizindeki ek yüklemeleri (süresi dolup henüz süpürülmeyenler dahil) + süren ek yüklemelerinin payı;
   *  geri yükleme dosyaları kendi bütçesinde */
  private totalBytes(): number {
    let n = this.inflightBytes
    for (const e of this.entries.values()) if ((e.purpose ?? 'attachment') === 'attachment') n += e.size
    return n
  }

  /** Gövde okunmadan önce eşzamanlı (await yok) yer ayırır: paralel istekler denetimi birlikte geçemez.
   *  Başarılıysa ayrılan payı bırakan işlev; aşımda 'quota' (oturum) ya da 'full' (dizin).
   *  Geri yükleme (purpose 'restore') ne ek kotasına ne genel sınıra sayılır: sunucu genelinde aynı anda bir
   *  tane ('quota'); boyut sınırı ve boş alan çağıranda. */
  reserve(owner: string, bytes: number, purpose: UploadPurpose = 'attachment'): (() => void) | 'quota' | 'full' {
    if (purpose === 'restore') {
      if (this.restoreInflight) return 'quota'
      this.restoreInflight = true
      let done = false
      return () => {
        if (done) return
        done = true
        this.restoreInflight = false
      }
    }
    const p = this.pending(owner)
    if (p.count + 1 > SESSION_PENDING_COUNT || p.bytes + bytes > SESSION_PENDING_BYTES) return 'quota'
    if (this.totalBytes() + bytes > this.globalBytes) return 'full'
    const f = this.inflight.get(owner) ?? { count: 0, bytes: 0 }
    f.count++
    f.bytes += bytes
    this.inflight.set(owner, f)
    this.inflightBytes += bytes
    let released = false
    return () => {
      if (released) return
      released = true
      f.count--
      f.bytes -= bytes
      if (f.count === 0) this.inflight.delete(owner)
      this.inflightBytes -= bytes
    }
  }

  /** Bekleyen geri yükleme dosyası sayısı (testler) */
  restoreCount(): number {
    let n = 0
    for (const e of this.entries.values()) if (e.purpose === 'restore') n++
    return n
  }

  /** Sahibin vazgeçtiği yükleme: dosya silinir; başkasınınki ya da bilinmeyen için false */
  discard(id: string, owner: string): boolean {
    const e = this.entries.get(id)
    if (!e || e.owner !== owner) return false
    this.entries.delete(id)
    rmSync(e.path, { force: true })
    return true
  }

  add(e: UploadEntry): string {
    // en çok bir bekleyen geri yükleme dosyası: yenisi öncekini (hangi yöneticinin olursa) siler — 2 GB'lık
    // dosyalar birikmesin
    if (e.purpose === 'restore') {
      for (const [id, x] of this.entries) if (x.purpose === 'restore') this.discard(id, x.owner)
    }
    const id = randomBytes(16).toString('hex')
    this.entries.set(id, e)
    return id
  }

  /** Süresi dolan yüklemeler: dosya silinir, kayıt düşer */
  sweep(): void {
    for (const [id, e] of this.entries) {
      if (!this.expired(e)) continue
      this.entries.delete(id)
      rmSync(e.path, { force: true })
    }
  }

  close(): void {
    clearInterval(this.timer)
  }
}

export type Receive = { ok: true; size: number } | { ok: false; status: 400 | 408 | 413 | 500 }

/** Yükleme süre sınırları. Sunucuda genel requestTimeout yok (2 GB geri yükleme yavaş hatta saatler sürebilir):
 *  her gövde okuyan yol kendi süresini koyar. idleMs: bu kadar süre bayt gelmezse 408; totalMs: toplam üst sınır */
export interface ReceiveLimits {
  idleMs: number
  totalMs?: number
}
export const ATTACHMENT_RECEIVE: ReceiveLimits = { idleMs: 60_000, totalMs: 5 * 60_000 }
/** Geri yüklemede toplam üst sınır yok (boyut en çok 2 GB), yalnız durgunluk */
export const RESTORE_RECEIVE: ReceiveLimits = { idleMs: 60_000 }

/** Gövdeyi en çok limit bayt olarak dosyaya akıtır (belleğe toplamaz). Aşım/kopma/süre/yazma hatasında yarım dosya
 *  akış kapandıktan sonra silinir (açılış henüz bitmemişken silmek dosyayı geride bırakırdı). */
export function receive(req: IncomingMessage, path: string, limit: number, limits: ReceiveLimits): Promise<Receive> {
  return new Promise((done) => {
    const out = createWriteStream(path, { flags: 'wx', mode: 0o600 })
    let size = 0
    let settled = false
    let ended = false
    let idle: ReturnType<typeof setTimeout> | undefined
    const armIdle = (): void => {
      clearTimeout(idle)
      // disk yavaşsa akış kendiliğinden durur: bu, istemcinin durgunluğu değil
      idle = setTimeout(() => (out.writableNeedDrain ? armIdle() : fail(408)), limits.idleMs).unref()
    }
    const total = limits.totalMs ? setTimeout(() => fail(408), limits.totalMs).unref() : undefined
    const clearTimers = (): void => {
      clearTimeout(idle)
      clearTimeout(total)
    }
    const fail = (status: 400 | 408 | 413 | 500): void => {
      if (settled) return
      settled = true
      clearTimers()
      req.unpipe(out)
      out.once('close', () => rmSync(path, { force: true }))
      out.destroy()
      done({ ok: false, status })
    }
    armIdle()
    req.on('data', (c: Buffer) => {
      size += c.length
      if (settled) return
      armIdle()
      if (size > limit) fail(413)
    })
    req.on('end', () => {
      ended = true
      clearTimers()
    })
    req.on('error', () => fail(400))
    req.on('close', () => {
      if (!ended) fail(400) // istemci gövde bitmeden koptu
    })
    out.on('error', () => fail(500))
    out.on('finish', () => {
      if (settled) return
      settled = true
      clearTimers()
      done({ ok: true, size })
    })
    req.pipe(out)
  })
}

export const receiveReason = (status: 400 | 408 | 413 | 500): string =>
  ({ 400: 'invalid', 408: 'timeout', 413: 'tooLarge', 500: 'internal' })[status]

export type AttachmentRoutes = ((req: IncomingMessage, res: ServerResponse, user: SessionUser, sessionId: string) => Promise<boolean>) & {
  /** süpürücüyü durdurur (sunucu kapanışı) */
  close(): void
  /** yükleme deposu (geri yükleme yüklemesi de burada, backupRoutes.ts) */
  store: UploadStore
}

/** Ek uçları. İsteği ele aldıysa true; eşleşmeyen yol/yöntem çağırana kalır (404). */
export function createAttachmentRoutes(o: {
  hub: RpcHub; dataDir: string; https: boolean; now?: () => number; sweepMs?: number; globalBytes?: number
  /** testler: kısa süre sınırları */
  receiveLimits?: ReceiveLimits
}): AttachmentRoutes {
  const { hub, https } = o
  const { q } = hub.deps
  const store = new UploadStore(join(o.dataDir, 'uploads'), o.now ?? Date.now, o.sweepMs, o.globalBytes)
  hub.uploads = store

  const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): true => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      ...securityHeaders({ https, api: true }), ...extra,
      'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text))
    })
    res.end(text)
    return true
  }

  const download = async (res: ServerResponse, user: SessionUser, messageId: number, attachmentId: number, head: boolean): Promise<true> => {
    const msg = q.getMessage(messageId)
    if (!msg) return json(res, 404, { reason: 'notFound' })
    if (!userCanView(q, user, msg.accountId)) return json(res, 403, { reason: 'forbidden' })
    const att = q.getAttachment(attachmentId)
    if (!att || att.message_id !== messageId) return json(res, 404, { reason: 'notFound' })
    // kasa hesabının eki kilitliyken düz hâliyle verilmez (kilitlemede diskteki kopyalar da silinir)
    if (q.getAccountRow(msg.accountId)?.secure && getVaultStatus(q) === 'locked') return json(res, 423, { reason: 'vaultLocked' })
    let path: string
    try {
      path = await attachmentOnDisk(hub.deps, msg, att)
    } catch {
      // IMAP hata metni yanıta gitmez
      return json(res, 502, { reason: 'fetchFailed' })
    }
    const root = resolve(hub.deps.attachDir)
    let size: number
    try {
      if (!resolve(path).startsWith(root + sep)) throw new Error('kök dışı')
      const st = statSync(path)
      if (!st.isFile()) throw new Error('dosya değil')
      size = st.size
    } catch {
      return json(res, 404, { reason: 'notFound' })
    }
    res.writeHead(200, {
      ...securityHeaders({ https, api: true }),
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
      'Content-Disposition': contentDisposition(att.filename ?? FALLBACK_NAME)
    })
    if (head) {
      res.end()
      return true
    }
    const stream = createReadStream(path)
    // okuma hatası (dosya bu arada silindi): başlık gitti, bağlantı kesilir
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return true
  }

  const smimeDownload = (res: ServerResponse, user: SessionUser, messageId: number, index: number, head: boolean): true => {
    const msg = q.getMessage(messageId)
    if (!msg) return json(res, 404, { reason: 'notFound' })
    if (!userCanView(q, user, msg.accountId)) return json(res, 403, { reason: 'forbidden' })
    const att = hub.smimeCache.get(user.id, messageId)?.attachments.find((a) => a.index === index)
    if (!att) return json(res, 410, { reason: 'gone' })
    res.writeHead(200, {
      ...securityHeaders({ https, api: true }),
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(att.content.length),
      'Content-Disposition': contentDisposition(att.filename ?? FALLBACK_NAME),
      'Cache-Control': 'no-store'
    })
    res.end(head ? undefined : Buffer.from(att.content)) // kopya: önbellek silinince yazılmakta olan bayt sıfırlanmasın
    return true
  }

  const upload = async (req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<true> => {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/octet-stream') return json(res, 415, { reason: 'contentType' })
    // aşımda gövdenin kalanı okunmaz: bağlantı yanıttan sonra kapanır
    const cl = req.headers['content-length']
    if (cl !== undefined && !/^\d{1,15}$/.test(cl)) return json(res, 400, { reason: 'invalid' }, { Connection: 'close' })
    const declared = cl === undefined ? null : Number(cl)
    if (declared != null && declared > UPLOAD_LIMIT) return json(res, 413, { reason: 'tooLarge' }, { Connection: 'close' })
    // uzunluk bildirilmediyse (chunked) en kötü durum ayrılır
    const reserved = store.reserve(sessionId, declared ?? UPLOAD_LIMIT)
    if (reserved === 'quota') return json(res, 413, { reason: 'quota' }, { Connection: 'close' })
    if (reserved === 'full') return json(res, 507, { reason: 'storageFull' }, { Connection: 'close' })
    const filename = displayName(req.headers['x-filename'])
    const path = join(store.dir, randomBytes(16).toString('hex'))
    let r: Receive
    try {
      r = await receive(req, path, UPLOAD_LIMIT, o.receiveLimits ?? ATTACHMENT_RECEIVE)
    } finally {
      reserved()
    }
    if (!r.ok) {
      if (res.destroyed || res.headersSent) return true
      return json(res, r.status, { reason: receiveReason(r.status) }, { Connection: 'close' })
    }
    const uploadId = store.add({ path, size: r.size, filename, owner: sessionId, createdAt: (o.now ?? Date.now)() })
    return json(res, 200, { uploadId })
  }

  const routes = (async (req, res, user, sessionId) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/api/upload') return req.method === 'POST' ? upload(req, res, sessionId) : false
    const d = /^\/api\/upload\/([0-9a-f]{32})$/.exec(path)
    if (d && req.method === 'DELETE') {
      if (!store.discard(d[1], sessionId)) return json(res, 404, { reason: 'notFound' })
      res.writeHead(204, securityHeaders({ https, api: true })).end()
      return true
    }
    const m = /^\/api\/attachment\/(\d{1,15})\/(\d{1,15})$/.exec(path)
    if (m && (req.method === 'GET' || req.method === 'HEAD')) return download(res, user, Number(m[1]), Number(m[2]), req.method === 'HEAD')
    const sm = /^\/api\/smime-attachment\/(\d{1,15})\/(\d{1,4})$/.exec(path)
    if (sm && (req.method === 'GET' || req.method === 'HEAD')) return smimeDownload(res, user, Number(sm[1]), Number(sm[2]), req.method === 'HEAD')
    return false
  }) as AttachmentRoutes
  routes.close = () => store.close()
  routes.store = store
  return routes
}
