import { describe, expect, it } from 'vitest'
import { addClause, addGroup, emptyForm, formFromRule, moveId, removeClause, removeGroup, ruleFromForm, setClauseField } from '../notifyRuleForm'
import { MAX_CLAUSES, MAX_GROUPS, type NotifyRule } from '../../../shared/notifyRules'

const base = () => ({ ...emptyForm(), name: 'Önemli kişi' })

describe('notifyRuleForm', () => {
  it('boş form tek grup ve tek boş satır içerir', () => {
    const f = emptyForm()
    expect(f.groups).toHaveLength(1)
    expect(f.groups[0]).toHaveLength(1)
    expect(f.level).toBe('normal')
  })

  it('formdan kural: boş değerli satır ve boş grup atılır', () => {
    let f = base()
    f.groups[0][0] = { field: 'from', value: ' x@a.co ', not: false }
    f = addClause(f, 0) // boş satır
    f = addGroup(f) // boş grup
    f = { ...f, level: 'urgent' }
    const r = ruleFromForm(f)
    expect(r).toEqual({ ok: true, rule: { name: 'Önemli kişi', enabled: true, level: 'urgent', groups: [[{ field: 'from', value: 'x@a.co' }]] } })
  })

  it('"değil" işareti taşınır', () => {
    const f = base()
    f.groups[0][0] = { field: 'subject', value: 'fatura', not: true }
    const r = ruleFromForm(f)
    expect(r.ok && r.rule.groups[0][0]).toEqual({ field: 'subject', value: 'fatura', not: true })
  })

  it('hiç dolu koşul yoksa hata kodu groups', () => {
    expect(ruleFromForm(base())).toEqual({ ok: false, error: 'groups' })
  })

  it('validateRule hatası kod olarak döner (ad boş, hesap sayı değil)', () => {
    const f = emptyForm()
    f.groups[0][0] = { field: 'from', value: 'a', not: false }
    expect(ruleFromForm(f)).toEqual({ ok: false, error: 'name' })
    const g = base()
    g.groups[0][0] = { field: 'account', value: 'abc', not: false }
    expect(ruleFromForm(g)).toEqual({ ok: false, error: 'value' })
  })

  it('düzenlemede id ve sıra korunur', () => {
    const rule: NotifyRule = { id: 7, name: 'k', enabled: false, position: 3, level: 'silent', groups: [[{ field: 'domain', value: 'a.co' }]] }
    const f = formFromRule(rule)
    const r = ruleFromForm(f)
    expect(r).toMatchObject({ ok: true, rule: { id: 7, position: 3, enabled: false, level: 'silent' } })
  })

  it('grup ve satır silme: son grup silinirse boş grup kalır', () => {
    let f = addGroup(base())
    f = removeGroup(f, 1)
    expect(f.groups).toHaveLength(1)
    f = removeGroup(f, 0)
    expect(f.groups).toHaveLength(1)
    expect(f.groups[0][0].value).toBe('')
    f = addClause(f, 0)
    f = removeClause(f, 0, 1)
    expect(f.groups[0]).toHaveLength(1)
    f = removeClause(f, 0, 0)
    expect(f.groups[0]).toHaveLength(1) // en az bir satır
  })

  it('alan değişince değer sıfırlanır; ek alanı varsayılan "true"', () => {
    let f = base()
    f.groups[0][0] = { field: 'from', value: 'x', not: false }
    f = setClauseField(f, 0, 0, 'hasAttachment')
    expect(f.groups[0][0]).toMatchObject({ field: 'hasAttachment', value: 'true' })
    f = setClauseField(f, 0, 0, 'subject')
    expect(f.groups[0][0].value).toBe('')
  })

  it('moveId sınırda yerinde kalır', () => {
    expect(moveId([1, 2, 3], 1, -1)).toEqual([2, 1, 3])
    expect(moveId([1, 2, 3], 1, 1)).toEqual([1, 3, 2])
    expect(moveId([1, 2, 3], 0, -1)).toEqual([1, 2, 3])
    expect(moveId([1, 2, 3], 2, 1)).toEqual([1, 2, 3])
  })

  it('çok gruplu kural: formFromRule → ruleFromForm gidiş-dönüş (değil, ek, hesap)', () => {
    const rule: NotifyRule = {
      id: 4,
      name: 'Karma',
      enabled: true,
      position: 2,
      level: 'urgent',
      groups: [
        [{ field: 'from', value: 'x@a.co', not: true }, { field: 'hasAttachment', value: 'false' }],
        [{ field: 'account', value: '12' }, { field: 'subject', value: 'fatura', not: true }],
        [{ field: 'domain', value: 'b.co' }]
      ]
    }
    const f = formFromRule(rule)
    expect(f.groups).toHaveLength(3)
    expect(f.groups[0][1]).toEqual({ field: 'hasAttachment', value: 'false', not: false })
    expect(ruleFromForm(f)).toEqual({ ok: true, rule })
  })

  it('sınır aşan form sunucudaki hata kodlarını döner (clauses, groups)', () => {
    let f = base()
    f.groups[0][0] = { field: 'from', value: 'a', not: false }
    for (let i = 0; i < MAX_CLAUSES; i++) f = addClause(f, 0)
    f = { ...f, groups: [f.groups[0].map((c) => ({ ...c, value: 'a' }))] }
    expect(f.groups[0]).toHaveLength(MAX_CLAUSES + 1)
    expect(ruleFromForm(f)).toEqual({ ok: false, error: 'clauses' })
    const g = base()
    g.groups = Array.from({ length: MAX_GROUPS + 1 }, () => [{ field: 'from' as const, value: 'a', not: false }])
    expect(ruleFromForm(g)).toEqual({ ok: false, error: 'groups' })
  })
})
