// Playwright düzeneği: derlenmiş sunucuyu (out/server/index.mjs, web dosyaları out/web) her test için geçici
// veri dizininde ve boş bir portta başlatır, CLI ile yönetici açar. Burada derleme yapılmaz (npm run test:e2e
// önce build:server çalıştırır). DB'ye doğrudan erişim (tercih, örnek posta) better-sqlite3 ile; sunucu
// tercihleri her istekte DB'den okur, çalışırken yazmak yeterli. Örnek hesapların IMAP'i zararsızca başarısız olur.
// pushService seçeneği sunucuyu e2e/pushServer.ts'ten başlatır (yerel sahte push servisi, stdin'den bildirim).
import { test as base, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startDav, type FakeDav } from './davServer'
import { seedMail } from './seed'

const ROOT = resolve(__dirname, '..')
const SERVER = join(ROOT, 'out', 'server', 'index.mjs')
const PUSH_SERVER = join(ROOT, 'out', 'e2e-server', 'index.mjs')
const WEB = join(ROOT, 'out', 'web', 'index.html')

export const ADMIN = { username: 'yonetici', password: 'yonetici-parola-1' }

export type CliResult = { code: number | null; stdout: string; stderr: string }

/** Bildirim hattının PushSink'e verdiği öge (e2e/pushServer.ts) */
export interface PushItemInput { title: string; body: string; accountId: number | null; messageId: number | null; level: 'normal' | 'urgent'; tag: string; count: number }

export interface GeckoServer {
  url: string
  dataDir: string
  /** Sunucu CLI'si (create-admin, reset-2fa, unlock…); stdin verilirse borulanır */
  cli(args: string[], stdin?: string): Promise<CliResult>
  /** CLI create-admin ile kullanıcı (rolü admin) */
  createUser(username: string, password: string): Promise<void>
  setPref(key: string, value: string): void
  /** DB'yi açıp kapatır (sunucu çalışırken de: WAL + busy_timeout) */
  withDb<T>(fn: (db: Database.Database) => T): T
  /** Sunucunun şimdiye dek yazdıkları (hata ayıklama için) */
  logs(): string
  /** Docker'ın restart: unless-stopped'u gibi: süreç (POST /api/restart ile) çıkınca aynı ortamla yeniden açar;
   *  çıkış kodunu döner */
  restartAfterExit(): Promise<number | null>
  /** Sunucuyu durdurur (ulaşılamayan sunucu); restartAfterExit aynı ortamla yeniden açar */
  stop(): Promise<void>
  /** Yalnız pushService: gerçek posta olmadan kullanıcıya bildirim */
  deliver(userId: number, item: PushItemInput): void
}

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer()
    s.unref()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const port = typeof a === 'object' && a ? a.port : 0
      s.close(() => res(port))
    })
  })

function run(env: NodeJS.ProcessEnv, args: string[], stdin?: string): Promise<CliResult> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [SERVER, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('error', rej)
    p.on('close', (code) => res({ code, stdout, stderr }))
    p.stdin.end(stdin ?? '')
  })
}

