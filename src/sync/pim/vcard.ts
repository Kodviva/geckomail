// vCard 2.1/3.0/4.0 okuma ve yazma. Yazarken taban kart metin düzeyinde korunur: ayrıştırıp yeniden üretmek
// bilinmeyen özellikleri ve data: adreslerini bozar. Uzak PHOTO adresi asla çekilmez.
import { createHash, randomUUID } from 'crypto'
import ICAL from 'ical.js'
import type { ContactDetail, ContactDraft, ContactEmail } from '../../shared/pim'
import { compactUtc } from './recur'

export interface ParsedCard {
  uid: string
  kind: 'individual' | 'group'
  fullName: string
  org: string | null
  emails: ContactEmail[]
  memberUids: string[]
  detail: Omit<ContactDetail, 'id' | 'collectionId' | 'etag' | 'memberIds'>
}

const MAX_CARD_BYTES = 1_000_000
const MAX_PHOTO_BYTES = 256 * 1024
const NOISE_TYPES = new Set(['internet', 'pref', 'x400', 'voice'])

/** Eski kartlar: QP yumuşak satır sonu ayrıştırıcıdan önce birleşir, çıplak parametreler (TEL;CELL) adlandırılır */
function normalize(raw: string): string {
  const legacy = /^VERSION:\s*2\.1\s*$/im.test(raw)
  const lines = raw.split(/\r?\n/)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    const colonAt = line.indexOf(':')
    if (colonAt >= 0 && /QUOTED-PRINTABLE/i.test(line.slice(0, colonAt)) && line.endsWith('=')) {
      const soft = [line.slice(0, -1)]
      for (let more = true; more && i + 1 < lines.length; ) {
        const next = lines[++i]
        more = next.endsWith('=')
        soft.push(more ? next.slice(0, -1) : next)
      }
      line = soft.join('')
    }
    if (legacy) {
      const colon = line.indexOf(':')
      if (colon > 0) {
        const head = line.slice(0, colon).split(';').map((p, n) => {
          if (n === 0 || p.includes('=')) return p
          if (/^quoted-printable$/i.test(p)) return 'ENCODING=QUOTED-PRINTABLE'
          if (/^(base64|b)$/i.test(p)) return 'ENCODING=b'
          return `TYPE=${p}`
        })
        line = head.join(';') + line.slice(colon)
      }
    }
    out.push(line)
  }
  return out.join('\r\n')
}

function decodeQp(s: string, charset: string | null): string {
  const bytes: number[] = []
  const src = Buffer.from(s, 'utf8')
  for (let i = 0; i < src.length; i++) {
    const hex = src[i] === 0x3d ? src.toString('latin1', i + 1, i + 3) : ''
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16))
      i += 2
    } else bytes.push(src[i])
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(Uint8Array.from(bytes))
  } catch {
    return Buffer.from(bytes).toString('utf8')
  }
}

/** Özelliğin metin parçaları (N, ADR, ORG çok parçalı) */
function parts(p: ICAL.Property): string[] {
  const flat = p.getValues().flat(3).map((v) => (v == null ? '' : String(v)))
  const enc = p.getParameter('encoding')
  if (typeof enc !== 'string' || !/quoted-printable/i.test(enc)) return flat
  const charset = p.getParameter('charset')
  return flat.map((v) => decodeQp(v, typeof charset === 'string' ? charset : null))
}

/** ical.js vCard tasarımı yapısız metinde `\\;` kaçışını açmaz; 3.0 NOTE virgülde bölünür */
const plainText = (p: ICAL.Property | null): string | null => (p ? parts(p).join(',').replace(/\\;/g, ';') || null : null)

const joined = (p: ICAL.Property | null): string | null => (p ? parts(p).filter(Boolean).join(', ') || null : null)

function labelOf(p: ICAL.Property, card: ICAL.Component): string | null {
  const group = p.getParameter('group')
  if (typeof group === 'string') {
    const label = card.getAllProperties('x-ablabel').find((l) => l.getParameter('group') === group)
    if (label) return String(label.getFirstValue()).replace(/^_\$!<(.*)>!\$_$/, '$1')
  }
  const type = p.getParameter('type')
  const types = (Array.isArray(type) ? type : type ? [type] : []).map((t) => String(t).toLowerCase())
  return types.find((t) => !NOISE_TYPES.has(t)) ?? null
}

