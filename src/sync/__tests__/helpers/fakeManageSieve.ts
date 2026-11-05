// Testler için sahte ManageSieve sunucusu (RFC 5804 alt kümesi). Yalnız 127.0.0.1 dinler; anahtar ve sertifika
// makeTestCert ile geçici dizinde üretilir, depoya girmez.
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { createServer, type AddressInfo, type Server, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer as createTlsServer, TLSSocket, type TlsOptions } from 'tls'

export interface TestCert {
  key: Buffer
  cert: Buffer
}

export function makeTestCert(): TestCert {
  const dir = mkdtempSync(join(tmpdir(), 'gecko-sieve-cert-'))
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=sieve.fake.test',
      '-addext', 'subjectAltName=DNS:sieve.fake.test,DNS:localhost,IP:127.0.0.1',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')
    ], { stdio: 'ignore' })
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export interface FakeSieveOptions {
  tls: 'starttls' | 'implicit' | 'none'
  cert?: TestCert
  /** TLS sonrası SASL listesi */
  sasl?: string[]
  /** TLS öncesi ilan edilen SASL listesi: TLS sonrası kullanılmamalı */
  saslBeforeTls?: string[]
  extensions?: string[]
  checkScript?: (content: string) => { ok: true; warning?: string } | { ok: false; error: string }
  maxScripts?: number
  failAuth?: boolean
  /** failAuth'ta istemcinin yükünü hata metninde geri yollar */
  echoAuthPayload?: boolean
  /** STARTTLS ilan etmeden SASL "PLAIN" ilan eder (indirgeme saldırısı) */
  leakPlainSaslBeforeTls?: boolean
  /** STARTTLS ilan eder ama komutu reddeder */
  refuseStarttls?: boolean
  /** STARTTLS onayına düz metin bayt ekler (komut enjeksiyonu) */
  injectAfterStarttlsOk?: string
  /** karşılama göndermez */
  silent?: boolean
  version?: string | null
  maxRedirects?: number
  /** PUTSCRIPT başarısında uyarı döner */
  putWarning?: string
  /** komut satırına ham yanıt: string yazar, null susar, undefined varsayılan işleyişe bırakır */
  intercept?: (line: string) => string | Buffer | null | undefined
}

export interface FakeSieve {
  port: number
  scripts: Map<string, string>
  active: string | null
  commands: string[]
  /** AUTHENTICATE ile gelen ilk yanıtlar: dizgi ya da literal */
  authPayloads: string[]
  /** kabul edilen bağlantı sayısı */
  connections: number
  /** kapanan bağlantı sayısı */
  closed: number
  close(): Promise<void>
}

const quote = (s: string): string => `"${s.replace(/[\\"]/g, '\\$&')}"`

class Conn {
  private buf = Buffer.alloc(0)
  private secured: boolean
  private authed = false
  private pendingAuth: { failing: boolean } | null = null

  constructor(
    private socket: Socket,
    private o: FakeSieveOptions,
    private s: FakeSieve,
    secured: boolean
  ) {
    this.secured = secured
    this.bind()
  }

