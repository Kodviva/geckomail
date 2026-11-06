import { credentialFor, type Credential } from './oauth'
import { ImapFlow } from 'imapflow'
import type { AccountRow } from './db/queries'
import { mailEndpoint } from './net/mailNet'

// preauth: login tamamlanmadan ağ hatası (TCP/TLS reset, eof, greeting yok) — IP engelinin imzası
export type ErrClass = 'auth' | 'limit' | 'preauth' | 'net' | 'other'

const NET_CODES = [
  'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE', 'ECONNABORTED', 'ENETUNREACH',
  'ETIMEOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'NoConnection', 'EConnectionClosed'
]

export function classifyError(e: unknown): ErrClass {
  const err = e as { authenticationFailed?: boolean; code?: string; message?: string; responseText?: string; phase?: string }
  const m = `${err?.message ?? ''} ${err?.responseText ?? ''}`.toLowerCase()
  if (err?.authenticationFailed || err?.code === 'EAUTH' || /authentication|login failed|invalid credentials|auth failed/.test(m)) return 'auth'
  if (err?.code === 'ETHROTTLE' || /too many|maximum number|limit|throttl|try again later/.test(m)) return 'limit'
  if (
    (err?.code && NET_CODES.includes(err.code)) ||
    /timeout|timed out|socket|connection closed|connection reset|greeting|unexpected eof|disconnected|hang up/.test(m)
  )
    return err?.phase === 'connect' ? 'preauth' : 'net'
  return 'other'
}

/** Sunucuda artık olmayan klasör (silinmiş/yeniden adlandırılmış — Stalwart'a taşımada "Sent" → "Sent Items"):
 *  hesap hatası değil, yerel klasör listesi bayat. RFC 5530 NONEXISTENT ya da sunucu metni. */
export function isMissingMailbox(e: unknown): boolean {
  const err = e as { serverResponseCode?: string; responseText?: string; message?: string }
  if (err?.serverResponseCode?.toUpperCase() === 'NONEXISTENT') return true
  return /does not exist|doesn't exist|no such mailbox|mailbox not found|unknown mailbox|nonexistent/i.test(`${err?.responseText ?? ''} ${err?.message ?? ''}`)
}

/**
 * Kullanıcıya/loga gidecek okunur hata metni. imapflow'un 'Command failed' iletisi tek başına işe
 * yaramaz; sunucunun NO/BAD cevabı (responseText) ve hangi komutun düştüğü (executedCommand —
 * imapflow bunu loglama modunda derler, LOGIN/AUTH sırları maskelidir) teşhisin kendisidir.
 */
export function describeError(e: unknown): string {
  const err = e as { message?: string; responseStatus?: string; responseText?: string; executedCommand?: string; code?: string }
  let out = String(err?.message ?? e)
  if (err?.responseText) out += ` — ${err.responseStatus ? `${err.responseStatus}: ` : ''}${err.responseText}`
  else if (err?.code && !out.includes(err.code)) out += ` (${err.code})`
  if (err?.executedCommand) {
    // "A12 UID FETCH 1:* (...)" → etiketi at, yalnız komut + ilk argüman (uzun listeler kısaltılır)
    const cmd = err.executedCommand.replace(/^\S+\s+/, '').split(/\s+/).slice(0, 3).join(' ')
    out += ` [${cmd.slice(0, 60)}]`
  }
  return out.slice(0, 300)
}

export interface ConnOpts {
  connectTimeoutMs: number
  socketTimeoutMs: number
}

export async function openConnection(account: AccountRow, secret: string, opts: ConnOpts): Promise<ImapFlow> {
  // OAuth hesabında sır yenileme belirtecidir: bağlantı için geçerli erişim belirteci alınır
  let cred: Credential
  try {
    cred = await credentialFor(account, secret)
  } catch (e) {
    if (e && typeof e === 'object') (e as { phase?: string }).phase = 'token'
    throw e
  }
  let endpoint: Awaited<ReturnType<typeof mailEndpoint>>
  try {
    endpoint = await mailEndpoint(account.imap_host, account.imap_port)
  } catch (e) {
    if (e && typeof e === 'object') (e as { phase?: string }).phase = 'connect'
    throw e
  }
  const client = new ImapFlow({
    host: endpoint.host,
    ...(endpoint.servername ? { servername: endpoint.servername } : {}),
    port: account.imap_port,
    secure: account.imap_tls !== 'starttls',
    auth: cred.kind === 'oauth' ? { user: account.email, accessToken: cred.accessToken } : { user: account.email, pass: cred.password },
    logger: false,
    connectionTimeout: opts.connectTimeoutMs,
    socketTimeout: opts.socketTimeoutMs,
    greetingTimeout: opts.connectTimeoutMs,
    tls: { rejectUnauthorized: !account.allow_invalid_certs }
  })
  // 'error' dinleyicisi yoksa process çöker; kapatma yolu zaten hataları ele alıyor
  client.on('error', () => {})
  try {
    await client.connect()
  } catch (e) {
    // login tamamlanmadan düştü: governor ban imzasını buradan ayırt eder
    if (e && typeof e === 'object') (e as { phase?: string }).phase = 'connect'
    try {
      client.close()
    } catch {
      /* umursanmaz */
    }
    throw e
  }
  return client
}
