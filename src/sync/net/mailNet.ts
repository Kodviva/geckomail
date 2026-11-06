// Sunucu kipinde IMAP/SMTP uç noktası bağlantı anında süzülür: hesap adresi iç hizmetleri yoklamanın yolu olmasın.
// Masaüstünde kullanıcının kendi ağı serbesttir; ilke yalnız sunucu motoru açılırken kurulur.
import { lookup } from 'dns/promises'
import { isIP } from 'net'
import { t } from '../../shared/i18n'
import { isBlockedAddress } from './safeFetch'

let privateHosts: ReadonlySet<string> | null = null

/** null: serbest (masaüstü). Küme: genel internet + listedeki `ad` ya da `ad:port` (GECKO_MAIL_PRIVATE_HOSTS) */
export function setMailNetPolicy(allowed: ReadonlySet<string> | null): void {
  privateHosts = allowed
}

export interface MailEndpoint {
  host: string
  /** TLS adı: bağlantı çözülen adrese kilitlenince sertifika yine alan adıyla doğrulanır */
  servername?: string
}

/** Bağlanılacak adres. Çözümle bağlantı arasında DNS değişemesin diye denetlenen adrese kilitlenir */
export async function mailEndpoint(host: string, port: number): Promise<MailEndpoint> {
  const name = host.toLowerCase()
  if (!privateHosts || privateHosts.has(name) || privateHosts.has(`${name}:${port}`)) return { host }
  const blocked = (): Error => new Error(t('sync.net.blockedInternal', { host }))
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw blocked()
    return { host }
  }
  const list = await lookup(host, { all: true })
  if (!list.length || list.some((a) => isBlockedAddress(a.address))) throw blocked()
  const pick = list.find((a) => a.family === 4) ?? list[0]
  return { host: pick.address, servername: host }
}
