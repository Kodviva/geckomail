// Anahtar yalnız motordadır (K1): arayüz paketi kripto kodu taşımaz, S/MIME durumunu RPC'den okur.
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..', '..')
const OUT_WEB = join(SRC, '..', 'out', 'web')

function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return n === '__tests__' ? [] : files(p)
    return [p]
  })
}

describe('renderer does not import smime', () => {
  it('kaynakta kripto içe aktarımı yok', () => {
    const list = [...files(join(SRC, 'renderer')), ...files(join(SRC, 'preload'))].filter((f) => /\.tsx?$/.test(f))
    expect(list.length).toBeGreaterThan(50)
    for (const f of list) {
      const text = readFileSync(f, 'utf-8')
      expect({ f, hit: /from\s+['"](pkijs|asn1js)['"]|import\(['"](pkijs|asn1js)['"]\)|sync\/smime/.test(text) }).toEqual({ f, hit: false })
    }
  })

  it('derlenmiş web paketinde pkijs yok', () => {
    for (const f of files(OUT_WEB).filter((x) => x.endsWith('.js'))) expect({ f, hit: readFileSync(f, 'utf-8').includes('pkijs') }).toEqual({ f, hit: false })
  })
})
