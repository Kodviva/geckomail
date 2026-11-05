// Arama sözdizimi (R27): hem sync (SQL/FTS kurar) hem renderer (vurgu terimleri) aynı ayrıştırıcıyı kullanır.
//   kelime            kelime başıyla eşleşir (konu, gönderen, alıcı, içerik)
//   "tam ifade"       ardışık kelimeler
//   -kelime           dışla
//   from: kimden:     gönderen (adres/ad parçası)      to: kime:  alıcı
//   subject: konu:    yalnız konuda                     account: hesap:  hesap adresi parçası
//   group: grup:      hesap grubu adı                   in: klasör:  gelen/gönderilen/arşiv/çöp/spam
//   after: sonra:     tarihten sonra                    before: önce:  tarihten önce
//                     (2026-09-01 · 01.09.2026 · 7g/2h/3a/1y · 7d/2w/3m/1y)
//   is:unread okunmamış · is:read okunmuş · is:starred yıldızlı · has:attachment ekli
import type { FolderKind } from './rpc'

export interface ParsedQuery {
  terms: string[]
  phrases: string[]
  negTerms: string[]
  subject: string[]
  from: string | null
  to: string | null
  account: string | null
  group: string | null
  folderKind: FolderKind | null
  after: number | null
  before: number | null
  unread: boolean | null
  flagged: boolean
  attach: boolean
}

const FOLDER_ALIASES: Record<string, FolderKind> = {
  inbox: 'inbox', gelen: 'inbox',
  sent: 'sent', 'gönderilen': 'sent', gonderilen: 'sent', giden: 'sent',
  archive: 'archive', 'arşiv': 'archive', arsiv: 'archive',
  trash: 'trash', 'çöp': 'trash', cop: 'trash',
  spam: 'junk', junk: 'junk', istenmeyen: 'junk'
}

/** Türkçe duyarlı katlama: küçük harf, ı/İ → i, aksanlar (ş, ğ, ü, ö, ç) → taban harf. Karakter başına
 *  tek karakter döner (uzunluk korunur) — vurgu/snippet konumları orijinal metne eşlenebilsin diye. */
export function foldChar(c: string): string {
  if (c === 'ı' || c === 'İ' || c === 'I') return 'i'
  const base = c.normalize('NFD')[0] ?? c
  const low = base.toLowerCase()
  return low.length === 1 ? low : c
}

export function fold(s: string): string {
  let out = ''
  for (const c of s) out += foldChar(c)
  return out
}

/** FTS'e yazılacak metin: unicode61 ı'yı i'ye katlamıyor ("kapi" "kapı"yı bulmuyordu) — önceden katla. */
export function foldForIndex(s: string): string {
  return s.replace(/[ıİ]/g, 'i')
}

function parseDate(v: string, now: number): number | null {
  const rel = /^(\d{1,4})([gdhwamy])$/i.exec(v)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2].toLowerCase()
    const day = 86_400_000
    const span = unit === 'g' || unit === 'd' ? day : unit === 'h' || unit === 'w' ? 7 * day : unit === 'a' || unit === 'm' ? 30 * day : 365 * day
    return now - n * span
  }
  let y: number, m: number, d: number
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v)
  const tr = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(v)
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  else if (tr) [y, m, d] = [Number(tr[3]), Number(tr[2]), Number(tr[1])]
  else return null
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  // before:2026-09-01 → o günden önce; after:2026-09-01 → o gün dahil sonrası
  return new Date(y, m - 1, d).getTime()
}

