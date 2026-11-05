// Web istemcisinin derlenmiş dosyaları (out/web). Hash'li varlıklar kalıcı önbellekte; giriş sayfası,
// manifest ve service worker her seferinde doğrulanır. Uzantısız bilinmeyen yol SPA rotasıdır → index.html.
// Kök dışına çıkan ya da '..' içeren yol (kodlanmış hâli dahil) 404; dizin listesi yok. Noktayla başlayan
// bölüm (.env, .git) ve gerçek yolu kök dışına çıkan sembolik bağlantı da 404.
import { createReadStream, realpathSync, statSync, type Stats } from 'fs'
import type { IncomingMessage, ServerResponse } from 'http'
import { extname, resolve, sep } from 'path'
import { WEB_CSP } from './securityHeaders'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
}

const IMMUTABLE = 'public, max-age=31536000, immutable'

/** Gerçek yolu (bağlantılar çözülmüş) kökün içinde kalan düz dosya; değilse null */
function fileStat(path: string, realRoot: string): Stats | null {
  try {
    const real = realpathSync(path)
    if (!real.startsWith(realRoot + sep)) return null
    const st = statSync(real)
    return st.isFile() ? st : null
  } catch {
    return null
  }
}

/** İsteği ele aldıysa true (GET/HEAD dışındakiler çağırana kalır). HSTS gibi bağlama bağlı başlıkları çağıran
 *  önceden setHeader ile ekleyebilir; writeHead onlarla birleşir. */
export function serveStatic(req: IncomingMessage, res: ServerResponse, rootDir: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const base = { 'Content-Security-Policy': WEB_CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
  const notFound = (): true => {
    const body = 'Not Found'
    res.writeHead(404, { ...base, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(body.length), 'Cache-Control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : body)
    return true
  }

  let path: string
  try {
    path = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0])
  } catch {
    return notFound()
  }
  // ters bölü, NUL ve '..' (kodlaması çözülmüş hâliyle) hiç kabul edilmez; normalleştirmeye bırakılmaz
  if (!path.startsWith('/') || path.includes('\0') || path.includes('\\') || path.split('/').includes('..')) return notFound()
  if (path.split('/').some((seg) => seg.startsWith('.'))) return notFound()

  const root = resolve(rootDir)
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return notFound()
  }
  let full = resolve(root, '.' + path)
  if (full !== root && !full.startsWith(root + sep)) return notFound()

  let st = full === root ? null : fileStat(full, realRoot)
  if (!st) {
    // uzantılı yol gerçek bir dosya olmalı; uzantısız yol arayüz rotası
    if (extname(path)) return notFound()
    full = resolve(root, 'index.html')
    st = fileStat(full, realRoot)
    if (!st) return notFound()
  }

  const rel = full.slice(root.length + 1).split(sep).join('/')
  // HTML'e no-transform: Cloudflare gibi vekiller analiz betiği enjekte etmesin (CSP script-src 'self' bozulur)
  const cache = rel.startsWith('assets/') ? IMMUTABLE : extname(full).toLowerCase() === '.html' ? 'no-cache, no-transform' : 'no-cache'
  res.writeHead(200, {
    ...base,
    'Content-Type': TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(st.size),
    'Cache-Control': cache
  })
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  const stream = createReadStream(full)
  // okuma hatası (dosya bu arada silindi): başlık gitti, bağlantı kesilir
  stream.on('error', () => res.destroy())
  stream.pipe(res)
  return true
}
