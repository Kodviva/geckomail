// Her HTTP yanıtına eklenen güvenlik başlıkları. CSP uygulanır (report-only değil).
export const CSP = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"

/** Web istemcisi sayfası ve varlıkları (index.html, /assets/*): uygulama yalnız kendi kökenine bağlanır,
 *  üçüncü taraf kaynak yok; posta HTML'i sandbox iframe'de kendi iç CSP'siyle */
export const WEB_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; " +
  "form-action 'self'; frame-ancestors 'none'"

export function securityHeaders(o: { https: boolean; api: boolean }): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }
  // HSTS yalnız HTTPS kökeninde (düz HTTP'de tarayıcı yok sayar, yerel denemeyi de kilitlemesin)
  if (o.https) h['Strict-Transport-Security'] = 'max-age=31536000'
  // API yanıtları (kullanıcı bilgisi, 2FA sırrı) önbelleğe yazılmaz
  if (o.api) h['Cache-Control'] = 'no-store'
  return h
}
