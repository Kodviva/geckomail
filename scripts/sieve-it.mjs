#!/usr/bin/env node
// `npm run test:sieve-it`: ManageSieve'i gerçek sunucuda sınar.
//   --target dovecot   yerel Docker (varsayılan)
//   --target stalwart  yerel Docker, sabit Stalwart görüntüsü
//   --target all       ikisi sırayla
//   --target remote    tünel: GECKO_SIEVE_IT_HOST, _PORT, _USER, _USER2, _SERVERNAME zorunlu; _IMAP_PORT, _SMTP_AUTH_PORT
//                      isteğe bağlı (yoksa teslimat gerektiren senaryolar atlanır). Parolalar gizli sorulur.
// Güvenlik kapısı burada ve sieveServer.it.ts başında çalışır, kapatan bir ayar yoktur. Parola ekrana ve dosyaya yazılmaz.
import { execFileSync, spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { connect } from 'net'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { createInterface } from 'readline'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const COMPOSE = join(ROOT, 'scripts/sieve-it/docker-compose.yml')
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost'])
const TEST_USER = /^[a-z0-9][a-z0-9._+-]*@(?:[a-z0-9-]+\.)+test$/i
const DOCKER_USERS = ['sieve-1@geckomail-sieve.test', 'sieve-2@geckomail-sieve.test']

/** null: geçti. Kullanıcı denetimi her koşumda çalışır, çünkü tünel de yerel görünür */
export function gateError({ host, users }) {
  if (users.length !== 2) return 'iki kullanıcı gerekir'
  for (const u of users) {
    if (!TEST_USER.test(u)) return `yalnız .test hesapları sınanır: ${JSON.stringify(u)}`
  }
  if (!LOCAL_HOSTS.has(host)) return `ana makine yalnız 127.0.0.1 ya da localhost olabilir, tünel dışı yol yok: ${JSON.stringify(host)}`
  return null
}

/** İlk kimlik reddinden sonra hiçbir login denenmez: yeniden deneme ban sayacını doldurur */
export function authGuard() {
  let rejected = false
  return {
    get rejected() {
      return rejected
    },
    async run(login) {
      if (rejected) throw new Error('kimlik reddi alındı: bu koşumda yeni login denenmez')
      try {
        return await login()
      } catch (e) {
        if (e?.authenticationFailed) rejected = true
        throw e
      }
    }
  }
}

const die = (message) => {
  process.stderr.write(`sieve-it: ${message}\n`)
  process.exit(1)
}

function compose(profile, args, env = {}) {
  return execFileSync('docker', ['compose', '-f', COMPOSE, '--profile', profile, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function publishedPort(profile, service, port) {
  return compose(profile, ['port', service, String(port)]).trim().split(':').pop()
}

/** Dinleyici bayt yollayana kadar bekler: Docker'ın yayın vekili hizmet hazır olmadan da bağlantı kabul eder */
async function waitGreeting(port, ms = 60_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const ok = await new Promise((resolve) => {
      const s = connect({ host: '127.0.0.1', port })
      const done = (v) => {
        s.destroy()
        resolve(v)
      }
      s.setTimeout(2000, () => done(false))
      s.once('data', () => done(true))
      s.once('error', () => done(false))
      s.once('close', () => done(false))
    })
    if (ok) return
    if (Date.now() > deadline) throw new Error(`port ${port} yanıt vermedi`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

async function startDovecot() {
  const pass = randomBytes(24).toString('hex')
  compose('dovecot', ['up', '-d', '--force-recreate'], { USER_PASSWORD: pass })
  const port = publishedPort('dovecot', 'dovecot', 34190)
  await waitGreeting(port)
  return {
    stop: () => compose('dovecot', ['down', '-v']),
    env: {
      GECKO_SIEVE_IT_HOST: '127.0.0.1', GECKO_SIEVE_IT_PORT: port, GECKO_SIEVE_IT_USER: DOCKER_USERS[0], GECKO_SIEVE_IT_USER2: DOCKER_USERS[1],
      GECKO_SIEVE_IT_PASS1: pass, GECKO_SIEVE_IT_PASS2: pass, GECKO_SIEVE_IT_DOCKER: '1', GECKO_SIEVE_IT_TARGET: 'dovecot',
      GECKO_SIEVE_IT_IMAP_PORT: publishedPort('dovecot', 'dovecot', 31143), GECKO_SIEVE_IT_DELIVER_PORT: publishedPort('dovecot', 'dovecot', 31025),
      GECKO_SIEVE_IT_DELIVER_PROTO: 'lmtp'
    }
  }
}

/** Yalnız yerel kapsayıcıda: alan ve hesaplar burada açılır, kapsayıcı inince kalmaz */
async function stalwartAdmin(port, admin, calls) {
  const res = await fetch(`http://127.0.0.1:${port}/jmap/`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(admin).toString('base64')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: calls })
  })
  if (!res.ok) throw new Error(`stalwart yönetim: ${res.status}`)
  return (await res.json()).methodResponses
}

async function waitStalwart(port, admin, ms = 60_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const ok = await stalwartAdmin(port, admin, [['x:Domain/get', { ids: null, properties: ['name'] }, 'd']]).then(() => true, () => false)
    if (ok) return
    if (Date.now() > deadline) throw new Error('stalwart yanıt vermedi')
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

async function startStalwart() {
  const admin = `admin:${randomBytes(24).toString('hex')}`
  const passes = [randomBytes(24).toString('hex'), randomBytes(24).toString('hex')]
  const env = { STALWART_RECOVERY_ADMIN: admin }
  compose('stalwart', ['up', '-d', '--force-recreate'], env)
  const http = publishedPort('stalwart', 'stalwart', 8080)
  await waitStalwart(http, admin)
  const domain = DOCKER_USERS[0].split('@')[1]
  const [[, made]] = await stalwartAdmin(http, admin, [['x:Domain/set', { create: { d: {
    name: domain, certificateManagement: { '@type': 'Manual' }, dkimManagement: { '@type': 'Automatic' }, dnsManagement: { '@type': 'Manual' },
    subAddressing: { '@type': 'Enabled' }
  } } }, 'c']])
  const domainId = made.created?.d?.id
  if (!domainId) throw new Error('stalwart: alan açılamadı')
  const accounts = Object.fromEntries(DOCKER_USERS.map((u, i) => [`a${i}`, {
    '@type': 'User', name: u.split('@')[0], domainId, credentials: { 0: { '@type': 'Password', secret: passes[i] } }, roles: { '@type': 'User' }
  }]))
  const [[, users]] = await stalwartAdmin(http, admin, [['x:Account/set', { create: accounts }, 'c']])
  if (Object.keys(users.created ?? {}).length !== 2) throw new Error('stalwart: hesaplar açılamadı')
  // yalnız bu geçici kapsayıcıda: varsayılan sınır 25 posta/saat, senaryolar bunu aşar
  const [[, throttles]] = await stalwartAdmin(http, admin, [['x:MtaInboundThrottle/get', { ids: null, properties: ['enable'] }, 't']])
  const off = Object.fromEntries(throttles.list.map((x) => [x.id, { enable: false }]))
  await stalwartAdmin(http, admin, [['x:MtaInboundThrottle/set', { update: off }, 'u']])
  const port = publishedPort('stalwart', 'stalwart', 4190)
  await waitGreeting(port)
  return {
    stop: () => compose('stalwart', ['down', '-v']),
    env: {
      GECKO_SIEVE_IT_HOST: '127.0.0.1', GECKO_SIEVE_IT_PORT: port, GECKO_SIEVE_IT_USER: DOCKER_USERS[0], GECKO_SIEVE_IT_USER2: DOCKER_USERS[1],
      GECKO_SIEVE_IT_PASS1: passes[0], GECKO_SIEVE_IT_PASS2: passes[1], GECKO_SIEVE_IT_DOCKER: '1', GECKO_SIEVE_IT_TARGET: 'stalwart',
      GECKO_SIEVE_IT_IMAP_PORT: publishedPort('stalwart', 'stalwart', 993), GECKO_SIEVE_IT_IMAP_TLS: 'implicit',
      GECKO_SIEVE_IT_SMTP_AUTH_PORT: publishedPort('stalwart', 'stalwart', 465), GECKO_SIEVE_IT_JMAP_PORT: http
    }
  }
}

function hiddenPrompt(label) {
  if (!process.stdin.isTTY) die('parola terminalden sorulur, stdin terminal değil')
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = () => {} // yazılan görünmesin
    process.stdout.write(`${label}: `)
    rl.question('', (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

async function remoteTarget() {
  const e = process.env
  return {
    stop: () => {},
    env: {
      GECKO_SIEVE_IT_TARGET: 'remote',
      GECKO_SIEVE_IT_PASS1: await hiddenPrompt(`${e.GECKO_SIEVE_IT_USER} parolası`),
      GECKO_SIEVE_IT_PASS2: await hiddenPrompt(`${e.GECKO_SIEVE_IT_USER2} parolası`)
    }
  }
}

function runVitest(env, outFile, notesFile) {
  return new Promise((resolve, reject) => {
    const args = ['vitest', 'run', '--config', 'scripts/sieve-it/vitest.config.mjs', '--reporter=default', '--reporter=json', `--outputFile.json=${outFile}`]
    const p = spawn('npx', args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env, GECKO_SIEVE_IT_NOTES: notesFile } })
    p.on('error', reject)
    p.on('close', resolve)
  })
}

function readReport(outFile, notesFile) {
  const results = {}
  try {
    for (const f of JSON.parse(readFileSync(outFile, 'utf8')).testResults) {
      for (const t of f.assertionResults) results[t.title] = t.status === 'passed' ? 'geçti' : t.status === 'failed' ? 'KALDI' : 'atlandı'
    }
  } catch {
    // vitest raporsuz çıktıysa çıkış kodu yine başarısızdır
  }
  let notes = {}
  try {
    notes = JSON.parse(readFileSync(notesFile, 'utf8'))
  } catch {
    // not yazılmadan önce durmuş olabilir
  }
  return { results, notes }
}

async function runTarget(name) {
  const dir = mkdtempSync(join(tmpdir(), 'gecko-sieve-it-'))
  const outFile = join(dir, 'vitest.json')
  const notesFile = join(dir, 'notes.json')
  let server = null
  try {
    server = name === 'remote' ? await remoteTarget() : await START[name]()
    const code = await runVitest(server.env, outFile, notesFile)
    return { name, code, ...readReport(outFile, notesFile) }
  } finally {
    try {
      server?.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function printSummary(runs) {
  const titles = [...new Set(runs.flatMap((r) => Object.keys(r.results)))]
  const out = process.stdout
  out.write(`\n| senaryo | ${runs.map((r) => r.name).join(' | ')} |\n|---|${runs.map(() => '---').join('|')}|\n`)
  for (const t of titles) out.write(`| ${t} | ${runs.map((r) => r.results[t] ?? '-').join(' | ')} |\n`)
  for (const r of runs) out.write(`\nNotlar (${r.name}):\n${JSON.stringify(r.notes, null, 1)}\n`)
}

const START = { dovecot: startDovecot, stalwart: startStalwart }

async function main() {
  const i = process.argv.indexOf('--target')
  const target = i === -1 ? 'dovecot' : process.argv[i + 1]
  if (!['dovecot', 'stalwart', 'all', 'remote'].includes(target)) die(`bilinmeyen hedef: ${target}`)
  if (process.env.GECKO_SIEVE_IT_DOCKER) die('GECKO_SIEVE_IT_DOCKER yalnız bu betik tarafından verilir: sertifika denetimi dışarıdan kapatılamaz')
  if (target === 'remote') {
    const e = process.env
    const err = gateError({ host: e.GECKO_SIEVE_IT_HOST ?? '', users: [e.GECKO_SIEVE_IT_USER ?? '', e.GECKO_SIEVE_IT_USER2 ?? ''] })
    if (err) die(err)
    if (!e.GECKO_SIEVE_IT_PORT) die('GECKO_SIEVE_IT_PORT gerekli')
    if (!e.GECKO_SIEVE_IT_SERVERNAME) die('GECKO_SIEVE_IT_SERVERNAME gerekli: tünelde sertifika gerçek adla doğrulanır')
  }
  const names = target === 'all' ? ['dovecot', 'stalwart'] : [target]
  const runs = []
  for (const name of names) {
    const run = await runTarget(name)
    runs.push(run)
    if (run.notes.authRejected) break // kimlik reddi: sonraki hedef de başlamaz
  }
  printSummary(runs)
  process.exitCode = runs.every((r) => r.code === 0) ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => die(e instanceof Error ? e.message : String(e)))
}
