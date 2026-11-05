// Çift CSP. Sunucu adresi kullanıcı girdisidir: index.html'deki taban politika her https/wss adresine izin verir, sunucu
// seçilince ikinci meta eklenir. Birden çok politika kesişir, connect-src tek köke iner. index.html meta'sı BASE_CSP ile aynıdır.
export const BASE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self' https: wss:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"

/** Yalnız connect-src: öteki yönergeler taban politikada kalır */
export function serverCsp(origin: string): string {
  const u = new URL(origin)
  // kuralı bozacak değer politikaya yazılmaz; köken zaten doğrulanmış olmalı
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== origin) throw new Error('gecko.csp.origin')
  const ws = origin.replace(/^http/, 'ws')
  return `connect-src 'self' ${origin} ${ws}`
}

export function applyServerCsp(doc: Document, origin: string): void {
  const meta = doc.createElement('meta')
  meta.httpEquiv = 'Content-Security-Policy'
  meta.content = serverCsp(origin)
  doc.head.append(meta)
}
