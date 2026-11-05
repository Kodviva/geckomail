import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

/** Günlük dizininden en yeni satırlar (bugün + dün, main ve sync birlikte), zamana göre sıralı. */
export function readRecentLogLines(dir: string, limit: number): unknown[] {
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => /^geckomail-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-2)
  } catch {
    return []
  }
  const out: { ts?: number }[] = []
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), 'utf-8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as { ts?: number })
      } catch {
        /* yarım satır */
      }
    }
  }
  return out.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)).slice(-limit)
}
