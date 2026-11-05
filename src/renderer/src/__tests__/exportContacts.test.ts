import { describe, expect, it } from 'vitest'
import { toCsv } from '../exportContacts'

describe('toCsv', () => {
  it('başlık satırıyla başlar', () => {
    expect(toCsv([]).split(/\r?\n/)[0]).toBe('Ad,E-posta')
  })

  it('virgül ve tırnak içeren adı RFC 4180 kurallarına göre kaçışlar', () => {
    const line = toCsv([{ name: 'Yılmaz, "Ada"', addr: 'ada@ornek.com' }]).split(/\r?\n/)[1]
    expect(line).toBe('"Yılmaz, ""Ada""",ada@ornek.com')
  })

  it('null adı boş alana çevirir', () => {
    const line = toCsv([{ name: null, addr: 'bos@ornek.com' }]).split(/\r?\n/)[1]
    expect(line).toBe(',bos@ornek.com')
  })
})
