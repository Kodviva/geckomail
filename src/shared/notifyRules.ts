// Kişiye ait bildirim kuralları (§10.1): saf eşleştirme ve doğrulama; hem sunucu hem arayüz kullanır.
export type NotifyLevel = 'silent' | 'normal' | 'urgent'
export type NotifyField = 'from' | 'domain' | 'to' | 'subject' | 'body' | 'hasAttachment' | 'account'
/** hasAttachment: value 'true'|'false'; account: hesap kimliği */
export interface NotifyClause { field: NotifyField; value: string; not?: boolean }
export interface NotifyRule {
  id: number
  name: string
  enabled: boolean
  position: number
  /** gruplar VEYA, grup içi koşullar VE */
  groups: NotifyClause[][]
  level: NotifyLevel
}
export interface NotifyMessage {
  accountId: number
  fromAddr: string | null
  to: string[]
  subject: string | null
  body: string | null
  hasAttachments: boolean
}

const FIELDS: readonly NotifyField[] = ['from', 'domain', 'to', 'subject', 'body', 'hasAttachment', 'account']
const LEVELS: readonly NotifyLevel[] = ['silent', 'normal', 'urgent']
export const MAX_GROUPS = 20
export const MAX_CLAUSES = 10
export const MAX_VALUE = 200
/** Kişi başına kural sayısı: her yeni posta bütün kurallara karşı değerlendirilir */
export const MAX_RULES = 200
const MAX_NAME = 100

/** Büyük/küçük harf ve Türkçe i/İ/ı duyarsız karşılaştırma için tek biçime indirger */
export function norm(s: string): string {
  return s.toLocaleLowerCase('tr').replace(/ı/g, 'i').replace(/i̇/g, 'i').toLocaleLowerCase('en')
}

/** Kural ileti gövdesine bakıyor mu (gövde çekimi yalnız gerekince yapılsın) */
export function ruleNeedsBody(r: NotifyRule): boolean {
  return r.groups.some((g) => g.some((c) => c.field === 'body'))
}

function clauseHolds(c: NotifyClause, m: NotifyMessage): boolean {
  const v = norm(c.value)
  switch (c.field) {
    case 'from':
      return m.fromAddr != null && norm(m.fromAddr).includes(v)
    case 'domain': {
      if (m.fromAddr == null) return false
      const at = m.fromAddr.lastIndexOf('@')
      // alan adı tam eşleşir: a.co ≠ xa.co, a.co ≠ mail.a.co
      return at >= 0 && norm(m.fromAddr.slice(at + 1)) === v.replace(/^@/, '')
    }
    case 'to':
      return m.to.some((a) => norm(a).includes(v))
    case 'subject':
      return m.subject != null && norm(m.subject).includes(v)
    case 'body':
      return m.body != null && norm(m.body).includes(v)
    case 'hasAttachment':
      return m.hasAttachments === (c.value === 'true')
    case 'account':
      return String(m.accountId) === c.value
  }
}

function clauseMatches(c: NotifyClause, m: NotifyMessage): boolean {
  // bilinmeyen gövde (henüz çekilmedi) ne eşleşir ne "değil" ile eşleşir
  if (c.field === 'body' && m.body == null) return false
  const holds = clauseHolds(c, m)
  return c.not ? !holds : holds
}

/** Gruplardan biri tüm koşullarını sağlıyorsa eşleşir; boş groups/grup eşleşmez */
export function matchRule(r: NotifyRule, m: NotifyMessage): boolean {
  return r.groups.some((g) => g.length > 0 && g.every((c) => clauseMatches(c, m)))
}

/** position sırasıyla ilk etkin eşleşen kural */
export function firstMatch(rules: NotifyRule[], m: NotifyMessage): NotifyRule | null {
  const sorted = [...rules].sort((a, b) => a.position - b.position)
  return sorted.find((r) => r.enabled && matchRule(r, m)) ?? null
}

/** İstemciden gelen kuralı doğrular; geçerliyse temiz kural (id/position yoksa 0), değilse hata kodu metni */
export function validateRule(input: unknown): NotifyRule | string {
  if (typeof input !== 'object' || input === null) return 'rule'
  const i = input as Record<string, unknown>
  const name = typeof i.name === 'string' ? i.name.trim() : ''
  if (!name || name.length > MAX_NAME) return 'name'
  if (i.id !== undefined && !(Number.isInteger(i.id) && (i.id as number) > 0)) return 'id'
  if (!LEVELS.includes(i.level as NotifyLevel)) return 'level'
  if (!Array.isArray(i.groups) || i.groups.length === 0 || i.groups.length > MAX_GROUPS) return 'groups'
  const groups: NotifyClause[][] = []
  for (const g of i.groups) {
    if (!Array.isArray(g) || g.length === 0 || g.length > MAX_CLAUSES) return 'clauses'
    const out: NotifyClause[] = []
    for (const c of g) {
      if (typeof c !== 'object' || c === null) return 'clause'
      const f = (c as Record<string, unknown>).field
      const value = (c as Record<string, unknown>).value
      if (!FIELDS.includes(f as NotifyField) || typeof value !== 'string') return 'clause'
      if (value.trim().length === 0 || value.length > MAX_VALUE) return 'value'
      if (f === 'hasAttachment' && value !== 'true' && value !== 'false') return 'value'
      if (f === 'account' && !/^\d{1,10}$/.test(value)) return 'value'
      const clause: NotifyClause = { field: f as NotifyField, value }
      if ((c as Record<string, unknown>).not === true) clause.not = true
      out.push(clause)
    }
    groups.push(out)
  }
  const id = typeof i.id === 'number' ? i.id : 0
  const position = typeof i.position === 'number' && Number.isInteger(i.position) ? i.position : 0
  return { id, name, enabled: i.enabled !== false, position, groups, level: i.level as NotifyLevel }
}
