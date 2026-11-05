// Uçtan uca S/MIME için en küçük posta sunucusu: TLS üstünde IMAP + SMTP, tek kullanıcı, bellekte. imapflow ve nodemailer'ın
// kullandığı komutlardan fazlasını bilmez. Sertifika test fikstürüdür; hesap allow_invalid_certs ile bağlanır.
import { readFileSync } from 'node:fs'
import { createServer as createTls, type Server, type TLSSocket } from 'node:tls'
import { join } from 'node:path'

const FIXTURES = join(__dirname, '..', 'src', 'sync', 'smime', '__tests__', 'fixtures')

interface Stored { uid: number; raw: Buffer; flags: string[]; date: Date }
interface Box { name: string; special: string | null; uidNext: number; msgs: Stored[] }

export interface FakeMail {
  imapPort: number
  smtpPort: number
  /** kutuya doğrudan ileti (IMAP'e gelmiş gibi) */
  deliver(box: string, raw: Buffer): void
  /** SMTP'den geçen zarflar */
  sent: { to: string[]; raw: Buffer }[]
  close(): Promise<void>
}

const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const nstring = (s: string | undefined | null): string => (s ? quote(s) : 'NIL')

function splitHeaders(raw: Buffer): { head: string; body: Buffer } {
  const i = raw.indexOf('\r\n\r\n')
  if (i < 0) return { head: raw.toString('latin1'), body: Buffer.alloc(0) }
  return { head: raw.subarray(0, i).toString('latin1'), body: raw.subarray(i + 4) }
}

function header(head: string, name: string): string | undefined {
  const m = new RegExp(`^${name}:[ \\t]*((?:.*)(?:\\r\\n[ \\t].*)*)`, 'im').exec(head)
  return m?.[1].replace(/\r\n[ \t]+/g, ' ')
}

function contentType(head: string): { type: string; sub: string; params: Record<string, string> } {
  const v = header(head, 'content-type') ?? 'text/plain'
  const [full, ...rest] = v.split(';')
  const [type, sub] = full.trim().toLowerCase().split('/')
  const params: Record<string, string> = {}
  for (const p of rest) {
    const m = /^\s*([\w-]+)\s*=\s*"?([^"]*)"?\s*$/.exec(p)
    if (m) params[m[1].toLowerCase()] = m[2]
  }
  return { type, sub: sub ?? 'plain', params }
}

function bodyStructure(entity: Buffer): string {
  const { head, body } = splitHeaders(entity)
  const ct = contentType(head)
  const params = (): string => {
    const list = Object.entries(ct.params).flatMap(([k, v]) => [quote(k), quote(v)])
    return list.length ? `(${list.join(' ')})` : 'NIL'
  }
  if (ct.type === 'multipart') {
    const mark = `--${ct.params.boundary}`
    const parts = body.toString('latin1').split(mark).slice(1, -1).map((p) => Buffer.from(p.replace(/^\r\n/, '').replace(/\r\n$/, ''), 'latin1'))
    return `(${parts.map(bodyStructure).join('')} ${quote(ct.sub)} ${params()} NIL NIL)`
  }
  const cte = (header(head, 'content-transfer-encoding') ?? '7bit').trim().toLowerCase()
  const common = `${quote(ct.type)} ${quote(ct.sub)} ${params()} NIL NIL ${quote(cte)} ${body.length}`
  return ct.type === 'text' ? `(${common} ${body.toString('latin1').split('\r\n').length})` : `(${common})`
}

function address(v: string | undefined): string {
  if (!v) return 'NIL'
  const m = /([^<\s]+)@([^>\s]+)/.exec(v)
  return m ? `((NIL NIL ${quote(m[1])} ${quote(m[2])}))` : 'NIL'
}

