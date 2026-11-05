// ManageSieve desteği yoklaması. Kimlik gönderilmez: sunucu yetenekleri karşılamada söyler. Governor'a
// dokunmaz: kapalı port IMAP'i etkileyen yanlış "IP engeli" soğuması doğurmamalı. Sonuç önbellekli,
// çünkü 67 hesap aynı ana makinedeyken tekrar yoklama kendi başına engel sebebi olur.
import type { SieveCapsInfo } from '../../shared/sieve'
import { providerOfAuthType } from '../oauth'
import { ManageSieveClient, ManageSieveError, saslMechanismFor, type SieveTlsMode } from './manageSieve'

const SUCCESS_TTL_MS = 24 * 3600_000
const FAILURE_TTL_MS = 7 * 24 * 3600_000
/** STARTTLS karşılaması gelmezse implicit TLS denenir: uzun beklenmez */
const GREETING_TIMEOUT_MS = 5000
/** ManageSieve sunmayan bilinen sağlayıcılar: bağlantı açılmaz */
const NO_SIEVE_HOSTS = new Set(['imap.gmail.com', 'outlook.office365.com'])

export interface DetectResult {
  supported: boolean
  tls: SieveTlsMode | null
  caps: SieveCapsInfo | null
  reason: 'no_listener' | 'no_tls' | 'no_sasl' | 'provider' | null
  /** ağ ya da ad çözümü yoktu: sunucu hakkında bilgi değil, önbelleğe yazılmaz */
  transient?: boolean
}

interface Probe {
  tls: SieveTlsMode | null
  caps: SieveCapsInfo | null
  reason: 'no_listener' | 'no_tls' | null
  transient?: boolean
}

const cache = new Map<string, Probe & { expires: number }>()
const inflight = new Map<string, Promise<Probe>>()

export function clearDetectCache(): void {
  cache.clear()
}

type Connect = typeof ManageSieveClient.connect

async function tryMode(connect: Connect, t: { host: string; port: number; rejectUnauthorized: boolean }, tls: SieveTlsMode, timeoutMs?: number): Promise<SieveCapsInfo> {
  const c = await connect({ host: t.host, port: t.port, rejectUnauthorized: t.rejectUnauthorized, tls, timeoutMs })
  const caps = c.caps
  await c.logout()
  return caps
}

async function probe(connect: Connect, t: { host: string; port: number; rejectUnauthorized: boolean }, greetingTimeoutMs: number): Promise<Probe> {
  try {
    return { tls: 'starttls', caps: await tryMode(connect, t, 'starttls', greetingTimeoutMs), reason: null }
  } catch (e) {
    const err = e instanceof ManageSieveError ? e : null
    if (!err || err.transport === 'no_tcp') return { tls: null, caps: null, reason: 'no_listener', transient: err?.networkDown }
    // karşılama geldi ama TLS kurulamadı: STARTTLS'siz sunucuya kimlik gönderilmez, implicit denenmez
    if (err.phase === 'tls') return { tls: null, caps: null, reason: 'no_tls' }
  }
  try {
    return { tls: 'tls', caps: await tryMode(connect, t, 'tls'), reason: null }
  } catch (e) {
    const tlsFailed = e instanceof ManageSieveError && e.phase === 'tls' && e.transport === null
    return { tls: null, caps: null, reason: tlsFailed ? 'no_tls' : 'no_listener', transient: e instanceof ManageSieveError && e.networkDown }
  }
}

function view(p: Probe, authType: string): DetectResult {
  if (p.reason) return { supported: false, tls: null, caps: null, reason: p.reason, ...(p.transient ? { transient: true } : {}) }
  const kind = authType.startsWith('oauth') ? 'oauth' : 'password'
  if (!saslMechanismFor(p.caps?.sasl ?? [], kind)) return { supported: false, tls: p.tls, caps: p.caps, reason: 'no_sasl' }
  return { supported: true, tls: p.tls, caps: p.caps, reason: null }
}

export async function detectSieve(
  target: { host: string; port: number; rejectUnauthorized: boolean; authType: string },
  deps?: { now(): number; connect?: Connect; greetingTimeoutMs?: number; force?: boolean }
): Promise<DetectResult> {
  const host = target.host.toLowerCase()
  // belirteç sağlayıcıya aittir: elle verilen uç nokta ona gitmesini sağlayamaz
  if (NO_SIEVE_HOSTS.has(host) || providerOfAuthType(target.authType)) return { supported: false, tls: null, caps: null, reason: 'provider' }
  const now = deps?.now ?? Date.now
  // sertifika denetimi anahtara girer: geçersiz sertifikaya izin veren hesap başkasının sonucunu miras almasın
  const key = `${host}:${target.port}:${target.rejectUnauthorized ? 1 : 0}`
  const hit = deps?.force ? undefined : cache.get(key)
  if (hit && now() < hit.expires) return view(hit, target.authType)
  let running = inflight.get(key)
  if (!running) {
    const connect = deps?.connect ?? ManageSieveClient.connect.bind(ManageSieveClient)
    running = probe(connect, target, deps?.greetingTimeoutMs ?? GREETING_TIMEOUT_MS)
      .then((p) => {
        if (!p.transient) cache.set(key, { ...p, expires: now() + (p.reason ? FAILURE_TTL_MS : SUCCESS_TTL_MS) })
        return p
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, running)
  }
  return view(await running, target.authType)
}
