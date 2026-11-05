// Ek dosyaları için platforma bağlı güvenlik. electron içe aktarılmaz, yol modülü enjekte edilir:
// Windows dalları bu Mac'te path.win32 ile test edilir.
import type { execFile as nodeExecFile } from 'child_process'
import type { writeFile as nodeWriteFile } from 'fs/promises'
import type nodePath from 'path'
import { quarantineValue } from '../shared/attachmentSafety'
import type { Os } from './os'

/** Renderer'dan gelen yol ek klasörünün içinde mi? Değilse null. startsWith tek başına '../' kaçışına açıktı. */
export function attachmentPathIn(p: unknown, root: string, os: Os, pathImpl: typeof nodePath): string | null {
  if (typeof p !== 'string') return null
  const base = pathImpl.resolve(root)
  const full = pathImpl.resolve(p)
  if (os !== 'win32') return full.startsWith(base + pathImpl.sep) ? full : null
  // \\?\ ve UNC biçimleri normalleştirmeyi atlar; sürücü harfinden sonraki ':' NTFS akışıdır
  if (/^[\\/]{2}/.test(p) || full.slice(2).includes(':')) return null
  // Win32 sondaki nokta ve boşluğu atar: 'a.' denetimden sonra başka dosyaya, '... ' başka klasöre çıkabilir
  if (full.split(pathImpl.sep).some((seg) => /[. ]$/.test(seg))) return null
  return full.toLowerCase().startsWith(base.toLowerCase() + pathImpl.sep) ? full : null
}

/** Mark of the Web: ZoneId=3 internet bölgesi, SmartScreen ve Office bunu okur */
export function zoneIdentifier(): string {
  return '[ZoneTransfer]\r\nZoneId=3\r\n'
}

/** Tarayıcıların indirmelere koyduğu işaret. Hata sessiz: konamazsa açma yine tehlikeli tür onayından geçer. */
export function markUntrusted(path: string, os: Os, d: { execFile: typeof nodeExecFile; writeFile: typeof nodeWriteFile }): Promise<void> {
  if (os === 'darwin') {
    return new Promise((done) => {
      d.execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantineValue(), path], () => done())
    })
  }
  if (os === 'win32') return d.writeFile(`${path}:Zone.Identifier`, zoneIdentifier()).catch(() => {})
  return Promise.resolve()
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/** Kaydetme iletişim kutusunun önerdiği ad; ad posta konusundan gelebilir. Yalnız Windows'ta değişir. */
export function safeSaveName(name: string, os: Os): string {
  if (os !== 'win32') return name
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '')
  if (!clean) return '_'
  return RESERVED.test(clean) ? `_${clean}` : clean
}
