// Sunucu komut satırı: serve (varsayılan), create-admin <kullanıcı>, reset-2fa <kullanıcı>, unlock <kullanıcı>, reset-vault-throttle, smime-selftest.
// serve dışındaki komutlar DB'yi doğrudan açar; IMAP motorunu/zamanlayıcıyı başlatmaz. Parola yalnız stdin'den
// okunur ve hiçbir çıktıya yazılmaz (terminalde yankısız).
import '../shared/i18n/locales/all' // sunucu iletileri için tüm diller
import { existsSync, readdirSync, renameSync, rmSync } from 'fs'
import { basename, join } from 'path'
import type { Readable, Writable } from 'stream'
import { createLogger, mirrorConsole } from '../shared/jsonlLog'
import { hashPassword } from '../sync/auth/password'
import { openDb } from '../sync/db'
import { makeQueries } from '../sync/db/queries'
import { startEngine, type Engine } from '../sync/engine'
import { setSyncLog } from '../sync/log'
import { resetVaultThrottle } from '../sync/vault/throttle'
import { smimeSelfTest } from '../sync/smime/selfTest'
import type { EngineHost } from '../sync/host'
import { loginKey, WebAuth } from './auth'
import { passkeysAvailable } from './passkeys'
import type { ServerConfig } from './config'
import { createServerHost } from './hosts/serverHost'
import { fsyncFileAndDir, rejectedRestores, RESTORE_PENDING, sqliteIntact, sweepBackupTemps } from './backupRoutes'
import { createHttpServer } from './http'
import { loadOrCreateMasterKey } from './keyfile'
import { serverPushSink, type PushSink } from './pushDevices'
import { RelayClient, relayKeyLoader } from './relayClient'

export interface CliIo { stdin: Readable; stdout: Writable; stderr: Writable }
/** Testler: exit kapanış 10 sn'de bitmezse çağrılan zorla çıkış (varsayılan process.exit); pushHosts izinli push servislerine ek
 *  (ortam değişkeniyle verilmez); onPush uçtan uca testin yeni posta olmadan bildirim vermesi için */
export interface CliOptions { exit?: (code: number) => void; pushHosts?: string[]; onPush?: (push: PushSink) => void }

/** Terminal girişi (process.stdin): yankıyı kapatmak için ham kip */
type TtyReadable = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (raw: boolean) => unknown }

const MIN_PASSWORD = 8
const MAX_LINE = 1024
const SHUTDOWN_MS = 10_000
/** Ev sahibinin fatal'ı çağrıldı (ör. DB bu sürümden yeni): yeniden başlatmak çözmez */
export const EXIT_FATAL = 3
/** Açılışta saklanan geri yükleme öncesi DB kopyası sayısı */
export const KEEP_DB_BACKUPS = 3
export const KEEP_REJECTED_RESTORES = 3

const USAGE = 'kullanım: gecko-server [serve | create-admin <kullanıcı> | reset-2fa <kullanıcı> | unlock <kullanıcı> | reset-vault-throttle | smime-selftest]\n'

type LineResult = { ok: true; value: string } | { ok: false; reason: 'tooLong' | 'cancelled' }

/** Borulanmış stdin'in ilk satırı (sondaki \r\n atılır); veri yoksa boş dize. MAX_LINE baytı aşan satır reddedilir. */
async function readPipedLine(stdin: Readable): Promise<LineResult> {
  let buf = Buffer.alloc(0)
  for await (const chunk of stdin) {
    buf = Buffer.concat([buf, typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)])
    const i = buf.indexOf(0x0a)
    if (i >= 0) {
      buf = buf.subarray(0, i)
      break
    }
    // satır sonu gelmeden sınır aşıldı: kalanı okunmaz (+1: olası \r)
    if (buf.length > MAX_LINE + 1) return { ok: false, reason: 'tooLong' }
  }
  const value = buf.toString('utf-8').replace(/\r$/, '')
  return Buffer.byteLength(value) > MAX_LINE ? { ok: false, reason: 'tooLong' } : { ok: true, value }
}

/** Terminalden yankısız satır: ham kipte karakter karakter okunur (Enter biter, Ctrl-C iptal, geri silme);
 *  önceki kip finally'de geri yüklenir, sonra yeni satır yazılır. */
