// Yedekleme ve geri yükleme HTTP üzerinden (sunucu modu, yalnız yönetici). Masaüstünün backupToFile/stageRestore
// RPC'leri sunucunun dosya sistemindeki yola yazdığı için sunucu modunda kapalı; web bunları kullanır:
//   POST /api/backup          JSON { passphrase } → .geckobak indirme (masaüstüyle aynı biçim: DB anlık görüntüsü,
//                             ekler hariç — diskteki ekler önbellektir, IMAP'ten yeniden iner). X-Gecko-Restorable: 0
//                             → dosya yükleme sınırını aşıyor, arayüzden geri yüklenemez
//   POST /api/restore/upload  application/octet-stream (≤ 2 GB, uzunluk bildirilmeli) → { uploadId }; ek yükleme
//                             deposunda (attachments.ts) ama kendi bütçesiyle, yalnız yükleyen oturum ve yalnız geri
//                             yükleme için
//   POST /api/restore/stage   JSON { uploadId, passphrase } → çözülür, bütünlüğü ve sürümü denetlenir,
//                             dataDir/restore-pending.db (geçici dosya + fsync + rename); { restartRequired: true }.
//                             Yanlış parolada ya da bozuk içerikte yükleme kalır.
//   GET  /api/restore/status  → { staged, stagedAt?, rejectedAt? } (rejectedAt: son geri yükleme açılışta reddedildi)
//   POST /api/restore/cancel  → bekleyen geri yükleme silinir
//   POST /api/restart         → tüm oturumlara 'server:restarting', ardından düzgün kapanış (çıkış kodu 0;
//                             Docker restart: unless-stopped yeniden başlatır). serve açılışı bekleyeni uygular.
// Çerez, rol ve aynı köken denetimi http.ts'te. Parola hiçbir günlüğe, yanıta, başlığa yazılmaz.
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { closeSync, createReadStream, fsyncSync, openSync, readdirSync, renameSync, rmSync, statfsSync, statSync } from 'fs'
import type { IncomingMessage, ServerResponse } from 'http'
import { dirname, join } from 'path'
import { BackupError, sealBackupFile, openBackupFile } from '../sync/backupFile'
import { MIGRATIONS } from '../sync/db'
import type { RpcHub } from '../sync/rpcHub'
import { receive, receiveReason, RESTORE_RECEIVE, RESTORE_UPLOAD_LIMIT, type ReceiveLimits, type UploadStore } from './attachments'
import { securityHeaders } from './securityHeaders'

export const RESTORE_PENDING = 'restore-pending.db'
const PASS_MAX = 1024
const TMP_RE = /^(yedek|geri-yukleme)-[0-9a-f]{16}\.tmp(-wal|-shm|-journal)?$/
/** Bu boyutun üstünde integrity_check yerine quick_check: tam denetim dizin içeriklerini tablolarla karşılaştırır
 *  (O(N log N)), GB'lık DB'de dakikalar sürer ve better-sqlite3 eşzamanlı olduğundan sunucuyu bekletir;
 *  quick_check sayfa/biçim bozukluğunu (asıl risk: bozuk/yarım dosya) doğrusal sürede yakalar */
export const INTEGRITY_FULL_MAX = 500 * 1024 * 1024

const REJECTED_PREFIX = `${RESTORE_PENDING}.rejected-`
const BAK_PREFIX = 'geckomail.db.bak-'
const STAMP = '[0-9TZ-]+'

/** Reddedilen geri yükleme dosyaları, en yeni başta (ad ISO zaman damgasıyla sıralanır) */
export function rejectedRestores(dataDir: string): string[] {
  const re = new RegExp(`^${REJECTED_PREFIX.replace(/\./g, '\\.')}${STAMP}$`)
  return readdirSync(dataDir).filter((f) => re.test(f)).sort().reverse()
}

