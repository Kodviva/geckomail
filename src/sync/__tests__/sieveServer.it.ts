// Gerçek sunucuda ManageSieve ve üretilen betikler. Yalnız `npm run test:sieve-it` çalıştırır: `npm test` toplamaz.
// Güvenlik kapısı dosya yüklenirken de çalışır. Yalnız `geckomail-` önekli betikler ve kendi açtığımız klasörler silinir.
import { createHash, randomBytes } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { ImapFlow } from 'imapflow'
import { createTransport } from 'nodemailer'
import { connect as netConnect } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authGuard, gateError } from '../../../scripts/sieve-it.mjs'
import type { RuleAction, RuleCondition } from '../../shared/rpc'
import { SIEVE_RULES_SCRIPT as RULES, SIEVE_VACATION_CONFLICT, SIEVE_WRAPPER_SCRIPT as WRAPPER, type SieveVacation } from '../../shared/sieve'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { DEFAULT_LIMITS, HostGovernor } from '../net/hostGovernor'
import { clearDetectCache, detectSieve } from '../sieve/detect'
import { ManageSieveClient, type SieveConnectOpts } from '../sieve/manageSieve'
import { SieveManager } from '../sieve/manager'

const env = process.env
const T = {
  target: env.GECKO_SIEVE_IT_TARGET ?? '',
  host: env.GECKO_SIEVE_IT_HOST ?? '',
  port: Number(env.GECKO_SIEVE_IT_PORT),
  users: [env.GECKO_SIEVE_IT_USER ?? '', env.GECKO_SIEVE_IT_USER2 ?? ''],
  passes: [env.GECKO_SIEVE_IT_PASS1 ?? '', env.GECKO_SIEVE_IT_PASS2 ?? ''],
  servername: env.GECKO_SIEVE_IT_SERVERNAME,
  /** yalnız sieve-it.mjs verir, dışarıdan gelirse o betik reddeder */
  docker: env.GECKO_SIEVE_IT_DOCKER === '1',
  imapPort: Number(env.GECKO_SIEVE_IT_IMAP_PORT) || 0,
  imapImplicit: env.GECKO_SIEVE_IT_IMAP_TLS === 'implicit',
  deliverPort: Number(env.GECKO_SIEVE_IT_DELIVER_PORT) || 0,
  jmapPort: Number(env.GECKO_SIEVE_IT_JMAP_PORT) || 0,
  smtpAuthPort: Number(env.GECKO_SIEVE_IT_SMTP_AUTH_PORT) || 0
}
const gate = gateError({ host: T.host, users: T.users })
if (gate) throw new Error(`sieve-it: ${gate}`)
if (!T.docker && !T.servername) throw new Error('sieve-it: sertifika gerçek adla doğrulanır')

/** 30 Eylül JMAP oturumundan; o gün yalnız bu 12'si not edilmiş, toplam 47 */
const JMAP_SEP30 = ['fileinto', 'mailbox', 'special-use', 'imap4flags', 'include', 'foreverypart', 'mime', 'copy', 'body', 'variables', 'vacation', 'duplicate']
const CRLF = '\r\n'
const INVALID_LINE3 = `require "fileinto";${CRLF}if true {${CRLF}  nonsense "x";${CRLF}}${CRLF}`

