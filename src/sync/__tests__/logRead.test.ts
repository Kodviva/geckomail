import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { readRecentLogLines } from '../logRead'

describe('readRecentLogLines', () => {
  it('son iki günün satırlarını zamana göre birleştirir, yarım satırı atlar, sınırı uygular', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gecko-logr-'))
    writeFileSync(join(dir, 'geckomail-2026-09-28.jsonl'), '{"ts":1,"msg":"eski"}\n')
    writeFileSync(join(dir, 'geckomail-2026-09-29.jsonl'), '{"ts":30,"msg":"b"}\n{"ts":10,"msg":"a"}\n')
    writeFileSync(join(dir, 'geckomail-2026-09-30.jsonl'), '{"ts":40,"msg":"c"}\n{"ts":5\n')
    const lines = readRecentLogLines(dir, 2) as { msg: string }[]
    expect(lines.map((l) => l.msg)).toEqual(['b', 'c'])
    expect(readRecentLogLines(join(dir, 'yok'), 5)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})