/** Son geri yükleme reddedildiyse zamanı: reddedilenden sonra başarıyla uygulanan (geckomail.db.bak-* bırakan) varsa yok */
export function lastRejectedAt(dataDir: string): number | undefined {
  const name = rejectedRestores(dataDir)[0]
  if (!name) return undefined
  const stamp = name.slice(REJECTED_PREFIX.length)
  const applied = readdirSync(dataDir).filter((f) => f.startsWith(BAK_PREFIX) && !/-(wal|shm)$/.test(f)).map((f) => f.slice(BAK_PREFIX.length))
  if (applied.some((a) => a > stamp)) return undefined
  // 2026-11-04T10-20-30-123Z → ISO
  const iso = /^(.+T\d\d)-(\d\d)-(\d\d)-(\d{3}Z)$/.exec(stamp)
  const at = iso ? Date.parse(`${iso[1]}:${iso[2]}:${iso[3]}.${iso[4]}`) : NaN
  return Number.isNaN(at) ? undefined : at
}

/** Dosyayı ve (rename'in kalıcı olması için) dizinini diske yazdırır */
export function fsyncFileAndDir(path: string): void {
  for (const p of [path, dirname(path)]) {
    const fd = openSync(p, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}

/** SQLite bütünlük denetimi (salt okunur). Bozuksa ya da açılamıyorsa false. */
export function sqliteIntact(path: string, full: boolean): boolean {
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true })
    try {
      const rows = db.pragma(full ? 'integrity_check' : 'quick_check') as Record<string, unknown>[]
      return rows.length === 1 && Object.values(rows[0])[0] === 'ok'
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

export type BackupRoutes = (req: IncomingMessage, res: ServerResponse, sessionId: string, body: () => Promise<Record<string, unknown> | null>) => Promise<boolean>

/** Önceki çalışmadan kalan yarım yedek/geri yükleme geçici dosyaları (açılışta) */
export function sweepBackupTemps(dataDir: string): void {
  for (const f of readdirSync(dataDir)) if (TMP_RE.test(f)) rmSync(join(dataDir, f), { force: true })
}

/** dataDir'in bulunduğu dosya sistemindeki boş alan (bayt) */
export function diskFree(dir: string): number {
  const s = statfsSync(dir)
  return Number(s.bavail) * Number(s.bsize)
}

export function createBackupRoutes(o: {
  hub: RpcHub; dataDir: string; https: boolean; store: UploadStore; now?: () => number
  /** yeniden başlatma: yanıt gittikten sonra çağrılır (serve düzgün kapanır, çıkış 0) */
  onRestart?: () => void
  /** testler: boş alan ölçümü */
  freeBytes?: (dir: string) => number
  /** testler: kısa durgunluk süresi */
  receiveLimits?: ReceiveLimits
  /** testler: geri yüklenebilir en büyük yedek */
  restoreLimit?: number
}): BackupRoutes {
  const { hub, dataDir, https, store } = o
  const now = o.now ?? Date.now
  const freeBytes = o.freeBytes ?? diskFree
  const restoreLimit = o.restoreLimit ?? RESTORE_UPLOAD_LIMIT
  const pendingPath = join(dataDir, RESTORE_PENDING)
  // yedek alma ve geri yükleme hazırlama aynı anda tek: disk kullanımı iki katına çıkmasın
  let busy = false
  const tmp = (kind: 'yedek' | 'geri-yukleme'): string => join(dataDir, `${kind}-${randomBytes(8).toString('hex')}.tmp`)

  const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): true => {
    if (res.destroyed || res.headersSent) return true // istemci koptu
    const text = JSON.stringify(body)
    res.writeHead(status, {
      ...securityHeaders({ https, api: true }), ...extra,
      'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text))
    })
    res.end(text)
    return true
  }

  const backup = async (res: ServerResponse, b: Record<string, unknown>): Promise<true> => {
    const pass = b.passphrase
    if (typeof pass !== 'string' || pass.length > PASS_MAX) return json(res, 400, { reason: 'invalid' })
    if (pass.length < 8) return json(res, 400, { reason: 'passphraseTooShort' })
    if (busy) return json(res, 409, { reason: 'busy' })
    busy = true
    // kopuş, await'lerden önce dinlenir: anlık görüntü/şifreleme sürerken gelen 'close' kaçmasın
    let closed = false
    const done = new Promise<void>((r) => res.once('close', () => {
      closed = true
      r()
    }))
    const snap = tmp('yedek')
    const sealed = tmp('yedek')
    try {
      try {
        await hub.deps.q.backupTo(snap) // SQLite çevrimiçi yedek API'si: tutarlı anlık görüntü
        if (closed) return true
        await sealBackupFile(snap, sealed, pass)
      } finally {
        rmSync(snap, { force: true })
      }
      if (closed || res.destroyed) return true
      const date = new Date(now()).toISOString().slice(0, 10)
      const size = statSync(sealed).size
      res.writeHead(200, {
        ...securityHeaders({ https, api: true }),
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
        'Content-Disposition': `attachment; filename="geckomail-${date}.geckobak"`,
        'X-Gecko-Restorable': size <= restoreLimit ? '1' : '0'
      })
      const stream = createReadStream(sealed)
      stream.on('error', () => res.destroy())
      stream.pipe(res)
      await done // bitti ya da istemci koptu
      stream.destroy()
      return true
    } catch {
      if (!res.headersSent) return json(res, 500, { reason: 'internal' })
      res.destroy()
      return true
    } finally {
      rmSync(sealed, { force: true })
      busy = false
    }
  }

  const upload = async (req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<true> => {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/octet-stream') return json(res, 415, { reason: 'contentType' })
    // 2 GB'a kadar: en kötü durumu ayırmamak için uzunluk zorunlu (tarayıcı fetch(File) bildirir)
    const cl = req.headers['content-length']
    if (cl === undefined) return json(res, 411, { reason: 'lengthRequired' }, { Connection: 'close' })
    if (!/^\d{1,15}$/.test(cl)) return json(res, 400, { reason: 'invalid' }, { Connection: 'close' })
    const declared = Number(cl)
    if (declared > RESTORE_UPLOAD_LIMIT) return json(res, 413, { reason: 'tooLarge' }, { Connection: 'close' })
    // yüklenen dosya + çözülmüş kopyası için yer olmalı
    let free: number
    try {
      free = freeBytes(dataDir)
    } catch {
      free = Number.POSITIVE_INFINITY // ölçülemiyorsa yazma hatası yine yakalanır
    }
    if (free < 2 * declared) return json(res, 507, { reason: 'storageFull' }, { Connection: 'close' })
    const reserved = store.reserve(sessionId, declared, 'restore')
    if (typeof reserved !== 'function') return json(res, 409, { reason: 'busy' }, { Connection: 'close' })
    const path = join(store.dir, randomBytes(16).toString('hex'))
    let r
    try {
      // bildirilen uzunluğun ötesi kabul edilmez
      r = await receive(req, path, declared, o.receiveLimits ?? RESTORE_RECEIVE)
    } finally {
      reserved()
    }
    if (!r.ok) return json(res, r.status, { reason: receiveReason(r.status) }, { Connection: 'close' })
    const uploadId = store.add({ path, size: r.size, filename: 'geri-yukleme', owner: sessionId, createdAt: now(), purpose: 'restore' })
    return json(res, 200, { uploadId })
  }

  const stage = async (res: ServerResponse, sessionId: string, b: Record<string, unknown>): Promise<true> => {
    const { uploadId, passphrase } = b
    if (typeof uploadId !== 'string' || !/^[0-9a-f]{32}$/.test(uploadId)) return json(res, 400, { reason: 'invalid' })
    if (passphrase != null && (typeof passphrase !== 'string' || passphrase.length > PASS_MAX)) return json(res, 400, { reason: 'invalid' })
    const up = store.get(uploadId, sessionId, 'restore')
    if (!up) return json(res, 404, { reason: 'notFound' })
    if (busy) return json(res, 409, { reason: 'busy' })
    busy = true
    const out = tmp('geri-yukleme')
    const cleanup = (): void => {
      for (const s of ['', '-wal', '-shm', '-journal']) rmSync(out + s, { force: true })
    }
    try {
      try {
        // parolasız düz .sqlite yedeği de kabul edilir (masaüstüyle aynı: şifresiz yedek seçeneği var)
        await openBackupFile(up.path, out, (passphrase as string | undefined) || undefined)
      } catch (e) {
        // yükleme kalır: doğru parolayla yeniden denenebilir
        if (e instanceof BackupError) return json(res, 400, { reason: e.code === 'passphraseRequired' ? 'badPassphrase' : e.code })
        throw e
      }
      // önce salt okunur bütünlük denetimi (bozuk dosyaya yazmadan); sonra sürüm/hesap
      if (!sqliteIntact(out, statSync(out).size <= INTEGRITY_FULL_MAX)) return json(res, 400, { reason: 'unreadable' })
      // yedekteki web oturumları ve onlara bağlı push cihazları geçersiz kılınır (yedek alındıktan sonra kapatılan
      // oturum, kaldırılan cihaz geri gelmesin) ve dosya tek parça (WAL'sız) kalır
      let info: { accounts: number; schemaVersion: number }
      try {
        const db = new Database(out)
        try {
          const schemaVersion = db.pragma('user_version', { simple: true }) as number
          const accounts = (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n
          info = { accounts, schemaVersion }
          if (schemaVersion <= MIGRATIONS.length) {
            db.pragma('journal_mode = DELETE')
            // eski yedeklerde tablolar olmayabilir
            for (const table of ['web_sessions', 'push_devices']) {
              if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)) db.prepare(`DELETE FROM ${table}`).run()
            }
          }
        } finally {
          db.close()
        }
      } catch {
        return json(res, 400, { reason: 'unreadable' })
      }
      if (info.schemaVersion > MIGRATIONS.length) return json(res, 400, { reason: 'tooNew' })
      // kalıcı ve atomik: içerik diske, sonra rename, sonra dizin; yarım dosya hiç bekleyen görünmez
      fsyncFileAndDir(out)
      renameSync(out, pendingPath)
      fsyncFileAndDir(pendingPath)
      store.discard(uploadId, sessionId)
      console.log('gecko: geri yükleme hazırlandı; yeniden başlatınca uygulanır')
      return json(res, 200, { restartRequired: true, ...info })
    } finally {
      cleanup()
      busy = false
    }
  }

  const status = (res: ServerResponse): true => {
    const rejectedAt = lastRejectedAt(dataDir)
    try {
      return json(res, 200, { staged: true, stagedAt: Math.round(statSync(pendingPath).mtimeMs), rejectedAt })
    } catch {
      return json(res, 200, { staged: false, rejectedAt })
    }
  }

  const cancel = (res: ServerResponse): true => {
    if (busy) return json(res, 409, { reason: 'busy' })
    rmSync(pendingPath, { force: true })
    console.log('gecko: bekleyen geri yükleme iptal edildi')
    return json(res, 200, { staged: false })
  }

  const restart = (res: ServerResponse): true => {
    console.log('gecko: yönetici yeniden başlatma istedi')
    hub.broadcast('server:restarting', {})
    res.once('finish', () => setImmediate(() => o.onRestart?.()))
    return json(res, 202, { restarting: true })
  }

  return async (req, res, sessionId, body) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/api/restore/status') return req.method === 'GET' ? status(res) : false
    if (req.method !== 'POST') return false
    if (path === '/api/restore/upload') return upload(req, res, sessionId)
    if (!['/api/backup', '/api/restore/stage', '/api/restore/cancel', '/api/restart'].includes(path)) return false
    const b = await body()
    if (!b) return true // gövde hatası çağıranda yanıtlandı
    if (path === '/api/backup') return backup(res, b)
    if (path === '/api/restore/stage') return stage(res, sessionId, b)
    if (path === '/api/restore/cancel') return cancel(res)
    return restart(res)
  }
}
