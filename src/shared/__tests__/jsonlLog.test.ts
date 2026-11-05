import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLogger, logFileName } from '../jsonlLog'

describe('jsonlLog', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'gecko-log-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('satır başına bir JSON olay yazar', () => {
    const t = new Date('2026-09-30T10:00:00').getTime()
    const log = createLogger(dir, 'sync', () => t)
    log.warn('host soğumada', { host: 'mail.test', until: 5 })
    log.info('ok')
    const lines = readFileSync(join(dir, logFileName(t)), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ ts: t, proc: 'sync', level: 'warn', msg: 'host soğumada', host: 'mail.test', until: 5 })
  })

  it('14 günden eski dosyaları siler, diğer dosyalara dokunmaz', () => {
    const t = new Date('2026-09-30T10:00:00').getTime()
    const old = logFileName(t - 20 * 86_400_000)
    const recent = logFileName(t - 3 * 86_400_000)
    writeFileSync(join(dir, old), '{}\n')
    writeFileSync(join(dir, recent), '{}\n')
    writeFileSync(join(dir, 'baska.txt'), 'x')
    createLogger(dir, 'main', () => t)
    const files = readdirSync(dir)
    expect(files).not.toContain(old)
    expect(files).toContain(recent)
    expect(files).toContain('baska.txt')
  })
})
