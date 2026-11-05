// S/MIME MIME çözümlemesi: saf bayt işlemleri, kripto yok. Yalnız kök yapıya bakılır: gömülü .p7m sıradan ektir,
// böylece şifreli parça saldırgan HTML'iyle aynı görünümde birleşemez (EFAIL). İmzalı baytlar ham kopya kalır.
import type { SmimeKind } from '../../shared/smime'
import { SmimeFormatError } from './errors'

export type SmimeRoot = 'none' | 'multipart_signed' | 'opaque_signed' | 'enveloped' | 'auth_enveloped' | 'compressed' | 'ambiguous'

const P7_MIME = new Set(['application/pkcs7-mime', 'application/x-pkcs7-mime'])
const P7_SIG = new Set(['application/pkcs7-signature', 'application/x-pkcs7-signature'])

interface Header {
  name: string
  value: string
}

/** Üst bilgi metni (latin1) ve gövdenin başladığı konum */
function splitEntity(raw: Buffer): { head: string; bodyAt: number } {
  if (raw.subarray(0, 2).toString('latin1') === '\r\n') return { head: '', bodyAt: 2 }
  if (raw[0] === 0x0a) return { head: '', bodyAt: 1 }
  // satır sonları karışık olabilir: ilk boş satır üç biçimden biridir, gerçek ayrıştırıcılarla aynı yerde bitmeli
  const ends = [
    { at: raw.indexOf('\r\n\r\n'), body: 4 },
    { at: raw.indexOf('\n\r\n'), body: 3 },
    { at: raw.indexOf('\n\n'), body: 2 }
  ].filter((e) => e.at >= 0)
  if (!ends.length) return { head: raw.toString('latin1'), bodyAt: raw.length }
  const first = ends.reduce((a, b) => (b.at < a.at ? b : a))
  return { head: raw.subarray(0, first.at).toString('latin1'), bodyAt: first.at + first.body }
}

function parseHeaders(head: string): Header[] {
  const out: Header[] = []
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1].value += line
      continue
    }
    const c = line.indexOf(':')
    if (c > 0) out.push({ name: line.slice(0, c).trim().toLowerCase(), value: line.slice(c + 1).trim() })
  }
  return out
}

const headersOf = (raw: Buffer): Header[] => parseHeaders(splitEntity(raw).head)

/** Ham başlık değeri (katlama açılmış); yoksa null */
export function headerValue(raw: Buffer, name: string): string | null {
  return headersOf(raw).find((h) => h.name === name)?.value ?? null
}

export const entityBody = (raw: Buffer): Buffer => raw.subarray(splitEntity(raw).bodyAt)

interface ContentType {
  type: string
  /** küçük harf ad → değerler; aynı parametre iki kez verildiyse iki değer */
  params: Map<string, string[]>
}

/** Tırnak içindeki `;` ve `=` değer sayılır. RFC 2231 parçaları tek ada iner. */
function parseContentType(value: string): ContentType {
  const parts: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '\\' && quoted) {
      cur += ch + (value[++i] ?? '')
      continue
    }
    if (ch === '"') quoted = !quoted
    if (ch === ';' && !quoted) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  const params = new Map<string, string[]>()
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=')
    if (eq < 0) continue
    const name = p.slice(0, eq).trim().toLowerCase().replace(/\*.*$/, '')
    const v = p.slice(eq + 1).trim().replace(/^"([\s\S]*)"$/, '$1').replace(/\\(.)/g, '$1')
    params.set(name, [...(params.get(name) ?? []), v])
  }
  return { type: parts[0].trim().toLowerCase(), params }
}

export const contentTypeOf = (raw: Buffer): string => {
  const v = headerValue(raw, 'content-type')
  return v ? parseContentType(v).type : ''
}

const isSmimeType = (c: ContentType): boolean => P7_MIME.has(c.type) || (c.type === 'multipart/signed' && P7_SIG.has((c.params.get('protocol')?.[0] ?? '').toLowerCase()))

const SMIME_TYPES: Record<string, SmimeRoot> = {
  'signed-data': 'opaque_signed',
  'enveloped-data': 'enveloped',
  'authenveloped-data': 'auth_enveloped',
  'compressed-data': 'compressed'
}

const OID_PREFIX = '2a864886f70d01'
const DER_KINDS: [string, SmimeRoot][] = [
  [`0609${OID_PREFIX}0702`, 'opaque_signed'],
  [`0609${OID_PREFIX}0703`, 'enveloped'],
  [`060b${OID_PREFIX}09100117`, 'auth_enveloped'],
  [`060b${OID_PREFIX}09100109`, 'compressed']
]

/** smime-type bildirmeyen istemciler için: ContentInfo'nun içerik türü DER'in başındadır */
function sniffDer(raw: Buffer): SmimeRoot {
  try {
    const head = pkcs7Der(raw).subarray(0, 24).toString('hex')
    return DER_KINDS.find(([oid]) => head.includes(oid))?.[1] ?? 'ambiguous'
  } catch {
    return 'ambiguous'
  }
}

