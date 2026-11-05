// Bildirim kuralı formunun saf durum işlemleri: arayüz yalnız bunları çağırır, doğrulama sunucuyla aynı validateRule.
import { validateRule, type NotifyField, type NotifyLevel, type NotifyRule } from '../../shared/notifyRules'

export interface FormClause { field: NotifyField; value: string; not: boolean }
export interface RuleForm {
  id?: number
  position?: number
  name: string
  enabled: boolean
  level: NotifyLevel
  /** gruplar VEYA, grup içi satırlar VE */
  groups: FormClause[][]
}
export type FormResult = { ok: true; rule: NotifyRule | Omit<NotifyRule, 'id' | 'position'> } | { ok: false; error: string }

export const FIELD_ORDER: readonly NotifyField[] = ['from', 'domain', 'to', 'subject', 'body', 'hasAttachment', 'account']

const blank = (): FormClause => ({ field: 'from', value: '', not: false })

export function emptyForm(): RuleForm {
  return { name: '', enabled: true, level: 'normal', groups: [[blank()]] }
}

export function formFromRule(r: NotifyRule): RuleForm {
  return {
    id: r.id,
    position: r.position,
    name: r.name,
    enabled: r.enabled,
    level: r.level,
    groups: r.groups.map((g) => g.map((c) => ({ field: c.field, value: c.value, not: c.not === true })))
  }
}

/** Boş değerli satırlar ve boşalan gruplar atılır; sonra sunucudaki doğrulama uygulanır */
export function ruleFromForm(f: RuleForm): FormResult {
  const groups = f.groups
    .map((g) => g.filter((c) => c.value.trim() !== '').map((c) => ({ field: c.field, value: c.value.trim(), ...(c.not ? { not: true } : {}) })))
    .filter((g) => g.length > 0)
  const v = validateRule({ ...(f.id !== undefined ? { id: f.id, position: f.position } : {}), name: f.name, enabled: f.enabled, level: f.level, groups })
  if (typeof v === 'string') return { ok: false, error: v }
  if (f.id === undefined) {
    const { id: _id, position: _p, ...rest } = v
    return { ok: true, rule: rest }
  }
  return { ok: true, rule: v }
}

const withGroups = (f: RuleForm, groups: FormClause[][]): RuleForm => ({ ...f, groups: groups.length ? groups : [[blank()]] })

export const addGroup = (f: RuleForm): RuleForm => withGroups(f, [...f.groups, [blank()]])
export const removeGroup = (f: RuleForm, gi: number): RuleForm => withGroups(f, f.groups.filter((_, i) => i !== gi))
export const addClause = (f: RuleForm, gi: number): RuleForm => withGroups(f, f.groups.map((g, i) => (i === gi ? [...g, blank()] : g)))
export const removeClause = (f: RuleForm, gi: number, ci: number): RuleForm =>
  withGroups(f, f.groups.map((g, i) => (i === gi ? (g.length > 1 ? g.filter((_, j) => j !== ci) : g) : g)))

const patch = (f: RuleForm, gi: number, ci: number, p: Partial<FormClause>): RuleForm =>
  withGroups(f, f.groups.map((g, i) => (i === gi ? g.map((c, j) => (j === ci ? { ...c, ...p } : c)) : g)))

export const setClauseValue = (f: RuleForm, gi: number, ci: number, value: string): RuleForm => patch(f, gi, ci, { value })
export const setClauseNot = (f: RuleForm, gi: number, ci: number, not: boolean): RuleForm => patch(f, gi, ci, { not })
/** Alan değişince eski değer anlamını yitirir: sıfırlanır (ek durumu için "true") */
export const setClauseField = (f: RuleForm, gi: number, ci: number, field: NotifyField): RuleForm =>
  patch(f, gi, ci, { field, value: field === 'hasAttachment' ? 'true' : '' })

/** ids[index] öğesini dir (-1 yukarı, +1 aşağı) kadar kaydırır; sınırda aynen döner */
export function moveId(ids: number[], index: number, dir: -1 | 1): number[] {
  const to = index + dir
  if (index < 0 || index >= ids.length || to < 0 || to >= ids.length) return ids
  const out = [...ids]
  ;[out[index], out[to]] = [out[to], out[index]]
  return out
}
