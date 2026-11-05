// Mobil uygulamada sunucu adresi kullanıcı girdisidir: yalnız köken saklanır, yol ve sorgu atılır, kimlik bilgisi reddedilir.
// Üretimde https zorunlu (T12); Debug derlemesinde yalnız geri döngü adresine düz http.
export type ServerUrlError = 'empty' | 'invalid' | 'insecure' | 'credentials'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const PROBE_MS = 10_000

export function parseServerUrl(input: string, o: { dev: boolean }): { ok: true; origin: string } | { ok: false; reason: ServerUrlError } {
  const text = input.trim()
  if (!text) return { ok: false, reason: 'empty' }
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+(\/|$)/.test(text) ? text : `https://${text}`
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'invalid' }
  if (!u.hostname) return { ok: false, reason: 'invalid' }
  if (u.username || u.password) return { ok: false, reason: 'credentials' }
  if (u.protocol === 'http:' && !(o.dev && LOOPBACK.has(u.hostname))) return { ok: false, reason: 'insecure' }
  return { ok: true, origin: u.origin }
}

export type ProbeResult = 'ok' | 'notGecko' | 'tooOld' | 'unreachable'

/** Kaydetmeden önce adresin gerçekten bir GeckoMail sunucusu olduğu sınanır */
export async function probeServer(origin: string, f: typeof fetch = fetch): Promise<ProbeResult> {
  let res: Response
  try {
    res = await f(`${origin}/api/mobile/hello`, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(PROBE_MS) })
  } catch {
    return 'unreachable'
  }
  if (res.status === 404) return 'tooOld'
  if (!res.ok) return 'notGecko'
  const body = (await res.json().catch(() => null)) as { product?: unknown } | null
  return body?.product === 'geckomail' ? 'ok' : 'notGecko'
}
