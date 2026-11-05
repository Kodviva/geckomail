// Bağımlılıksız ManageSieve istemcisi (RFC 5804). Düz metin asla: connect döndüğünde TLS kuruludur ve
// yetenekler TLS sonrası listedir. Betik içeriği, parola ve belirteç hata metnine girmez.
import { connect as netConnect, isIP, type Socket } from 'net'
import { connect as tlsConnect, type TLSSocket } from 'tls'
import { SIEVE_RULES_SCRIPT, SIEVE_WRAPPER_SCRIPT, type SieveCapsInfo } from '../../shared/sieve'
import { classifyError } from '../imapClient'
import type { LoginFailureKind } from '../net/hostGovernor'
import { oauthBearer, xoauth2 } from '../oauth'
import { sieveQuote } from './generate'

const MAX_LITERAL = 1024 * 1024
const MAX_LINE = 64 * 1024
const MAX_BUFFER = 2 * MAX_LITERAL
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_ERROR_TEXT = 300
/** RFC 5804 §1.6: tırnaklı dizgi üst sınırı */
const MAX_QUOTED = 1024
/** CHECKSCRIPT olmayan sunucuda geçici denetim adı: PUTSCRIPT sözdizimini doğrular, hemen silinir */
const CHECK_SCRIPT = 'geckomail-check'
const CRLF = '\r\n'

export type SieveTlsMode = 'starttls' | 'tls'
export type SieveCredential = { kind: 'password'; user: string; password: string } | { kind: 'oauth'; user: string; accessToken: string }
export type SievePhase = 'connect' | 'tls' | 'auth' | 'command'

export interface SieveConnectOpts {
  host: string
  port: number
  tls: SieveTlsMode
  rejectUnauthorized: boolean
  servername?: string
  /** sistem köklerinin yerine geçer; yalnız kendi sertifikasıyla çalışan sınama sunucusu için */
  ca?: Buffer
  timeoutMs?: number
}

/** İşletim sistemi hata kodları: sunucu dinlemiyor değil, ağ ya da ad çözümü yok */
const NETWORK_DOWN = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN', 'ENONET'])

export class ManageSieveError extends Error {
  readonly code: string | null
  readonly phase: SievePhase
  /** classifyError ile uyumlu */
  readonly authenticationFailed: boolean
  /** no_tcp: bağlantı hiç kurulmadı; lost: kurulduktan sonra koptu ya da zaman aşımı */
  readonly transport: 'no_tcp' | 'lost' | null
  /** no_tcp'nin nedeni ad çözümü ya da ağ kesintisi: sunucu hakkında bir şey söylemez */
  readonly networkDown: boolean

  constructor(message: string, o: { phase: SievePhase; code?: string | null; authenticationFailed?: boolean; transport?: 'no_tcp' | 'lost' | null; networkDown?: boolean }) {
    super(message)
    this.networkDown = o.networkDown ?? false
    this.name = 'ManageSieveError'
    this.phase = o.phase
    this.code = o.code ?? null
    this.authenticationFailed = o.authenticationFailed ?? false
    this.transport = o.transport ?? null
  }
}

export type Tok = { t: 'str' | 'atom'; v: string } | { t: 'list'; v: Tok[] }

interface Response {
  status: 'OK' | 'NO' | 'BYE'
  code: string | null
  text: string
  lines: Tok[][]
}

type Parsed = { kind: 'response'; response: Response; next: number } | { kind: 'challenge'; next: number }

const limitError = (what: string): Error => new Error(`ManageSieve: ${what}`)

