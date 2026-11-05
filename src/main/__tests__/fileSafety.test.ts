import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { attachmentPathIn, markUntrusted, safeSaveName, zoneIdentifier } from '../fileSafety'

const WIN_ROOT = 'C:\\u\\attachments'
const win = (p: unknown): string | null => attachmentPathIn(p, WIN_ROOT, 'win32', path.win32)
const mac = (p: unknown): string | null => attachmentPathIn(p, '/u/attachments', 'darwin', path.posix)

describe('attachmentPathIn', () => {
  it('win32: kök altındaki yol, büyük/küçük harf duyarsız', () => {
    expect(win('C:\\u\\attachments\\a')).toBe('C:\\u\\attachments\\a')
    expect(win('c:\\U\\ATTACHMENTS\\a')).toBe('c:\\U\\ATTACHMENTS\\a')
    expect(win('C:/u/attachments/a')).toBe('C:\\u\\attachments\\a')
  })
  it('win32: kaçış ve özel biçimler reddedilir', () => {
    expect(win('..\\x')).toBeNull()
    expect(win('C:\\u\\attachments\\..\\x')).toBeNull()
    expect(win('C:\\u\\attachments2\\a')).toBeNull()
    expect(win('C:\\u\\attachments')).toBeNull()
    expect(win('attachments\\a:b')).toBeNull()
    expect(win('C:\\u\\attachments\\a:b')).toBeNull()
    expect(win('C:\\u\\attachments\\a::$DATA')).toBeNull()
    expect(win('\\\\?\\C:\\u\\attachments\\a')).toBeNull()
    expect(win('\\\\sunucu\\pay\\attachments\\a')).toBeNull()
    expect(win('//sunucu/pay/attachments/a')).toBeNull()
  })
  it('win32: Windows sonda nokta ve boşluğu atar, aynı dosyaya farklı ad verilemez', () => {
    expect(win('C:\\u\\attachments\\a.')).toBeNull()
    expect(win('C:\\u\\attachments\\a ')).toBeNull()
    expect(win('C:\\u\\attachments\\... \\x')).toBeNull()
  })
  it('posix: bugünkü davranış', () => {
    expect(mac('/u/attachments/a')).toBe('/u/attachments/a')
    expect(mac('/u/attachments/a:b')).toBe('/u/attachments/a:b')
    expect(mac('/U/ATTACHMENTS/a')).toBeNull()
    expect(mac('/u/attachments/../x')).toBeNull()
    expect(mac('/u/attachments')).toBeNull()
    expect(mac('/u/attachments2/a')).toBeNull()
    expect(mac(42)).toBeNull()
  })
})

describe('zoneIdentifier', () => {
  it('internet bölgesi', () => {
    expect(zoneIdentifier()).toBe('[ZoneTransfer]\r\nZoneId=3\r\n')
  })
})

describe('markUntrusted', () => {
  const deps = (fail = false) => ({
    execFile: vi.fn((_c: string, _a: string[], cb: () => void) => cb()),
    writeFile: vi.fn(async () => {
      if (fail) throw new Error('ADS yok')
    })
  })
  type Deps = Parameters<typeof markUntrusted>[2]

  it('win32: Zone.Identifier akışı, xattr çağrılmaz', async () => {
    const d = deps()
    await markUntrusted('C:\\u\\a', 'win32', d as unknown as Deps)
    expect(d.writeFile).toHaveBeenCalledWith('C:\\u\\a:Zone.Identifier', zoneIdentifier())
    expect(d.execFile).not.toHaveBeenCalled()
  })
  it('win32: yazma hatası sessiz (FAT, ağ sürücüsü)', async () => {
    await expect(markUntrusted('C:\\u\\a', 'win32', deps(true) as unknown as Deps)).resolves.toBeUndefined()
  })
  it('darwin: karantina işareti, dosyaya yazma yok', async () => {
    const d = deps()
    await markUntrusted('/u/a', 'darwin', d as unknown as Deps)
    expect(d.execFile).toHaveBeenCalledWith('/usr/bin/xattr', ['-w', 'com.apple.quarantine', expect.stringMatching(/^0081;/), '/u/a'], expect.any(Function))
    expect(d.writeFile).not.toHaveBeenCalled()
  })
  it('linux: işlem yok', async () => {
    const d = deps()
    await markUntrusted('/u/a', 'linux', d as unknown as Deps)
    expect(d.execFile).not.toHaveBeenCalled()
    expect(d.writeFile).not.toHaveBeenCalled()
  })
})

describe('safeSaveName', () => {
  it('win32: ayrılmış aygıt adları', () => {
    expect(safeSaveName('NUL.txt', 'win32')).toBe('_NUL.txt')
    expect(safeSaveName('con', 'win32')).toBe('_con')
    expect(safeSaveName('COM1.tar.gz', 'win32')).toBe('_COM1.tar.gz')
    expect(safeSaveName('LPT9', 'win32')).toBe('_LPT9')
    expect(safeSaveName('COM0.txt', 'win32')).toBe('COM0.txt')
    expect(safeSaveName('console.txt', 'win32')).toBe('console.txt')
  })
  it('win32: yasak karakterler ve denetim karakterleri', () => {
    expect(safeSaveName('a:b.eml', 'win32')).toBe('a_b.eml')
    expect(safeSaveName('a<b>c"d/e\\f|g?h*.eml', 'win32')).toBe('a_b_c_d_e_f_g_h_.eml')
    expect(safeSaveName('a\u0001b\u001f.eml', 'win32')).toBe('a_b_.eml')
  })
  it('win32: sondaki nokta ve boşluk', () => {
    expect(safeSaveName('rapor.', 'win32')).toBe('rapor')
    expect(safeSaveName('rapor . ', 'win32')).toBe('rapor')
    expect(safeSaveName('...', 'win32')).toBe('_')
    expect(safeSaveName('NUL.', 'win32')).toBe('_NUL')
  })
  it('darwin: dokunulmaz', () => {
    expect(safeSaveName('a:b NUL.', 'darwin')).toBe('a:b NUL.')
  })
})