const uidOfMember = (v: unknown): string => String(v).replace(/^urn:uuid:/i, '')

function birthdayOf(p: ICAL.Property | null): string | null {
  if (!p) return null
  const v = String(p.getFirstValue() ?? '').split('T')[0]
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(v)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const noYear = /^--(\d{2})-?(\d{2})$/.exec(v)
  return noYear ? `--${noYear[1]}-${noYear[2]}` : v || null
}

function photoOf(card: ICAL.Component): string | null {
  for (const p of card.getAllProperties('photo')) {
    const value = String((p.toJSON() as unknown[])[3] ?? '').replace(/\s/g, '')
    let mime: string | null = null
    let data = ''
    const uri = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/i.exec(value)
    if (uri) {
      mime = uri[1].toLowerCase()
      data = uri[2]
    } else if (/^(b|base64)$/i.test(String(p.getParameter('encoding') ?? '')) && /^[A-Za-z0-9+/=]+$/.test(value)) {
      const type = String(p.getParameter('type') ?? '').toLowerCase().replace(/^image\//, '')
      mime = type === 'png' ? 'png' : type === 'jpeg' || type === 'jpg' ? 'jpeg' : null
      data = value
    }
    if (mime && (data.length * 3) / 4 <= MAX_PHOTO_BYTES) return `data:image/${mime};base64,${data}`
  }
  return null
}

export function parseCard(raw: string): ParsedCard | null {
  try {
    if (!raw || Buffer.byteLength(raw) > MAX_CARD_BYTES) return null
    const jcal = ICAL.parse(normalize(raw)) as unknown[]
    if (typeof jcal[0] !== 'string') return null
    const card = new ICAL.Component(jcal as never)
    if (card.name !== 'vcard') return null
    const list = (name: string, read: (p: ICAL.Property) => string | null): { value: string; label: string | null }[] =>
      card.getAllProperties(name).flatMap((p) => {
        const value = read(p)?.trim()
        return value ? [{ value, label: labelOf(p, card) }] : []
      })
    const emails = list('email', (p) => parts(p)[0] ?? null).map((e) => ({ addr: e.value, label: e.label }))
    const name = card.getFirstProperty('n')
    const [family = null, given = null] = name ? parts(name).map((s) => s || null) : []
    const org = joined(card.getFirstProperty('org'))
    const fn = card.getFirstProperty('fn')
    const fullName = plainText(fn)?.trim() || [given, family].filter(Boolean).join(' ') || org || emails[0]?.addr || ''
    const kind = String(card.getFirstPropertyValue('kind') ?? card.getFirstPropertyValue('x-addressbookserver-kind') ?? '').toLowerCase() === 'group' ? 'group' : 'individual'
    const memberUids = [...card.getAllProperties('member'), ...card.getAllProperties('x-addressbookserver-member')].map((p) => uidOfMember(p.getFirstValue()))
    const uid = String(card.getFirstPropertyValue('uid') ?? '').trim() || `gecko-${createHash('sha1').update(raw).digest('hex')}`
    return {
      uid, kind, fullName, org, emails, memberUids,
      detail: {
        kind, fullName, org, emails, given, family, phones: list('tel', (p) => parts(p)[0] ?? null), addresses: list('adr', joined),
        note: plainText(card.getFirstProperty('note')), birthday: birthdayOf(card.getFirstProperty('bday')), photoDataUrl: photoOf(card)
      }
    }
  } catch {
    return null
  }
}

export function splitVcf(raw: string): string[] {
  const out: string[] = []
  let card: string[] | null = null
  for (const line of raw.split(/\r\n|\r|\n/)) {
    if (/^\s*BEGIN:VCARD\s*$/i.test(line)) card = [line.trim()]
    else if (!card) continue
    else if (/^\s*END:VCARD\s*$/i.test(line)) {
      card.push(line.trim())
      out.push(`${card.join('\r\n')}\r\n`)
      card = null
    } else card.push(line)
  }
  return out
}

export function detectCardVersion(raw: string | null): '3.0' | '4.0' {
  return raw && /^VERSION:\s*4\.0\s*$/im.test(raw) ? '4.0' : '3.0'
}

export const escapeText = (s: string): string => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n')
const typeParam = (label: string | null): string => {
  const clean = (label ?? '').replace(/[";:\r\n]/g, '').trim()
  return clean ? `;TYPE=${/^[\w-]+$/.test(clean) ? clean : `"${clean}"`}` : ''
}

/** 75 baytta katlar, çok baytlı karakteri bölmez */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line) <= 75) return line
  const out: string[] = []
  let cur = ''
  let size = 0
  for (const ch of line) {
    const n = Buffer.byteLength(ch)
    if (size + n > 75) {
      out.push(cur)
      cur = ' '
      size = 1
    }
    cur += ch
    size += n
  }
  out.push(cur)
  return out.join('\r\n')
}