/** Tek satır belirteçleri. Eksik veri: null. Satır sınırı literal gövdesini saymaz */
function scanLine(buf: Buffer, start: number): { tokens: Tok[]; next: number } | null {
  const root: Tok[] = []
  const stack: Tok[][] = [root]
  let lineStart = start
  let pos = start
  const incomplete = (): null => {
    if (pos - lineStart > MAX_LINE) throw limitError('response line too long')
    return null
  }
  for (;;) {
    if (pos - lineStart > MAX_LINE) throw limitError('response line too long')
    if (pos >= buf.length) return incomplete()
    const c = buf[pos]
    const top = stack[stack.length - 1]
    if (c === 0x0a) return { tokens: root, next: pos + 1 }
    if (c === 0x0d) {
      if (pos + 1 >= buf.length) return incomplete()
      pos += buf[pos + 1] === 0x0a ? 2 : 1
      return { tokens: root, next: pos }
    }
    if (c === 0x20) {
      pos++
    } else if (c === 0x28 || c === 0x5b) {
      const list: Tok[] = []
      top.push({ t: 'list', v: list })
      stack.push(list)
      pos++
    } else if (c === 0x29 || c === 0x5d) {
      if (stack.length > 1) stack.pop()
      pos++
    } else if (c === 0x22) {
      let end = pos + 1
      while (end < buf.length && buf[end] !== 0x22) end += buf[end] === 0x5c ? 2 : 1
      if (end >= buf.length) {
        pos = buf.length
        return incomplete()
      }
      top.push({ t: 'str', v: buf.subarray(pos + 1, end).toString('utf8').replace(/\\([\s\S])/g, '$1') })
      pos = end + 1
    } else if (c === 0x7b) {
      const close = buf.indexOf(0x7d, pos)
      if (close === -1 || close - pos > 32) {
        if (buf.length - pos > 32) throw limitError('malformed literal')
        return null
      }
      const m = /^\{(\d+)\+?\}$/.exec(buf.subarray(pos, close + 1).toString('latin1'))
      if (!m) throw limitError('malformed literal')
      const size = Number(m[1])
      if (size > MAX_LITERAL) throw limitError('literal too large')
      const nl = buf.indexOf(0x0a, close)
      if (nl === -1) return null
      if (nl - close > 2) throw limitError('malformed literal')
      const end = nl + 1 + size
      if (buf.length < end) return null
      top.push({ t: 'str', v: buf.subarray(nl + 1, end).toString('utf8') })
      pos = end
      lineStart = pos
    } else {
      const from = pos
      while (pos < buf.length && ![0x20, 0x0d, 0x0a, 0x28, 0x29, 0x5b, 0x5d, 0x22].includes(buf[pos])) pos++
      if (pos >= buf.length) return incomplete()
      top.push({ t: 'atom', v: buf.subarray(from, pos).toString('latin1') })
    }
  }
}

/** Tamamlanmış satırlar: her yeni parçada bütün yanıt baştan taranmasın */
export interface ParseProgress {
  pos: number
  lines: Tok[][]
}

export const freshProgress = (): ParseProgress => ({ pos: 0, lines: [] })

/** Eksik veri: null, ilerleme `p`de kalır. wantChallenge: OK/NO/BYE yerine dizgiyle başlayan satır SASL sürdürmesidir */
export function parseResponse(buf: Buffer, wantChallenge: boolean, p: ParseProgress = freshProgress()): Parsed | null {
  const { lines } = p
  for (;;) {
    const line = scanLine(buf, p.pos)
    if (!line) return null
    p.pos = line.next
    const pos = p.pos
    const first = line.tokens[0]
    if (!first) continue
    const word = first.t === 'atom' ? first.v.toUpperCase() : ''
    if (word === 'OK' || word === 'NO' || word === 'BYE') {
      const rest = line.tokens.slice(1)
      const list = rest.find((x) => x.t === 'list')
      const head = list?.t === 'list' ? list.v[0] : undefined
      const code = head && head.t !== 'list' ? head.v.toUpperCase() : null
      const text = [...rest].reverse().find((x) => x.t === 'str')
      return { kind: 'response', response: { status: word, code, text: text?.t === 'str' ? text.v : '', lines }, next: pos }
    }
    if (wantChallenge && first.t === 'str' && lines.length === 0) return { kind: 'challenge', next: pos }
    lines.push(line.tokens)
  }
}

const strOf = (t: Tok | undefined): string | null => (t && t.t !== 'list' ? t.v : null)

