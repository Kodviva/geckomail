import { describe, expect, it } from 'vitest'
import { scriptUses } from '../sieve/scriptScan'

describe('scriptUses', () => {
  it('yorum ve dizgi komut sayılmaz', () => {
    expect(scriptUses('# vacation\r\nkeep;', 'vacation')).toBe(false)
    expect(scriptUses('/* vacation "x"; */ keep;', 'vacation')).toBe(false)
    expect(scriptUses('require "vacation"; keep;', 'vacation')).toBe(false)
    expect(scriptUses('require ["fileinto", "vacation"];', 'vacation')).toBe(false)
    expect(scriptUses('fileinto "a\\" vacation \\"";', 'vacation')).toBe(false)
  })

  it('komut bulunur', () => {
    expect(scriptUses('vacation "x";', 'vacation')).toBe(true)
    expect(scriptUses('require "vacation";\r\nif true { vacation :days 1 "x"; }', 'vacation')).toBe(true)
    expect(scriptUses('VACATION "x";', 'vacation')).toBe(true)
    expect(scriptUses('require "include"; include :personal "x";', 'include')).toBe(true)
    expect(scriptUses('require "include"; keep;', 'include')).toBe(false)
  })

  it('text: blok içi sayılmaz, blok sonrası sayılır', () => {
    expect(scriptUses('reject text:\r\nvacation "x";\r\n.\r\n;', 'vacation')).toBe(false)
    expect(scriptUses('reject text: # yorum\r\nvacation\r\n..\r\n.\r\n;\r\nvacation "y";', 'vacation')).toBe(true)
    expect(scriptUses('reject text:\nvacation "x";\n.\n;', 'vacation')).toBe(false)
    expect(scriptUses('reject text:\r\nkapanmayan vacation', 'vacation')).toBe(false)
  })

  it('etiket ve daha uzun ad komut değildir', () => {
    expect(scriptUses('foo :vacation "x";', 'vacation')).toBe(false)
    expect(scriptUses('myvacation "x";', 'vacation')).toBe(false)
    expect(scriptUses('vacation2 "x";', 'vacation')).toBe(false)
  })

  it('kapanmayan yorum ve dizgi taşmaz', () => {
    expect(scriptUses('/* vacation', 'vacation')).toBe(false)
    expect(scriptUses('"vacation', 'vacation')).toBe(false)
    expect(scriptUses('', 'vacation')).toBe(false)
  })
})
