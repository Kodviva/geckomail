// Yedekleme ve geri yükleme HTTP üzerinden (yalnız yönetici): serve süreç içinde, çıkış işlevi sahte.
import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import http from 'http'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { Writable, Readable } from 'stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { hashPassword } from '../../sync/auth/password'
import { openDb } from '../../sync/db'
import { makeQueries } from '../../sync/db/queries'
import { applyPendingRestore, KEEP_DB_BACKUPS, KEEP_REJECTED_RESTORES, pruneRejectedRestores, runCli } from '../cli'
import { lastRejectedAt, sqliteIntact } from '../backupRoutes'
import { sealBackup } from '../../sync/backupFile'
import type { ServerConfig } from '../config'

const PW = 'dogru-parola-1'
const PASS = 'yedek-parolasi-1'

class Sink extends Writable {
  text = ''
  override _write(c: Buffer, _e: string, cb: () => void): void {
    this.text += c.toString()
    cb()
  }
}

interface Res { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const p = typeof a === 'object' && a ? a.port : 0
      s.close(() => res(p))
    })
  })

/** Geçerli başlıklı ama sayfaları bozuk SQLite: çok satırlı DB'nin ortasındaki sayfalar rastgele baytla ezilir */
function corruptDb(dir: string): Buffer {
  const d = mkdtempSync(join(dir, 'bozuk-'))
  const db = openDb(d)
  const q = makeQueries(db)
  for (let i = 0; i < 300; i++) q.insertAccount({ email: `h${i}@t.co`, displayName: 'x'.repeat(200), imapHost: 'h', imapPort: 9, smtpHost: 'h', smtpPort: 9, passwordEnc: Buffer.alloc(64, i) })
  db.close()
  const buf = readFileSync(join(d, 'geckomail.db'))
  const page = buf.readUInt16BE(16) || 65536
  for (let p = 2; p * page < buf.length - page; p += 3) Buffer.alloc(page, 0xa5).copy(buf, p * page + 8)
  rmSync(d, { recursive: true, force: true })
  return buf
}

