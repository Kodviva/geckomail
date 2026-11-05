// Sync sürecinin kalıcı günlüğü (index.ts kurar). Modüller doğrudan kullanır; kurulmadıysa (testler) sessiz.
import type { JsonlLogger } from '../shared/jsonlLog'

let current: JsonlLogger | null = null

export function setSyncLog(l: JsonlLogger): void {
  current = l
}

export const syncLog = {
  info: (msg: string, fields?: Record<string, unknown>) => current?.info(msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => current?.warn(msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => current?.error(msg, fields)
}
