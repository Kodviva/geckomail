import { describe, expect, it } from 'vitest'
import { subjectTemplateKey } from '../noise'

describe('subjectTemplateKey', () => {
  it('sayıları normalize ederek aynı kalıbı üretir', () => {
    expect(subjectTemplateKey('SLA gecikmesi: 1 açık arıza')).toBe(subjectTemplateKey('SLA gecikmesi: 3 açık arıza'))
  })

  it('farklı metinler farklı kalıp üretir', () => {
    expect(subjectTemplateKey('SLA gecikmesi: 1 açık arıza')).not.toBe(subjectTemplateKey('Ödeme hatası: 1 kayıt'))
  })

  it('büyük/küçük harf farkını yok sayar', () => {
    expect(subjectTemplateKey('Report Domain: X')).toBe(subjectTemplateKey('report domain: x'))
  })

  it('null/boş konu için boş string döner', () => {
    expect(subjectTemplateKey(null)).toBe('')
    expect(subjectTemplateKey('')).toBe('')
  })
})