describe('yedek ve geri yükleme (HTTP)', () => {
  let dir: string
  let cfg: ServerConfig
  let origin: string
  let saved: { warn: typeof console.warn; error: typeof console.error; log: typeof console.log }
  let exits: number[]
  let stderr: Sink

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-bkr-'))
    const port = await freePort()
    origin = `http://127.0.0.1:${port}`
    cfg = { dataDir: dir, listenHost: '127.0.0.1', listenPort: port, keyFile: join(dir, 'master.key'), publicOrigin: origin, trustedProxyDepth: 0, webDir: join(dir, 'web') }
    saved = { warn: console.warn, error: console.error, log: console.log }
    console.log = () => {}
    exits = []
    stderr = new Sink()
  })
  afterEach(() => {
    Object.assign(console, saved)
    rmSync(dir, { recursive: true, force: true })
  })

  const withDb = <T>(fn: (q: ReturnType<typeof makeQueries>, db: Database.Database) => T): T => {
    const db = openDb(dir)
    try {
      return fn(makeQueries(db), db)
    } finally {
      db.close()
    }
  }
  const seedUsers = () =>
    withDb((q) => {
      q.insertUser({ username: 'yon', passwordHash: hashPassword(PW), role: 'admin' })
      q.insertUser({ username: 'uye', passwordHash: hashPassword(PW), role: 'member' })
    })
  const addAccount = (email: string) =>
    withDb((q) => q.insertAccount({ email, displayName: null, imapHost: '127.0.0.1', imapPort: 9, smtpHost: '127.0.0.1', smtpPort: 9, passwordEnc: Buffer.from('x') }))
  const accountEmails = () => withDb((q) => q.getAccountRows().map((r) => r.email).sort())

  /** serve'ü başlatır; hazır olana dek /healthz yoklanır. stopped çıkış koduyla biter (async işlev sözü
   *  doğrudan dönerse çağıranın await'i onu benimser: nesneye sarılır) */
  const serve = async (): Promise<{ stopped: Promise<number> }> => {
    let ended = false
    const p = runCli(['serve'], { stdin: Readable.from(['']), stdout: new Sink(), stderr }, cfg, { exit: (c) => void exits.push(c) })
    void p.finally(() => (ended = true))
    for (let i = 0; i < 200 && !ended; i++) {
      const ok = await new Promise<boolean>((resolve) => {
        const r = http.get(`${origin}/healthz`, { timeout: 1000 }, (res) => {
          res.resume()
          resolve(res.statusCode === 200)
        })
        r.on('timeout', () => r.destroy())
        r.on('error', () => resolve(false))
      })
      if (ok) return { stopped: p }
      await new Promise((r) => setTimeout(r, 50))
    }
    return { stopped: p }
  }

  const req = (method: string, path: string, o: { headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<Res> =>
    new Promise((resolve, reject) => {
      const body = typeof o.body === 'string' ? Buffer.from(o.body) : o.body
      const headers = { origin, ...(body ? { 'content-length': String(body.length) } : {}), ...o.headers }
      const r = http.request(`${origin}${path}`, { method, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      r.on('error', reject)
      if (body) r.write(body)
      r.end()
    })
  const json = (cookie: string, path: string, body: unknown) =>
    req('POST', path, { headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const login = async (username: string): Promise<string> => {
    const r = await req('POST', '/api/login', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })
    expect(r.status).toBe(200)
    return String(r.headers['set-cookie']?.[0] ?? '').split(';')[0]
  }
  const uploadRestore = (cookie: string, data: Buffer) =>
    req('POST', '/api/restore/upload', { headers: { cookie, 'content-type': 'application/octet-stream' }, body: data })
  const reason = (r: Res): string => (JSON.parse(r.body.toString()) as { reason: string }).reason

  it('member forbidden', async () => {
    seedUsers()
    const { stopped } = await serve()
    const uye = await login('uye')
    expect((await json(uye, '/api/backup', { passphrase: PASS })).status).toBe(403)
    expect((await uploadRestore(uye, Buffer.from('SQLite format 3\u0000'))).status).toBe(403)
    expect((await json(uye, '/api/restore/stage', { uploadId: 'a'.repeat(32), passphrase: PASS })).status).toBe(403)
    expect((await json(uye, '/api/restart', {})).status).toBe(403)
    // girişsiz 401, başka köken 403
    expect((await req('POST', '/api/backup', { headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
    const yon = await login('yon')
    const foreign = await req('POST', '/api/backup', { headers: { cookie: yon, origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: PASS }) })
    expect(foreign.status).toBe(403)
    expect(existsSync(join(dir, 'restore-pending.db'))).toBe(false)
    expect((await json(yon, '/api/restart', {})).status).toBe(202)
    expect(await stopped).toBe(0)
  }, 60_000)

  it('wrong passphrase 400', async () => {
    seedUsers()
    const { stopped } = await serve()
    const yon = await login('yon')
    expect(reason(await json(yon, '/api/backup', { passphrase: 'kisa' }))).toBe('passphraseTooShort')
    const bk = await json(yon, '/api/backup', { passphrase: PASS })
    expect(bk.status).toBe(200)
    const up = await uploadRestore(yon, bk.body)
    expect(up.status).toBe(200)
    const { uploadId } = JSON.parse(up.body.toString()) as { uploadId: string }
    const bad = await json(yon, '/api/restore/stage', { uploadId, passphrase: 'yanlis-parola-9' })
    expect(bad.status).toBe(400)
    expect(reason(bad)).toBe('badPassphrase')
    expect(existsSync(join(dir, 'restore-pending.db'))).toBe(false)
    // yükleme yeniden denenebilir; başka oturum kullanamaz
    const other = await login('yon')
    expect((await json(other, '/api/restore/stage', { uploadId, passphrase: PASS })).status).toBe(404)
    const ok = await json(yon, '/api/restore/stage', { uploadId, passphrase: PASS })
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body.toString())).toMatchObject({ restartRequired: true })
    // yükleme tüketildi
    expect((await json(yon, '/api/restore/stage', { uploadId, passphrase: PASS })).status).toBe(404)
    // yabancı dosya
    const junk = JSON.parse((await uploadRestore(yon, Buffer.from('PK\u0003\u0004zip'))).body.toString()) as { uploadId: string }
    expect(reason(await json(yon, '/api/restore/stage', { uploadId: junk.uploadId, passphrase: PASS }))).toBe('notABackup')
    // parola hiçbir günlüğe yazılmaz
    const logs = readdirSync(join(dir, 'logs')).map((f) => readFileSync(join(dir, 'logs', f), 'utf-8')).join('')
    expect(logs + stderr.text).not.toContain(PASS)
    expect(logs).not.toContain('yanlis-parola-9')
    await json(yon, '/api/restart', {})
    expect(await stopped).toBe(0)
  }, 60_000)

  it('backup roundtrip via http', async () => {
    seedUsers()
    addAccount('eski@t.co')
    withDb((q) => q.upsertPushDevice({ userId: q.getUserByUsername('yon')!.id, sessionId: 's', endpoint: 'https://fcm.googleapis.com/x', p256dh: 'p', auth: 'a', label: null, now: 1 }))
    let { stopped } = await serve()
    const yon = await login('yon')
    const bk = await json(yon, '/api/backup', { passphrase: PASS })
    expect(bk.status).toBe(200)
    expect(bk.headers['content-type']).toBe('application/octet-stream')
    expect(bk.headers['content-disposition']).toMatch(/^attachment; filename="geckomail-\d{4}-\d{2}-\d{2}\.geckobak"$/)
    expect(bk.headers['x-content-type-options']).toBe('nosniff')
    expect(bk.headers['cache-control']).toBe('no-store')
    expect(bk.body.subarray(0, 9).toString()).toBe('GECKOBAK1')
    // geçici dosyalar kalmaz (mühürlü dosya yanıt soketi kapanınca silinir: istemci gövdeyi biraz önce alabilir)
    await expect.poll(() => readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])

    addAccount('yeni@t.co') // yedekten sonra eklenen
    const { uploadId } = JSON.parse((await uploadRestore(yon, bk.body)).body.toString()) as { uploadId: string }
    expect((await json(yon, '/api/restore/stage', { uploadId, passphrase: PASS })).status).toBe(200)

    // diğer oturum yeniden başlatma olayını alır
    const uye = await login('uye')
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/rpc`, { headers: { origin, cookie: uye } })
    const events: string[] = []
    ws.on('message', (d) => events.push((JSON.parse(d.toString()) as { event?: string }).event ?? ''))
    await new Promise((r) => ws.once('open', r))
    const rs = await json(yon, '/api/restart', {})
    expect(rs.status).toBe(202)
    expect(await stopped).toBe(0)
    expect(events).toContain('server:restarting')
    ws.terminate()

    ;({ stopped } = await serve())
    expect(accountEmails()).toEqual(['eski@t.co'])
    expect(readdirSync(dir).some((f) => f.startsWith('geckomail.db.bak-'))).toBe(true)
    expect(existsSync(join(dir, 'restore-pending.db'))).toBe(false)
    // yedekteki oturumlar geçersiz: yeniden giriş gerekir
    expect((await req('GET', '/api/me', { headers: { cookie: yon } })).status).toBe(401)
    // yedekteki push cihazları da: kaldırılan cihaz geri gelmesin
    expect(withDb((_q, d) => d.prepare(`SELECT COUNT(*) AS n FROM push_devices`).get())).toEqual({ n: 0 })
    await json(await login('yon'), '/api/restart', {})
    expect(await stopped).toBe(0)
    expect(exits).toEqual([])
  }, 90_000)

  it('pending restore applied on boot and old db kept', async () => {
    seedUsers()
    addAccount('yedek@t.co')
    copyFileSync(join(dir, 'geckomail.db'), join(dir, 'restore-pending.db'))
    withDb((q, db) => {
      db.prepare('DELETE FROM accounts').run()
      q.insertAccount({ email: 'simdiki@t.co', displayName: null, imapHost: 'h', imapPort: 9, smtpHost: 'h', smtpPort: 9, passwordEnc: Buffer.from('x') })
    })
    const { stopped } = await serve()
    expect(accountEmails()).toEqual(['yedek@t.co'])
    const bak = readdirSync(dir).find((f) => /^geckomail\.db\.bak-[0-9TZ-]+$/.test(f))!
    expect(bak).toBeDefined()
    const old = new Database(join(dir, bak), { readonly: true })
    expect((old.prepare('SELECT email FROM accounts').all() as { email: string }[]).map((r) => r.email)).toEqual(['simdiki@t.co'])
    old.close()
    await json(await login('yon'), '/api/restart', {})
    expect(await stopped).toBe(0)
  }, 60_000)

  it('rejected pending restore: current db kept, server starts', async () => {
    seedUsers()
    addAccount('simdiki@t.co')
    const bad = corruptDb(dir)
    expect(bad.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\u0000')
    writeFileSync(join(dir, 'restore-pending.db'), bad)
    expect(sqliteIntact(join(dir, 'restore-pending.db'), false)).toBe(false)
    // açılışta yeni reddedilenle birlikte en yeni üçü kalır
    for (const y of [2020, 2021, 2022]) writeFileSync(join(dir, `restore-pending.db.rejected-${y}-01-01T00-00-00-000Z`), 'eski')
    const before = Date.now()
    const { stopped } = await serve()
    expect(accountEmails()).toEqual(['simdiki@t.co'])
    expect(readdirSync(dir).some((f) => /\.bak-/.test(f))).toBe(false)
    expect(existsSync(join(dir, 'restore-pending.db'))).toBe(false)
    const rejected = readdirSync(dir).filter((f) => /^restore-pending\.db\.rejected-[0-9TZ-]+$/.test(f))
    expect(rejected).toHaveLength(KEEP_REJECTED_RESTORES)
    expect(rejected).not.toContain('restore-pending.db.rejected-2020-01-01T00-00-00-000Z')
    // web ayarları durumdan öğrenir
    const yon = await login('yon')
    const st = JSON.parse((await req('GET', '/api/restore/status', { headers: { cookie: yon } })).body.toString()) as { staged: boolean; rejectedAt?: number }
    expect(st.staged).toBe(false)
    expect(st.rejectedAt).toBeGreaterThanOrEqual(before - 1)
    await json(yon, '/api/restart', {})
    expect(await stopped).toBe(0)
  }, 60_000)

  it('mid-swap rename failure rolls back and reports error', () => {
    seedUsers()
    addAccount('simdiki@t.co')
    addAccount('ikinci@t.co')
    const d2 = mkdtempSync(join(dir, 'yedek-'))
    const db2 = openDb(d2)
    makeQueries(db2).insertAccount({ email: 'yedek@t.co', displayName: null, imapHost: 'h', imapPort: 9, smtpHost: 'h', smtpPort: 9, passwordEnc: Buffer.from('x') })
    db2.close()
    copyFileSync(join(d2, 'geckomail.db'), join(dir, 'restore-pending.db'))
    const before = readFileSync(join(dir, 'geckomail.db'))
    const calls: string[] = []
    const r = applyPendingRestore(dir, {
      rename: (from, to) => {
        calls.push(`${from.split('/').pop()}>${to.split('/').pop()}`)
        if (from.endsWith('restore-pending.db')) throw new Error('EIO: yazılamadı')
        renameSync(from, to)
      }
    })
    expect(r).toEqual({ error: 'EIO: yazılamadı' })
    // takas geri alındı: mevcut DB aynı yerde ve aynı içerikte, bekleyen dosya duruyor, .bak kalmadı
    expect(readFileSync(join(dir, 'geckomail.db')).equals(before)).toBe(true)
    expect(existsSync(join(dir, 'restore-pending.db'))).toBe(true)
    expect(readdirSync(dir).some((f) => f.includes('.bak-'))).toBe(false)
    expect(calls.some((c) => c.startsWith('geckomail.db.bak-'))).toBe(true) // geri alma rename'i
    expect(accountEmails()).toEqual(['ikinci@t.co', 'simdiki@t.co'])
  })

  it('keeps only the newest db backups at boot', async () => {
    seedUsers()
    for (const ts of ['2020-01-01T00-00-00-000Z', '2021-01-01T00-00-00-000Z', '2022-01-01T00-00-00-000Z', '2023-01-01T00-00-00-000Z']) {
      writeFileSync(join(dir, `geckomail.db.bak-${ts}`), 'eski')
      writeFileSync(join(dir, `geckomail.db.bak-${ts}-wal`), 'eski')
    }
    copyFileSync(join(dir, 'geckomail.db'), join(dir, 'restore-pending.db'))
    const { stopped } = await serve()
    const baks = readdirSync(dir).filter((f) => /^geckomail\.db\.bak-[0-9TZ-]+$/.test(f)).sort()
    expect(baks).toHaveLength(KEEP_DB_BACKUPS)
    expect(baks[0]).toBe('geckomail.db.bak-2022-01-01T00-00-00-000Z')
    expect(existsSync(join(dir, 'geckomail.db.bak-2020-01-01T00-00-00-000Z-wal'))).toBe(false)
    await json(await login('yon'), '/api/restart', {})
    expect(await stopped).toBe(0)
  }, 60_000)

  it('reddedilen dosyalardan en yeni üçü kalır; rejectedAt yalnız son geri yükleme reddedildiyse', () => {
    const stamps = ['2020-01-01T00-00-00-000Z', '2021-01-01T00-00-00-000Z', '2022-01-01T00-00-00-000Z', '2023-02-03T04-05-06-007Z']
    expect(lastRejectedAt(dir)).toBeUndefined()
    for (const ts of stamps) writeFileSync(join(dir, `restore-pending.db.rejected-${ts}`), 'bozuk')
    writeFileSync(join(dir, 'restore-pending.db.rejected-notlar.txt'), 'dokunulmaz')
    expect(pruneRejectedRestores(dir)).toBe(1)
    const left = readdirSync(dir).filter((f) => f.startsWith('restore-pending.db.rejected-')).sort()
    expect(left).toHaveLength(KEEP_REJECTED_RESTORES + 1)
    expect(left).not.toContain(`restore-pending.db.rejected-${stamps[0]}`)
    expect(lastRejectedAt(dir)).toBe(Date.UTC(2023, 1, 3, 4, 5, 6, 7))
    // reddedilenden önceki bak-* sonucu değiştirmez; sonraki başarılı uygulama notu kaldırır
    writeFileSync(join(dir, 'geckomail.db.bak-2022-06-01T00-00-00-000Z'), 'x')
    expect(lastRejectedAt(dir)).toBe(Date.UTC(2023, 1, 3, 4, 5, 6, 7))
    writeFileSync(join(dir, 'geckomail.db.bak-2024-01-01T00-00-00-000Z'), 'x')
    expect(lastRejectedAt(dir)).toBeUndefined()
  })

  it('corrupt backup content is rejected at stage and the upload stays usable', async () => {
    seedUsers()
    const { stopped } = await serve()
    const yon = await login('yon')
    const up = await uploadRestore(yon, sealBackup(corruptDb(dir), PASS))
    const { uploadId } = JSON.parse(up.body.toString()) as { uploadId: string }
    for (let i = 0; i < 2; i++) {
      const r = await json(yon, '/api/restore/stage', { uploadId, passphrase: PASS })
      expect(r.status).toBe(400)
      expect(reason(r)).toBe('unreadable')
    }
    expect(existsSync(join(dir, 'restore-pending.db'))).toBe(false)
    expect(readdirSync(dir).filter((f) => f.startsWith('geri-yukleme-'))).toEqual([])
    await json(yon, '/api/restart', {})
    expect(await stopped).toBe(0)
  }, 60_000)

  it('push_devices tablosu olmayan eski yedek kabul edilir', async () => {
    seedUsers()
    const { stopped } = await serve()
    const yon = await login('yon')
    const d2 = mkdtempSync(join(tmpdir(), 'gecko-eski-yedek-'))
    const old = openDb(d2)
    old.exec('DROP TABLE push_devices')
    const raw = old.serialize()
    old.close()
    rmSync(d2, { recursive: true, force: true })
    const up = await uploadRestore(yon, sealBackup(raw, PASS))
    const { uploadId } = JSON.parse(up.body.toString()) as { uploadId: string }
    expect((await json(yon, '/api/restore/stage', { uploadId, passphrase: PASS })).status).toBe(200)
    await json(yon, '/api/restore/cancel', {})
    await json(yon, '/api/restart', {})
    expect(await stopped).toBe(0)
  }, 60_000)

  it('aborted backup releases the lock and leaves no temp files', async () => {
    seedUsers()
    for (let i = 0; i < 50; i++) addAccount(`h${i}@t.co`)
    const { stopped } = await serve()
    const yon = await login('yon')
    // istek gönderilir, scrypt/şifreleme sürerken bağlantı kesilir
    await new Promise<void>((resolve) => {
      const body = JSON.stringify({ passphrase: PASS })
      const r = http.request(`${origin}/api/backup`, {
        method: 'POST', headers: { origin, cookie: yon, 'content-type': 'application/json', 'content-length': String(body.length) }
      })
      r.on('error', () => resolve())
      r.end(body)
      setTimeout(() => {
        r.destroy()
        resolve()
      }, 30)
    })
    await expect.poll(async () => (await json(yon, '/api/backup', { passphrase: PASS })).status, { timeout: 15_000 }).toBe(200)
    await expect.poll(() => readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    await json(yon, '/api/restart', {})
    expect(await stopped).toBe(0)
  }, 60_000)

  it('restore status and cancel', async () => {
    seedUsers()
    const { stopped } = await serve()
    const yon = await login('yon')
    const st = async () => JSON.parse((await req('GET', '/api/restore/status', { headers: { cookie: yon } })).body.toString()) as { staged: boolean; stagedAt?: number }
    expect(await st()).toEqual({ staged: false })
    const bk = await json(yon, '/api/backup', { passphrase: PASS })
    const { uploadId } = JSON.parse((await uploadRestore(yon, bk.body)).body.toString()) as { uploadId: string }
    expect((await json(yon, '/api/restore/stage', { uploadId, passphrase: PASS })).status).toBe(200)
    const s1 = await st()
    expect(s1.staged).toBe(true)
    expect(typeof s1.stagedAt).toBe('number')
    // üye ne durumu görür ne iptal eder
    const uye = await login('uye')
    expect((await req('GET', '/api/restore/status', { headers: { cookie: uye } })).status).toBe(403)
    expect((await json(uye, '/api/restore/cancel', {})).status).toBe(403)
    expect(existsSync(join(dir, 'restore-pending.db'))).toBe(true)
    expect((await json(yon, '/api/restore/cancel', {})).status).toBe(200)
    expect(existsSync(join(dir, 'restore-pending.db'))).toBe(false)
    expect(await st()).toEqual({ staged: false })
    await json(yon, '/api/restart', {})
    expect(await stopped).toBe(0)
  }, 60_000)
})
