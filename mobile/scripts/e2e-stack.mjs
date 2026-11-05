#!/usr/bin/env node
// Simülatör ve emülatör denemeleri için yerel yığın: geçici dizinde derlenmiş sunucu, gerçek imzalı röle, sahte APNs/FCM.
// Gerçek hesap, gerçek posta ya da dış ağ yok. Önkoşul: npm run build:server && npx vite build --config vite.e2e.config.ts
// Kullanım: node mobile/scripts/e2e-stack.mjs            yığın açık kalır, denetim ucu 127.0.0.1:9102
//           node mobile/scripts/e2e-stack.mjs --chain    motor + röle zinciri çalışır, testdata/engine-chain.json yazılır, çıkar
import { spawn, execFileSync } from 'node:child_process'
import { createECDH, createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import tls from 'node:tls'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

process.removeAllListeners('warning') // .ts modüller doğrudan içe aktarılır
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const req = createRequire(join(ROOT, 'package.json'))
const Database = req('better-sqlite3')
const { WebSocket } = req('ws')
const load = (p) => import(pathToFileURL(join(ROOT, p)).href)
const { seedMail } = await load('e2e/seed.ts')
const { base32Decode, totpCode } = await load('src/sync/auth/totp.ts')

const SERVER_PORT = 9100
const RELAY_TLS_PORT = 9101
const CONTROL_PORT = 9102
const RELAY_PORT = 9103
const ORIGIN = `http://localhost:${SERVER_PORT}`
export const USER = { username: 'deneme', password: 'deneme-parola-1' }

const chain = process.argv.includes('--chain')
const dir = mkdtempSync(join(tmpdir(), 'gecko-mobil-'))
const children = []
const cleanup = () => {
  for (const c of children) c.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
}
process.on('exit', cleanup)
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0))

/** Yalnız yerel, tek kullanımlık: GECKO_RELAY_URL https ister */
function relayCert() {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', join(dir, 'relay.key'), '-out', join(dir, 'relay.crt')], { stdio: 'ignore' })
  return { key: readFileSync(join(dir, 'relay.key')), cert: readFileSync(join(dir, 'relay.crt')) }
}

const env = {
  ...process.env,
  GECKO_DATA_DIR: join(dir, 'server'),
  GECKO_LISTEN: `127.0.0.1:${SERVER_PORT}`,
  GECKO_PUBLIC_ORIGIN: ORIGIN,
  GECKO_RELAY_URL: `https://localhost:${RELAY_TLS_PORT}`,
  NODE_EXTRA_CA_CERTS: join(dir, 'relay.crt')
}
mkdirSync(env.GECKO_DATA_DIR)
mkdirSync(join(dir, 'relay'))

const logs = { server: [], relay: [] }
const captured = []
let onCapture = () => {}

