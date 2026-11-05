// Şablon değişkenleri (R28). Bilinmeyen {{…}} olduğu gibi kalır — kullanıcı yazım hatasını görsün.
//   {{ad}}        {{name}}       ilk alıcının adı (görünen ad yoksa adresin @ öncesi, büyük harfle)
//   {{alıcı}}     {{recipient}}  ilk alıcının tam adı ya da adresi
//   {{gönderen}}  {{sender}}     gönderen hesabın görünen adı (yoksa adres)
//   {{hesap}}     {{account}}    gönderen hesap adresi
//   {{konu}}      {{subject}}    mailin konusu
//   {{tarih}}     {{date}}       bugün (30 Eylül 2026)    {{saat}} {{time}}  şimdi (14:05)
// Tarih/saat arayüz dilinde biçimlenir. Türkçe adlar, ASCII yazımları (alici, gonderen) ve İngilizce
// adlar her dilde çalışır; menüdeki ipucu yalnız arayüz diline uygun adları gösterir.
import { getLocale, intlTag, type Locale } from './i18n'
import { stripSubjectPrefixes } from './subjectPrefix'

export interface TemplateContext {
  to: string
  subject: string
  fromEmail: string
  fromName: string | null
  now?: Date
}

export const TEMPLATE_VARS = ['ad', 'alıcı', 'gönderen', 'hesap', 'konu', 'tarih', 'saat'] as const
export const TEMPLATE_VARS_EN = ['name', 'recipient', 'sender', 'account', 'subject', 'date', 'time'] as const

/** Şablon menüsünde gösterilecek değişken adları: Türkçe arayüzde Türkçe, diğerlerinde İngilizce */
export function templateVarNames(l: Locale = getLocale()): readonly string[] {
  return l === 'tr' ? TEMPLATE_VARS : TEMPLATE_VARS_EN
}

const ALIAS: Record<string, string> = {
  alici: 'alıcı',
  gonderen: 'gönderen',
  ...Object.fromEntries(TEMPLATE_VARS_EN.map((en, i) => [en, TEMPLATE_VARS[i]]))
}

function firstRecipient(to: string): { name: string | null; addr: string } | null {
  const first = to.split(/[,;]/).map((s) => s.trim()).find(Boolean)
  if (!first) return null
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(first)
  if (m) return { name: m[1].trim() || null, addr: m[2].trim() }
  return { name: null, addr: first }
}

function title(s: string): string {
  return s ? s.charAt(0).toLocaleUpperCase(intlTag()) + s.slice(1) : s
}

export function templateValues(ctx: TemplateContext): Record<string, string> {
  const now = ctx.now ?? new Date()
  const r = firstRecipient(ctx.to)
  const local = r ? r.addr.split('@')[0].split(/[._-]/)[0] : ''
  return {
    ad: r ? (r.name ? r.name.split(/\s+/)[0] : title(local)) : '',
    'alıcı': r ? (r.name ?? r.addr) : '',
    'gönderen': ctx.fromName?.trim() || ctx.fromEmail,
    hesap: ctx.fromEmail,
    konu: stripSubjectPrefixes(ctx.subject),
    tarih: now.toLocaleDateString(intlTag(), { day: 'numeric', month: 'long', year: 'numeric' }),
    saat: now.toLocaleTimeString(intlTag(), { hour: '2-digit', minute: '2-digit' })
  }
}

/** {{ ad }} gibi boşluklu, ASCII (alici, gonderen) ve İngilizce ({{name}}, {{date}}) yazımları da kabul eder */
export function fillTemplate(text: string, ctx: TemplateContext): string {
  const v = templateValues(ctx)
  return text.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (whole, key: string) => {
    // Türkçe küçük harf (İ→i, I→ı) Türkçe adlar için; düz küçük harf İngilizce adlar için (TIME → time)
    for (const k of new Set([key.toLocaleLowerCase('tr-TR'), key.toLowerCase()])) {
      const hit = v[k] ?? v[ALIAS[k] ?? '']
      if (hit !== undefined) return hit
    }
    return whole
  })
}