/** Yalnız kök. Ayrıştırıcı farkına açık yapılar (çift Content-Type, çift sınır) 'ambiguous' olur. */
export function classifyRaw(raw: Buffer): SmimeRoot {
  const cts = headersOf(raw).filter((h) => h.name === 'content-type').map((h) => parseContentType(h.value))
  const smime = cts.filter(isSmimeType)
  if (!smime.length) return 'none'
  if (cts.length > 1) return 'ambiguous'
  const [c] = smime
  if (c.type === 'multipart/signed') return (c.params.get('boundary')?.length ?? 0) > 1 ? 'ambiguous' : 'multipart_signed'
  const declared = c.params.get('smime-type')?.[0]?.toLowerCase()
  return declared ? (SMIME_TYPES[declared] ?? 'ambiguous') : sniffDer(raw)
}

/** imapflow bodyStructure kökü: gövde indirilmeden liste rozeti için */
export function classifyStructure(root: unknown): SmimeKind | null {
  if (!root || typeof root !== 'object') return null
  const { type, parameters } = root as { type?: unknown; parameters?: Record<string, string> }
  if (typeof type !== 'string') return null
  const t = type.toLowerCase()
  if (t === 'multipart/signed') return P7_SIG.has((parameters?.protocol ?? '').toLowerCase()) ? 'signed' : null
  if (!P7_MIME.has(t)) return null
  const kind = SMIME_TYPES[(parameters?.['smime-type'] ?? 'enveloped-data').toLowerCase()]
  if (kind === 'opaque_signed') return 'signed'
  return kind === 'enveloped' || kind === 'auth_enveloped' ? 'encrypted' : null
}

/** Tam 2 parça; imzalı bayt ham kopyadır, sınırdan önceki satır sonu sınıra aittir (RFC 2046 §5.1.1). */
export function splitMultipartSigned(raw: Buffer): { signed: Buffer; signature: Buffer } | null {
  const ct = headerValue(raw, 'content-type')
  const boundaries = ct ? parseContentType(ct).params.get('boundary') : undefined
  if (boundaries?.length !== 1 || !boundaries[0]) return null
  const delimiter = `--${boundaries[0]}`
  const { bodyAt } = splitEntity(raw)
  const text = raw.toString('latin1')

  const parts: Buffer[] = []
  let partStart = -1
  let lineStart = bodyAt
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl < 0 ? text.length : nl
    const line = text.slice(lineStart, lineEnd)
    if (line.startsWith(delimiter)) {
      const tail = line.slice(delimiter.length).trimEnd()
      if (tail === '' || tail === '--') {
        if (partStart >= 0) {
          let end = lineStart
          if (text[end - 1] === '\n') end--
          if (text[end - 1] === '\r') end--
          parts.push(raw.subarray(partStart, Math.max(partStart, end)))
        }
        if (tail === '--') return parts.length === 2 ? { signed: parts[0], signature: parts[1] } : null
        partStart = nl < 0 ? text.length : nl + 1
      }
    }
    if (nl < 0) break
    lineStart = nl + 1
  }
  return null // kapanış sınırı yok: kesilmiş ileti
}

/** application/pkcs7-* varlığının DER gövdesi */
export function pkcs7Der(raw: Buffer): Buffer {
  const cte = (headerValue(raw, 'content-transfer-encoding') ?? '').toLowerCase()
  const body = entityBody(raw)
  if (cte === 'base64') return Buffer.from(body.toString('latin1'), 'base64')
  if (cte === '' || cte === 'binary' || cte === '7bit' || cte === '8bit') return Buffer.from(body)
  throw new SmimeFormatError()
}

const ADDR = /^[^\s@<>",;:]+@[^\s@<>",;:]+$/

/** Virgülle ayrılmış adresler. Grup veya ayrıştırılamayan öğe varsa null. */
export function addressList(value: string): string[] | null {
  const items: string[] = []
  let cur = ''
  let quoted = false
  let angle = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (quoted) {
      if (ch === '\\') i++
      else if (ch === '"') quoted = false
      continue // görünen ad atılır
    }
    if (ch === '"') quoted = true
    else if (ch === '<') {
      angle = true
      cur = ''
    } else if (ch === '>') angle = false
    else if (ch === ',' && !angle) {
      items.push(cur.trim())
      cur = ''
    } else if ((ch === ':' || ch === ';') && !angle) return null
    else cur += ch
  }
  items.push(cur.trim())
  return items.every((a) => ADDR.test(a)) ? items : null
}

/** Karşılaştırma ham iletideki dış başlıktan yapılır; görünen ad ve Sender yok sayılır. */
export function fromHeaders(raw: Buffer): { single: string | null; subject: string | null; to: string | null } {
  const headers = headersOf(raw)
  const froms = headers.filter((h) => h.name === 'from')
  const list = froms.length === 1 ? addressList(froms[0].value) : null
  return {
    single: list?.length === 1 ? list[0] : null,
    subject: headers.find((h) => h.name === 'subject')?.value ?? null,
    to: headers.find((h) => h.name === 'to')?.value ?? null
  }
}

/** RFC 2047 kodlu sözcükleri çözer; yalnız başlık karşılaştırması içindir */
export function decodeWords(s: string): string {
  return s.replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (whole, charset: string, enc: string, text: string) => {
    try {
      const bytes = enc.toLowerCase() === 'b'
        ? Buffer.from(text, 'base64')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1')
      return new TextDecoder(charset).decode(bytes)
    } catch {
      return whole
    }
  })
}

/** Yalnız tek LF'ler CRLF olur: imza kanonik biçim üzerindedir */
export function canonicalizeCrlf(b: Buffer): Buffer {
  return Buffer.from(b.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1')
}