  private bind(): void {
    this.socket.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d])
      this.pump()
    })
    this.socket.on('error', () => {})
  }

  private capabilities(): string {
    const lines = [`"IMPLEMENTATION" "Fake Sieve"`]
    lines.push(`"SIEVE" ${quote((this.o.extensions ?? ['fileinto']).join(' '))}`)
    if (this.secured || this.o.tls === 'none') {
      const list = this.secured ? (this.o.sasl ?? ['PLAIN']) : this.o.leakPlainSaslBeforeTls ? ['PLAIN'] : []
      if (list.length) lines.push(`"SASL" ${quote(list.join(' '))}`)
    } else if (this.o.saslBeforeTls) {
      lines.push(`"SASL" ${quote(this.o.saslBeforeTls.join(' '))}`)
    }
    if (!this.secured && this.o.tls === 'starttls') lines.push(`"STARTTLS"`)
    if (this.o.version !== null) lines.push(`"VERSION" ${quote(this.o.version ?? '1.0')}`)
    if (this.o.maxRedirects !== undefined) lines.push(`"MAXREDIRECTS" "${this.o.maxRedirects}"`)
    return lines.map((l) => `${l}\r\n`).join('')
  }

  greet(): void {
    if (this.o.silent) return
    this.socket.write(`${this.capabilities()}OK "fake ready"\r\n`)
  }

  private pump(): void {
    for (;;) {
      const eol = this.buf.indexOf('\r\n')
      if (eol === -1) return
      const line = this.buf.subarray(0, eol).toString('utf8')
      const lit = /\{(\d+)\+?\}$/.exec(line)
      let literal: Buffer | null = null
      let next = eol + 2
      if (lit) {
        const end = next + Number(lit[1])
        if (this.buf.length < end + 2) return
        literal = this.buf.subarray(next, end)
        next = end + 2
      }
      this.buf = this.buf.subarray(next)
      this.s.commands.push(line)
      if (this.pendingAuth) this.finishAuth()
      else this.handle(line, literal)
    }
  }

  private finishAuth(): void {
    this.pendingAuth = null
    this.socket.write(`NO "Authentication failed"\r\n`)
  }

  private handle(line: string, literal: Buffer | null): void {
    const raw = this.o.intercept?.(line)
    if (raw === null) return
    if (raw !== undefined) {
      this.socket.write(raw)
      return
    }
    const command = line.split(' ')[0].toUpperCase()
    const arg = /^\S+ "((?:\\.|[^"\\])*)"/.exec(line)?.[1]?.replace(/\\(.)/g, '$1')
    const ok = (t = 'done'): void => void this.socket.write(`OK ${quote(t)}\r\n`)
    const no = (code: string | null, t: string): void => void this.socket.write(`NO ${code ? `(${code}) ` : ''}${quote(t)}\r\n`)
    switch (command) {
      case 'STARTTLS':
        return this.startTls(ok, no)
      case 'CAPABILITY':
        this.socket.write(`${this.capabilities()}OK "caps"\r\n`)
        return
      case 'AUTHENTICATE':
        return this.authenticate(line, literal, ok, no)
      case 'LOGOUT':
        this.socket.end(`OK "bye"\r\n`)
        return
    }
    if (!this.authed) return no(null, 'not authenticated')
    switch (command) {
      case 'LISTSCRIPTS': {
        const rows = [...this.s.scripts.keys()].map((n) => `${quote(n)}${n === this.s.active ? ' ACTIVE' : ''}\r\n`)
        this.socket.write(`${rows.join('')}OK "listed"\r\n`)
        return
      }
      case 'GETSCRIPT': {
        const text = this.s.scripts.get(arg ?? '')
        if (text === undefined) return no('NONEXISTENT', 'no such script')
        this.socket.write(`{${Buffer.byteLength(text)}}\r\n${text}\r\nOK "got"\r\n`)
        return
      }
      case 'CHECKSCRIPT': {
        const r = this.o.checkScript?.(literal?.toString('utf8') ?? '') ?? { ok: true as const }
        if (!r.ok) return no(null, r.error)
        if (r.warning) this.socket.write(`OK (WARNINGS) ${quote(r.warning)}\r\n`)
        else ok()
        return
      }
      case 'HAVESPACE': {
        if (this.o.maxScripts !== undefined && !this.s.scripts.has(arg ?? '') && this.s.scripts.size >= this.o.maxScripts) {
          return no('QUOTA/MAXSCRIPTS', 'too many scripts')
        }
        return ok()
      }
      case 'PUTSCRIPT': {
        const content = literal?.toString('utf8') ?? ''
        if (this.o.maxScripts !== undefined && !this.s.scripts.has(arg ?? '') && this.s.scripts.size >= this.o.maxScripts) {
          return no('QUOTA/MAXSCRIPTS', 'too many scripts')
        }
        const r = this.o.checkScript?.(content)
        if (r && !r.ok) return no(null, r.error)
        this.s.scripts.set(arg ?? '', content)
        if (this.o.putWarning) {
          this.socket.write(`OK (WARNINGS) ${quote(this.o.putWarning)}\r\n`)
          return
        }
        return ok()
      }
      case 'SETACTIVE': {
        if (arg && !this.s.scripts.has(arg)) return no('NONEXISTENT', 'no such script')
        this.s.active = arg || null
        return ok()
      }
      case 'DELETESCRIPT': {
        if (!this.s.scripts.has(arg ?? '')) return no('NONEXISTENT', 'no such script')
        if (this.s.active === arg) return no('ACTIVE', 'script is active')
        this.s.scripts.delete(arg ?? '')
        return ok()
      }
      default:
        return no(null, 'unknown command')
    }
  }

  private startTls(ok: (t?: string) => void, no: (code: string | null, t: string) => void): void {
    if (this.o.tls !== 'starttls' || this.secured || this.o.refuseStarttls) return no(null, 'TLS refused')
    ok('begin tls')
    if (this.o.injectAfterStarttlsOk) this.socket.write(this.o.injectAfterStarttlsOk)
    this.socket.removeAllListeners('data')
    const secure = new TLSSocket(this.socket, { isServer: true, key: this.o.cert!.key, cert: this.o.cert!.cert })
    this.socket = secure
    this.secured = true
    this.buf = Buffer.alloc(0)
    this.bind()
    secure.once('secure', () => this.greet())
  }

  private authenticate(line: string, literal: Buffer | null, ok: (t?: string) => void, no: (code: string | null, t: string) => void): void {
    const mech = /^AUTHENTICATE "([^"]+)"/i.exec(line)?.[1]?.toUpperCase() ?? ''
    const payload = literal?.toString('utf8') ?? /"([^"]*)"$/.exec(line)?.[1] ?? ''
    this.s.authPayloads.push(payload)
    if (!(this.o.sasl ?? ['PLAIN']).includes(mech)) return no(null, 'unsupported mechanism')
    if (!this.o.failAuth) {
      this.authed = true
      return ok('authenticated')
    }
    if (mech === 'PLAIN') return no(null, this.o.echoAuthPayload ? `Authentication failed for ${payload} ${Buffer.from(payload, 'base64').toString('latin1')}` : 'Authentication failed')
    // OAuth hatası: sunucu önce JSON ayrıntılı meydan okuma gönderir, istemci boş yanıtla kapatır
    this.pendingAuth = { failing: true }
    this.socket.write(`${quote(Buffer.from('{"status":"401"}').toString('base64'))}\r\n`)
  }
}

export async function startFakeManageSieve(opts: FakeSieveOptions): Promise<FakeSieve> {
  const state: FakeSieve = {
    port: 0, scripts: new Map(), active: null, commands: [], authPayloads: [], connections: 0, closed: 0,
    close: async () => {}
  }
  const sockets = new Set<Socket>()
  const track = (sock: Socket): void => {
    state.connections++
    sockets.add(sock)
    sock.once('close', () => {
      state.closed++
      sockets.delete(sock)
    })
  }
  let server: Server
  if (opts.tls === 'implicit') {
    const tlsOpts: TlsOptions = { key: opts.cert!.key, cert: opts.cert!.cert }
    server = createTlsServer(tlsOpts, (sock) => {
      track(sock)
      new Conn(sock, opts, state, true).greet()
    })
    server.on('tlsClientError', () => {})
  } else {
    server = createServer((sock) => {
      track(sock)
      new Conn(sock, opts, state, false).greet()
    })
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.port = (server.address() as AddressInfo).port
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy()
      server.close(() => resolve())
    })
  return state
}
