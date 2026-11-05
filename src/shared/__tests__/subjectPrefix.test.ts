import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../i18n'
import '../i18n/locales/all'
import { forwardSubject, replySubject, stripSubjectPrefixes } from '../subjectPrefix'

describe('subjectPrefix', () => {
  afterEach(() => setLocale('tr'))

  it('strips localized reply/forward prefixes', () => {
    expect(stripSubjectPrefixes('Re: AW: WG: Rapor')).toBe('Rapor')
    expect(stripSubjectPrefixes('TR : Fwd: İlt: Rapor')).toBe('Rapor')
    expect(stripSubjectPrefixes('回复：转发: 报告')).toBe('报告')
    expect(stripSubjectPrefixes('Re[2]: Enc: Relatório')).toBe('Relatório')
    expect(stripSubjectPrefixes('Trend raporu')).toBe('Trend raporu')
  })

  it('adds the UI-language forward prefix only once', () => {
    setLocale('de')
    expect(forwardSubject('Rapor')).toBe('WG: Rapor')
    expect(forwardSubject('Fwd: Rapor')).toBe('Fwd: Rapor')
    setLocale('tr')
    expect(forwardSubject('Rapor')).toBe('İlt: Rapor')
    expect(forwardSubject('TR : Rapor')).toBe('TR : Rapor')
  })

  it('adds Re: unless a reply prefix exists', () => {
    expect(replySubject('Rapor')).toBe('Re: Rapor')
    expect(replySubject('AW: Rapor')).toBe('AW: Rapor')
    expect(replySubject('Retro')).toBe('Re: Retro')
  })
})
