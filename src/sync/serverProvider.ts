// Mail sunucusu yönetim sağlayıcıları. Uygulama herhangi bir IMAP sunucusuyla çalışır; yönetim
// (IP engelleri, izinler, hesap uyumu) ise sunucunun yönetim API'sine bağlıdır. Tür, verilen adres +
// anahtarla otomatik algılanır. Şimdilik Stalwart (JMAP yönetimi); yeni sağlayıcı bu arayüzü uygular.
import type { ServerAllowedIp, ServerBlockedIp } from '../shared/rpc'
import { StalwartAdmin } from './stalwartAdmin'
import { t } from '../shared/i18n'

export type ProviderId = 'stalwart'

export interface ServerProvider {
  readonly id: ProviderId
  readonly name: string
  session(): Promise<{ username: string }>
  principalCount(): Promise<number>
  individualEmails(): Promise<string[]>
  blocked(opts: { address?: string; position?: number; limit?: number }): Promise<{ total: number; items: ServerBlockedIp[] }>
  allowed(): Promise<ServerAllowedIp[]>
  unblock(ids: string[]): Promise<number>
  allow(address: string, reason: string, expiresAt: string | null): Promise<void>
  removeAllowed(ids: string[]): Promise<number>
}

export const PROVIDER_NAMES: Record<ProviderId, string> = { stalwart: 'Stalwart' }

export function providerFor(id: ProviderId, baseUrl: string, key: string, fetchImpl?: typeof fetch): ServerProvider {
  switch (id) {
    case 'stalwart':
      return new StalwartAdmin(baseUrl, key, fetchImpl)
  }
}

/** Adres + anahtarla hangi sağlayıcı konuşuyor? Hiçbiri değilse anlaşılır hata. */
export async function detectProvider(baseUrl: string, key: string, fetchImpl?: typeof fetch): Promise<ServerProvider> {
  const errors: string[] = []
  for (const id of Object.keys(PROVIDER_NAMES) as ProviderId[]) {
    const p = providerFor(id, baseUrl, key, fetchImpl)
    try {
      await p.session()
      return p
    } catch (e) {
      errors.push(`${PROVIDER_NAMES[id]}: ${(e as Error).message}`)
    }
  }
  throw new Error(t('sync.server.noProvider', { supported: Object.values(PROVIDER_NAMES).join(', '), errors: errors.join(' · ') }))
}

/** Hesaplardaki en yaygın IMAP sunucusundan yönetim adresi önerisi (kullanıcı değiştirebilir) */
export function suggestAdminUrl(imapHosts: string[]): string | null {
  const counts = new Map<string, number>()
  for (const h of imapHosts) {
    const host = h.trim().toLowerCase()
    if (host) counts.set(host, (counts.get(host) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  return top ? `https://${top[0]}` : null
}
