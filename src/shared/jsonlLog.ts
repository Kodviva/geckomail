// Kalıcı JSONL günlüğü (main ve sync süreçleri; renderer içe aktarmaz — fs kullanır).
// 29 Eyl'deki IP banını teşhis etmek için sunucuya SSH gerekti: uygulamanın kendi kaydı yoktu.
// Satır başına bir olay: {ts, proc, level, msg, ...alanlar}. Günlük dosya, 14 gün saklama, dosya
// başına üst sınır (disk dolmasın). Şifre/kimlik bilgisi yazılmaz — çağıranlar describeError gibi
// maskeli metin verir.
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'

export type LogLevel = 'info' | 'warn' | 'error'

const KEEP_DAYS = 14
const MAX_FILE_BYTES = 20 * 1024 * 1024

export interface JsonlLogger {
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  dir: string
}

export function logFileName(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `geckomail-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`
}

export function createLogger(dir: string, proc: 'main' | 'sync', now: () => number = Date.now): JsonlLogger {
  mkdirSync(dir, { recursive: true })
  prune(dir, now())
  let full = false
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    const ts = now()
    const file = join(dir, logFileName(ts))
    try {
      if (full) return
      try {
        if (statSync(file).size > MAX_FILE_BYTES) {
          full = true
          appendFileSync(file, JSON.stringify({ ts, proc, level: 'warn', msg: 'günlük dosyası sınırına ulaşıldı — bugünkü diğer satırlar yazılmayacak' }) + '\n')
          return
        }
      } catch {
        /* dosya yok: ilk satır */
      }
      appendFileSync(file, JSON.stringify({ ts, proc, level, msg, ...fields }) + '\n')
    } catch {
      /* günlük yazılamaması uygulamayı düşürmemeli */
    }
  }
  // gün dönünce sınır bayrağını sıfırla
  let day = logFileName(now())
  const guard = (level: LogLevel) => (msg: string, fields?: Record<string, unknown>) => {
    const today = logFileName(now())
    if (today !== day) {
      day = today
      full = false
      prune(dir, now())
    }
    write(level, msg, fields)
  }
  return { info: guard('info'), warn: guard('warn'), error: guard('error'), dir }
}

function prune(dir: string, ts: number): void {
  try {
    const keep = new Set(Array.from({ length: KEEP_DAYS }, (_, i) => logFileName(ts - i * 86_400_000)))
    for (const f of readdirSync(dir)) {
      if (/^geckomail-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && !keep.has(f)) rmSync(join(dir, f), { force: true })
    }
  } catch {
    /* umursanmaz */
  }
}

/** console.warn/error'u günlüğe de yansıt (mevcut çağrı yerleri değişmeden kalıcı olur). */
export function mirrorConsole(log: JsonlLogger): void {
  const fmt = (args: unknown[]) =>
    args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 2000)
  const origWarn = console.warn.bind(console)
  const origError = console.error.bind(console)
  console.warn = (...args: unknown[]) => {
    origWarn(...args)
    log.warn(fmt(args))
  }
  console.error = (...args: unknown[]) => {
    origError(...args)
    log.error(fmt(args))
  }
}