const guard = authGuard()
const notes: Record<string, unknown> = {}
const note = (key: string, value: unknown): void => {
  notes[key] = value
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const token = (): string => randomBytes(6).toString('hex')

const connectGuarded = async (o: SieveConnectOpts): Promise<ManageSieveClient> => {
  const c = await ManageSieveClient.connect({ ...o, servername: T.servername, rejectUnauthorized: !T.docker })
  const login = c.authenticate.bind(c)
  c.authenticate = (cred) => guard.run(() => login(cred))
  return c
}

/** `user` 0 ya da 1 */
async function sieve<R>(user: number, fn: (c: ManageSieveClient) => Promise<R>): Promise<R> {
  const c = await connectGuarded({ host: T.host, port: T.port, tls: detectedTls, rejectUnauthorized: !T.docker })
  try {
    await c.authenticate({ kind: 'password', user: T.users[user], password: T.passes[user] })
    const out = await fn(c)
    await c.logout()
    return out
  } finally {
    c.close()
  }
}

async function imap<R>(user: number, fn: (c: ImapFlow) => Promise<R>): Promise<R> {
  const c = new ImapFlow({
    host: T.host, port: T.imapPort, secure: T.imapImplicit, doSTARTTLS: T.imapImplicit ? undefined : true, logger: false,
    auth: { user: T.users[user], pass: T.passes[user] },
    tls: { rejectUnauthorized: !T.docker, servername: T.servername }
  })
  c.on('error', () => {})
  await guard.run(() => c.connect())
  try {
    return await fn(c)
  } finally {
    await c.logout().catch(() => {})
    c.close()
  }
}

interface Landed {
  folder: string
  flags: string[]
  subject: string
}

async function listAll(user: number): Promise<Landed[]> {
  return imap(user, async (c) => {
    const out: Landed[] = []
    for (const box of await c.list()) {
      if (box.flags.has('\\Noselect')) continue
      const lock = await c.getMailboxLock(box.path)
      try {
        if (c.mailbox && c.mailbox.exists > 0) {
          for await (const m of c.fetch('1:*', { flags: true, envelope: true })) {
            out.push({ folder: box.path, flags: [...(m.flags ?? [])], subject: m.envelope?.subject ?? '' })
          }
        }
      } finally {
        lock.release()
      }
    }
    return out
  })
}

/** En az `n` kopya görünene kadar bekler, sonra fazla kopya gelecek mi diye bir süre daha izler */
async function landed(user: number, tok: string, n = 1, settleMs = 700): Promise<Landed[]> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const found = (await listAll(user)).filter((m) => m.subject.includes(tok))
    if (found.length >= n) break
    if (Date.now() > deadline) return found
    await sleep(250)
  }
  await sleep(settleMs)
  return (await listAll(user)).filter((m) => m.subject.includes(tok))
}

/** Stalwart: kimlikli gönderim, 25'teki spam süzgeci ve hız sınırı sınanan şey değil. Gönderen hep sınama hesabı */
async function submit(fromUser: number, to: string, raw: string): Promise<void> {
  const smtp = createTransport({
    host: T.host, port: T.smtpAuthPort, secure: true, auth: { user: T.users[fromUser], pass: T.passes[fromUser] },
    tls: { rejectUnauthorized: !T.docker, servername: T.servername }
  })
  try {
    await guard.run(() => smtp.sendMail({ envelope: { from: T.users[fromUser], to }, raw }))
  } finally {
    smtp.close()
  }
}

/** LMTP ile teslim (Dovecot): yalnız iki .test adresi arasında. Yanıt 2xx/3xx değilse hata */
function lmtp(to: string, from: string, raw: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = netConnect({ host: T.host, port: T.deliverPort })
    const steps = [
      'LHLO it.test', `MAIL FROM:<${from}>`, `RCPT TO:<${to}>`, 'DATA',
      `${raw.replace(/\r?\n/g, CRLF).replace(/^\./gm, '..')}${CRLF}.`, 'QUIT'
    ]
    let i = -1
    let buf = ''
    s.setTimeout(20_000, () => s.destroy(new Error('teslim zaman aşımı')))
    s.on('error', reject)
    s.on('close', () => (i >= steps.length - 1 ? resolve() : reject(new Error(`teslim kesildi: ${buf.slice(0, 200)}`))))
    s.on('data', (d) => {
      buf += String(d)
      const lines = buf.split(CRLF)
      const done = lines.filter((l) => /^\d{3} /.test(l))
      if (!done.length) return
      const last = done[done.length - 1]
      if (!/^[23]/.test(last)) {
        s.destroy(new Error(`teslim reddi: ${last.slice(0, 200)}`))
        return
      }
      buf = ''
      i++
      if (i < steps.length) s.write(`${steps[i]}${CRLF}`)
      else s.end()
    })
  })
}

const b64Subject = (s: string): string => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`

async function mail(subject: string, o: { from?: number; to?: number; encoded?: boolean } = {}): Promise<void> {
  const fromUser = o.from ?? 1
  const toUser = o.to ?? 0
  const from = T.users[fromUser]
  const head = `From: ${from}${CRLF}To: ${T.users[toUser]}${CRLF}Subject: ${o.encoded ? b64Subject(subject) : subject}${CRLF}` +
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}${CRLF}Message-ID: <${token()}@it.test>${CRLF}MIME-Version: 1.0${CRLF}Content-Type: text/plain; charset=utf-8${CRLF}`
  const raw = `${head}${CRLF}sınama${CRLF}`
  await (T.smtpAuthPort ? submit(fromUser, T.users[toUser], raw) : lmtp(T.users[toUser], from, raw))
}

