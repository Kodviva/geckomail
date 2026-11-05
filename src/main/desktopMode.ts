// Masaüstü modu: `userData/desktop-mode.json`. Sync DB'sinde değildir, sunucu modunda DB hiç açılmaz. electron içe aktarılmaz.
// Dosya yok ya da bozuksa yerel mod: 1.0.7'den yükselen kurulum bugünkü gibi açılır, hiçbir şey yazılmaz.
import { randomUUID } from 'crypto'
import * as nodeFs from 'fs'
import { join } from 'path'
import { DESKTOP_API } from '../server/desktopRoutes'

type Fs = typeof nodeFs

export interface DesktopModeFile {
  version: 1
  mode: 'local' | 'server'
  serverOrigin: string | null
  /** Bu kurulumun kalıcı kimliği: ajan cihazı ve taşıma kaydı. Sır değildir */
  sourceId: string
  closeHintShown: boolean
  importedTo: { origin: string; at: number } | null
}

const FILE = 'desktop-mode.json'
const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/
/** config.ts ile aynı küme: düz http yalnız burada */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const PROBE_TIMEOUT_MS = 10_000

const fresh = (): DesktopModeFile => ({ version: 1, mode: 'local', serverOrigin: null, sourceId: randomUUID(), closeHintShown: false, importedTo: null })

function valid(v: unknown): v is DesktopModeFile {
  if (!v || typeof v !== 'object') return false
  const m = v as Partial<DesktopModeFile>
  if (m.version !== 1 || (m.mode !== 'local' && m.mode !== 'server')) return false
  if (typeof m.sourceId !== 'string' || !SOURCE_ID.test(m.sourceId) || typeof m.closeHintShown !== 'boolean') return false
  if (m.importedTo !== null && (typeof m.importedTo?.origin !== 'string' || typeof m.importedTo.at !== 'number')) return false
  // elle değiştirilmiş dosya güvensiz kökene bağlatamaz
  if (m.serverOrigin === null) return m.mode === 'local'
  if (typeof m.serverOrigin !== 'string') return false
  const n = normalizeServerUrl(m.serverOrigin)
  return n.ok && n.origin === m.serverOrigin
}

export function readMode(dir: string, fs: Fs = nodeFs, log: (msg: string) => void = console.error): DesktopModeFile {
  let raw: string
  try {
    raw = fs.readFileSync(join(dir, FILE), 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log(`mod dosyası okunamadı: ${(e as NodeJS.ErrnoException).code}`)
    return fresh()
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (valid(parsed)) return parsed
  } catch {
    /* aşağıda */
  }
  log('mod dosyası bozuk, yerel modda açılıyor') // içerik yazılmaz
  return fresh()
}

/** Geçici dosya + rename: yarım kalan yazma önceki modu bozmaz */
export function writeMode(dir: string, m: DesktopModeFile, fs: Fs = nodeFs): void {
  fs.mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `${FILE}.${process.pid}.tmp`)
  try {
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, join(dir, FILE))
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

export function updateMode(dir: string, patch: Partial<DesktopModeFile>): DesktopModeFile {
  const next = { ...readMode(dir), ...patch }
  writeMode(dir, next)
  return next
}

/** Yalnız köken kalır. Kullanıcı bilgisi reddedilir: `https://iyi.example@kotu.example` gerçek ana makineyi gizler.
 *  `URL` adı küçültür ve IDN'i punycode'a çevirir: kullanıcı bağlanmadan önce gerçek adı görür. */
export function normalizeServerUrl(input: string): { ok: true; origin: string } | { ok: false; reason: 'invalid' | 'insecure' } {
  const text = input.trim()
  if (!text) return { ok: false, reason: 'invalid' }
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password) return { ok: false, reason: 'invalid' }
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) return { ok: false, reason: 'insecure' }
  return { ok: true, origin: url.origin }
}

/** Oturumsuz yoklama. Yönlendirme izlenmez: yanıtı veren köken kullanıcının gördüğü köken olmalı. TLS hatası `unreachable` */
export async function probeServer(origin: string, fetchFn: typeof fetch): Promise<{ ok: true } | { ok: false; reason: 'unreachable' | 'notGecko' | 'originMismatch' | 'apiMismatch' }> {
  let res: Response
  try {
    res = await fetchFn(`${origin}/api/server-info`, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  const info = res.ok ? ((await res.json().catch(() => null)) as { app?: unknown; desktopApi?: unknown; origin?: unknown } | null) : null
  if (info?.app !== 'geckomail') return { ok: false, reason: 'notGecko' }
  if (info.origin !== origin) return { ok: false, reason: 'originMismatch' }
  if (info.desktopApi !== DESKTOP_API) return { ok: false, reason: 'apiMismatch' }
  return { ok: true }
}

export interface ModeStarters {
  restore(): void
  spawnSync(): void
  bridge(): void
  localWindow(): void
  serverWindow(origin: string): void
  /** Pencereden bağımsız: gizli açılışta da bildirim gelir */
  serverAgent(origin: string): void
}

/** Sunucu modunda sync süreci başlamaz, `better-sqlite3` açılmaz. `hidden`: oturum açılışı, pencere kurulmaz */
export function startForMode(m: DesktopModeFile, o: { hidden: boolean }, d: ModeStarters): void {
  if (m.mode === 'server' && m.serverOrigin) {
    if (!o.hidden) d.serverWindow(m.serverOrigin)
    d.serverAgent(m.serverOrigin)
    return
  }
  d.restore()
  d.spawnSync()
  if (!o.hidden) d.localWindow()
  d.bridge()
}