export async function readTtyLine(stdin: TtyReadable, out: Writable): Promise<LineResult> {
  const wasRaw = !!stdin.isRaw
  stdin.setRawMode!(true)
  try {
    return await new Promise<LineResult>((resolve) => {
      let buf = ''
      const finish = (r: LineResult): void => {
        stdin.off('data', onData)
        stdin.off('end', onEnd)
        stdin.pause()
        resolve(r)
      }
      const onEnd = (): void => finish({ ok: true, value: buf })
      const onData = (chunk: Buffer | string): void => {
        for (const ch of chunk.toString()) {
          if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish({ ok: true, value: buf })
          if (ch === '\u0003') return finish({ ok: false, reason: 'cancelled' })
          if (ch === '\u007f' || ch === '\b') {
            buf = Array.from(buf).slice(0, -1).join('')
            continue
          }
          if (ch < ' ') continue // diğer denetim karakterleri yok sayılır
          buf += ch
          if (Buffer.byteLength(buf) > MAX_LINE) return finish({ ok: false, reason: 'tooLong' })
        }
      }
      stdin.on('data', onData)
      stdin.once('end', onEnd)
      stdin.resume()
    })
  } finally {
    stdin.setRawMode!(wasRaw)
    out.write('\n')
  }
}

function readPassword(io: CliIo): Promise<LineResult> {
  const stdin = io.stdin as TtyReadable
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    io.stderr.write('parola: ')
    return readTtyLine(stdin, io.stderr)
  }
  return readPipedLine(stdin)
}

async function createAdmin(username: string | undefined, io: CliIo, cfg: ServerConfig): Promise<number> {
  if (!username) {
    io.stderr.write(USAGE)
    return 1
  }
  const line = await readPassword(io)
  if (!line.ok) {
    io.stderr.write(line.reason === 'tooLong' ? `parola en çok ${MAX_LINE} bayt olabilir\n` : 'iptal edildi\n')
    return 1
  }
  const password = line.value
  if (password.length < MIN_PASSWORD) {
    io.stderr.write(`parola stdin'den okunur ve en az ${MIN_PASSWORD} karakter olmalı\n`)
    return 1
  }
  const db = openDb(cfg.dataDir)
  try {
    const q = makeQueries(db)
    if (q.getUserByUsername(username)) {
      io.stderr.write(`kullanıcı zaten var: ${username} (değiştirilmedi)\n`)
      return 1
    }
    q.insertUser({ username, passwordHash: hashPassword(password), role: 'admin' })
    io.stdout.write(`yönetici oluşturuldu: ${username}\n`)
    return 0
  } finally {
    db.close()
  }
}

function reset2fa(username: string | undefined, io: CliIo, cfg: ServerConfig): number {
  if (!username) {
    io.stderr.write(USAGE)
    return 1
  }
  const db = openDb(cfg.dataDir)
  try {
    const q = makeQueries(db)
    const user = q.getUserByUsername(username)
    if (!user) {
      io.stderr.write(`kullanıcı yok: ${username}\n`)
      return 1
    }
    q.clearTotp(user.id)
    // telefonu/anahtarı kaybolmuş hesabın temizliği: passkey'ler de gider, yoksa saldırgan girmeyi sürdürür
    const removed = q.deletePasskeysForUser(user.id)
    // çalışan sunucudaki açık soketler 60 sn'lik yeniden doğrulamada kapanır; oturum satırları hemen silinir
    const noHost = {} as EngineHost // revokeUser şifreleme kullanmaz
    new WebAuth(q, noHost).revokeUser(user.id)
    io.stdout.write(`2FA sıfırlandı, ${removed} passkey silindi, oturumlar kapatıldı: ${username}\n`)
    return 0
  } finally {
    db.close()
  }
}

/** Giriş kilidini kaldırır: kullanıcı adının deneme kayıtları (WebAuth'un anahtarıyla) silinir */
function unlock(username: string | undefined, io: CliIo, cfg: ServerConfig): number {
  if (!username) {
    io.stderr.write(USAGE)
    return 1
  }
  const db = openDb(cfg.dataDir)
  try {
    const q = makeQueries(db)
    // WebAuth kullanıcıyı kırpılmış adla arar
    if (!q.getUserByUsername(username.trim())) {
      io.stderr.write(`kullanıcı yok: ${username}\n`)
      return 1
    }
    const n = q.deleteWebLoginAttemptsForUser(loginKey(username))
    io.stdout.write(`giriş kilidi kaldırıldı: ${username} (${n} deneme kaydı silindi)\n`)
    return 0
  } finally {
    db.close()
  }
}

/** Kasa parolası deneme sınırı kurtarması: tüm kovalar ve 24 saatlik bütçeler silinir (yönetici de kilitlenmişse) */
function resetVaultThrottleCmd(io: CliIo, cfg: ServerConfig): number {
  const db = openDb(cfg.dataDir)
  try {
    resetVaultThrottle(makeQueries(db))
    io.stdout.write('kasa parola sınırı sıfırlandı\n')
    return 0
  } finally {
    db.close()
  }
}

export type PendingRestore = { applied: boolean } | { rejected: string } | { error: string }