function envelope(m: Stored): string {
  const { head } = splitHeaders(m.raw)
  const from = address(header(head, 'from'))
  return `(${nstring(header(head, 'date'))} ${nstring(header(head, 'subject'))} ${from} ${from} ${from} ${address(header(head, 'to'))} NIL NIL NIL ${nstring(header(head, 'message-id'))})`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function internalDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`
}

function inSet(set: string, n: number, max: number): boolean {
  return set.split(',').some((r) => {
    const [a, b] = r.split(':').map((x) => (x === '*' ? max : Number(x)))
    const hi = b ?? a
    return n >= Math.min(a, hi) && n <= Math.max(a, hi)
  })
}

class ImapConn {
  private buf = Buffer.alloc(0)
  private box: Box | null = null
  private pending: { tag: string; box: Box; flags: string[]; size: number } | null = null

  constructor(private readonly s: TLSSocket, private readonly boxes: Map<string, Box>) {
    s.on('data', (d: Buffer) => this.feed(d))
    s.on('error', () => {})
    this.line('* OK [CAPABILITY IMAP4rev1 UIDPLUS] sahte sunucu hazir')
  }

  private line(l: string): void {
    this.s.write(`${l}\r\n`)
  }

  private feed(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d])
    for (;;) {
      if (this.pending) {
        const need = this.pending.size + 2
        if (this.buf.length < need) return
        const { tag, box, flags, size } = this.pending
        const raw = Buffer.from(this.buf.subarray(0, size))
        this.buf = this.buf.subarray(need)
        this.pending = null
        const uid = box.uidNext++
        box.msgs.push({ uid, raw, flags, date: new Date() })
        this.line(`${tag} OK [APPENDUID 1 ${uid}] APPEND tamam`)
        continue
      }
      const i = this.buf.indexOf('\r\n')
      if (i < 0) return
      const l = this.buf.subarray(0, i).toString('utf8')
      this.buf = this.buf.subarray(i + 2)
      this.command(l)
    }
  }

  private selected(tag: string, name: string): void {
    const box = this.boxes.get(name)
    if (!box) return this.line(`${tag} NO yok`)
    this.box = box
    this.line(`* ${box.msgs.length} EXISTS`)
    this.line('* 0 RECENT')
    this.line('* FLAGS (\\Seen \\Flagged \\Deleted \\Draft \\Answered)')
    this.line('* OK [PERMANENTFLAGS (\\Seen \\Flagged \\Deleted \\Draft \\Answered)] tamam')
    this.line('* OK [UIDVALIDITY 1] tamam')
    this.line(`* OK [UIDNEXT ${box.uidNext}] tamam`)
    this.line(`${tag} OK [READ-WRITE] SELECT tamam`)
  }

  private fetch(tag: string, set: string, items: string, byUid: boolean): void {
    const msgs = this.box?.msgs ?? []
    const max = byUid ? (msgs[msgs.length - 1]?.uid ?? 0) : msgs.length
    msgs.forEach((m, i) => {
      if (!inSet(set, byUid ? m.uid : i + 1, Math.max(max, 1))) return
      const parts: (string | Buffer)[] = [`UID ${m.uid}`]
      const add = (label: string, data: Buffer): void => {
        parts.push(`${label} {${data.length}}\r\n`, data)
      }
      if (/\bFLAGS\b/.test(items)) parts.push(`FLAGS (${m.flags.join(' ')})`)
      if (/\bENVELOPE\b/.test(items)) parts.push(`ENVELOPE ${envelope(m)}`)
      if (/\bBODYSTRUCTURE\b/.test(items)) parts.push(`BODYSTRUCTURE ${bodyStructure(m.raw)}`)
      if (/\bINTERNALDATE\b/.test(items)) parts.push(`INTERNALDATE "${internalDate(m.date)}"`)
      if (/\bRFC822\.SIZE\b/.test(items)) parts.push(`RFC822.SIZE ${m.raw.length}`)
      if (/BODY(\.PEEK)?\[HEADER\.FIELDS/.test(items)) {
        const names = /HEADER\.FIELDS \(([^)]*)\)/.exec(items)![1]
        add(`BODY[HEADER.FIELDS (${names})]`, Buffer.from('\r\n'))
      }
      if (/BODY(\.PEEK)?\[HEADER\]/.test(items)) add('BODY[HEADER]', Buffer.from(`${splitHeaders(m.raw).head}\r\n\r\n`, 'latin1'))
      const whole = /BODY(?:\.PEEK)?\[\](?:<(\d+)\.(\d+)>)?/.exec(items)
      if (whole) {
        const from = Number(whole[1] ?? 0)
        const data = whole[2] ? m.raw.subarray(from, from + Number(whole[2])) : m.raw
        add(whole[2] ? `BODY[]<${from}>` : 'BODY[]', data)
      }
      this.s.write(`* ${i + 1} FETCH (`)
      parts.forEach((p, n) => {
        const prevLiteral = n > 0 && Buffer.isBuffer(parts[n - 1])
        if (typeof p === 'string') this.s.write(n > 0 && !prevLiteral ? ` ${p}` : prevLiteral ? ` ${p}` : p)
        else this.s.write(p)
      })
      this.s.write(')\r\n')
    })
    this.line(`${tag} OK FETCH tamam`)
  }

  private command(l: string): void {
    const m = /^(\S+) (?:(UID) )?(\S+)\s*(.*)$/.exec(l)
    if (!m) return
    const [, tag, uid, verb, rest] = m
    switch (verb.toUpperCase()) {
      case 'CAPABILITY':
        this.line('* CAPABILITY IMAP4rev1 UIDPLUS')
        return this.line(`${tag} OK tamam`)
      case 'LOGIN':
        return this.line(`${tag} OK [CAPABILITY IMAP4rev1 UIDPLUS] giris tamam`)
      case 'NOOP':
      case 'CHECK':
        if (this.box) this.line(`* ${this.box.msgs.length} EXISTS`)
        return this.line(`${tag} OK tamam`)
      case 'LOGOUT':
        this.line('* BYE')
        this.line(`${tag} OK tamam`)
        this.s.end()
        return
      case 'LIST':
      case 'LSUB':
        if (/""\s*""$/.test(rest)) this.line('* LIST (\\Noselect) "/" ""')
        else for (const b of this.boxes.values()) this.line(`* ${verb.toUpperCase()} (\\HasNoChildren${b.special ? ` ${b.special}` : ''}) "/" ${quote(b.name)}`)
        return this.line(`${tag} OK tamam`)
      case 'STATUS': {
        const name = /^"?([^"\s]+)"?/.exec(rest)![1]
        const b = this.boxes.get(name)
        if (!b) return this.line(`${tag} NO yok`)
        this.line(`* STATUS ${quote(name)} (MESSAGES ${b.msgs.length} UIDNEXT ${b.uidNext} UIDVALIDITY 1 UNSEEN 0)`)
        return this.line(`${tag} OK tamam`)
      }
      case 'SELECT':
      case 'EXAMINE':
        return this.selected(tag, /^"?([^"\s]+)"?/.exec(rest)![1])
      case 'CLOSE':
      case 'UNSELECT':
        this.box = null
        return this.line(`${tag} OK tamam`)
      case 'FETCH': {
        const [, set, items] = /^(\S+) (.*)$/.exec(rest)!
        return this.fetch(tag, set, items, !!uid)
      }
      case 'SEARCH':
        this.line(`* SEARCH ${(this.box?.msgs ?? []).map((x, i) => (uid ? x.uid : i + 1)).join(' ')}`.trimEnd())
        return this.line(`${tag} OK tamam`)
      case 'STORE':
      case 'EXPUNGE':
        return this.line(`${tag} OK tamam`)
      case 'APPEND': {
        const a = /^"?([^"\s]+)"?\s+(?:\(([^)]*)\)\s+)?(?:"[^"]*"\s+)?\{(\d+)\+?\}$/.exec(rest)!
        const box = this.boxes.get(a[1])
        if (!box) return this.line(`${tag} NO yok`)
        this.pending = { tag, box, flags: (a[2] ?? '').split(' ').filter(Boolean), size: Number(a[3]) }
        return this.line('+ devam')
      }
      default:
        return this.line(`${tag} BAD bilinmiyor`)
    }
  }
}

function smtpConn(s: TLSSocket, done: (to: string[], raw: Buffer) => void): void {
  let inData = false
  let to: string[] = []
  let buf = Buffer.alloc(0)
  const say = (l: string): void => void s.write(`${l}\r\n`)
  s.on('error', () => {})
  say('220 sahte ESMTP')
  s.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d])
    for (;;) {
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n')
        if (end < 0) return
        const wire = buf.subarray(0, end + 2).toString('latin1').replace(/^\.\./gm, '.')
        buf = buf.subarray(end + 5)
        inData = false
        done(to, Buffer.from(wire, 'latin1'))
        to = []
        say('250 tamam')
        continue
      }
      const i = buf.indexOf('\r\n')
      if (i < 0) return
      const l = buf.subarray(0, i).toString('latin1')
      buf = buf.subarray(i + 2)
      const verb = l.slice(0, 4).toUpperCase()
      if (verb === 'EHLO') {
        s.write('250-sahte\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n')
      } else if (verb === 'AUTH') say('235 tamam')
      else if (verb === 'RCPT') {
        to.push(/<([^>]+)>/.exec(l)?.[1] ?? '')
        say('250 tamam')
      } else if (verb === 'DATA') {
        inData = true
        say('354 devam')
      } else if (verb === 'QUIT') {
        say('221 bay')
        s.end()
      } else say('250 tamam')
    }
  })
}

const listen = (srv: Server): Promise<number> =>
  new Promise((res) => {
    srv.listen(0, '127.0.0.1', () => res((srv.address() as { port: number }).port))
  })

export async function startFakeMail(): Promise<FakeMail> {
  const boxes = new Map<string, Box>([
    ['INBOX', { name: 'INBOX', special: null, uidNext: 1, msgs: [] }],
    ['Sent', { name: 'Sent', special: '\\Sent', uidNext: 1, msgs: [] }]
  ])
  const tlsOpts = { key: readFileSync(join(FIXTURES, 'alice.key')), cert: readFileSync(join(FIXTURES, 'alice.crt')) }
  const socks = new Set<TLSSocket>()
  const track = (s: TLSSocket): void => {
    socks.add(s)
    s.on('close', () => socks.delete(s))
  }
  const deliver = (box: string, raw: Buffer): void => {
    const b = boxes.get(box)!
    b.msgs.push({ uid: b.uidNext++, raw, flags: [], date: new Date() })
  }
  const sent: FakeMail['sent'] = []
  const imap = createTls(tlsOpts, (s) => {
    track(s)
    new ImapConn(s, boxes)
  })
  const smtp = createTls(tlsOpts, (s) => {
    track(s)
    smtpConn(s, (to, raw) => {
      sent.push({ to, raw })
      deliver('INBOX', raw)
    })
  })
  const [imapPort, smtpPort] = await Promise.all([listen(imap), listen(smtp)])
  return {
    imapPort, smtpPort, deliver, sent,
    async close() {
      for (const s of socks) s.destroy()
      await Promise.all([new Promise((r) => imap.close(r)), new Promise((r) => smtp.close(r))])
    }
  }
}
