// Dışarıdan gelen yapılandırmanın DB'ye birleştirilmesi: cihaz senkronu (doSyncPull) ve yerelden sunucuya taşıma aynı kuralları kullanır.
import type { Queries } from './db/queries'
import type { RuleAction, RuleCondition } from '../shared/rpc'
import { actionsFromPortable, remotePasswordWins, type SyncAccount } from './deviceSync'
import type { Scheduler } from './scheduler'
import type { SieveManager } from './sieve/manager'
import { encryptAccountPassword } from './vault/manager'

/** Gruba bağlanmamış kuralın rengi: gruplar adla eşlenir, renk yalnız ilk oluşturmada */
const DEFAULT_GROUP_COLOR = '#8d7ba6'

export interface MergeDeps {
  q: Queries
  scheduler: Scheduler
  creds: Map<number, string>
  encrypt(values: string[]): Promise<Uint8Array[]>
  sieve?: SieveManager
}

export type MergedAccount = { skippedSecure: true } | { skippedSecure: false; id: number; isNew: boolean; passwordTaken: boolean }

/** `vault`: parola sunucunun kasa anahtarıyla saklanır, hesap kasa hesabı olur. Çağıran kasanın açık olduğunu denetler */
export async function mergeAccount(d: MergeDeps, sa: SyncAccount, o: { vault?: boolean } = {}): Promise<MergedAccount> {
  const { q, creds, scheduler, sieve } = d
  const existingId = q.getAccountIdByEmail(sa.email)
  if (existingId != null && q.getAccountRow(existingId)?.secure) return { skippedSecure: true } // yerel kasa hesabına dokunma (password_enc vault-anahtarlı, bozulmasın)
  const localRow = existingId != null ? q.getAccountRow(existingId) : undefined
  // eski şifre yeniyi ezmesin: uzak şifre yalnız kesin olarak daha yeniyse (ya da hesap yeniyse)
  const takePassword = remotePasswordWins(existingId == null, localRow?.password_changed_at ?? null, sa.passwordChangedAt)
  const password = takePassword
    ? { enc: o.vault ? encryptAccountPassword(sa.password) : Buffer.from((await d.encrypt([sa.password]))[0]), changedAt: sa.passwordChangedAt ?? 0 }
    : null
  const groupId = sa.groupName ? q.ensureGroupByName(sa.groupName, DEFAULT_GROUP_COLOR) : null
  // adres başka cihazdan da değişebilir: önce eski sunucudaki betikler geri alınır, olmazsa yerel adres kalır
  let imapHost = sa.imapHost
  if (existingId != null && localRow && localRow.imap_host !== imapHost) {
    await sieve?.prepareHostChange(existingId).catch((e: unknown) => {
      console.warn('sync: Sieve geri alınamadı, IMAP adresi korunuyor', (e as Error).message)
      imapHost = localRow.imap_host
    })
  }
  const { id, isNew } = q.tx(() => {
    const r = q.upsertSyncAccount({
      email: sa.email, displayName: sa.displayName, imapHost, imapPort: sa.imapPort, imapTls: sa.imapTls,
      smtpHost: sa.smtpHost, smtpPort: sa.smtpPort, smtpTls: sa.smtpTls, color: sa.color, signature: sa.signature,
      allowInvalidCerts: sa.allowInvalidCerts, groupId, password, authType: sa.authType
    })
    if (o.vault) q.setAccountSecureFlag(r.id, true) // parola ile bayrak birlikte: yarım kalırsa kasa blob'u düz parola sanılmaz
    return r
  })
  if (localRow && localRow.imap_host !== imapHost) sieve?.onAccountHostChanged(id)
  if (password) {
    const changed = creds.get(id) !== sa.password
    creds.set(id, sa.password)
    // başka cihazda gerçekten yenilenmiş şifre: auth durdurmasını kaldır, oturumu yeni şifreyle kur
    if (!isNew && changed) {
      scheduler.retryAccount(id)
      sieve?.onCredentialsChanged(id)
    }
  }
  return { skippedSecure: false, id, isNew, passwordTaken: !!password }
}

/** Kural eylemleri yerel id'ye çevrilmiş olarak yazılır (id cihazlar arası farklı, R36) */
export function mergeRule(q: Queries, r: { name: string; enabled: boolean; accountEmail: string | null; groupName: string | null; conditions: RuleCondition; actions: RuleAction[]; runOnServer?: boolean }, webhookIds: Map<string, number>): void {
  const accountId = r.accountEmail ? (q.getAccountIdByEmail(r.accountEmail) ?? null) : null
  const groupId = r.groupName ? q.ensureGroupByName(r.groupName, DEFAULT_GROUP_COLOR) : null
  q.upsertSyncRuleByName({ name: r.name, enabled: r.enabled, accountId, groupId, conditions: r.conditions, actions: actionsFromPortable(r.actions, webhookIds), runOnServer: r.runOnServer })
}
