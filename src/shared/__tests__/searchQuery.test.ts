import { describe, expect, it } from 'vitest'
import { fold, ftsMatch, ftsNegMatch, highlightTerms, htmlToText, makeSnippet, matchRanges, parseSearch } from '../searchQuery'

const NOW = new Date(2026, 8, 30, 12).getTime()

describe('arama ayrıştırıcı', () => {
  it('operatörleri, ifadeleri ve dışlamayı ayırır', () => {
    const p = parseSearch('fatura "son ödeme" -reklam from:veeam to:ali konu:yedek hesap:destek grup:müşteri in:arşiv ekli okunmamış yıldızlı', NOW)
    expect(p.terms).toEqual(['fatura'])
    expect(p.phrases).toEqual(['son ödeme'])
    expect(p.negTerms).toEqual(['reklam'])
    expect(p).toMatchObject({ from: 'veeam', to: 'ali', subject: ['yedek'], account: 'destek', group: 'müşteri', folderKind: 'archive', attach: true, unread: true, flagged: true })
  })
  it('tırnaklı operatör değeri', () => {
    expect(parseSearch('from:"Ali Veli" x').from).toBe('Ali Veli')
  })
  it('tarihler: ISO, TR, göreli', () => {
    expect(parseSearch('sonra:2026-09-01', NOW).after).toBe(new Date(2026, 8, 1).getTime())
    expect(parseSearch('önce:01.09.2026', NOW).before).toBe(new Date(2026, 8, 1).getTime())
    expect(parseSearch('sonra:7g', NOW).after).toBe(NOW - 7 * 86_400_000)
    expect(parseSearch('after:2w', NOW).after).toBe(NOW - 14 * 86_400_000)
  })
  it('tanınmayan anahtar ya da geçersiz değer düz metin olur', () => {
    expect(parseSearch('saat:14 in:bilinmeyen önce:dün').terms).toEqual(['saat:14', 'in:bilinmeyen', 'önce:dün'])
  })
  it('is:read okunmamışı false yapar', () => {
    expect(parseSearch('is:read').unread).toBe(false)
  })
  it('FTS ifadesi: her parça tırnaklı, ı katlanır, kullanıcı sözdizimi etkisiz', () => {
    expect(ftsMatch(parseSearch('kapı "a b" konu:yedek to:ali'))).toBe('"kapi"* "a b" subject : "yedek"* to_text : "ali"*')
    expect(ftsMatch(parseSearch('x" OR y'))).toBe('"x"* "OR"* "y"*')
    expect(ftsNegMatch(parseSearch('a -b -c'))).toBe('"b"* OR "c"*')
    expect(ftsMatch(parseSearch('from:x ekli'))).toBeNull()
  })
  it('vurgu terimleri filtre anahtarlarını içermez', () => {
    expect(highlightTerms(parseSearch('fatura from:veeam ekli önce:7g x'))).toEqual(['fatura', 'veeam'])
  })
})

describe('katlama ve eşleşme', () => {
  it('Türkçe karakterleri katlar, uzunluk korunur', () => {
    expect(fold('KAPI İstanbul Şükrü ÇĞÖ')).toBe('kapi istanbul sukru cgo')
    expect(fold('ığüşöç').length).toBe(6)
  })
  it('katlamalı aralıklar orijinal konumlarla; çakışanlar birleşir', () => {
    const t = 'Kapı ödemesi — KAPI'
    expect(matchRanges(t, ['kapi']).map(([a, b]) => t.slice(a, b))).toEqual(['Kapı', 'KAPI'])
    expect(matchRanges('abcdef', ['bcd', 'cde'])).toEqual([[1, 5]])
  })
  it('emoji gibi iki birimlik karakterlerde konum kaymaz', () => {
    const t = '😀 fatura'
    const [[a, b]] = matchRanges(t, ['fatura'])
    expect(t.slice(a, b)).toBe('fatura')
  })
  it('snippet eşleşmenin çevresinden alınır', () => {
    const body = 'x '.repeat(200) + 'son ödeme tarihi 5 Ekim' + ' y'.repeat(200)
    const s = makeSnippet(body, ['odeme'])!
    expect(s).toContain('ödeme')
    expect(s.startsWith('…')).toBe(true)
    expect(makeSnippet('yok', ['var'])).toBeNull()
  })
  it('htmlToText stil/etiket/varlıkları temizler', () => {
    expect(htmlToText('<style>p{}</style><p>Merhaba&nbsp;<b>dünya</b> &amp; &#304;</p>').replace(/\s+/g, ' ').trim()).toBe('Merhaba dünya & İ')
  })
})
