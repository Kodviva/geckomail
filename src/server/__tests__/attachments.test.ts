import type Database from 'better-sqlite3'
import { createHash, randomBytes } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import http from 'http'
import { connect, type AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { hashPassword } from '../../sync/auth/password'
import { openDb } from '../../sync/db'
import { makeQueries } from '../../sync/db/queries'
import type { OpQueue } from '../../sync/opQueue'
import { RpcHub, type RpcServerDeps } from '../../sync/rpcHub'
import type { Scheduler } from '../../sync/scheduler'
import { createVault, lockVault } from '../../sync/vault/manager'
import { setVaultKey } from '../../sync/vault/state'
import { WebAuth } from '../auth'
import type { ServerConfig } from '../config'
import { createServerHost } from '../hosts/serverHost'
import { createHttpServer } from '../http'
import { contentDisposition, displayName, UploadStore } from '../attachments'
import type { DraftOut } from '../../shared/rpc'
import { t } from '../../shared/i18n'
import { sendContentHash } from '../../sync/rpc/compose'

const ORIGIN = 'https://posta.example.com'
const PW = 'dogru-parola-1'
const MB = 1024 * 1024

interface Res {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

describe('ek indirme ve yükleme (HTTP)', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let auth: WebAuth
  let server: http.Server
  let port: number
  let clock: number
  // ek gövdesi diskte yoksa sahte IMAP istemcisinden gelir
  let imapContent: Buffer | null
  let imapCalls: number
  const sockets: WebSocket[] = []

  const start = async (
    uploadSweepMs?: number, uploadGlobalBytes?: number, freeBytes?: (dir: string) => number,
    extra: Pick<Parameters<typeof createHttpServer>[0], 'bodyLimits' | 'restoreLimit'> = {}
  ): Promise<void> => {
    const cfg: ServerConfig = {
      dataDir: dir, listenHost: '127.0.0.1', listenPort: 0, keyFile: join(dir, 'master.key'), publicOrigin: ORIGIN, trustedProxyDepth: 0,
      webDir: join(dir, 'web')
    }
    server = createHttpServer({ cfg, hub, auth, now: () => clock, uploadSweepMs, uploadGlobalBytes, freeBytes, ...extra })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-att-'))
    db = openDb(dir)
    q = makeQueries(db)
    clock = Date.now()
    imapContent = null
    imapCalls = 0
    const host = createServerHost(randomBytes(32), () => hub)
    const stub = new Proxy({}, { get: () => () => undefined })
    const client = {
      getMailboxLock: async () => ({ release() {} }),
      download: async () => ({ content: Readable.from([imapContent!]) })
    }
    const scheduler = {
      async enqueueInteractive(accountId: number, fn: (c: unknown, row: unknown) => Promise<unknown>) {
        imapCalls++
        return fn(client, q.getAccountRow(accountId))
      }
    }
    const deps: RpcServerDeps = {
      q, scheduler: scheduler as unknown as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'attachments'),
      encrypt: (v) => host.encrypt(v),
      decrypt: async (b) => (await host.decrypt(b)).map((u) => Buffer.from(u).toString('utf-8')),
      userData: dir, dbSchemaVersion: () => 0
    }
    hub = new RpcHub(deps, 'server')
    auth = new WebAuth(q, host)
  })
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    if (server?.listening) await new Promise<void>((r) => server.close(() => r()))
    setVaultKey(null)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const mkUser = (username: string, role: 'admin' | 'member' = 'member') => q.insertUser({ username, passwordHash: hashPassword(PW), role })

  /** Gruplu hesap + ileti + ek satırı; content verilirse ek diske yazılır */
  const seed = (o: { content?: Buffer; filename?: string; email?: string } = {}) => {
    const acc = q.insertAccount({ email: o.email ?? 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    const g = q.insertGroup(`G-${o.email ?? 'a'}`, '#111111')
    q.setAccountGroup(acc, g)
    const f = q.upsertFolder(acc, 'INBOX', 'inbox')
    const msg = q.upsertHeader({
      folderId: f, accountId: acc, folderKind: 'inbox', uid: 7, messageId: '<m7@t>', inReplyTo: null, subject: 's',
      fromName: null, fromAddr: 'x@y.co', toJson: null, date: 1, size: 1, seen: false, flagged: false, answered: false,
      hasAttachments: true, listUnsubscribe: null, listUnsubscribePost: null
    }).id
    let diskPath: string | null = null
    if (o.content) {
      mkdirSync(join(dir, 'attachments'), { recursive: true })
      diskPath = join(dir, 'attachments', `ek-${acc}.bin`)
      writeFileSync(diskPath, o.content)
    }
    const att = q.insertAttachment({
      messageId: msg, partId: '2', filename: o.filename ?? 'rapor.pdf', mime: 'application/pdf', size: o.content?.length ?? 100,
      contentId: null, diskPath
    })
    return { acc, group: g, msg, att }
  }

  const req = (method: string, path: string, o: { headers?: Record<string, string>; body?: Buffer | Readable } = {}): Promise<Res> =>
    new Promise((resolve, reject) => {
      // tarayıcı fetch(File) gibi uzunluk bildirilir (Node istemcisi write ile chunked gönderirdi)
      const headers = Buffer.isBuffer(o.body) && !o.headers?.['content-length'] && !o.headers?.['transfer-encoding']
        ? { ...o.headers, 'content-length': String(o.body.length) }
        : o.headers
      const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      r.on('error', reject)
      if (o.body instanceof Readable) return void o.body.pipe(r)
      if (o.body != null) r.write(o.body)
      r.end()
    })
  const loginCookie = async (username: string): Promise<string> => {
    const r = await req('POST', '/api/login', {
      headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ username, password: PW }))
    })
    expect(r.status).toBe(200)
    return (r.headers['set-cookie']?.[0] ?? '').split(';')[0]
  }
  const upload = (cookie: string, data: Buffer, headers: Record<string, string> = {}) =>
    req('POST', '/api/upload', {
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/octet-stream', 'x-filename': "UTF-8''rapor.pdf", ...headers },
      body: data
    })
  const uploadsDir = () => join(dir, 'uploads')

  const openWs = (cookie: string): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { headers: { origin: ORIGIN, cookie } })
      sockets.push(ws)
      ws.on('open', () => resolve(ws))
      ws.on('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    })
  const call = (ws: WebSocket, id: number, method: string, params: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
    new Promise((resolve) => {
      const onMsg = (data: WebSocket.RawData) => {
        const m = JSON.parse(data.toString())
        if (m.id !== id) return
        ws.off('message', onMsg)
        resolve(m)
      }
      ws.on('message', onMsg)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const sendWithUpload = (ws: WebSocket, id: number, accountId: number, uploadId: string) =>
    call(ws, id, 'sendMail', {
      draft: { accountId, to: 'b@t.co', subject: 'ek', text: 'x', attachments: [{ uploadId, filename: 'yok-sayilir', mime: 'application/pdf' }] }
    })

  it('attachment forbidden for non-viewer', async () => {
    const s = seed({ content: Buffer.from('gizli') })
    const uye = mkUser('uye')
    await start()
    const cookie = await loginCookie('uye')
    // girişsiz: 401
    expect((await req('GET', `/api/attachment/${s.msg}/${s.att}`)).status).toBe(401)
    // grubu görmeyen üye: 403, içerik yok
    const r = await req('GET', `/api/attachment/${s.msg}/${s.att}`, { headers: { cookie } })
    expect(r.status).toBe(403)
    expect(r.body.toString()).not.toContain('gizli')
    // izin verilince açılır (oturum izinleri her istekte DB'den)
    q.setGroupPermission(uye, s.group, true, false)
    const ok = await req('GET', `/api/attachment/${s.msg}/${s.att}`, { headers: { cookie } })
    expect(ok.status).toBe(200)
    expect(ok.body.toString()).toBe('gizli')
  })

  /** Başlıkları ve gövdenin bir kısmını gönderip susan istemci: sunucunun yanıtı ya da kapanışı beklenir */
  const stall = (path: string, cookie: string, declared: number, sent: string, headers: Record<string, string> = {}): Promise<string> =>
    new Promise((resolve, reject) => {
      const c = connect(port, '127.0.0.1')
      let out = ''
      const lines = Object.entries({ cookie, origin: ORIGIN, 'content-type': 'application/octet-stream', 'content-length': String(declared), ...headers })
        .map(([k, v]) => `${k}: ${v}\r\n`).join('')
      c.write(`POST ${path} HTTP/1.1\r\nhost: x\r\n${lines}\r\n${sent}`)
      c.on('data', (d) => (out += d.toString()))
      c.on('close', () => resolve(out))
      c.on('error', reject)
    })

  it('HEAD: gövdesiz aynı denetimler (403, 423, 502, 200)', async () => {
    const s = seed({ content: Buffer.from('gizli') })
    mkUser('yon', 'admin')
    mkUser('uye')
    await start()
    const yon = await loginCookie('yon')
    const url = `/api/attachment/${s.msg}/${s.att}`
    const ok = await req('HEAD', url, { headers: { cookie: yon } })
    expect(ok.status).toBe(200)
    expect(ok.headers['content-length']).toBe('5')
    expect(ok.body.length).toBe(0)
    expect((await req('HEAD', url)).status).toBe(401)
    expect((await req('HEAD', url, { headers: { cookie: await loginCookie('uye') } })).status).toBe(403)
    const imap = seed({ email: 'b@t.co' })
    imapContent = null // sahte IMAP akışı çöker
    expect((await req('HEAD', `/api/attachment/${imap.msg}/${imap.att}`, { headers: { cookie: yon } })).status).toBe(502)
    q.setAccountSecureFlag(s.acc, true)
    createVault(q, 'kasa-parolasi-123')
    lockVault(q, new Map())
    expect((await req('HEAD', url, { headers: { cookie: yon } })).status).toBe(423)
  })

  it('susan ek yüklemesi 408 ile biter: yarım dosya silinir, kota geri gelir', async () => {
    mkUser('yon', 'admin')
    await start(undefined, undefined, undefined, { bodyLimits: { attachment: { idleMs: 60, totalMs: 10_000 } } })
    const cookie = await loginCookie('yon')
    const out = await stall('/api/upload', cookie, 1024, 'yarim')
    expect(out).toMatch(/^HTTP\/1\.1 408 /)
    expect(out).toContain('"timeout"')
    await expect.poll(() => readdirSync(uploadsDir())).toEqual([])
    expect((await upload(cookie, Buffer.from('tam'))).status).toBe(200)
  })

  it('ek yüklemesi veri gelse de toplam süreyi aşamaz', async () => {
    mkUser('yon', 'admin')
    await start(undefined, undefined, undefined, { bodyLimits: { attachment: { idleMs: 500, totalMs: 80 } } })
    const out = await stall('/api/upload', await loginCookie('yon'), 1024, 'yarim')
    expect(out).toMatch(/^HTTP\/1\.1 408 /)
  })

  it('geri yükleme: bayt gelmezse iptal, bayt geldikçe toplam sınır yok; rezervasyon bırakılır', async () => {
    mkUser('yon', 'admin')
    await start(undefined, undefined, () => Number.MAX_SAFE_INTEGER, { bodyLimits: { restore: { idleMs: 120 } } })
    const cookie = await loginCookie('yon')
    expect(await stall('/api/restore/upload', cookie, 1024, 'yarim')).toMatch(/^HTTP\/1\.1 408 /)
    await expect.poll(() => readdirSync(uploadsDir())).toEqual([])
    // parça parça gelen yükleme, süresi idleMs'in birkaç katı olsa da tamamlanır
    const c = connect(port, '127.0.0.1')
    let out = ''
    c.on('data', (d) => (out += d.toString()))
    c.write(`POST /api/restore/upload HTTP/1.1\r\nhost: x\r\ncookie: ${cookie}\r\norigin: ${ORIGIN}\r\ncontent-type: application/octet-stream\r\ncontent-length: 5\r\n\r\n`)
    for (const b of 'abcde') {
      await new Promise((r) => setTimeout(r, 60))
      c.write(b)
    }
    await expect.poll(() => out).toMatch(/^HTTP\/1\.1 200 /)
    c.destroy()
  })

  it('yedek dosyası sınırı aşıyorsa X-Gecko-Restorable: 0', async () => {
    mkUser('yon', 'admin')
    await start(undefined, undefined, undefined, { restoreLimit: 1 })
    const cookie = await loginCookie('yon')
    const r = await req('POST', '/api/backup', {
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ passphrase: 'yedek-parolasi-1' }))
    })
    expect(r.status).toBe(200)
    expect(r.headers['x-gecko-restorable']).toBe('0')
  })

  it('attachment of another message or bad ids is 404', async () => {
    const s = seed({ content: Buffer.from('x') })
    mkUser('yon', 'admin')
    await start()
    const cookie = await loginCookie('yon')
    for (const p of [`/api/attachment/${s.msg + 1}/${s.att}`, `/api/attachment/${s.msg}/${s.att + 1}`, `/api/attachment/${s.msg}/abc`, `/api/attachment/${s.msg}`]) {
      const r = await req('GET', p, { headers: { cookie } })
      expect(r.status, p).toBe(404)
      expect(r.headers['content-type'], p).toMatch(/^application\/json/)
    }
  })

  it('attachment of another account via a visible message is 404 (IDOR)', async () => {
    const a = seed({ content: Buffer.from('gorunen') })
    const b = seed({ content: Buffer.from('baska-hesap'), email: 'b@t.co' })
    const uye = mkUser('uye')
    q.setGroupPermission(uye, a.group, true, false)
    await start()
    const cookie = await loginCookie('uye')
    const r = await req('GET', `/api/attachment/${a.msg}/${b.att}`, { headers: { cookie } })
    expect(r.status).toBe(404)
    expect(r.body.toString()).not.toContain('baska-hesap')
    expect(imapCalls).toBe(0)
    expect((await req('GET', `/api/attachment/${a.msg}/${a.att}`, { headers: { cookie } })).body.toString()).toBe('gorunen')
  })

  it('streams 20MB', async () => {
    const content = randomBytes(20 * MB)
    const s = seed({ content, filename: 'Şubat "rapor"/özet.pdf' })
    mkUser('yon', 'admin')
    await start()
    const cookie = await loginCookie('yon')
    const r = await req('GET', `/api/attachment/${s.msg}/${s.att}`, { headers: { cookie } })
    expect(r.status).toBe(200)
    expect(r.body.length).toBe(content.length)
    expect(createHash('sha256').update(r.body).digest('hex')).toBe(createHash('sha256').update(content).digest('hex'))
    expect(r.headers['content-length']).toBe(String(content.length))
    expect(r.headers['content-type']).toBe('application/octet-stream')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.headers['content-disposition']).toBe(
      `attachment; filename="Subat _rapor__ozet.pdf"; filename*=UTF-8''%C5%9Eubat%20%22rapor%22_%C3%B6zet.pdf`
    )
  })

  it('attachment not on disk is fetched via getAttachment path, then streamed', async () => {
    const s = seed()
    imapContent = Buffer.from('imapten gelen')
    mkUser('yon', 'admin')
    await start()
    const cookie = await loginCookie('yon')
    const r = await req('GET', `/api/attachment/${s.msg}/${s.att}`, { headers: { cookie } })
    expect(r.status).toBe(200)
    expect(r.body.toString()).toBe('imapten gelen')
    expect(imapCalls).toBe(1)
    // ikinci istek diskten
    expect((await req('GET', `/api/attachment/${s.msg}/${s.att}`, { headers: { cookie } })).body.toString()).toBe('imapten gelen')
    expect(imapCalls).toBe(1)
  })

  it('vault locked → 423', async () => {
    const s = seed({ content: Buffer.from('kasa') })
    q.setAccountSecureFlag(s.acc, true)
    createVault(q, 'kasa-parolasi-123')
    lockVault(q, new Map())
    mkUser('yon', 'admin')
    await start()
    const cookie = await loginCookie('yon')
    const r = await req('GET', `/api/attachment/${s.msg}/${s.att}`, { headers: { cookie } })
    expect(r.status).toBe(423)
    expect(r.body.toString()).not.toContain('kasa')
    expect(imapCalls).toBe(0)
  })

  it('upload over 25MB → 413', async () => {
    mkUser('yon', 'admin')
    await start()
    const cookie = await loginCookie('yon')
    // bildirilen uzunluk sınırı aşıyor: gövde okunmadan reddedilir
    const r = await req('POST', '/api/upload', {
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/octet-stream', 'content-length': String(26 * MB) }
    }).catch(() => null)
    expect(r?.status).toBe(413)
    // uzunluk bildirilmeden (chunked) akan gövde sınırda kesilir; yarım dosya kalmaz
    const big = Readable.from((function* () {
      for (let i = 0; i < 27; i++) yield Buffer.alloc(MB, 1)
    })())
    const r2 = await req('POST', '/api/upload', {
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' }, body: big
    }).catch(() => null)
    // sunucu yanıtı yazıp bağlantıyı kapatır; istemci hâlâ yazıyorsa yanıtı okuyamadan EPIPE alabilir
    if (r2) expect(r2.status).toBe(413)
    await new Promise((res) => setTimeout(res, 50))
    expect(existsSync(uploadsDir()) ? readdirSync(uploadsDir()) : []).toEqual([])
    // tam sınırdaki yükleme kabul edilir
    const ok = await upload(cookie, Buffer.alloc(25_000_000, 2))
    expect(ok.status).toBe(200)
  })

  it('upload stores random-named private temp file; needs origin, cookie and octet-stream', async () => {
    mkUser('yon', 'admin')
    await start()
    const cookie = await loginCookie('yon')
    expect((await req('POST', '/api/upload', { headers: { origin: ORIGIN, 'content-type': 'application/octet-stream' }, body: Buffer.from('x') })).status).toBe(401)
    expect((await upload(cookie, Buffer.from('x'), { origin: 'https://kotu.example.com' })).status).toBe(403)
    expect((await upload(cookie, Buffer.from('x'), { 'content-type': 'application/json' })).status).toBe(415)
    expect((await req('GET', '/api/upload', { headers: { cookie } })).status).toBe(404)
    const r = await upload(cookie, Buffer.from('icerik'), { 'x-filename': "UTF-8''..%2F..%2Fetc%2Fpasswd" })
    expect(r.status).toBe(200)
    const { uploadId } = JSON.parse(r.body.toString()) as { uploadId: string }
    expect(uploadId).toMatch(/^[0-9a-f]{32}$/)
    expect(statSync(uploadsDir()).mode & 0o777).toBe(0o700)
    const files = readdirSync(uploadsDir())
    expect(files).toHaveLength(1)
    expect(files[0]).not.toContain('passwd')
    expect(statSync(join(uploadsDir(), files[0])).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(uploadsDir(), files[0]), 'utf-8')).toBe('icerik')
  })

  it('uploadId of another session rejected; owner session consumes it on send', async () => {
    const s = seed()
    mkUser('yon', 'admin')
    await start()
    const cookieA = await loginCookie('yon')
    const cookieB = await loginCookie('yon') // aynı kullanıcı, başka oturum (başka cihaz)
    const r = await upload(cookieA, Buffer.from('pdf-icerigi'), { 'x-filename': "UTF-8''%C3%B6zet%2F2026.pdf" })
    const { uploadId } = JSON.parse(r.body.toString()) as { uploadId: string }
    const wsB = await openWs(cookieB)
    const denied = await sendWithUpload(wsB, 1, s.acc, uploadId)
    expect(denied.ok).toBe(false)
    expect(q.listOps(null)).toHaveLength(0)
    const wsA = await openWs(cookieA)
    const sent = await sendWithUpload(wsA, 2, s.acc, uploadId)
    expect(sent.ok).toBe(true)
    const [op] = q.listOps(null)
    const payload = JSON.parse(op.payload_json) as { attachments: { path: string; filename: string; mime: string }[] }
    expect(payload.attachments).toHaveLength(1)
    // görünen ad X-Filename'den (yol ayırıcısı ayıklanmış), içerik kuyruğun dosyasında
    expect(payload.attachments[0].filename).toBe('özet2026.pdf')
    expect(payload.attachments[0].mime).toBe('application/pdf')
    expect(readFileSync(payload.attachments[0].path, 'utf-8')).toBe('pdf-icerigi')
    // tüketildi: geçici dosya yok, ikinci kullanım reddedilir
    expect(readdirSync(uploadsDir())).toEqual([])
    expect((await sendWithUpload(wsA, 3, s.acc, uploadId)).ok).toBe(false)
  })

  it('upload expires after 1h', async () => {
    const s = seed()
    mkUser('yon', 'admin')
    await start(20)
    const cookie = await loginCookie('yon')
    const r = await upload(cookie, Buffer.from('eski'))
    const { uploadId } = JSON.parse(r.body.toString()) as { uploadId: string }
    await new Promise((res) => setTimeout(res, 60))
    expect(readdirSync(uploadsDir())).toHaveLength(1) // saat ilerlemedi: süpürücü dokunmaz
    clock += 60 * 60 * 1000 + 1
    await new Promise((res) => setTimeout(res, 60))
    expect(readdirSync(uploadsDir())).toEqual([])
    const ws = await openWs(cookie)
    expect((await sendWithUpload(ws, 1, s.acc, uploadId)).ok).toBe(false)
  })

  it('leftover temp files from a previous run are cleared on start', async () => {
    mkdirSync(uploadsDir(), { recursive: true })
    writeFileSync(join(uploadsDir(), 'artik'), 'x')
    await start()
    expect(readdirSync(uploadsDir())).toEqual([])
  })
  it('server session cannot send inline data attachments (only uploadId)', async () => {
    const s = seed()
    mkUser('yon', 'admin')
    await start()
    const ws = await openWs(await loginCookie('yon'))
    const draft = (data: unknown) => ({ accountId: s.acc, to: 'b@t.co', subject: 'x', text: 'x', attachments: [{ filename: 'a.bin', mime: 'text/plain', data }] })
    // {length: 2e9}: boyut 0 sayılıp Buffer.from 2 GB ayırmamalı
    for (const data of [{ length: 2e9 }, JSON.parse(JSON.stringify(new Uint8Array([1, 2]))), [1, 2], 'abc']) {
      const r = await call(ws, 1, 'sendMail', { draft: draft(data) })
      expect(r.ok).toBe(false)
      expect(r.error).toBe('Yüklenen ek bulunamadı ya da süresi doldu; eki yeniden ekleyin')
    }
    expect(q.listOps(null)).toHaveLength(0)
  })

  it('aynı clientSendId ile iki sendMail tek işlem; ek ilk çağrıda tüketilse de ikincisi başarı', async () => {
    const s = seed()
    mkUser('yon', 'admin')
    await start()
    const cookie = await loginCookie('yon')
    const { uploadId } = JSON.parse((await upload(cookie, Buffer.from('ek'))).body.toString()) as { uploadId: string }
    const ws = await openWs(cookie)
    const clientSendId = '3f2b8c1e-5d4a-4f6b-9a7e-1c2d3e4f5a6b'
    const params = {
      draft: { accountId: s.acc, to: 'b@t.co', subject: 'x', text: 'x', attachments: [{ uploadId, filename: 'x', mime: 'text/plain' }] }, clientSendId
    }
    expect((await call(ws, 1, 'sendMail', params)).ok).toBe(true)
    expect((await call(ws, 2, 'sendMail', params)).ok).toBe(true)
    expect(q.listOps(null)).toHaveLength(1)
    // kimliksiz çağrılar, başka kimlik ve biçimsiz kimlik korumadan geçmez
    const plain = { accountId: s.acc, to: 'b@t.co', subject: 'y', text: 'y' }
    await call(ws, 3, 'sendMail', { draft: plain })
    await call(ws, 4, 'sendMail', { draft: plain })
    await call(ws, 5, 'sendMail', { draft: plain, clientSendId: '3f2b8c1e-5d4a-4f6b-9a7e-1c2d3e4f5a6c' })
    await call(ws, 6, 'sendMail', { draft: plain, clientSendId: 'uydurma' })
    await call(ws, 7, 'sendMail', { draft: plain, clientSendId: 'uydurma' })
    expect(q.listOps(null)).toHaveLength(6)
    // 24 saatten eski kayıt budanır: kimlik yeniden kullanılabilir
    db.prepare(`UPDATE send_ids SET created_at = ?`).run(Date.now() - 25 * 3_600_000)
    expect((await call(ws, 8, 'sendMail', { draft: plain, clientSendId })).ok).toBe(true)
    expect(q.listOps(null)).toHaveLength(7)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM send_ids`).get()).toEqual({ n: 1 })
  })

  describe('aynı kimlikle yeniden deneme', () => {
    const id = '3f2b8c1e-5d4a-4f6b-9a7e-1c2d3e4f5a6b'
    const setup = async () => {
      const s = seed()
      mkUser('yon', 'admin')
      await start()
      const ws = await openWs(await loginCookie('yon'))
      const draft = (over: object = {}) => ({ accountId: s.acc, to: 'b@t.co', subject: 'x', text: 'ilk', ...over })
      const send = (seq: number, over: object = {}, extra: object = {}) => call(ws, seq, 'sendMail', { draft: draft(over), clientSendId: id, ...extra })
      const texts = () => q.listOps(null).map((o) => (JSON.parse(o.payload_json) as { draft: { text: string } }).draft.text)
      return { ws, send, texts }
    }

    it('özdeş yeniden deneme tek işlem; adres yazımı ve satır sonu aynı içeriktir', async () => {
      const { send, texts } = await setup()
      expect((await send(1, { to: 'A@t.co, b@t.co' })).ok).toBe(true)
      expect((await send(2, { to: ' a@t.co,B@t.co ', text: 'ilk\r\n' })).ok).toBe(true)
      expect(texts()).toEqual(['ilk'])
    })

    it('düzenlenmiş yeniden deneme yeni içerikle ikinci işlem; sonraki özdeşi yenisine bağlıdır', async () => {
      const { send, texts } = await setup()
      await send(1)
      expect((await send(2, { text: 'düzeltilmiş' })).ok).toBe(true)
      await send(3, { text: 'düzeltilmiş' })
      expect(texts().sort()).toEqual(['düzeltilmiş', 'ilk'])
      for (const over of [{ subject: 'y' }, { to: 'c@t.co' }, { cc: 'c@t.co' }, { bcc: 'c@t.co' }, { html: '<b>x</b>' }]) await send(4, { ...over, text: 'düzeltilmiş' })
      expect(texts()).toHaveLength(7)
    })

    it('başka zamanlama yeni gönderimdir', async () => {
      const { send, texts } = await setup()
      const later = Date.now() + 3_600_000
      await send(1, {}, { sendAt: later })
      await send(2, {}, { sendAt: later })
      expect(texts()).toHaveLength(1)
      await send(3, {}, { sendAt: later + 60_000 })
      expect(texts()).toHaveLength(2)
    })

    it('işlem kalıcı başarısızsa yeniden deneme yeni işlem', async () => {
      const { send, texts } = await setup()
      await send(1)
      q.opFailed(q.listOps(null)[0].id, 'smtp reddetti')
      expect((await send(2)).ok).toBe(true)
      expect(texts()).toHaveLength(2)
      // yeni kayıt sağlam işleme bağlı: bir sonraki özdeş deneme kuyruğa girmez
      await send(3)
      expect(texts()).toHaveLength(2)
    })

    it('işlem iptal edildiyse yeniden deneme yeni işlem', async () => {
      const { ws, send, texts } = await setup()
      await send(1)
      expect((await call(ws, 2, 'cancelOp', { id: q.listOps(null)[0].id })).ok).toBe(true)
      expect(texts()).toEqual([])
      await send(3)
      expect(texts()).toEqual(['ilk'])
    })

    it('gönderilmiş işlem (satır silindi) yeniden gönderilmez', async () => {
      const { send, texts } = await setup()
      await send(1)
      q.opDone(q.listOps(null)[0].id)
      expect((await send(2)).ok).toBe(true)
      expect(texts()).toEqual([])
    })

    it('gönderilen işlemin kimliğini alan append_sent başarısız olsa da özdeş yeniden deneme göndermez', async () => {
      const { send, texts } = await setup()
      await send(1)
      const { id: sent, account_id: acc } = q.listOps(null)[0]
      q.opDone(sent) // gönderildi; SMTP sonrası kopya aynı (boşalan) kimliği alır
      const copy = q.enqueueOp(acc, 'append_sent', { draft: { text: 'kopya' } })
      expect(copy).toBe(sent)
      q.opFailed(copy, 'imap reddetti')
      expect((await send(2)).ok).toBe(true)
      expect(texts()).toEqual(['kopya'])
    })

    it('kimliği geri dönüşümle alan sonraki gönderim eski kaydı etkilemez', async () => {
      const { ws, send, texts } = await setup()
      await send(1)
      const { id: sent, account_id: acc } = q.listOps(null)[0]
      q.opDone(sent)
      // başka iletinin gönderimi aynı kimliği alır (kayıttan sonra oluşturuldu)
      const next = q.enqueueOp(acc, 'smtp_send', { draft: { text: 'baska' } })
      expect(next).toBe(sent)
      db.prepare(`UPDATE op_queue SET created_at = created_at + 1000 WHERE id = ?`).run(next)
      q.opFailed(next, 'smtp reddetti')
      await send(2)
      expect(texts()).toEqual(['baska'])
      // onun iptali de eski kaydı silmez: özdeş yeniden deneme hâlâ gönderilmiş sayılır
      expect((await call(ws, 3, 'cancelOp', { id: next })).ok).toBe(true)
      await send(4)
      expect(texts()).toEqual([])
    })

    it('silinen hesaba yeniden deneme hata verir, yanlış başarı dönmez', async () => {
      const { send } = await setup()
      await send(1)
      db.pragma('foreign_keys = OFF')
      db.prepare(`DELETE FROM accounts`).run()
      const r = await send(2)
      expect(r.ok).toBe(false)
      expect(r.error).toBe(t('sync.err.accountNotFound'))
    })

    it('takip: kimliği geri dönüşümle alan işlem takibi bekletmez', async () => {
      const { send } = await setup()
      await send(1, {}, { followupDays: 1 })
      const op = q.listOps(null)[0]
      const dueIn = Date.now() + 2 * 86_400_000
      expect(q.listFollowups(null)[0].pendingSend).toBe(true)
      q.opDone(op.id)
      const copy = q.enqueueOp(op.account_id, 'append_sent', { draft: { text: 'kopya' } })
      expect(copy).toBe(op.id)
      q.opFailed(copy, 'imap reddetti')
      expect(q.listFollowups(null)[0].pendingSend).toBe(false)
      expect(q.markDueFollowups(dueIn)).toHaveLength(1)
    })

    it('özet uploadId görmez, ek adı ve boyutunu görür', () => {
      const d = (a: object) => ({ accountId: 1, to: 'b@t.co', subject: 's', text: 't', attachments: [{ mime: 'x/y', ...a }] }) as DraftOut
      const base = sendContentHash(d({ filename: 'a.pdf', size: 5, uploadId: 'aa' }), undefined)
      expect(sendContentHash(d({ filename: 'a.pdf', size: 5, uploadId: 'bb' }), undefined)).toBe(base)
      expect(sendContentHash(d({ filename: 'b.pdf', size: 5, uploadId: 'aa' }), undefined)).not.toBe(base)
      expect(sendContentHash(d({ filename: 'a.pdf', size: 6, uploadId: 'aa' }), undefined)).not.toBe(base)
    })
  })

  it('failed move rolls back earlier attachments and keeps uploads usable', async () => {
    const s = seed()
    mkUser('yon', 'admin')
    await start()
    const cookie = await loginCookie('yon')
    const id = async (data: string) => (JSON.parse((await upload(cookie, Buffer.from(data))).body.toString()) as { uploadId: string }).uploadId
    const first = await id('birinci')
    const second = await id('ikinci')
    // ikinci geçici dosya diskten kaybolur: taşıma başarısız
    const files = readdirSync(uploadsDir())
    const secondFile = files.find((f) => readFileSync(join(uploadsDir(), f), 'utf-8') === 'ikinci')!
    rmSync(join(uploadsDir(), secondFile))
    const ws = await openWs(cookie)
    const att = (uploadId: string) => ({ uploadId, filename: 'x', mime: 'text/plain' })
    const r = await call(ws, 1, 'sendMail', { draft: { accountId: s.acc, to: 'b@t.co', subject: 'x', text: 'x', attachments: [att(first), att(second)] } })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Ekler gönderim için kaydedilemedi; yeniden deneyin')
    expect(r.error).not.toContain(dir)
    expect(r.error).not.toContain('/')
    expect(q.listOps(null)).toHaveLength(0)
    expect(readdirSync(join(dir, 'outbox'))).toEqual([])
    // birinci yerine döndü, hâlâ kullanılabilir
    expect(readdirSync(uploadsDir()).map((f) => readFileSync(join(uploadsDir(), f), 'utf-8'))).toEqual(['birinci'])
    const ok = await call(ws, 2, 'sendMail', { draft: { accountId: s.acc, to: 'b@t.co', subject: 'x', text: 'x', attachments: [att(first)] } })
    expect(ok.ok).toBe(true)
    expect(readdirSync(uploadsDir())).toEqual([])
  })

  it('parallel uploads cannot exceed the session quota; reservation released on finish', async () => {
    mkUser('yon', 'admin')
    await start()
    const cookie = await loginCookie('yon')
    // 4 × 25 MB bildirilen, gövdesi henüz gelmeyen yükleme oturumun 100 MB payını doldurur
    const held: http.ClientRequest[] = []
    for (let i = 0; i < 4; i++) {
      const r = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/upload',
        headers: { origin: ORIGIN, cookie, 'content-type': 'application/octet-stream', 'content-length': String(25_000_000) }
      })
      r.on('error', () => {})
      r.write(Buffer.alloc(10))
      held.push(r)
    }
    await new Promise((res) => setTimeout(res, 100))
    const over = await upload(cookie, Buffer.from('x'))
    expect(over.status).toBe(413)
    expect(JSON.parse(over.body.toString())).toEqual({ reason: 'quota' })
    // süren yüklemeler koptu: pay bırakılır, yarım dosyalar silinir
    for (const r of held) r.destroy()
    await new Promise((res) => setTimeout(res, 100))
    expect(readdirSync(uploadsDir())).toEqual([])
    expect((await upload(cookie, Buffer.from('x'))).status).toBe(200)
  })

  it('global cap on the uploads directory → 507; bad Content-Length → 400', async () => {
    mkUser('yon', 'admin')
    mkUser('ali', 'admin')
    await start(undefined, 30)
    const a = await loginCookie('yon')
    const b = await loginCookie('ali')
    expect((await upload(a, Buffer.alloc(20))).status).toBe(200)
    const full = await upload(b, Buffer.alloc(20))
    expect(full.status).toBe(507)
    expect(JSON.parse(full.body.toString())).toEqual({ reason: 'storageFull' })
    expect((await upload(b, Buffer.alloc(10))).status).toBe(200)
    // sayı olmayan uzunluk: Node ayrıştırıcısı ya da uç 400 verir
    const bad = await new Promise<number>((resolve) => {
      const r = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/upload',
        headers: { origin: ORIGIN, cookie: a, 'content-type': 'application/octet-stream', 'content-length': '1e3' }
      }, (res) => resolve(res.statusCode!))
      r.on('error', () => resolve(-1))
      r.end()
    })
    expect(bad).toBe(400)
  })

  it('DELETE /api/upload/:id: only the owner session, same origin', async () => {
    const s = seed()
    mkUser('yon', 'admin')
    await start()
    const a = await loginCookie('yon')
    const b = await loginCookie('yon')
    const { uploadId } = JSON.parse((await upload(a, Buffer.from('sil'))).body.toString()) as { uploadId: string }
    const del = (cookie: string, origin = ORIGIN, id = uploadId) => req('DELETE', `/api/upload/${id}`, { headers: { origin, cookie } })
    expect((await req('DELETE', `/api/upload/${uploadId}`, { headers: { origin: ORIGIN } })).status).toBe(401)
    expect((await del(a, 'https://kotu.example.com')).status).toBe(403)
    expect((await del(b)).status).toBe(404)
    expect((await del(a, ORIGIN, 'f'.repeat(32))).status).toBe(404)
    expect(readdirSync(uploadsDir())).toHaveLength(1)
    expect((await del(a)).status).toBe(204)
    expect(readdirSync(uploadsDir())).toEqual([])
    expect((await del(a)).status).toBe(404)
    const ws = await openWs(a)
    expect((await sendWithUpload(ws, 1, s.acc, uploadId)).ok).toBe(false)
  })

  const restoreUpload = (cookie: string, data: Buffer) =>
    req('POST', '/api/restore/upload', { headers: { origin: ORIGIN, cookie, 'content-type': 'application/octet-stream' }, body: data })
  const stage = (cookie: string, uploadId: string) =>
    req('POST', '/api/restore/stage', { headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ uploadId, passphrase: 'yedek-parolasi-1' })) })

  it('restore upload has its own budget: not counted against the attachment cap, not usable as attachment', async () => {
    const s = seed()
    mkUser('yon', 'admin')
    q.setGroupPermission(q.getUserByUsername('yon')!.id, s.group, true, true)
    await start(undefined, 1 * MB) // eklerin genel sınırı 1 MB
    const cookie = await loginCookie('yon')
    const big = await restoreUpload(cookie, Buffer.alloc(3 * MB, 1))
    expect(big.status).toBe(200)
    const { uploadId } = JSON.parse(big.body.toString()) as { uploadId: string }
    // geri yükleme dosyası eklerin genel sınırını doldurmaz
    expect((await upload(cookie, Buffer.alloc(MB / 2, 2))).status).toBe(200)
    // ek olarak gönderilemez
    const ws = await openWs(cookie)
    expect((await sendWithUpload(ws, 1, s.acc, uploadId)).ok).toBe(false)
    // DELETE ile silinir, sonra stage bulamaz
    expect((await req('DELETE', `/api/upload/${uploadId}`, { headers: { origin: ORIGIN, cookie } })).status).toBe(204)
    expect((await stage(cookie, uploadId)).status).toBe(404)
  })

  it('restore upload needs twice its size free on disk', async () => {
    mkUser('yon', 'admin')
    let free = 5 * MB
    await start(undefined, undefined, () => free)
    const cookie = await loginCookie('yon')
    // bildirilen uzunluk: gövde okunmadan reddedilir
    const r = await req('POST', '/api/restore/upload', {
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/octet-stream', 'content-length': String(3 * MB) }
    }).catch(() => null)
    expect(r?.status).toBe(507)
    expect(JSON.parse(r!.body.toString())).toEqual({ reason: 'storageFull' })
    expect(readdirSync(uploadsDir())).toEqual([])
    free = 6 * MB
    expect((await restoreUpload(cookie, Buffer.alloc(3 * MB))).status).toBe(200)
    // uzunluk bildirilmeyen geri yükleme reddedilir
    const chunked = await req('POST', '/api/restore/upload', {
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' }, body: Readable.from([Buffer.from('x')])
    }).catch(() => null)
    if (chunked) expect(chunked.status).toBe(411)
  })

  it('restore upload expires after 1h; a newer one replaces the older', async () => {
    mkUser('yon', 'admin')
    await start(20)
    const cookie = await loginCookie('yon')
    const a = JSON.parse((await restoreUpload(cookie, Buffer.from('bir'))).body.toString()) as { uploadId: string }
    const b = JSON.parse((await restoreUpload(cookie, Buffer.from('iki'))).body.toString()) as { uploadId: string }
    expect(readdirSync(uploadsDir())).toHaveLength(1)
    expect((await stage(cookie, a.uploadId)).status).toBe(404)
    clock += 60 * 60 * 1000 + 1
    await new Promise((res) => setTimeout(res, 60))
    expect(readdirSync(uploadsDir())).toEqual([])
    expect((await stage(cookie, b.uploadId)).status).toBe(404)
  })
})

describe('UploadStore geri yükleme bütçesi', () => {
  it('one restore upload in flight server-wide; ignores the attachment global cap', () => {
    const d = mkdtempSync(join(tmpdir(), 'gecko-store-'))
    const store = new UploadStore(join(d, 'u'), Date.now, 60_000, 10)
    try {
      const r1 = store.reserve('s1', 2 * 1024 * 1024 * 1024, 'restore')
      expect(typeof r1).toBe('function')
      expect(store.reserve('s2', 1, 'restore')).toBe('quota')
      // ek ayırması geri yükleme payından etkilenmez (genel sınır 10 bayt)
      const a = store.reserve('s1', 5)
      expect(typeof a).toBe('function')
      ;(r1 as () => void)()
      expect(typeof store.reserve('s2', 1, 'restore')).toBe('function')
    } finally {
      store.close()
      rmSync(d, { recursive: true, force: true })
    }
  })
})

describe('dosya adı yardımcıları', () => {
  it('displayName decodes RFC 5987 and strips separators/control chars, max 255 bytes', () => {
    expect(displayName("UTF-8''%C3%B6rnek%20dosya.txt")).toBe('örnek dosya.txt')
    expect(displayName("utf-8'tr'a%2Fb%5Cc.txt")).toBe('abc.txt')
    expect(displayName('duz.txt')).toBe('duz.txt')
    expect(displayName("UTF-8''a%00b%0Ac%7F.txt")).toBe('abc.txt')
    expect(displayName("UTF-8''%E0%A4%A")).toBe('ek')
    expect(displayName(undefined)).toBe('ek')
    expect(displayName("UTF-8''%2F%2F")).toBe('ek')
    const long = displayName(`UTF-8''${encodeURIComponent('ş'.repeat(300))}`)
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(255)
    expect(long).toBe('ş'.repeat(127))
  })

  it('contentDisposition has ASCII fallback and UTF-8 form', () => {
    expect(contentDisposition('a.pdf')).toBe(`attachment; filename="a.pdf"; filename*=UTF-8''a.pdf`)
    expect(contentDisposition("çok 'güzel' (1).txt")).toBe(
      `attachment; filename="cok 'guzel' (1).txt"; filename*=UTF-8''%C3%A7ok%20%27g%C3%BCzel%27%20%281%29.txt`
    )
    expect(contentDisposition('日本.txt')).toBe(`attachment; filename="__.txt"; filename*=UTF-8''%E6%97%A5%E6%9C%AC.txt`)
  })
})
