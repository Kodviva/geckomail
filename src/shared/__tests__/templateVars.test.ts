import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../i18n'
import { fillTemplate, templateValues, templateVarNames } from '../templateVars'

const base = { subject: 'Re: Teklif', fromEmail: 'destek@firma.co', fromName: 'Destek Ekibi', now: new Date(2026, 8, 30, 14, 5) }

describe('şablon değişkenleri', () => {
  afterEach(() => setLocale('tr'))
  it('görünen addan ilk isim; yoksa adresten', () => {
    expect(templateValues({ ...base, to: '"Ayşe Yılmaz" <ayse@x.co>, b@y.co' }).ad).toBe('Ayşe')
    expect(templateValues({ ...base, to: 'ismail.kaya@x.co' }).ad).toBe('İsmail')
    expect(templateValues({ ...base, to: '' }).ad).toBe('')
  })
  it('tüm değişkenler; boşluklu ve ASCII yazım; bilinmeyen korunur', () => {
    const out = fillTemplate('Merhaba {{ad}}, {{ konu }} hk. — {{gonderen}} ({{hesap}}) {{tarih}} {{saat}} {{bilinmez}}', {
      ...base,
      to: 'Ali Veli <ali@x.co>'
    })
    expect(out).toBe('Merhaba Ali, Teklif hk. — Destek Ekibi (destek@firma.co) 30 Eylül 2026 14:05 {{bilinmez}}')
  })
  it('gönderen adı yoksa adres', () => {
    expect(fillTemplate('{{gönderen}}', { ...base, fromName: null, to: '' })).toBe('destek@firma.co')
  })
  it('İngilizce adlar her dilde; tarih/saat arayüz dilinde; ipucu dile göre', () => {
    const ctx = { ...base, to: 'Ali Veli <ali@x.co>' }
    expect(fillTemplate('{{name}} {{Recipient}} {{sender}} {{account}} {{subject}} {{TIME}}', ctx)).toBe(
      'Ali Ali Veli Destek Ekibi destek@firma.co Teklif 14:05'
    )
    expect(templateVarNames('tr')).toContain('ad')
    expect(templateVarNames('en')).toContain('name')
    setLocale('en')
    expect(fillTemplate('{{date}}', ctx)).toBe('September 30, 2026')
  })
})