/** Hazırlanmış geri yüklemeyi (restore-pending.db) motor açılmadan uygular. Önce quick_check: geçmezse mevcut
 *  DB'ye dokunulmaz, bekleyen dosya restore-pending.db.rejected-<zaman> olur ve sunucu mevcut DB ile açılır.
 *  Geçerse mevcut DB (ve WAL/SHM'si) geckomail.db.bak-<zaman> olur, bekleyen dosya yerine geçer. Takas
 *  sırasında bir adım başarısızsa yapılan taşımalar geri alınır — mevcut DB yerinde kalır, yarım değişim olmaz;
 *  çağıran ölümcül kodla çıkar. rename yalnız testlerde verilir. */
export function applyPendingRestore(
  dataDir: string,
  o: { now?: Date; rename?: (from: string, to: string) => void } = {}
): PendingRestore {
  const pending = join(dataDir, RESTORE_PENDING)
  if (!existsSync(pending)) return { applied: false }
  const rename = o.rename ?? renameSync
  const stamp = (o.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  if (!sqliteIntact(pending, false)) {
    const rejected = `${pending}.rejected-${stamp}`
    try {
      rename(pending, rejected)
      fsyncFileAndDir(rejected)
    } catch (e) {
      return { error: (e as Error).message }
    }
    return { rejected }
  }
  const db = join(dataDir, 'geckomail.db')
  const bak = `${db}.bak-${stamp}`
  const moves: [string, string][] = []
  for (const s of ['', '-wal', '-shm']) if (existsSync(db + s)) moves.push([db + s, bak + s])
  moves.push([pending, db])
  const done: [string, string][] = []
  try {
    for (const [from, to] of moves) {
      rename(from, to)
      done.push([from, to])
    }
    fsyncFileAndDir(db)
    return { applied: true }
  } catch (e) {
    for (const [from, to] of done.reverse()) {
      try {
        rename(to, from)
      } catch {
        /* geri alma da olmadı: hata satırı dosya adlarını verir */
      }
    }
    return { error: (e as Error).message }
  }
}

/** Geri yükleme öncesi DB kopyalarından (geckomail.db.bak-*) en yeni KEEP_DB_BACKUPS tanesi kalır; silinen sayısı */
export function pruneDbBackups(dataDir: string): number {
  const baks = readdirSync(dataDir).filter((f) => /^geckomail\.db\.bak-[0-9TZ-]+$/.test(f)).sort().reverse()
  for (const f of baks.slice(KEEP_DB_BACKUPS)) {
    for (const s of ['', '-wal', '-shm']) rmSync(join(dataDir, f + s), { force: true })
  }
  return Math.max(0, baks.length - KEEP_DB_BACKUPS)
}

/** Reddedilen geri yükleme dosyalarından (restore-pending.db.rejected-*) en yeni KEEP_REJECTED_RESTORES tanesi kalır:
 *  biri 2 GB olabilir, tekrarlanan denemeler diski doldurmasın */
export function pruneRejectedRestores(dataDir: string): number {
  const old = rejectedRestores(dataDir).slice(KEEP_REJECTED_RESTORES)
  for (const f of old) rmSync(join(dataDir, f), { force: true })
  return old.length
}

async function serve(io: CliIo, cfg: ServerConfig, opts: CliOptions = {}): Promise<number> {
  const log = createLogger(join(cfg.dataDir, 'logs'), 'sync')
  mirrorConsole(log)
  setSyncLog(log)

  sweepBackupTemps(cfg.dataDir)
  const restored = applyPendingRestore(cfg.dataDir)
  if ('error' in restored) {
    // takas yarıda kaldı, geri alındı: mevcut DB yerinde; yeniden başlatmak çözmez (operatör incelemeli)
    const line = `gecko: geri yükleme uygulanamadı, mevcut veritabanı korundu (${RESTORE_PENDING} yerinde): ${restored.error}`
    console.error(line)
    io.stderr.write(line + '\n')
    return EXIT_FATAL
  }
  if ('rejected' in restored) {
    console.error(`gecko: bekleyen geri yükleme bütünlük denetiminden geçmedi; mevcut veritabanıyla açılıyor (dosya: ${basename(restored.rejected)})`)
  } else if (restored.applied) {
    console.log('gecko: yedekten geri yükleme uygulandı; önceki veritabanı geckomail.db.bak-* olarak saklandı')
  }
  const pruned = pruneDbBackups(cfg.dataDir)
  if (pruned) console.log(`gecko: eski geri yükleme öncesi kopyalardan ${pruned} tanesi silindi (en yeni ${KEEP_DB_BACKUPS} kalır)`)
  const prunedRejected = pruneRejectedRestores(cfg.dataDir)
  if (prunedRejected) console.log(`gecko: reddedilen eski geri yükleme dosyalarından ${prunedRejected} tanesi silindi (en yeni ${KEEP_REJECTED_RESTORES} kalır)`)

  const key = loadOrCreateMasterKey(cfg.keyFile)
  let engine: Engine | null = null
  let fatal = false
  let push: PushSink | undefined
  let relay: RelayClient | undefined
  const host = createServerHost(key, () => engine?.hub ?? null, () => (fatal = true))
  try {
    engine = startEngine({
      userData: cfg.dataDir, host, mode: 'server', idleMax: cfg.idleMax, davPrivateHosts: cfg.davPrivateHosts, mailPrivateHosts: cfg.mailPrivateHosts,
      notifySink: (q, hub) => {
        if (cfg.relayUrl && cfg.mobileEnabled !== false) relay = new RelayClient({ url: cfg.relayUrl, keys: relayKeyLoader(q, host) })
        return (push = serverPushSink({ q, host, hub, publicOrigin: cfg.publicOrigin, extraHosts: opts.pushHosts, relay }))
      }
    })
  } catch (e) {
    // ölümcül hata ev sahibince günlüğe yazıldı; yeniden başlatma döngüsü ayırt edebilsin diye ayrı kod
    if (fatal) return EXIT_FATAL
    throw e
  }
  const { hub } = engine
  if (push) opts.onPush?.(push)
  const auth = new WebAuth(hub.deps.q, host)
  // yeniden başlatma isteği aynı düzgün kapanıştan geçer (çıkış 0; Docker restart: unless-stopped yeniden açar)
  let shutdown: (why: string) => void = () => {}
  const server = createHttpServer({ cfg, hub, auth, onRestart: () => shutdown('yeniden başlatma'), pushHosts: opts.pushHosts, relay })

  if (hub.deps.q.userCount() === 0) {
    console.log('gecko: hiç kullanıcı yok — yönetici oluşturmak için: gecko-server create-admin <kullanıcı> (parola stdin\'den)')
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.listenPort, cfg.listenHost, () => {
      server.off('error', reject)
      resolve()
    })
  }).catch(async (e: Error) => {
    io.stderr.write(`dinlenemedi (${cfg.listenHost}:${cfg.listenPort}): ${e.message}\n`)
    push?.close()
    await engine?.stop()
    throw e
  })
  console.log(`gecko: dinleniyor ${cfg.listenHost}:${cfg.listenPort}`)
  if (!passkeysAvailable(cfg.publicOrigin)) console.log('gecko: GECKO_PUBLIC_ORIGIN bir IP adresi: passkey kullanılamaz (WebAuthn alan adı ister)')

  return new Promise<number>((resolve) => {
    let closing = false
    const onTerm = (): void => shutdown('SIGTERM')
    const onInt = (): void => shutdown('SIGINT')
    shutdown = (sig: string): void => {
      if (closing) return
      closing = true
      process.off('SIGTERM', onTerm)
      process.off('SIGINT', onInt)
      console.log(`gecko: ${sig} alındı, kapanıyor`)
      // 10 sn içinde bitmezse zorla çık
      const force = setTimeout(() => (opts.exit ?? process.exit)(1), SHUTDOWN_MS)
      force.unref()
      const finish = (code: number): void => {
        clearTimeout(force)
        resolve(code)
      }
      // kapanan sunucunun dinleme soketi de bırakılsın (aynı süreçte yeniden açılış: testler); close()'tan önce
      // dinlenir, sonra listening false olur
      const closed = new Promise<void>((r) => (server.listening ? server.once('close', () => r()) : r()))
      // yeni bağlantı reddedilir, soketler 1001 ile kapanır; ardından motor durur
      server.close()
      server.closeAllConnections()
      // bekleyen push gönderimleri kapanan DB'ye dokunmasın
      push?.close()
      void engine!.stop().then(
        () => closed.then(() => finish(0)),
        (e: Error) => {
          io.stderr.write(`motor durdurulamadı: ${e.message}\n`)
          finish(1)
        }
      )
    }
    process.once('SIGTERM', onTerm)
    process.once('SIGINT', onInt)
  })
}

export async function runCli(argv: string[], io: CliIo, cfg: ServerConfig, opts: CliOptions = {}): Promise<number> {
  const [cmd = 'serve', arg] = argv
  try {
    if (cmd === 'serve') return await serve(io, cfg, opts)
    if (cmd === 'create-admin') return await createAdmin(arg, io, cfg)
    if (cmd === 'reset-2fa') return reset2fa(arg, io, cfg)
    if (cmd === 'unlock') return unlock(arg, io, cfg)
    if (cmd === 'reset-vault-throttle') return resetVaultThrottleCmd(io, cfg)
    if (cmd === 'smime-selftest') {
      await smimeSelfTest()
      io.stdout.write('smime: hazır\n')
      return 0
    }
  } catch (e) {
    io.stderr.write(`hata: ${(e as Error).message}\n`)
    return 1
  }
  io.stderr.write(USAGE)
  return 1
}
