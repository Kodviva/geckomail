import { describe, expect, it } from 'vitest'
import { SIEVE_RULES_SCRIPT as RULES, SIEVE_WRAPPER_SCRIPT as WRAPPER } from '../../shared/sieve'
import { planActivation, vacationConflict, type ServerView } from '../sieve/coexist'
import { generateEmptyRules, generateWrapper } from '../sieve/generate'

const GOOD_RULES = generateEmptyRules().text
const DRIFTED_RULES = `${GOOD_RULES}# elle eklendi\r\n`
const GOOD_WRAPPER = generateWrapper('kullanici')

function view(over: Partial<ServerView> & { active?: string | null; extra?: string[] } = {}): ServerView {
  const { active = null, extra = [], ...rest } = over
  const names = [...extra]
  if (rest.rulesText != null) names.push(RULES)
  if (rest.wrapperText != null) names.push(WRAPPER)
  return {
    scripts: names.map((name) => ({ name, active: name === active })),
    rulesText: null, wrapperText: null, activeText: null, extensions: ['include', 'fileinto'], consentScript: null, wrapperOf: null,
    ...rest
  }
}

describe('planActivation', () => {
  it('etkin yok: activate_rules', () => {
    expect(planActivation(view())).toEqual({ do: 'activate_rules' })
    expect(planActivation(view({ rulesText: GOOD_RULES }))).toEqual({ do: 'activate_rules' })
  })

  it('etkin bizim: replace_only', () => {
    expect(planActivation(view({ active: RULES, rulesText: GOOD_RULES, activeText: GOOD_RULES }))).toEqual({ do: 'replace_only' })
    expect(
      planActivation(view({ active: WRAPPER, rulesText: GOOD_RULES, wrapperText: GOOD_WRAPPER, activeText: GOOD_WRAPPER, wrapperOf: 'kullanici' }))
    ).toEqual({ do: 'replace_only' })
  })

  it('yabancı, onay yok: needs_consent', () => {
    expect(planActivation(view({ active: 'x', extra: ['x'], activeText: 'keep;' }))).toEqual({ do: 'stop', state: 'needs_consent', userScript: 'x' })
  })

  it('yabancı, onay aynı ad: write_wrapper', () => {
    expect(planActivation(view({ active: 'x', extra: ['x'], activeText: 'keep;', consentScript: 'x' }))).toEqual({ do: 'write_wrapper', userScript: 'x' })
  })

  it('onay başka ad: needs_consent', () => {
    expect(planActivation(view({ active: 'y', extra: ['y'], activeText: 'keep;', consentScript: 'x' }))).toMatchObject({ do: 'stop', state: 'needs_consent', userScript: 'y' })
  })

  it('include yok: blocked_no_include, onay olsa da', () => {
    const v = view({ active: 'x', extra: ['x'], activeText: 'keep;', consentScript: 'x', extensions: ['fileinto'] })
    expect(planActivation(v)).toMatchObject({ do: 'stop', state: 'blocked_no_include' })
  })

  it('kullanıcı betiği include kullanıyor: blocked_user_include', () => {
    const v = view({ active: 'x', extra: ['x'], activeText: 'require "include";\ninclude "y";', consentScript: 'x' })
    expect(planActivation(v)).toMatchObject({ do: 'stop', state: 'blocked_user_include' })
  })

  it('metni okunamayan yabancı betik onaylı sayılmaz', () => {
    expect(planActivation(view({ active: 'x', extra: ['x'], consentScript: 'x' }))).toMatchObject({ do: 'stop', state: 'needs_consent' })
  })

  it('başlıksız geckomail-rules: conflict', () => {
    expect(planActivation(view({ rulesText: 'keep;' }))).toMatchObject({ do: 'stop', state: 'conflict' })
    expect(planActivation(view({ active: RULES, rulesText: 'keep;', activeText: 'keep;' }))).toMatchObject({ do: 'stop', state: 'conflict' })
  })

  it('sarmalayıcı başlıklı geckomail-rules: conflict', () => {
    expect(planActivation(view({ rulesText: GOOD_WRAPPER }))).toMatchObject({ do: 'stop', state: 'conflict' })
  })

  it('başlıksız geckomail-main: conflict', () => {
    expect(planActivation(view({ wrapperText: 'keep;' }))).toMatchObject({ do: 'stop', state: 'conflict' })
  })

  it('başlığı tutmayan: drift', () => {
    expect(planActivation(view({ active: RULES, rulesText: DRIFTED_RULES, activeText: DRIFTED_RULES }))).toMatchObject({ do: 'stop', state: 'drift' })
    expect(planActivation(view({ wrapperText: `${GOOD_WRAPPER}# x\r\n` }))).toMatchObject({ do: 'stop', state: 'drift' })
  })

  it('sarmalayıcı kurulu, etkin başka: displaced', () => {
    const v = view({ active: 'x', extra: ['x'], rulesText: GOOD_RULES, wrapperText: GOOD_WRAPPER, activeText: 'keep;', wrapperOf: 'kullanici', consentScript: 'kullanici' })
    expect(planActivation(v)).toEqual({ do: 'stop', state: 'displaced', userScript: 'x' })
  })

  it('sarmalayıcı kurulu, etkin yok: displaced', () => {
    const v = view({ rulesText: GOOD_RULES, wrapperText: GOOD_WRAPPER, wrapperOf: 'kullanici' })
    expect(planActivation(v)).toMatchObject({ do: 'stop', state: 'displaced' })
  })

  it('yarım kalan sarmalayıcı: satırda iz yoksa yeniden yazılır', () => {
    const v = view({ active: 'x', extra: ['x'], rulesText: GOOD_RULES, wrapperText: generateWrapper('x'), activeText: 'keep;', consentScript: 'x' })
    expect(planActivation(v)).toEqual({ do: 'write_wrapper', userScript: 'x' })
  })
})

describe('vacationConflict', () => {
  it('kullanıcı betiğindeki vacation komutu çatışır, yorum ve dizgi çatışmaz', () => {
    expect(vacationConflict(null)).toBe(false)
    expect(vacationConflict('# vacation\nkeep;')).toBe(false)
    expect(vacationConflict('require "vacation";\nkeep;')).toBe(false)
    expect(vacationConflict('require "vacation";\nvacation "izin";')).toBe(true)
  })
})