function parseCaps(lines: Tok[][]): { info: SieveCapsInfo; starttls: boolean } {
  const info: SieveCapsInfo = { implementation: null, version: null, sasl: [], sieve: [], maxRedirects: null }
  let starttls = false
  for (const l of lines) {
    const key = strOf(l[0])?.toUpperCase()
    const value = strOf(l[1]) ?? ''
    const words = value.split(/\s+/).filter(Boolean)
    if (key === 'IMPLEMENTATION') info.implementation = value
    else if (key === 'VERSION') info.version = value
    else if (key === 'SASL') info.sasl = words.map((w) => w.toUpperCase())
    else if (key === 'SIEVE') info.sieve = words
    else if (key === 'STARTTLS') starttls = true
    else if (key === 'MAXREDIRECTS' && /^\d+$/.test(value)) info.maxRedirects = Number(value)
  }
  return { info, starttls }
}

/** Sunucunun ilanından kullanılacak SASL yöntemi; yoksa null */
export function saslMechanismFor(sasl: string[], kind: SieveCredential['kind']): 'PLAIN' | 'OAUTHBEARER' | 'XOAUTH2' | null {
  if (kind === 'password') return sasl.includes('PLAIN') ? 'PLAIN' : null
  if (sasl.includes('OAUTHBEARER')) return 'OAUTHBEARER'
  return sasl.includes('XOAUTH2') ? 'XOAUTH2' : null
}

const isCertError = (e: unknown): boolean => /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(String((e as { code?: string })?.code ?? ''))

const scrub = (text: string, secrets: string[]): string => secrets.filter(Boolean).reduce((out, s) => out.split(s).join('***'), text)

function quoteName(name: string): string {
  const q = sieveQuote(name)
  if (q === null) throw new ManageSieveError('ManageSieve: invalid script name', { phase: 'command' })
  return q
}

/** Parola yanlış demek değildir: TRYLATER geçici, REFERRAL izlenmez, diğerleri yöntem ya da bağlantı sorunu */
const NOT_CREDENTIAL_REJECTION = new Set(['TRYLATER', 'REFERRAL', 'AUTH-TOO-WEAK', 'ENCRYPT-NEEDED', 'TRANSITION-NEEDED'])

function serverError(r: Response, phase: SievePhase, secrets: string[] = []): ManageSieveError {
  // sunucu kimlik yükünü hata metninde geri yollayabilir
  const text = scrub(r.text, secrets).slice(0, MAX_ERROR_TEXT) || `ManageSieve: ${r.status}`
  const authenticationFailed = phase === 'auth' && r.status === 'NO' && !NOT_CREDENTIAL_REJECTION.has(r.code ?? '')
  return new ManageSieveError(text, { phase, code: r.code, authenticationFailed, transport: r.status === 'BYE' ? 'lost' : null })
}

export class ManageSieveClient {
  private socket: Socket | null = null
  private buf: Buffer = Buffer.alloc(0)
  private capsInfo: SieveCapsInfo = { implementation: null, version: null, sasl: [], sieve: [], maxRedirects: null }
  private failure: ManageSieveError | null = null
  private progress = freshProgress()
  private phase: SievePhase = 'connect'
  private tail: Promise<unknown> = Promise.resolve()
  /** yalnız AUTHENTICATE sürerken dolu: hata metninden temizlenir */
  private authSecrets: string[] = []
  private readonly timeoutMs: number
  private waiter: {
    wantChallenge: boolean
    resolve(p: Parsed): void
    reject(e: ManageSieveError): void
    timer: NodeJS.Timeout
  } | null = null

