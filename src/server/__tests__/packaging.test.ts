import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

describe('masaüstü paketi', () => {
  it('sunucu, röle, web ve e2e çıktıları pakete girmez', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf-8')) as { build: { files: string[] } }
    expect(pkg.build.files).toEqual(expect.arrayContaining(['out/**', '!out/server/**', '!out/relay/**', '!out/web/**', '!out/e2e-server/**']))
  })
})