const MANAGED = new Set(['FN', 'N', 'ORG', 'NOTE', 'BDAY', 'EMAIL', 'TEL', 'ADR', 'KIND', 'MEMBER', 'X-ADDRESSBOOKSERVER-KIND', 'X-ADDRESSBOOKSERVER-MEMBER', 'REV'])

function headOf(line: string): { group: string | null; name: string } {
  const m = /^(?:([A-Za-z0-9-]+)\.)?([A-Za-z0-9-]+)/.exec(line)
  return { group: m?.[1]?.toLowerCase() ?? null, name: m?.[2]?.toUpperCase() ?? '' }
}

export function draftToCard(d: ContactDraft, o: { uid?: string; base?: string; version: '3.0' | '4.0'; memberUids?: string[]; now: number }): string {
  const baseLines = o.base ? o.base.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter(Boolean) : null
  const version = o.base ? detectCardVersion(o.base) : o.version
  let kept: string[]
  if (baseLines) {
    const rest = baseLines.filter((l) => !MANAGED.has(headOf(l).name))
    const live = new Set(rest.filter((l) => headOf(l).name !== 'X-ABLABEL').map((l) => headOf(l).group).filter(Boolean))
    kept = rest.filter((l) => {
      const h = headOf(l)
      return h.name !== 'X-ABLABEL' || !h.group || live.has(h.group)
    }).filter((l) => headOf(l).name !== 'END')
  } else {
    kept = ['BEGIN:VCARD', `VERSION:${version}`]
  }
  if (!kept.some((l) => headOf(l).name === 'UID')) kept.push(`UID:${o.uid ?? randomUUID()}`)
  const lines = [...kept, `FN:${escapeText(d.fullName)}`, `N:${escapeText(d.family ?? '')};${escapeText(d.given ?? '')};;;`]
  if (d.org) lines.push(`ORG:${escapeText(d.org)}`)
  for (const e of d.emails) lines.push(`EMAIL${typeParam(e.label)}:${escapeText(e.addr)}`)
  for (const p of d.phones) lines.push(`TEL${typeParam(p.label)}:${escapeText(p.value)}`)
  for (const a of d.addresses) lines.push(`ADR${typeParam(a.label)}:;;${escapeText(a.value)};;;;`)
  if (d.note) lines.push(`NOTE:${escapeText(d.note)}`)
  // yılsız doğum günü: 4.0 `--MMDD`, 3.0 `--MM-DD`
  if (d.birthday && /^\d{4}-\d{2}-\d{2}$/.test(d.birthday)) lines.push(`BDAY:${d.birthday}`)
  else if (d.birthday && /^--\d{2}-\d{2}$/.test(d.birthday)) lines.push(`BDAY:${version === '4.0' ? d.birthday.replace(/-(\d{2})$/, '$1') : d.birthday}`)
  if (d.kind === 'group') {
    const v4 = version === '4.0'
    lines.push(v4 ? 'KIND:group' : 'X-ADDRESSBOOKSERVER-KIND:group')
    for (const m of o.memberUids ?? []) lines.push(`${v4 ? 'MEMBER' : 'X-ADDRESSBOOKSERVER-MEMBER'}:${m.includes(':') ? m : `urn:uuid:${m}`}`)
  }
  lines.push(`REV:${compactUtc(o.now)}`, 'END:VCARD')
  return `${lines.map(foldLine).join('\r\n')}\r\n`
}