const TOKEN = /(-?)(?:([^\s:"]+):)?(?:"([^"]*)"?|(\S+))/g

export function parseSearch(query: string, now = Date.now()): ParsedQuery {
  const p: ParsedQuery = {
    terms: [], phrases: [], negTerms: [], subject: [], from: null, to: null, account: null, group: null,
    folderKind: null, after: null, before: null, unread: null, flagged: false, attach: false
  }
  for (const m of query.matchAll(TOKEN)) {
    const neg = m[1] === '-'
    const key = m[2]?.toLowerCase() ?? null
    const quoted = m[3] !== undefined
    const value = (quoted ? m[3] : m[4]) ?? ''
    const word = fold(value)
    if (key !== null) {
      switch (key) {
        case 'from': case 'kimden': if (value) p.from = value; continue
        case 'to': case 'kime': if (value) p.to = value; continue
        case 'subject': case 'konu': if (value) p.subject.push(value); continue
        case 'account': case 'hesap': if (value) p.account = value; continue
        case 'group': case 'grup': if (value) p.group = value; continue
        case 'in': case 'klasör': case 'klasor': {
          const k = FOLDER_ALIASES[word]
          if (k) { p.folderKind = k; continue }
          break
        }
        case 'after': case 'sonra': case 'since': {
          const t = parseDate(value, now)
          if (t !== null) { p.after = t; continue }
          break
        }
        case 'before': case 'önce': case 'once': {
          const t = parseDate(value, now)
          if (t !== null) { p.before = t; continue }
          break
        }
        case 'is': case 'durum':
          if (word === 'unread' || word === 'okunmamis') { p.unread = true; continue }
          if (word === 'read' || word === 'okunmus') { p.unread = false; continue }
          if (word === 'starred' || word === 'flagged' || word === 'yildizli') { p.flagged = true; continue }
          break
        case 'has':
          if (word === 'attachment' || word === 'ek' || word === 'ekli') { p.attach = true; continue }
          break
      }
      // tanınmayan anahtar (örn. "saat:14", URL) → düz metin olarak aranır
      const whole = `${m[2]}:${value}`
      if (neg) p.negTerms.push(whole)
      else p.terms.push(whole)
      continue
    }
    if (!quoted) {
      if (word === 'ekli') { p.attach = true; continue }
      if (word === 'okunmamis') { p.unread = true; continue }
      if (word === 'yildizli') { p.flagged = true; continue }
    }
    if (!value.trim()) continue
    if (neg) p.negTerms.push(value)
    else if (quoted) p.phrases.push(value)
    else p.terms.push(value)
  }
  return p
}

/** FTS5 MATCH ifadesi (yalnız pozitif kısım) — boşsa null. Her parça tırnaklanır: kullanıcı girdisi
 *  FTS sözdizimi olarak yorumlanmaz. */
export function ftsMatch(p: ParsedQuery): string | null {
  const q = (s: string) => `"${foldForIndex(s).replace(/"/g, '')}"`
  const parts = [
    ...p.terms.map((t) => `${q(t)}*`),
    ...p.phrases.map(q),
    ...p.subject.map((t) => `subject : ${q(t)}*`),
    ...(p.to ? [`to_text : ${q(p.to)}*`] : [])
  ]
  return parts.length ? parts.join(' ') : null
}

export function ftsNegMatch(p: ParsedQuery): string | null {
  return p.negTerms.length ? p.negTerms.map((t) => `"${foldForIndex(t).replace(/"/g, '')}"*`).join(' OR ') : null
}

/** Vurgulanacak metin parçaları (filtre anahtarları hariç) */
export function highlightTerms(p: ParsedQuery): string[] {
  return [...p.terms, ...p.phrases, ...p.subject, ...(p.from ? [p.from] : [])].map((t) => t.trim()).filter((t) => t.length >= 2)
}

/** Katlanmış eşleşme aralıkları [başlangıç, bitiş) — orijinal metin konumlarıyla */
export function matchRanges(text: string, terms: string[]): [number, number][] {
  if (!text || !terms.length) return []
  // karakter başına tek UTF-16 birimi: katlanmış dizindeki konum = karakter dizini
  const one = (c: string): string => {
    const f = foldChar(c)
    return f.length === 1 ? f : '\uFFFF'
  }
  const chars = [...text]
  const folded = chars.map(one).join('')
  // karakter dizini → UTF-16 konumu (emoji vb. iki birimlik karakterler için)
  const offs: number[] = []
  let o = 0
  for (const c of chars) {
    offs.push(o)
    o += c.length
  }
  offs.push(o)
  const out: [number, number][] = []
  for (const t of terms) {
    const ft = [...t].map(one).join('')
    if (!ft) continue
    let i = folded.indexOf(ft)
    while (i >= 0) {
      out.push([offs[i], offs[i + ft.length]])
      i = folded.indexOf(ft, i + ft.length)
    }
  }
  out.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const merged: [number, number][] = []
  for (const r of out) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([...r])
  }
  return merged
}

/** Gövdedeki ilk eşleşmenin çevresinden kısa bir alıntı; eşleşme yoksa null. */
export function makeSnippet(text: string, terms: string[], width = 160): string | null {
  const flat = text.replace(/\s+/g, ' ').trim()
  const r = matchRanges(flat, terms)[0]
  if (!r) return null
  const start = Math.max(0, r[0] - Math.floor(width / 3))
  const end = Math.min(flat.length, start + width)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`
}

/** HTML gövdeden aranabilir düz metin (indeks ve snippet için; gösterim için değil) */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/[ \t]+/g, ' ')
}