async function waitHealthy(url: string, proc: ChildProcess, logs: () => string): Promise<void> {
  const until = Date.now() + 20_000
  while (Date.now() < until) {
    if (proc.exitCode != null) throw new Error(`sunucu açılmadan çıktı (${proc.exitCode}):\n${logs()}`)
    try {
      const r = await fetch(`${url}/healthz`)
      if (r.ok) return
    } catch {
      /* henüz dinlemiyor */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`sunucu 20 sn içinde hazır olmadı:\n${logs()}`)
}

export { seedMail, type SeedMail } from './seed'

/** Takvim ekli ileti (IMAP'e gidilmez): davet kartı eki diskten okur */
export function seedInvite(server: GeckoServer, ics: string, from = 'org@example.test'): { messageId: number; attachmentId: number; subject: string } {
  const dir = join(server.dataDir, 'attachments')
  mkdirSync(dir, { recursive: true })
  const diskPath = join(dir, 'davet.ics')
  writeFileSync(diskPath, ics)
  const subject = 'Toplantı daveti iletisi'
  return server.withDb((db) => {
    const { messageIds } = seedMail(db, { messages: [{ subject, from }] })
    const messageId = messageIds[0]
    db.prepare(`UPDATE messages SET has_attachments = 1 WHERE id = ?`).run(messageId)
    db.prepare(`INSERT INTO bodies (message_id, text_plain, html, fetched_at, last_access_at, raw_size) VALUES (?, 'Davet gövdesi', NULL, ?, ?, 10)`).run(messageId, Date.now(), Date.now())
    const r = db.prepare(`INSERT INTO attachments (message_id, part_id, filename, mime, size, content_id, disk_path, fetched_at, last_access_at) VALUES (?, NULL, 'invite.ics', 'text/calendar', ?, NULL, ?, ?, ?)`)
      .run(messageId, Buffer.byteLength(ics), diskPath, Date.now(), Date.now())
    return { messageId, attachmentId: Number(r.lastInsertRowid), subject }
  })
}

/** Örnek ileti + önbellekte gövde + diskte ek (IMAP'e gidilmez) */
export function seedAttachment(server: GeckoServer, filename: string, content: Buffer): { messageId: number; attachmentId: number } {
  const dir = join(server.dataDir, 'attachments')
  mkdirSync(dir, { recursive: true })
  const diskPath = join(dir, 'e2e-ek.bin')
  writeFileSync(diskPath, content)
  return server.withDb((db) => {
    const { messageIds } = seedMail(db, { messages: [{ subject: 'E2E ekli ileti' }] })
    const messageId = messageIds[0]
    db.prepare(`UPDATE messages SET has_attachments = 1 WHERE id = ?`).run(messageId)
    db.prepare(`INSERT INTO bodies (message_id, text_plain, html, fetched_at, last_access_at, raw_size) VALUES (?, ?, NULL, ?, ?, ?)`)
      .run(messageId, 'Ekli ileti gövdesi', Date.now(), Date.now(), content.length)
    const r = db
      .prepare(
        `INSERT INTO attachments (message_id, part_id, filename, mime, size, content_id, disk_path, fetched_at, last_access_at)
         VALUES (?, '2', ?, 'application/pdf', ?, NULL, ?, ?, ?)`
      )
      .run(messageId, filename, content.length, diskPath, Date.now(), Date.now())
    return { messageId, attachmentId: Number(r.lastInsertRowid) }
  })
}

export const test = base.extend<{ server: GeckoServer; publicHost: string; pushService: boolean; dav: FakeDav | null; withDav: boolean }>({
  // Kamu adresinin ana makinesi. WebAuthn IP'yi RP ID kabul etmez: passkey testleri 'localhost' seçer
  publicHost: ['127.0.0.1', { option: true }],
  pushService: [false, { option: true }],
  withDav: [false, { option: true }],
  dav: async ({ withDav }, provide) => {
    const d = withDav ? await startDav() : null
    await provide(d)
    await d?.close()
  },
  server: async ({ publicHost, pushService, dav }, provide, testInfo) => {
    if (!existsSync(SERVER) || !existsSync(WEB) || (pushService && !existsSync(PUSH_SERVER))) throw new Error('derleme yok: önce npm run test:e2e')
    const dataDir = mkdtempSync(join(tmpdir(), 'gecko-e2e-'))
    const port = await freePort()
    const url = `http://${publicHost}:${port}`
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GECKO_DATA_DIR: dataDir,
      GECKO_LISTEN: `127.0.0.1:${port}`,
      GECKO_PUBLIC_ORIGIN: url,
      ...(dav ? { GECKO_DAV_PRIVATE_HOSTS: new URL(dav.url).host } : {})
    }
    const cli = (args: string[], stdin?: string) => run(env, args, stdin)
    const createUser = async (username: string, password: string): Promise<void> => {
      const r = await cli(['create-admin', username], `${password}\n`)
      if (r.code !== 0) throw new Error(`create-admin başarısız (${r.code}): ${r.stderr}`)
    }
    await createUser(ADMIN.username, ADMIN.password)

    let out = ''
    const launch = (): ChildProcess => {
      const p = spawn(process.execPath, [pushService ? PUSH_SERVER : SERVER], { env, stdio: [pushService ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
      p.stdout!.on('data', (d) => (out += d))
      p.stderr!.on('data', (d) => (out += d))
      return p
    }
    let proc = launch()
    const logs = (): string => out
    const withDb = <T,>(fn: (db: Database.Database) => T): T => {
      const db = new Database(join(dataDir, 'geckomail.db'))
      try {
        db.pragma('busy_timeout = 5000')
        return fn(db)
      } finally {
        db.close()
      }
    }
    try {
      await waitHealthy(url, proc, logs)
      await provide({
        url,
        dataDir,
        cli,
        createUser,
        setPref: (key, value) =>
          withDb((db) => db.prepare(`INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)),
        withDb,
        logs,
        deliver: (userId, item) => void proc.stdin!.write(`${JSON.stringify({ userId, item })}\n`),
        async stop() {
          if (proc.exitCode != null) return
          const exited = new Promise((r) => proc.once('exit', r))
          proc.kill('SIGTERM')
          await exited
        },
        async restartAfterExit() {
          const code = proc.exitCode ?? (await new Promise<number | null>((r) => proc.once('exit', (c) => r(c))))
          proc = launch()
          await waitHealthy(url, proc, logs)
          return code
        }
      })
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) await testInfo.attach('sunucu-gunlugu', { body: out, contentType: 'text/plain' })
      if (proc.exitCode == null) {
        const exited = new Promise((r) => proc.once('exit', r))
        proc.kill('SIGTERM')
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
        if (proc.exitCode == null) proc.kill('SIGKILL')
      }
      rmSync(dataDir, { recursive: true, force: true })
    }
  },

  // ilk açılış dil sorusu (karşılama ekranı) atlanır: arayüz Türkçe
  page: async ({ page }, provide) => {
    await page.addInitScript(() => {
      try {
        if (!localStorage.getItem('gecko-locale')) localStorage.setItem('gecko-locale', 'tr')
      } catch {
        /* depo kapalı */
      }
    })
    await provide(page)
  }
})

export { expect }
