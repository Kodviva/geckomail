import { describe, expect, it } from 'vitest'
import { firstMatch, matchRule, ruleNeedsBody, validateRule, type NotifyMessage, type NotifyRule } from '../notifyRules'

const msg = (p: Partial<NotifyMessage> = {}): NotifyMessage => ({
  accountId: 1, fromAddr: 'Ali@Firma.co', to: ['ben@x.co', 'Ekip@Y.co'], subject: 'Fatura', body: 'toplantı yarın', hasAttachments: false, ...p
})
const rule = (groups: NotifyRule['groups'], p: Partial<NotifyRule> = {}): NotifyRule => ({
  id: 1, name: 'k', enabled: true, position: 0, groups, level: 'normal', ...p
})

describe('matchRule', () => {
  it('boş groups eşleşmez', () => {
    expect(matchRule(rule([]), msg())).toBe(false)
    expect(matchRule(rule([[]]), msg())).toBe(false)
  })
  it('gruplar VEYA, grup içi VE', () => {
    const r = rule([[{ field: 'from', value: 'ali' }, { field: 'subject', value: 'yok' }], [{ field: 'subject', value: 'fatura' }]])
    expect(matchRule(r, msg())).toBe(true)
    expect(matchRule(rule([[{ field: 'from', value: 'ali' }, { field: 'subject', value: 'yok' }]]), msg())).toBe(false)
  })
  it('not tersler', () => {
    expect(matchRule(rule([[{ field: 'subject', value: 'fatura', not: true }]]), msg())).toBe(false)
    expect(matchRule(rule([[{ field: 'subject', value: 'başka', not: true }]]), msg())).toBe(true)
  })
  it('domain tam eşleşir, alt alan ve sonek eşleşmez', () => {
    const r = rule([[{ field: 'domain', value: 'a.co' }]])
    expect(matchRule(r, msg({ fromAddr: 'x@a.co' }))).toBe(true)
    expect(matchRule(r, msg({ fromAddr: 'x@xa.co' }))).toBe(false)
    expect(matchRule(r, msg({ fromAddr: 'x@mail.a.co' }))).toBe(false)
    expect(matchRule(r, msg({ fromAddr: null }))).toBe(false)
  })
  it('to dizide arar', () => {
    expect(matchRule(rule([[{ field: 'to', value: 'ekip@y.co' }]]), msg())).toBe(true)
    expect(matchRule(rule([[{ field: 'to', value: 'yok@y.co' }]]), msg())).toBe(false)
  })
  it('Türkçe i duyarsız', () => {
    expect(matchRule(rule([[{ field: 'subject', value: 'istanbul' }]]), msg({ subject: 'İSTANBUL toplantısı' }))).toBe(true)
    expect(matchRule(rule([[{ field: 'subject', value: 'İSTANBUL' }]]), msg({ subject: 'istanbul' }))).toBe(true)
    expect(matchRule(rule([[{ field: 'subject', value: 'ISPARTA' }]]), msg({ subject: 'ısparta' }))).toBe(true)
  })
  it('body null iken body clause eşleşmez', () => {
    expect(matchRule(rule([[{ field: 'body', value: 'yarın' }]]), msg())).toBe(true)
    expect(matchRule(rule([[{ field: 'body', value: 'yarın' }]]), msg({ body: null }))).toBe(false)
    expect(matchRule(rule([[{ field: 'body', value: 'yarın', not: true }]]), msg({ body: null }))).toBe(false)
  })
  it('hasAttachment ve account', () => {
    expect(matchRule(rule([[{ field: 'hasAttachment', value: 'true' }]]), msg({ hasAttachments: true }))).toBe(true)
    expect(matchRule(rule([[{ field: 'hasAttachment', value: 'false' }]]), msg({ hasAttachments: true }))).toBe(false)
    expect(matchRule(rule([[{ field: 'account', value: '1' }]]), msg())).toBe(true)
    expect(matchRule(rule([[{ field: 'account', value: '2' }]]), msg())).toBe(false)
  })
})

describe('firstMatch / ruleNeedsBody', () => {
  it('position sırası; disabled atlanır', () => {
    const a = rule([[{ field: 'subject', value: 'fatura' }]], { id: 1, position: 2 })
    const b = rule([[{ field: 'subject', value: 'fatura' }]], { id: 2, position: 1 })
    const c = rule([[{ field: 'subject', value: 'fatura' }]], { id: 3, position: 0, enabled: false })
    expect(firstMatch([a, b, c], msg())?.id).toBe(2)
    expect(firstMatch([c], msg())).toBeNull()
  })
  it('ruleNeedsBody', () => {
    expect(ruleNeedsBody(rule([[{ field: 'body', value: 'x' }]]))).toBe(true)
    expect(ruleNeedsBody(rule([[{ field: 'subject', value: 'x' }]]))).toBe(false)
  })
})

describe('validateRule', () => {
  const ok = { name: 'Önemli', enabled: true, groups: [[{ field: 'from', value: 'a@b.co' }]], level: 'urgent' }
  it('geçerli kuralı döndürür', () => {
    const r = validateRule(ok)
    expect(typeof r).toBe('object')
    expect(r).toMatchObject({ name: 'Önemli', level: 'urgent', id: 0, position: 0 })
  })
  it('sınırlar', () => {
    expect(typeof validateRule(null)).toBe('string')
    expect(typeof validateRule({ ...ok, name: ' ' })).toBe('string')
    expect(typeof validateRule({ ...ok, level: 'x' })).toBe('string')
    expect(typeof validateRule({ ...ok, groups: [] })).toBe('string')
    expect(typeof validateRule({ ...ok, groups: Array(21).fill([{ field: 'from', value: 'a' }]) })).toBe('string')
    expect(typeof validateRule({ ...ok, groups: [Array(11).fill({ field: 'from', value: 'a' })] })).toBe('string')
    expect(typeof validateRule({ ...ok, groups: [[{ field: 'from', value: 'a'.repeat(201) }]] })).toBe('string')
    expect(typeof validateRule({ ...ok, groups: [[{ field: 'nope', value: 'a' }]] })).toBe('string')
    expect(typeof validateRule({ ...ok, groups: [[{ field: 'from', value: '' }]] })).toBe('string')
    expect(typeof validateRule({ ...ok, groups: [[{ field: 'hasAttachment', value: 'belki' }]] })).toBe('string')
    expect(typeof validateRule({ ...ok, groups: [[{ field: 'account', value: 'abc' }]] })).toBe('string')
    expect(typeof validateRule({ ...ok, groups: Array(20).fill(Array(10).fill({ field: 'from', value: 'a'.repeat(200) })) })).toBe('object')
  })
  it('validateRule: id verilmişse pozitif tamsayı olmalı', () => {
    const base = { name: 'k', level: 'normal', groups: [[{ field: 'subject', value: 'x' }]] }
    for (const id of [0, -1, 1.5, '3', null]) expect(validateRule({ ...base, id })).toBe('id')
    expect(validateRule(base)).toMatchObject({ id: 0 })
    expect(validateRule({ ...base, id: 7 })).toMatchObject({ id: 7 })
  })

  it('validateRule: yalnız boşluktan oluşan değer reddedilir', () => {
    const r = (value: string) => validateRule({ name: 'k', level: 'normal', groups: [[{ field: 'subject', value }]] })
    expect(r('   ')).toBe('value')
    expect(r('\t\n')).toBe('value')
    expect(r(' a ')).toMatchObject({ level: 'normal' })
  })
})
