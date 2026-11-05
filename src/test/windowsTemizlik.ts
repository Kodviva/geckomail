// Windows açık SQLite dosyasını silemez; testlerin geçici dizinleri temizlenemezse koşu düşmesin, dizin geçici klasörde kalır
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

if (process.platform === 'win32') {
  const rmSync = fs.rmSync
  fs.rmSync = (path, options) => {
    try {
      rmSync(path, options)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY') throw e
    }
  }
  syncBuiltinESMExports()
}
