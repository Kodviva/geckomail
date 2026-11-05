// Service worker yönlendirme kuralı (saf işlev; sw.ts'e gömülür, testten de çağrılır).
// 'pass': SW karışmaz. 'cache': hash'li dosya, önbellek öncelikli. 'network': ağ öncelikli, kopmada önbellek.

export type ShellRoute = 'pass' | 'cache' | 'network'

const NEVER = /^\/(api|rpc|oauth)(\/|$)/

export function shellRoute(method: string, mode: string, url: string, origin: string): ShellRoute {
  if (method !== 'GET') return 'pass'
  const u = new URL(url)
  if (u.origin !== origin) return 'pass'
  const path = u.pathname
  if (NEVER.test(path)) return 'pass'
  if (path.startsWith('/assets/')) return 'cache'
  if (path === '/manifest.webmanifest' || path.startsWith('/icons/')) return 'network'
  if (mode === 'navigate' && path !== '/healthz' && path !== '/sw.js') return 'network'
  return 'pass'
}

/** Yanıtın önbellek anahtarı; null: saklanmaz. '/' kabuk sayfasıdır: sekmede açılan simge ya da manifest onu ezmesin */
export function shellKey(mode: string, path: string, contentType: string | null): string | null {
  if (mode !== 'navigate') return path
  return contentType?.includes('text/html') ? '/' : null
}

/** Etkinleşince silinecek eski kabuklar: yenisi kabuk sayfasını içermeden hiçbiri silinmez, çevrimdışı açılış kaybolmaz */
export function staleShells(names: string[], current: string, currentReady: boolean): string[] {
  return currentReady ? names.filter((n) => n !== current) : []
}
