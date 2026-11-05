import { describe, expect, it } from 'vitest'
import { extensionOf, isDangerousAttachment, normalizedName, quarantineValue } from '../attachmentSafety'

describe('attachmentSafety', () => {
  it('çalıştırılabilir türleri yakalar (büyük/küçük harf, çift uzantı)', () => {
    expect(isDangerousAttachment('fatura.pdf.command')).toBe(true)
    expect(isDangerousAttachment('Kurulum.PKG')).toBe(true)
    expect(isDangerousAttachment('/x/y/z/run.sh')).toBe(true)
  })
  it('belgeler güvenli sayılır; uzantısız/gizli dosya uzantısız', () => {
    expect(isDangerousAttachment('rapor.pdf')).toBe(false)
    expect(isDangerousAttachment('tablo.xlsx')).toBe(false)
    expect(extensionOf('.bashrc')).toBe('')
    expect(extensionOf('README')).toBe('')
  })
  it('Windows ad kaçışları: sondaki nokta/boşluk ve akış', () => {
    for (const n of ['fatura.exe.', 'fatura.exe ', 'fatura.exe. . ', 'a.exe::$DATA', 'a.exe:gizli', 'FATURA.EXE', 'x.lnk', 'x.pdf:evil.exe', 'C:\\u\\attachments\\a.exe.']) {
      expect({ n, r: isDangerousAttachment(n) }).toEqual({ n, r: true })
    }
    expect(isDangerousAttachment('x.pdf')).toBe(false)
    expect(isDangerousAttachment('x.pdf.')).toBe(false)
    expect(isDangerousAttachment('C:\\u\\attachments\\a1b2')).toBe(false)
  })
  it('Windows türleri', () => {
    for (const e of ['com', 'pif', 'msc', 'msp', 'mst', 'gadget', 'wsh', 'vbe', 'psm1', 'ps1xml', 'scf', 'shb', 'shs', 'inf', 'application', 'appx', 'appxbundle', 'msix', 'msixbundle', 'appinstaller', 'library-ms', 'search-ms', 'settingcontent-ms', 'chm', 'hlp', 'dll', 'sys', 'vhd', 'vhdx', 'wim', 'xll']) {
      expect({ e, r: isDangerousAttachment(`x.${e}`) }).toEqual({ e, r: true })
    }
  })
  it('normalizedName', () => {
    expect(normalizedName('fatura.exe. ')).toBe('fatura.exe')
    expect(normalizedName('a.exe::$DATA')).toBe('a.exe')
    expect(normalizedName('C:\\u\\a.txt')).toBe('a.txt')
    expect(normalizedName('/x/y/rapor.pdf')).toBe('rapor.pdf')
    expect(normalizedName('rapor.pdf')).toBe('rapor.pdf')
  })
  it('karantina değeri biçimi', () => {
    expect(quarantineValue(0x10000 * 1000)).toBe('0081;10000;GeckoMail;')
  })
})