function startRelay() {
  const p = spawn(process.execPath, [join(ROOT, 'out/e2e-server/relay.mjs')], {
    env: { ...process.env, RELAY_DATA_DIR: join(dir, 'relay'), RELAY_LISTEN: `127.0.0.1:${RELAY_PORT}`, RELAY_PUBLIC_HOST: `localhost:${RELAY_TLS_PORT}` },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(p)
  createInterface({ input: p.stdout }).on('line', (line) => {
    logs.relay.push(line)
    try {
      captured.push(JSON.parse(line))
      onCapture()
    } catch { /* yakalama satırı değil */ }
  })
  createInterface({ input: p.stderr }).on('line', (line) => logs.relay.push(line))
  tls.createServer(relayCert(), (s) => {
    const up = net.connect(RELAY_PORT, '127.0.0.1')
    s.pipe(up).pipe(s)
    s.on('error', () => up.destroy())
    up.on('error', () => s.destroy())
  }).listen(RELAY_TLS_PORT, '127.0.0.1')
}

function cli(args, stdin) {
  execFileSync(process.execPath, [join(ROOT, 'out/server/index.mjs'), ...args], { env, input: stdin, stdio: ['pipe', 'ignore', 'pipe'] })
}

async function startServer() {
  const p = spawn(process.execPath, [join(ROOT, 'out/e2e-server/index.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(p)
  for (const s of [p.stdout, p.stderr]) createInterface({ input: s }).on('line', (line) => logs.server.push(line))
  for (let i = 0; i < 200; i++) {
    if (await fetch(`${ORIGIN}/healthz`).then((r) => r.ok, () => false)) return p
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`sunucu açılmadı: ${logs.server.slice(-5).join(' | ')}`)
}

const withDb = (fn) => {
  const db = new Database(join(env.GECKO_DATA_DIR, 'geckomail.db'))
  try {
    db.pragma('busy_timeout = 5000')
    return fn(db)
  } finally {
    db.close()
  }
}

/** Çerezli web oturumundan 2FA açılır: uygulamanın gireceği yol gerçek TOTP ister */
async function enableTotp() {
  const res = await fetch(`${ORIGIN}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(USER)
  })
  if (!res.ok) throw new Error(`web girişi ${res.status}`)
  const cookie = res.headers.get('set-cookie').split(';')[0]
  const ws = new WebSocket(`ws://localhost:${SERVER_PORT}/rpc`, { headers: { Cookie: cookie, Origin: ORIGIN } })
  await new Promise((ok, no) => { ws.once('open', ok); ws.once('error', no) })
  let id = 0
  const call = (method, params) => new Promise((ok, no) => {
    const mine = ++id
    const on = (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.id !== mine) return
      ws.off('message', on)
      if (m.error) no(new Error(`${method}: ${JSON.stringify(m.error)}`))
      else ok(m.result)
    }
    ws.on('message', on)
    ws.send(JSON.stringify({ id: mine, method, params }))
  })
  const { secretBase32 } = await call('twoFactorBegin')
  await call('twoFactorConfirm', { code: totpCode(base32Decode(secretBase32), Math.floor(Date.now() / 1000)) })
  ws.close()
  return secretBase32
}

/** Tek sayfalık geçerli PDF: QuickLook ve ACTION_VIEW gerçek dosya görsün */
function tinyPdf() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length 44 >>\nstream\nBT /F1 18 Tf 40 100 Td (GeckoMail ek) Tj ET\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const at = []
  objs.forEach((o, i) => {
    at.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((a) => `${String(a).padStart(10, '0')} 00000 n \n`).join('')}`
  return Buffer.from(`${out}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}

function seed() {
  return withDb((db) => {
    const now = Date.now()
    const m = seedMail(db, {
      email: 'deneme@example.test',
      messages: [
        { subject: 'Betikli ileti', fromName: 'Ayşe Yılmaz', from: 'ayse@example.test', preview: 'Bağlantıya dokunun' },
        { subject: 'PDF ekli rapor', fromName: 'Mehmet Kaya', from: 'mehmet@example.test', preview: 'Ek dosya' },
        ...Array.from({ length: 12 }, (_, i) => ({ subject: `Deneme iletisi ${i + 1}`, fromName: 'Elif Demir', from: 'elif@example.test', preview: 'Uzun liste', seen: i > 2 }))
      ]
    })
    const [htmlId, pdfId] = m.messageIds
    const html = `<p id="ilk">Merhaba</p><script>window.parent.postMessage('betik-calisti','*');document.body.innerHTML='BETIK CALISTI'</script>`
      + `<p><a href="https://example.com/" target="_blank">Dış bağlantı</a></p><img src="x" onerror="document.body.innerHTML='BETIK CALISTI'">`
    const body = db.prepare(`INSERT INTO bodies (message_id, text_plain, html, fetched_at, last_access_at, raw_size) VALUES (?, ?, ?, ?, ?, ?)`)
    body.run(htmlId, 'Merhaba', html, now, now, html.length)
    body.run(pdfId, 'Rapor ekte.', null, now, now, 100)
    const pdf = tinyPdf()
    const disk = join(env.GECKO_DATA_DIR, 'attachments')
    mkdirSync(disk, { recursive: true })
    writeFileSync(join(disk, 'rapor.bin'), pdf)
    db.prepare(`UPDATE messages SET has_attachments = 1 WHERE id = ?`).run(pdfId)
    db.prepare(`INSERT INTO attachments (message_id, part_id, filename, mime, size, content_id, disk_path, fetched_at, last_access_at)
                VALUES (?, '2', 'rapor.pdf', 'application/pdf', ?, NULL, ?, ?, ?)`).run(pdfId, pdf.length, join(disk, 'rapor.bin'), now, now)
    return m
  })
}

const totp = (secret) => totpCode(base32Decode(secret), Math.floor(Date.now() / 1000))

function pushItem(messageId, level = 'normal') {
  return { title: 'Ayşe Yılmaz', body: 'Betikli ileti', accountId: null, messageId, level, tag: `m${messageId}`, count: 1 }
}

const waitCapture = () => new Promise((ok, no) => {
  const n = captured.length
  const timer = setTimeout(() => no(new Error('yakalama yok')), 10_000)
  onCapture = () => {
    if (captured.length > n) {
      clearTimeout(timer)
      ok(captured.at(-1))
    }
  }
})

/** Yerel katmanın yaptığı yol: giriş, erişim, cihaz kaydı. Anahtarlar yalnız bu vektör için üretilir */
async function chainVector(server, secret, messageId) {
  // fetch Sec-Fetch başlığı ekler, yerel uçlar reddeder: yerel katman gibi düz http
  const post = (path, bearer, json) => new Promise((ok, no) => {
    const body = json ? JSON.stringify(json) : undefined
    const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }
    const q = http.request(`${ORIGIN}${path}`, { method: 'POST', headers }, (r) => {
      let text = ''
      r.on('data', (d) => (text += d))
      r.on('end', () => (r.statusCode < 300 ? ok(JSON.parse(text)) : no(new Error(`${path} ${r.statusCode}`))))
    })
    q.on('error', no)
    q.end(body)
  })
  await new Promise((r) => setTimeout(r, 31_000)) // TOTP adımı yeniden kullanılamaz
  const { token } = await post('/api/mobile/login', null, { ...USER, totp: totp(secret) })
  const { accessToken } = await post('/api/mobile/token', token)
  const out = {}
  for (const [platform, env, deviceToken] of [['ios', 'sandbox', 'a'.repeat(64)], ['android', 'production', 'f'.repeat(163)]]) {
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    const auth = randomBytes(16)
    await post('/api/mobile/device', accessToken, { platform, env, token: deviceToken, p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url'), label: 'zincir' })
    const got = waitCapture()
    server.stdin.write(`${JSON.stringify({ userId: 1, item: pushItem(messageId) })}\n`)
    const cap = await got
    out[platform] = { uaPrivate: ecdh.getPrivateKey().toString('base64url'), uaPublic: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url'), provider: cap.provider, body: JSON.parse(cap.body) }
    withDb((db) => db.prepare(`DELETE FROM push_devices`).run())
  }
  return out
}

function controlServer(server, secret, ids) {
  const routes = {
    'GET /totp': () => ({ code: totp(secret) }),
    'GET /seed': () => ids,
    'GET /captured': () => captured,
    'GET /logs': () => logs,
    /** Yerel oturum tablosunda her satır gider: uygulama açıkken sunucudan iptal */
    'POST /revoke': () => withDb((db) => ({ deleted: db.prepare(`DELETE FROM web_sessions WHERE kind = 'mobile'`).run().changes })),
    /** Oturum 8 gün boşta: push sürer, erişim yok (Review Focus 1) */
    'POST /idle': () => withDb((db) => ({ updated: db.prepare(`UPDATE web_sessions SET last_seen_at = ? WHERE kind = 'mobile'`).run(Date.now() - 8 * 24 * 3600_000).changes })),
    'GET /sessions': () => withDb((db) => db.prepare(`SELECT substr(id_hash, 1, 8) AS id, kind, last_seen_at FROM web_sessions`).all()),
    'GET /devices': () => withDb((db) => db.prepare(`SELECT id, web_session_id, label FROM push_devices`).all().map((d) => ({ ...d, web_session_id: d.web_session_id?.slice(0, 8) }))),
    'POST /push': async () => {
      const got = waitCapture()
      server.stdin.write(`${JSON.stringify({ userId: 1, item: pushItem(ids.messageIds[0]) })}\n`)
      return got
    }
  }
  http.createServer(async (rq, rs) => {
    const route = routes[`${rq.method} ${rq.url}`]
    if (!route) return rs.writeHead(404).end()
    try {
      const out = await route()
      rs.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out))
    } catch (e) {
      rs.writeHead(500).end(String(e))
    }
  }).listen(CONTROL_PORT, '127.0.0.1')
}

startRelay()
cli(['create-admin', USER.username], `${USER.password}\n`)
const server = await startServer()
const secret = await enableTotp()
const ids = seed()
if (chain) {
  const vector = await chainVector(server, secret, ids.messageIds[0])
  writeFileSync(join(ROOT, 'mobile/testdata/engine-chain.json'), `${JSON.stringify({
    note: 'mobile/scripts/e2e-stack.mjs --chain üretir: derlenmiş motor, gerçek imzalı röle, sahte sağlayıcı. Anahtarlar yalnız bu vektör için',
    expected: { title: 'Ayşe Yılmaz', body: 'Betikli ileti', messageId: ids.messageIds[0] }, ...vector
  }, null, 2)}\n`)
  const seen = [...logs.server, ...logs.relay.filter((l) => !l.startsWith('{"provider"'))].join('\n')
  for (const leak of ['gms_', 'gma_', 'gmt_', 'Betikli', 'example.test', 'Ayşe']) if (seen.includes(leak)) throw new Error(`günlükte sızıntı: ${leak}`)
  console.log('zincir yazıldı, günlükte belirteç ve içerik yok')
  process.exit(0)
}
controlServer(server, secret, ids)
console.log(`hazır: ${ORIGIN} kullanıcı ${USER.username}, denetim 127.0.0.1:${CONTROL_PORT}, tohum ${JSON.stringify(ids)} ${createHash('sha256').update(secret).digest('hex').slice(0, 6)}`)