/** Yalnız sınama hesabında: önekli betikler gider, kutular boşalır. Başka adlı betik varsa dokunulmaz, sınama durur */
async function resetAccount(user: number): Promise<void> {
  const had = await sieve(user, async (c) => {
    await c.setActive('')
    const list = await c.listScripts()
    for (const s of list) {
      if (!s.name.startsWith('geckomail-')) throw new Error('sınama hesabında yabancı betik')
      await c.deleteScript(s.name)
    }
    return list.length
  })
  // Dovecot `.dovecot.svbin` tazeliğini saniye çözünürlüğünde tartar: aynı saniyede gelen yeni betik eski ikiliyi kullanır
  if (had) await sleep(1100)
  if (!T.imapPort) return
  await imap(user, async (c) => {
    for (const box of await c.list()) {
      if (box.flags.has('\\Noselect')) continue
      const lock = await c.getMailboxLock(box.path)
      try {
        if (c.mailbox && c.mailbox.exists > 0) await c.messageDelete('1:*')
      } finally {
        lock.release()
      }
      if (box.path.startsWith('It')) await c.mailboxDelete(box.path).catch(() => {})
    }
  })
}

let detectedTls: 'starttls' | 'tls' = 'starttls'
let extensions: string[] = []

describe(`gerçek sunucu: ${T.target}`, () => {
  let dir = ''
  let db: ReturnType<typeof openDb>
  let q: ReturnType<typeof makeQueries>
  let acc = 0
  let m: SieveManager
  let clock = 1_000_000

  beforeEach(async () => {
    expect(guard.rejected).toBe(false)
    clearDetectCache()
    const r = await detectSieve({ host: T.host, port: T.port, rejectUnauthorized: !T.docker, authType: 'password' }, { now: Date.now, connect: connectGuarded })
    expect(r.supported).toBe(true)
    detectedTls = r.tls ?? 'starttls'
    extensions = r.caps?.sieve ?? []
    await resetAccount(0)
    await resetAccount(1)
    dir = mkdtempSync(join(tmpdir(), 'gecko-sieve-srv-'))
    db = openDb(dir)
    q = makeQueries(db)
    acc = q.insertAccount({ email: T.users[0], displayName: null, imapHost: T.host, imapPort: T.imapPort || 993, smtpHost: T.host, smtpPort: 25, passwordEnc: Buffer.from('x') })
    q.updateAccountFields(acc, { allow_invalid_certs: T.docker ? 1 : 0 })
    q.upsertFolder(acc, 'INBOX', 'inbox', false)
    q.upsertSieveAccount(acc, { port: T.port }, Date.now())
    const gov = new HostGovernor(T.host, DEFAULT_LIMITS, () => (clock += 60_000))
    m = new SieveManager({
      q, creds: new Map([[acc, T.passes[0]]]),
      scheduler: { governorFor: () => gov, sieveLoginGate: () => null, sieveCooldown: () => {}, sieveLoginOk: () => {} },
      connect: connectGuarded, detect: (t, o) => detectSieve(t, { ...o, now: o?.now ?? Date.now, connect: connectGuarded }), onState: () => {}, debounceMs: 10
    })
  })

  afterEach(() => {
    m?.stop()
    db?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  afterAll(async () => {
    if (!guard.rejected) {
      await resetAccount(0).catch(() => {})
      await resetAccount(1).catch(() => {})
    }
    note('authRejected', guard.rejected)
    if (env.GECKO_SIEVE_IT_NOTES) writeFileSync(env.GECKO_SIEVE_IT_NOTES, JSON.stringify(notes), { mode: 0o600 })
  })

  const needsMail = (ctx: { skip(): void }): void => {
    if ((!T.deliverPort && !T.smtpAuthPort) || !T.imapPort) ctx.skip()
  }
  const rule = (conditions: RuleCondition, actions: RuleAction[]): number =>
    q.insertRule({ name: `r${token()}`, accountId: null, groupId: null, conditions, actions })
  /** Sunucuda ve yerel klasör listesinde */
  const folder = async (path: string, kind: 'other' | 'archive' | 'junk' = 'other'): Promise<void> => {
    await imap(0, async (c) => {
      if (!(await c.list()).some((b) => b.path === path)) await c.mailboxCreate(path)
    })
    q.upsertFolder(acc, path, kind, kind !== 'other')
  }
  const scripts = (user = 0) => sieve(user, (c) => c.listScripts())
  const activeName = async (): Promise<string | null> => (await scripts()).find((s) => s.active)?.name ?? null
  const userScript = async (name: string, text: string): Promise<string> => {
    await sieve(0, async (c) => {
      await c.putScript(name, text)
      await c.setActive(name)
    })
    return sha(await sieve(0, (c) => c.getScript(name)))
  }
  const wrap = async (name: string): Promise<void> => {
    const info = await m.setEnabled(acc, true)
    expect(info).toMatchObject({ state: 'needs_consent', consentNeededFor: name })
    expect(await m.consent(acc, name)).toMatchObject({ state: 'active', wrapperOf: name })
    expect(await activeName()).toBe(WRAPPER)
  }

  it('caps', async () => {
    const info = await sieve(0, async (c) => c.caps)
    const lower = info.sieve.map((e) => e.toLowerCase())
    note('caps', info)
    note('caps.jmapSep30Missing', JMAP_SEP30.filter((e) => !lower.includes(e)))
    note('caps.notInSep30List', lower.filter((e) => !JMAP_SEP30.includes(e)))
    expect(lower).toEqual(expect.arrayContaining(['fileinto', 'imap4flags', 'include', 'vacation']))
  })

  it('tls mode', async () => {
    note('tlsMode', detectedTls)
    const r = await detectSieve({ host: T.host, port: T.port, rejectUnauthorized: !T.docker, authType: 'password' }, { now: Date.now, connect: connectGuarded, force: true })
    expect(r).toMatchObject({ supported: true, reason: null })
    expect(r.caps?.sasl).toContain('PLAIN')
  })

  it('deploy no active', async (ctx) => {
    needsMail(ctx)
    await folder('ItRapor')
    rule({ subjectContains: 'rapor' }, [{ type: 'move', folderName: 'ItRapor' }])
    expect(await m.setEnabled(acc, true)).toMatchObject({ state: 'active' })
    expect(await activeName()).toBe(RULES)
    const tok = token()
    await mail(`Rapor ${tok}`)
    expect((await landed(0, tok)).map((x) => x.folder)).toEqual(['ItRapor'])
  })

  it('replace active', async (ctx) => {
    needsMail(ctx)
    await folder('ItBir')
    await folder('ItIki')
    const id = rule({ subjectContains: 'rapor' }, [{ type: 'move', folderName: 'ItBir' }])
    await m.setEnabled(acc, true)
    const before = q.getSieveAccount(acc)?.script_hash
    q.updateRuleFields(id, { actions_json: JSON.stringify([{ type: 'move', folderName: 'ItIki' }]) })
    expect(await m.deployNow(acc)).toMatchObject({ state: 'active' })
    expect(q.getSieveAccount(acc)?.script_hash).not.toBe(before)
    expect(await activeName()).toBe(RULES)
    const tok = token()
    await mail(`Rapor ${tok}`)
    expect((await landed(0, tok)).map((x) => x.folder)).toEqual(['ItIki'])
  })

  it('wrapper with user script', async (ctx) => {
    needsMail(ctx)
    await folder('ItRapor')
    await imap(0, (c) => c.mailboxCreate('ItKullanici'))
    const user = `require ["fileinto"];${CRLF}# Şeker kuralı${CRLF}if header :contains "subject" "kullanici" { fileinto "ItKullanici"; }${CRLF}`
    const before = await userScript('geckomail-it-user', user)
    rule({ subjectContains: 'rapor' }, [{ type: 'move', folderName: 'ItRapor' }])
    await wrap('geckomail-it-user')
    expect(sha(await sieve(0, (c) => c.getScript('geckomail-it-user')))).toBe(before)
    const [a, b] = [token(), token()]
    await mail(`Rapor ${a}`)
    await mail(`kullanici ${b}`)
    expect((await landed(0, a)).map((x) => x.folder)).toEqual(['ItRapor'])
    expect((await landed(0, b)).map((x) => x.folder)).toEqual(['ItKullanici'])
  })

  it('flag implicit keep', async (ctx) => {
    needsMail(ctx)
    rule({ subjectContains: 'okundu' }, [{ type: 'markRead' }])
    await m.setEnabled(acc, true)
    const tok = token()
    await mail(`okundu ${tok}`)
    const [x] = await landed(0, tok)
    expect(x.folder).toBe('INBOX')
    expect(x.flags).toContain('\\Seen')
  })

  it('wrapper addflag implicit keep', async (ctx) => {
    needsMail(ctx)
    await imap(0, (c) => c.mailboxCreate('ItKullanici'))
    await userScript('geckomail-it-user', `require ["fileinto"];${CRLF}if header :contains "subject" "kullanici" { fileinto "ItKullanici"; }${CRLF}`)
    rule({ subjectContains: 'okundu' }, [{ type: 'markRead' }])
    await wrap('geckomail-it-user')
    const [keep, filed] = [token(), token()]
    await mail(`okundu ${keep}`)
    await mail(`okundu kullanici ${filed}`)
    const kept = await landed(0, keep)
    const moved = await landed(0, filed)
    note('wrapper.addflag.implicitKeep', kept)
    note('wrapper.addflag.userFileinto', moved)
    expect(kept.map((x) => x.folder)).toEqual(['INBOX'])
    expect(kept[0].flags).toContain('\\Seen')
  })

  it('wrapper both move', async (ctx) => {
    needsMail(ctx)
    await folder('ItRapor')
    await imap(0, (c) => c.mailboxCreate('ItKullanici'))
    await userScript('geckomail-it-user', `require ["fileinto"];${CRLF}if header :contains "subject" "ikisi" { fileinto "ItKullanici"; }${CRLF}`)
    rule({ subjectContains: 'ikisi' }, [{ type: 'move', folderName: 'ItRapor' }])
    await wrap('geckomail-it-user')
    const tok = token()
    await mail(`ikisi ${tok}`)
    note('wrapper.bothMove.copies', (await landed(0, tok, 1, 2000)).map((x) => x.folder))
  })

  it('wrapper missing user script', async (ctx) => {
    needsMail(ctx)
    await folder('ItRapor')
    await userScript('geckomail-it-user', `# kullanıcı${CRLF}keep;${CRLF}`)
    rule({ subjectContains: 'rapor' }, [{ type: 'move', folderName: 'ItRapor' }])
    await wrap('geckomail-it-user')
    await sieve(0, (c) => c.deleteScript('geckomail-it-user'))
    expect(await activeName()).toBe(WRAPPER)
    const [a, b] = [token(), token()]
    await mail(`Rapor ${a}`)
    await mail(`diger ${b}`)
    const hit = await landed(0, a)
    note('wrapper.missing', { rule: hit.map((x) => x.folder) })
    // Stalwart kuralı çalıştırır. Dovecot'ta çalışma zamanı hatası: ileti Gelen Kutusu'nda, K9 istemcide uygular
    expect(hit.map((x) => x.folder)).toEqual([T.target === 'dovecot' ? 'INBOX' : 'ItRapor'])
    expect((await landed(0, b)).map((x) => x.folder)).toEqual(['INBOX'])
  })

  it('optional include after delete', async (ctx) => {
    needsMail(ctx)
    await folder('ItRapor')
    const text = `require ["include"];${CRLF}include :personal "${RULES}";${CRLF}include :personal :optional "geckomail-it-user";${CRLF}`
    await userScript('geckomail-it-user', `if false { keep; }${CRLF}`)
    await sieve(0, async (c) => {
      await c.setActive('')
      await c.putScript(RULES, `require ["fileinto"];${CRLF}if header :contains "subject" "rapor" { fileinto "ItRapor"; }${CRLF}`)
      await c.putScript('geckomail-it-wrap', text)
      await c.setActive('geckomail-it-wrap')
    })
    const first = token()
    await mail(`Rapor ${first}`)
    expect(await landed(0, first)).toHaveLength(1)
    await sleep(1100)
    await sieve(0, (c) => c.deleteScript('geckomail-it-user'))
    const tok = token()
    const crashed = await mail(`Rapor ${tok}`).then(() => false, (e: Error) => /teslim kesildi/.test(e.message))
    note('optionalInclude', { crashed, landed: crashed ? [] : (await landed(0, tok)).map((x) => x.folder) })
    // Dovecot 2.4.5: ikili silinen hedefe bakarken LMTP düşer, üreticinin :optional yazmama nedeni. Hesap düzelsin
    if (crashed) await sieve(0, (c) => c.putScript('geckomail-it-user', `keep;${CRLF}`))
    if (crashed) {
      await sleep(1100)
      await sieve(0, async (c) => {
        await c.putScript('geckomail-it-yeni', `keep;${CRLF}`)
        await c.setActive('geckomail-it-yeni')
      })
      await sleep(1100)
      await mail(`onarim ${token()}`)
    }
    expect(crashed).toBe(T.target === 'dovecot')
  })

  it('rollback exact', async () => {
    const before = await userScript('geckomail-it-user', `# kullanıcı${CRLF}keep;${CRLF}`)
    rule({ subjectContains: 'rapor' }, [{ type: 'markRead' }])
    await wrap('geckomail-it-user')
    expect(await m.setEnabled(acc, false)).toMatchObject({ state: 'off', enabled: false })
    const after = await scripts()
    expect(after).toEqual([{ name: 'geckomail-it-user', active: true }])
    expect(sha(await sieve(0, (c) => c.getScript('geckomail-it-user')))).toBe(before)
    // etkin betik yokken açılan hesap yine hiçbir şeyi etkin bırakmaz
    await sieve(0, async (c) => {
      await c.setActive('')
      await c.deleteScript('geckomail-it-user')
    })
    await m.setEnabled(acc, true)
    expect(await activeName()).toBe(RULES)
    await m.setEnabled(acc, false)
    expect(await scripts()).toEqual([])
  })

  it('turkish subject', async (ctx) => {
    needsMail(ctx)
    await imap(0, (c) => c.mailboxCreate('ItEslesti'))
    const header = (cond: string, ext = ''): string =>
      `require ["fileinto"${ext}];${CRLF}if ${cond} { fileinto "ItEslesti"; }${CRLF}`
    const unicode = ', "comparator-i;unicode-casemap"'
    const branches: { key: string; script: string; subject: string }[] = [
      { key: 'ascii.tamHarf', script: header('header :contains "subject" "ŞEKER"'), subject: 'ŞEKER Raporu' },
      { key: 'ascii.kucukHarf', script: header('header :contains "subject" "şeker"'), subject: 'ŞEKER Raporu' },
      { key: 'ascii.asciiKisim', script: header('header :contains "subject" "RAPORU"'), subject: 'ŞEKER Raporu' },
      { key: 'unicode.kucukHarf', script: header('header :comparator "i;unicode-casemap" :contains "subject" "şeker"', unicode), subject: 'ŞEKER Raporu' },
      { key: 'unicode.noktasizI', script: header('header :comparator "i;unicode-casemap" :contains "subject" "ışık"', unicode), subject: 'IŞIK Raporu' }
    ]
    const result: Record<string, string> = {}
    for (const b of branches) {
      const check = await sieve(0, (c) => c.checkScript(b.script))
      if (!check.ok) {
        result[b.key] = `reddedildi: ${check.error}`
        continue
      }
      await sieve(0, async (c) => {
        await c.putScript('geckomail-it-tr', b.script)
        await c.setActive('geckomail-it-tr')
      })
      const tok = token()
      await mail(`${b.subject} ${tok}`, { encoded: true })
      result[b.key] = (await landed(0, tok, 1, 200)).map((x) => x.folder).join(',')
    }
    note('turkish.branches', result)
    await sieve(0, async (c) => {
      await c.setActive('')
      await c.deleteScript('geckomail-it-tr')
    })
    // üreticinin yolu: istemcinin toLowerCase'iyle aynı sonuç ya sunucuda ya istemcide
    await folder('ItTr')
    rule({ subjectContains: 'şeker' }, [{ type: 'move', folderName: 'ItTr' }])
    await m.setEnabled(acc, true)
    const placement = m.placementFor(acc)[0]
    note('turkish.placement', { placement: placement.placement, reason: placement.reason })
    const tok = token()
    await mail(`ŞEKER Raporu ${tok}`, { encoded: true })
    const where = (await landed(0, tok)).map((x) => x.folder)
    note('turkish.generated', where)
    if (extensions.includes('comparator-i;unicode-casemap')) expect(where).toEqual(['ItTr'])
    else {
      expect(placement).toMatchObject({ placement: 'client', reason: 'non_ascii' })
      expect(where).toEqual(['INBOX']) // istemci güvenlik ağı uygular
    }
    expect(result['ascii.tamHarf']).toBe('ItEslesti') // S3: konu RFC 2047 çözümünden sonra eşleşir
  })

  it('flag and move', async (ctx) => {
    needsMail(ctx)
    await folder('ItRapor')
    rule({ subjectContains: 'rapor' }, [{ type: 'markRead' }, { type: 'flag' }, { type: 'move', folderName: 'ItRapor' }])
    await m.setEnabled(acc, true)
    const tok = token()
    await mail(`Rapor ${tok}`)
    const found = await landed(0, tok)
    expect(found.map((x) => x.folder)).toEqual(['ItRapor'])
    expect(found[0].flags).toEqual(expect.arrayContaining(['\\Seen', '\\Flagged']))
  })

  it('two movers one copy', async (ctx) => {
    needsMail(ctx)
    await folder('ItBir')
    await folder('ItIki')
    rule({ subjectContains: 'rapor' }, [{ type: 'move', folderName: 'ItBir' }])
    rule({ senderContains: 'sieve-2' }, [{ type: 'move', folderName: 'ItIki' }])
    await m.setEnabled(acc, true)
    const tok = token()
    await mail(`Rapor ${tok}`)
    expect((await landed(0, tok, 1, 2000)).map((x) => x.folder)).toEqual(['ItBir'])
  })

  it('specialuse', async (ctx) => {
    needsMail(ctx)
    const boxes = await imap(0, (c) => c.list())
    const path = (use: string): string | undefined => boxes.find((b) => b.specialUse === use)?.path
    note('specialuse.boxes', boxes.map((b) => ({ path: b.path, use: b.specialUse ?? null })))
    const [archive, junk] = [path('\\Archive'), path('\\Junk')]
    if (!archive || !junk) {
      await imap(0, async (c) => {
        if (!archive) await c.mailboxCreate('Archive')
        if (!junk) await c.mailboxCreate('Junk')
      })
    }
    q.upsertFolder(acc, archive ?? 'Archive', 'archive', true)
    q.upsertFolder(acc, junk ?? 'Junk', 'junk', true)
    rule({ subjectContains: 'arsiv' }, [{ type: 'archive' }])
    rule({ subjectContains: 'istenmeyen' }, [{ type: 'spam' }])
    expect(await m.setEnabled(acc, true)).toMatchObject({ state: 'active' })
    const [a, b] = [token(), token()]
    await mail(`arsiv ${a}`)
    await mail(`istenmeyen ${b}`)
    note('specialuse.landed', { archive: await landed(0, a), junk: await landed(0, b) })
    expect((await landed(0, a, 1, 0)).map((x) => x.folder)).toEqual([archive ?? 'Archive'])
    expect((await landed(0, b, 1, 0)).map((x) => x.folder)).toEqual([junk ?? 'Junk'])
  })

  it('create folder', async (ctx) => {
    needsMail(ctx)
    rule({ subjectContains: 'yeni' }, [{ type: 'move', folderName: 'ItYeni' }])
    await m.setEnabled(acc, true)
    expect(m.placementFor(acc)[0]).toMatchObject({ placement: 'server', targetPath: 'ItYeni' })
    const tok = token()
    await mail(`yeni ${tok}`)
    expect((await landed(0, tok)).map((x) => x.folder)).toEqual(['ItYeni'])
  })

  const vacation = (id: string): SieveVacation => ({ enabled: true, subject: `İzindeyim ${id}`, body: `Dönünce yazarım ${id}`, days: 1, startDate: null, endDate: null })

  it('vacation', async (ctx) => {
    needsMail(ctx)
    const id = token()
    q.setSieveVacation(acc, vacation(id), Date.now())
    expect(await m.setEnabled(acc, true)).toMatchObject({ state: 'active' })
    const [a, b] = [token(), token()]
    await mail(`ilk ${a}`)
    expect(await landed(0, a)).toHaveLength(1)
    const first = await landed(1, id)
    note('vacation.firstReplies', first.length)
    expect(first).toHaveLength(1)
    await mail(`ikinci ${b}`)
    expect(await landed(0, b)).toHaveLength(1)
    await sleep(1500)
    const second = (await listAll(1)).filter((x) => x.subject.includes(id))
    note('vacation.afterSecond', second.length)
    expect(second).toHaveLength(1) // :days ikinci yanıtı engeller
  })

  it('vacation skips spam rule', async (ctx) => {
    needsMail(ctx)
    const boxes = await imap(0, (c) => c.list())
    const junk = boxes.find((b) => b.specialUse === '\\Junk')?.path ?? 'Junk'
    if (!boxes.some((b) => b.path === junk)) await imap(0, (c) => c.mailboxCreate(junk))
    q.upsertFolder(acc, junk, 'junk', true)
    const id = token()
    q.setSieveVacation(acc, vacation(id), Date.now())
    rule({ subjectContains: 'istenmeyen' }, [{ type: 'spam' }])
    await m.setEnabled(acc, true)
    const tok = token()
    await mail(`istenmeyen ${tok}`)
    expect((await landed(0, tok)).map((x) => x.folder)).toEqual([junk])
    await sleep(1500)
    expect((await listAll(1)).filter((x) => x.subject.includes(id))).toEqual([])
  })

  it('double vacation', async (ctx) => {
    needsMail(ctx)
    const id = token()
    const vac = (s: string): string => `require ["vacation"];${CRLF}vacation :days 1 :subject "Cift ${s} ${id}" :addresses ["${T.users[0]}"] "govde ${s} ${id}";${CRLF}`
    const wrapper = `require ["include"];${CRLF}include :personal "geckomail-it-a";${CRLF}include :personal "geckomail-it-b";${CRLF}`
    await sieve(0, async (c) => {
      await c.putScript('geckomail-it-a', vac('a'))
      await c.putScript('geckomail-it-b', vac('b'))
      await c.putScript('geckomail-it-wrap', wrapper)
      await c.setActive('geckomail-it-wrap')
    })
    const tok = token()
    await mail(`cift ${tok}`)
    const kept = await landed(0, tok)
    await sleep(1500)
    const replies = (await listAll(1)).filter((x) => x.subject.includes(id))
    note('doubleVacation.raw', { kept: kept.map((x) => x.folder), replies: replies.map((x) => x.subject) })
    // K19: üretici bu duruma hiç girmez
    await sieve(0, async (c) => {
      await c.setActive('')
      for (const s of ['geckomail-it-a', 'geckomail-it-b', 'geckomail-it-wrap']) await c.deleteScript(s)
    })
    await userScript('geckomail-it-user', vac('u'))
    q.setSieveVacation(acc, vacation(id), Date.now())
    rule({ subjectContains: 'okundu' }, [{ type: 'markRead' }])
    await wrap('geckomail-it-user')
    expect(q.getSieveAccount(acc)?.state_detail).toBe(SIEVE_VACATION_CONFLICT)
    expect(await sieve(0, (c) => c.getScript(RULES))).not.toMatch(/vacation/)
  })

  it('hundred fifty rules', async (ctx) => {
    needsMail(ctx)
    await folder('ItRapor')
    for (let i = 1; i <= 150; i++) {
      rule({ subjectContains: `kosul-${i}-son`, senderContains: 'sieve-2' }, [{ type: 'markRead' }, { type: 'move', folderName: 'ItRapor' }])
    }
    expect(await m.setEnabled(acc, true)).toMatchObject({ state: 'active' })
    const text = await sieve(0, (c) => c.getScript(RULES))
    const plans = m.placementFor(acc)
    note('hundredFifty', { bytes: Buffer.byteLength(text), server: plans.filter((p) => p.placement === 'server').length })
    expect(plans.filter((p) => p.placement === 'server')).toHaveLength(150)
    const [a, b] = [token(), token()]
    await mail(`kosul-150-son ${a}`)
    await mail(`hicbiri ${b}`)
    const hit = await landed(0, a)
    note('hundredFifty.landed', hit)
    expect(hit.map((x) => x.folder)).toEqual(['ItRapor'])
    expect(hit[0].flags).toContain('\\Seen')
    expect((await landed(0, b)).map((x) => x.folder)).toEqual(['INBOX'])
  })

  it('jmap vacation response', async (ctx) => {
    if (!T.jmapPort || !T.docker) ctx.skip()
    rule({ subjectContains: 'rapor' }, [{ type: 'markRead' }])
    await m.setEnabled(acc, true)
    const before = await scripts()
    const auth = `Basic ${Buffer.from(`${T.users[0]}:${T.passes[0]}`).toString('base64')}`
    const session = (await (await fetch(`http://${T.host}:${T.jmapPort}/jmap/session`, { headers: { authorization: auth } })).json()) as { primaryAccounts: Record<string, string> }
    const accountId = session.primaryAccounts['urn:ietf:params:jmap:vacationresponse'] ?? Object.values(session.primaryAccounts)[0]
    const res = await fetch(`http://${T.host}:${T.jmapPort}/jmap/`, {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:vacationresponse'],
        methodCalls: [['VacationResponse/set', { accountId, update: { singleton: { isEnabled: true, subject: 'JMAP', textBody: 'jmap yanit' } } }, 'v']]
      })
    })
    const body = (await res.json()) as { methodResponses: unknown[] }
    const after = await scripts()
    const state = await m.deployNow(acc, true)
    note('jmapVacation', { response: JSON.stringify(body.methodResponses).slice(0, 300), before, after, managerState: state.state, managerDetail: state.detail })
    expect(await scripts()).toEqual(expect.arrayContaining(after))
    await sieve(0, async (c) => {
      await c.setActive('')
      for (const x of await c.listScripts()) if (x.name.startsWith('vacation') || x.name.startsWith('jmap')) await c.deleteScript(x.name)
    })
  })

  it('checkscript error line', async () => {
    const r = await sieve(0, (c) => c.checkScript(INVALID_LINE3))
    note('checkscript', r)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/\bline\s+[23]\b/i) // Dovecot 3, Stalwart sıfırdan sayar: 2
  })

  it('active replace atomic', async (ctx) => {
    needsMail(ctx)
    await imap(0, async (c) => {
      await c.mailboxCreate('ItBir')
      await c.mailboxCreate('ItIki')
    })
    const script = (box: string): string => `require ["fileinto"];${CRLF}fileinto "${box}";${CRLF}`
    await sieve(0, async (c) => {
      await c.putScript('geckomail-it-yer', script('ItBir'))
      await c.setActive('geckomail-it-yer')
      await c.putScript('geckomail-it-yer', script('ItIki'))
      expect(await c.listScripts()).toEqual([{ name: 'geckomail-it-yer', active: true }])
      expect((await c.getScript('geckomail-it-yer')).replace(/\r\n/g, '\n')).toBe(script('ItIki').replace(/\r\n/g, '\n'))
    })
    const tok = token()
    await mail(`yer ${tok}`)
    expect((await landed(0, tok)).map((x) => x.folder)).toEqual(['ItIki'])
  })
})
