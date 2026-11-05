import type { ImapFlow } from 'imapflow'
import type { RuleAction, RuleCondition, SyncTemplate } from '../shared/rpc'
import { streamToBuffer } from './bodyFetch'
import { decrypt, deriveKey, encrypt, newSalt } from './vault/crypto'
import { t } from '../shared/i18n'

// Cihazlar arası senkron blob'u — saf serileştirme + şifreleme. IMAP/DB IO yok (o kısım rpcServer'da).
// Kimlikler cihazlar arası değiştiğinden hesap/grup email ve isimle eşlenir, id ile değil.

export interface SyncAccount {
  email: string
  displayName: string | null
  imapHost: string
  imapPort: number
  imapTls: string
  smtpHost: string
  smtpPort: number
  smtpTls: string
  color: string
  signature: string | null
  allowInvalidCerts: boolean
  groupName: string | null
  password: string // düz — blob'un tamamı senkron parolasıyla şifreli
  /** şifrenin o cihazda son değiştiği an; eski sürüm blob'larında yok */
  passwordChangedAt?: number
  /** 'password' | 'oauth:google' | 'oauth:microsoft' — OAuth'ta password yenileme belirtecidir */
  authType?: string
}

/**
 * Uzak (senkron blob'undaki) şifre yerel şifrenin yerine geçsin mi?
 * Eski şifre yeniyi ezerse hesap yanlış şifreyle login dener → sunucu auto-ban (29 Eyl).
 * - yeni hesap: her zaman (yerelde şifre yok)
 * - damgasız (eski sürüm) blob: asla — hangisinin yeni olduğu bilinemez
 * - aksi: yalnız uzak kesin olarak daha yeniyse
 */
export function remotePasswordWins(isNewLocally: boolean, localChangedAt: number | null, remoteChangedAt: number | undefined): boolean {
  if (isNewLocally) return true
  if (!remoteChangedAt) return false
  return remoteChangedAt > (localChangedAt ?? 0)
}

export interface SyncGroup {
  name: string
  color: string
}

export interface SyncRule {
  name: string
  enabled: boolean
  accountEmail: string | null
  groupName: string | null
  conditions: RuleCondition
  actions: RuleAction[]
  /** eski paketlerde yok: yerel değer korunur */
  runOnServer?: boolean
}

export interface SyncWebhook {
  name: string
  url: string
  secret: string | null
  enabled: boolean
}

export interface SyncConfig {
  version: number
  exportedAt: number
  accounts: SyncAccount[]
  groups: SyncGroup[]
  rules: SyncRule[]
  /** eski sürüm blob'larında yok */
  webhooks?: SyncWebhook[]
  /** silinen kuralların mezar taşları: diğer cihaz da siler, eski kopya geri gelmez */
  deletedRules?: { name: string; ts: number }[]
  /** R28: şablonlar (mezar taşlarıyla, ad başına son yazan kazanır) */
  templates?: SyncTemplate[]
}

// Kural eylemleri webhook'u yerel sayısal id ile tutar; id cihazlar arası farklıdır (R36).
// Dışa aktarırken ada, içe alırken yerel id'ye çevrilir. Bulunamayan webhook eylemi düşürülür
// (yanlış webhook'a veri göndermektense hiç göndermemek).
export function actionsToPortable(actions: RuleAction[], idToName: Map<number, string>): RuleAction[] {
  return actions.flatMap((a) => {
    if (a.type !== 'webhook') return [a]
    const name = idToName.get(a.webhookId)
    return name ? [{ ...a, webhookName: name } as RuleAction] : []
  })
}

export function actionsFromPortable(actions: RuleAction[], nameToId: Map<string, number>): RuleAction[] {
  return actions.flatMap((a) => {
    if (a.type !== 'webhook') return [a]
    const name = (a as { webhookName?: string }).webhookName
    const id = name ? nameToId.get(name) : undefined
    if (id == null) return []
    const { webhookName: _n, ...rest } = a as RuleAction & { webhookName?: string }
    return [{ ...rest, webhookId: id } as RuleAction]
  })
}

export const SYNC_VERSION = 1

// blob = salt(16) || AES-GCM(nonce||ct||tag).  Salt önekli ki her cihaz kendi parolasından anahtarı türetebilsin.
export function encodeSyncBlob(config: SyncConfig, passphrase: string): Buffer {
  const salt = newSalt()
  const key = deriveKey(passphrase, salt)
  const body = encrypt(key, Buffer.from(JSON.stringify(config), 'utf-8'))
  return Buffer.concat([salt, body])
}

export function decodeSyncBlob(blob: Buffer, passphrase: string): SyncConfig {
  if (blob.length < 16 + 12 + 16) throw new Error(t('sync.deviceSync.corrupt'))
  const salt = blob.subarray(0, 16)
  const body = blob.subarray(16)
  const key = deriveKey(passphrase, salt)
  const json = decrypt(key, body).toString('utf-8') // yanlış parola → GCM auth hatası
  const parsed = JSON.parse(json) as SyncConfig
  if (!parsed || typeof parsed.version !== 'number' || !Array.isArray(parsed.accounts)) {
    throw new Error(t('sync.deviceSync.unrecognized'))
  }
  return parsed
}

// ---- IMAP taşıma (çapa hesabın özel klasörü) ----
const SYNC_FOLDER = 'GeckoMail-Sync'
const SYNC_SUBJECT = 'GeckoMail-Sync-v1'

// blob'u base64 gövdeli minimal RFC822 mesaj olarak append et; en yeni hariç eskileri sil.
export async function pushBlobToImap(client: ImapFlow, blob: Buffer): Promise<void> {
  try {
    await client.mailboxCreate(SYNC_FOLDER)
  } catch {
    /* klasör zaten var */
  }
  const msg = [
    `Subject: ${SYNC_SUBJECT}`,
    'From: geckomail-sync@localhost',
    'To: geckomail-sync@localhost',
    `Date: ${new Date().toUTCString()}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    blob.toString('base64')
  ].join('\r\n')
  await client.append(SYNC_FOLDER, Buffer.from(msg, 'utf-8'), ['\\Seen'])
  const lock = await client.getMailboxLock(SYNC_FOLDER)
  try {
    const uids: number[] = []
    for await (const m of client.fetch('1:*', { uid: true })) uids.push(m.uid)
    uids.sort((a, b) => a - b)
    const stale = uids.slice(0, -1) // en büyük uid (en yeni append) kalır
    if (stale.length) await client.messageDelete(stale, { uid: true })
  } finally {
    lock.release()
  }
}

// en yüksek uid'li blob mesajını oku, gövdeyi base64-decode et. Klasör/mesaj yoksa null.
export async function pullBlobFromImap(client: ImapFlow): Promise<Buffer | null> {
  let lock
  try {
    lock = await client.getMailboxLock(SYNC_FOLDER)
  } catch {
    return null // senkron klasörü henüz yok
  }
  try {
    let maxUid = 0
    for await (const m of client.fetch('1:*', { uid: true })) if (m.uid > maxUid) maxUid = m.uid
    if (!maxUid) return null
    const dl = await client.download(String(maxUid), undefined, { uid: true })
    if (!dl?.content) return null
    const raw = await streamToBuffer(dl.content)
    const text = raw.toString('utf-8')
    const idx = text.indexOf('\r\n\r\n') // başlık/gövde ayracı sonrası base64 gövde
    const body = idx >= 0 ? text.slice(idx + 4) : text
    return Buffer.from(body.replace(/\s+/g, ''), 'base64')
  } finally {
    lock.release()
  }
}