  private constructor(private readonly o: SieveConnectOpts) {
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Döndüğünde TLS kurulu, yetenekler TLS sonrası. STARTTLS yoksa ya da reddedilirse phase 'tls' hatası */
  static async connect(o: SieveConnectOpts): Promise<ManageSieveClient> {
    const c = new ManageSieveClient(o)
    try {
      await c.open()
      return c
    } catch (e) {
      c.close()
      throw e
    }
  }

  get caps(): SieveCapsInfo {
    return this.capsInfo
  }

  private async open(): Promise<void> {
    const raw = await this.openTcp()
    if (this.o.tls === 'tls') {
      await this.secure(raw)
      this.phase = 'connect'
      await this.readCaps()
      return
    }
    this.attach(raw)
    const greeting = await this.readCaps()
    if (!greeting.starttls) throw new ManageSieveError('ManageSieve: STARTTLS not offered', { phase: 'tls', code: 'NO_STARTTLS' })
    this.phase = 'tls'
    this.write(`STARTTLS${CRLF}`)
    const r = await this.readResponse()
    if (r.status !== 'OK') throw serverError(r, 'tls')
    // TLS öncesi okunmuş fazla bayt, el sıkışma sonrasına sızdırılmış komut demektir
    if (this.buf.length) throw new ManageSieveError('ManageSieve: unexpected data before TLS', { phase: 'tls' })
    await this.secure(raw)
    await this.readCaps() // TLS öncesi liste düşer: saldırgan yazmış olabilir
  }

  private openTcp(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const sock = netConnect({ host: this.o.host, port: this.o.port })
      const fail = (message: string, networkDown = false): void => {
        clearTimeout(timer)
        sock.destroy()
        reject(new ManageSieveError(message, { phase: 'connect', transport: 'no_tcp', networkDown }))
      }
      const onError = (e: NodeJS.ErrnoException): void => fail(`ManageSieve: ${e.message}`, NETWORK_DOWN.has(e.code ?? ''))
      const timer = setTimeout(() => fail('ManageSieve: connect timeout'), this.timeoutMs)
      sock.once('error', onError)
      sock.once('connect', () => {
        clearTimeout(timer)
        sock.removeListener('error', onError)
        resolve(sock)
      })
    })
  }

  private secure(raw: Socket): Promise<void> {
    this.phase = 'tls'
    this.detach(raw)
    const { host, servername, rejectUnauthorized, ca } = this.o
    return new Promise((resolve, reject) => {
      const sock: TLSSocket = tlsConnect({ socket: raw, host, servername: servername ?? (isIP(host) ? undefined : host), rejectUnauthorized, ca })
      const onSecure = (): void => done(null)
      const onError = (e: Error): void =>
        done(new ManageSieveError(`ManageSieve: TLS: ${e.message}`.slice(0, MAX_ERROR_TEXT), { phase: 'tls', transport: isCertError(e) ? null : 'lost' }))
      const onClose = (): void => done(new ManageSieveError('ManageSieve: connection closed during TLS', { phase: 'tls', transport: 'lost' }))
      const done = (e: ManageSieveError | null): void => {
        clearTimeout(timer)
        sock.removeListener('secureConnect', onSecure)
        sock.removeListener('error', onError)
        sock.removeListener('close', onClose)
        if (e) {
          sock.on('error', () => {})
          sock.destroy()
          reject(e)
        } else {
          this.attach(sock)
          resolve()
        }
      }
      const timer = setTimeout(() => done(new ManageSieveError('ManageSieve: TLS timeout', { phase: 'tls', transport: 'lost' })), this.timeoutMs)
      sock.once('secureConnect', onSecure)
      sock.once('error', onError)
      sock.once('close', onClose)
    })
  }

  private readonly onData = (d: Buffer): void => {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d
    if (this.buf.length > MAX_BUFFER) this.fail(new ManageSieveError('ManageSieve: response too large', { phase: this.phase }))
    else this.pump()
  }

  private readonly onError = (e: Error): void => {
    this.fail(new ManageSieveError(`ManageSieve: ${e.message}`.slice(0, MAX_ERROR_TEXT), { phase: this.phase, transport: 'lost' }))
  }

  private readonly onClose = (): void => {
    this.fail(new ManageSieveError('ManageSieve: connection closed', { phase: this.phase, transport: 'lost' }))
  }

  private attach(sock: Socket): void {
    this.socket = sock
    sock.on('data', this.onData)
    sock.on('error', this.onError)
    sock.on('close', this.onClose)
  }

  /** Yalnız kendi dinleyicilerimiz: soketin iç dinleyicileri TLS sarmalaması için kalmalı */
  private detach(sock: Socket): void {
    sock.removeListener('data', this.onData)
    sock.removeListener('error', this.onError)
    sock.removeListener('close', this.onClose)
    this.socket = null
  }

  private fail(e: ManageSieveError): void {
    this.failure ??= e
    const w = this.waiter
    this.waiter = null
    if (w) {
      clearTimeout(w.timer)
      w.reject(this.failure)
    }
    this.socket?.destroy()
  }

  private pump(): void {
    const w = this.waiter
    if (!w) return
    let parsed: Parsed | null
    try {
      parsed = parseResponse(this.buf, w.wantChallenge, this.progress)
    } catch (e) {
      this.fail(new ManageSieveError((e as Error).message, { phase: this.phase }))
      return
    }
    if (!parsed) return
    this.buf = this.buf.subarray(parsed.next)
    this.progress = freshProgress()
    this.waiter = null
    clearTimeout(w.timer)
    w.resolve(parsed)
    if (parsed.kind === 'response' && parsed.response.status === 'BYE') this.fail(serverError(parsed.response, this.phase, this.authSecrets))
  }

  private read(wantChallenge: boolean): Promise<Parsed> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new ManageSieveError('ManageSieve: timeout', { phase: this.phase, transport: 'lost' })), this.timeoutMs)
      this.waiter = { wantChallenge, resolve, reject, timer }
      this.pump()
    })
  }

  private async readResponse(): Promise<Response> {
    const p = await this.read(false)
    if (p.kind !== 'response') throw new ManageSieveError('ManageSieve: unexpected response', { phase: this.phase })
    return p.response
  }

  private async readCaps(): Promise<{ starttls: boolean }> {
    const r = await this.readResponse()
    if (r.status !== 'OK') throw serverError(r, this.phase)
    const { info, starttls } = parseCaps(r.lines)
    this.capsInfo = info
    return { starttls }
  }

  private write(data: string | Buffer): void {
    if (this.failure) throw this.failure
    this.socket?.write(data)
  }

  /** Komutlar sırayla: yanıtlar etiketsiz olduğundan aynı anda ikisi çalışamaz */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn)
    this.tail = run.catch(() => {})
    return run
  }

  private exec(head: string, literal?: Buffer): Promise<Response> {
    return this.serial(async () => {
      this.phase = 'command'
      this.write(literal ? Buffer.concat([Buffer.from(`${head} {${literal.length}+}${CRLF}`), literal, Buffer.from(CRLF)]) : `${head}${CRLF}`)
      return this.readResponse()
    })
  }

  private async execOk(head: string, literal?: Buffer): Promise<Response> {
    const r = await this.exec(head, literal)
    if (r.status !== 'OK') throw serverError(r, 'command')
    return r
  }

  authenticate(c: SieveCredential): Promise<void> {
    return this.serial(async () => {
      this.phase = 'auth'
      const mech = saslMechanismFor(this.capsInfo.sasl, c.kind)
      if (!mech) throw new ManageSieveError('ManageSieve: no usable SASL mechanism', { phase: 'auth', code: 'NO_MECHANISM' })
      const payload = c.kind === 'password'
        ? Buffer.from(`\0${c.user}\0${c.password}`, 'utf8').toString('base64')
        : mech === 'OAUTHBEARER' ? oauthBearer(c.user, this.o.host, this.o.port, c.accessToken) : xoauth2(c.user, c.accessToken)
      this.authSecrets = [payload, c.kind === 'password' ? c.password : c.accessToken]
      try {
        // uzun belirteç dizgi sınırını (1024) aşar: literal olarak gider
        const arg = payload.length > MAX_QUOTED ? `{${payload.length}+}${CRLF}${payload}` : `"${payload}"`
        this.write(`AUTHENTICATE "${mech}" ${arg}${CRLF}`)
        let parsed = await this.read(true)
        if (parsed.kind === 'challenge') {
          // başarısız OAuth: sunucu ayrıntı gönderir, istemci sürdürme yanıtıyla kapatır (RFC 7628 §3.2.3)
          this.write(`${mech === 'OAUTHBEARER' ? '"AQ=="' : '""'}${CRLF}`)
          parsed = await this.read(false)
        }
        if (parsed.kind !== 'response') throw new ManageSieveError('ManageSieve: unexpected response', { phase: 'auth' })
        if (parsed.response.status !== 'OK') throw serverError(parsed.response, 'auth', this.authSecrets)
      } finally {
        this.authSecrets = []
      }
      this.write(`CAPABILITY${CRLF}`)
      await this.readCaps()
    })
  }

  async listScripts(): Promise<{ name: string; active: boolean }[]> {
    const r = await this.execOk('LISTSCRIPTS')
    return r.lines.flatMap((l) => {
      const name = l[0]?.t === 'str' ? l[0].v : null
      return name === null ? [] : [{ name, active: strOf(l[1])?.toUpperCase() === 'ACTIVE' }]
    })
  }

  async getScript(name: string): Promise<string> {
    const r = await this.execOk(`GETSCRIPT ${quoteName(name)}`)
    const content = r.lines[0]?.[0]
    if (content?.t !== 'str') throw new ManageSieveError('ManageSieve: empty GETSCRIPT response', { phase: 'command' })
    return content.v
  }

  async checkScript(content: string): Promise<{ ok: true; warning?: string } | { ok: false; error: string }> {
    if (this.capsInfo.version === null) return this.checkByUpload(content)
    const r = await this.exec('CHECKSCRIPT', Buffer.from(content, 'utf8'))
    if (r.status === 'OK') return r.code === 'WARNINGS' ? { ok: true, warning: r.text.slice(0, MAX_ERROR_TEXT) } : { ok: true }
    if (r.status === 'BYE' || r.code) throw serverError(r, 'command')
    return { ok: false, error: r.text.slice(0, MAX_ERROR_TEXT) }
  }

  private async checkByUpload(content: string): Promise<{ ok: true; warning?: string } | { ok: false; error: string }> {
    // var olan betik kullanıcınındır: boş ad bulunur, ona dokunulmaz
    const names = new Set((await this.listScripts()).map((s) => s.name))
    let name = CHECK_SCRIPT
    for (let i = 2; names.has(name); i++) name = `${CHECK_SCRIPT}-${i}`
    const r = await this.exec(`PUTSCRIPT ${quoteName(name)}`, Buffer.from(content, 'utf8'))
    if (r.status === 'OK') {
      await this.deleteScript(name)
      return r.code === 'WARNINGS' ? { ok: true, warning: r.text.slice(0, MAX_ERROR_TEXT) } : { ok: true }
    }
    if (r.status === 'BYE' || r.code) throw serverError(r, 'command')
    return { ok: false, error: r.text.slice(0, MAX_ERROR_TEXT) }
  }

  async haveSpace(name: string, size: number): Promise<boolean> {
    const r = await this.exec(`HAVESPACE ${quoteName(name)} ${size}`)
    if (r.status === 'OK') return true
    if (r.status === 'NO' && r.code?.startsWith('QUOTA')) return false
    throw serverError(r, 'command')
  }

  async putScript(name: string, content: string): Promise<void> {
    await this.execOk(`PUTSCRIPT ${quoteName(name)}`, Buffer.from(content, 'utf8'))
  }

  /** '' hepsini kapatır */
  async setActive(name: string): Promise<void> {
    await this.execOk(`SETACTIVE ${quoteName(name)}`)
  }

  async deleteScript(name: string): Promise<void> {
    await this.execOk(`DELETESCRIPT ${quoteName(name)}`)
  }

  async logout(): Promise<void> {
    if (!this.failure) await this.exec('LOGOUT').catch(() => {})
    this.close()
  }

  close(): void {
    this.fail(new ManageSieveError('ManageSieve: connection closed', { phase: this.phase, transport: 'lost' }))
  }
}

/** Dağıtım kodu yalnız kendi betiklerimize yazar: başka adı yazan tek yol kullanıcı eylemiyle ham düzenleyicidir */
export function assertManagedName(name: string): void {
  if (name !== SIEVE_RULES_SCRIPT && name !== SIEVE_WRAPPER_SCRIPT) throw new Error('ManageSieve: refusing to touch a script we do not own')
}

/** 'unreachable' governor türü değildir: dinlemeyen port IMAP'i soğutacak "IP engeli" sayılmaz */
export function sieveFailureKind(e: unknown): LoginFailureKind | 'unreachable' {
  if (!(e instanceof ManageSieveError)) return classifyError(e)
  if (e.authenticationFailed) return 'auth'
  if (e.code === 'TRYLATER') return 'limit'
  if (e.transport === 'no_tcp') return 'unreachable'
  if (e.transport === 'lost') return e.phase === 'connect' || e.phase === 'tls' ? 'preauth' : 'net'
  return 'other'
}
