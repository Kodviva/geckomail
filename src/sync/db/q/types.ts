// Sorgu katmanının satır türleri ve dönüştürücüleri.
import type { AccountStatus, FolderKind, MessageRow, ScheduleType, TriggerActionType, UserRole } from '../../../shared/rpc'
import type { SmimeKind } from '../../../shared/smime'
import { isOneClickUnsubscribe } from '../../../shared/unsubscribe'
import { decryptText } from '../../vault/crypto'
import { getVaultKey } from '../../vault/state'

export interface AccountRow {
  id: number
  email: string
  display_name: string | null
  imap_host: string
  imap_port: number
  imap_tls: string
  smtp_host: string
  smtp_port: number
  smtp_tls: string
  password_enc: Buffer
  color: string
  starred: number
  enabled: number
  allow_invalid_certs: number
  status: AccountStatus
  status_detail: string | null
  status_since: number | null
  last_success_at: number | null
  signature: string | null
  group_id: number | null
  secure: number
  password_changed_at: number
  /** 'password' | 'oauth:google' | 'oauth:microsoft' */
  auth_type: string
}

export interface UserRow {
  id: number
  username: string
  password_hash: string
  role: UserRole
  enabled: number
  created_at: number
  last_login_at: number | null
  totp_secret_enc: Buffer | null // host.encrypt ile; yanıtlara asla konmaz
  totp_enabled: number
  totp_last_step: number | null
}

export interface GroupRow {
  id: number
  name: string
  color: string
  created_at: number
}
export interface SyncExportAccount {
  id: number
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
  allowInvalidCerts: number
  groupName: string | null
  secure: number
  passwordChangedAt: number
  authType: string
}
export interface SyncExportRule {
  name: string
  enabled: number
  accountEmail: string | null
  groupName: string | null
  conditions_json: string
  actions_json: string
  /** eski paketlerde yok */
  run_on_server?: number
}

export interface RuleRow {
  id: number
  name: string
  enabled: number
  account_id: number | null
  group_id: number | null
  conditions_json: string
  actions_json: string
  created_at: number
  last_triggered_at: number | null
  trigger_count: number
  run_on_server: number
}

export interface WebhookRow {
  id: number
  name: string
  url: string
  secret: string | null
  enabled: number
  created_at: number
  last_delivered_at: number | null
  last_error: string | null
}

export interface ScheduledTriggerRow {
  id: number
  name: string
  enabled: number
  schedule_type: ScheduleType
  schedule_value: string
  action_type: TriggerActionType
  action_payload_json: string
  next_run_at: number
  last_run_at: number | null
  created_at: number
}

export interface RuleLogRow {
  id: number
  ts: number
  kind: 'rule' | 'webhook' | 'trigger' | 'vault'
  ref_id: number | null
  account_id: number | null
  message_id: number | null
  summary: string
  ok: number
  error: string | null
}

export interface FolderRow {
  id: number
  account_id: number
  path: string
  kind: FolderKind
  uidvalidity: number | null
  last_seen_uidnext: number | null
  highest_modseq: number | null
  backfill_low_uid: number | null
  last_deep_flag_sync_at: number | null
  last_seen_exists: number | null
}

export interface HeaderInput {
  folderId: number
  accountId: number
  folderKind: FolderKind
  uid: number
  messageId: string | null
  inReplyTo: string | null
  subject: string | null
  fromName: string | null
  fromAddr: string | null
  toJson: string | null
  date: number
  size: number | null
  seen: boolean
  flagged: boolean
  answered: boolean
  hasAttachments: boolean
  listUnsubscribe: string | null
  listUnsubscribePost: string | null
  /** yalnız yerleşik klasörde gerçekten yeni gelen mail (ilk senkron/backfill değil) — kurallar bunu görür */
  rulesEligible?: boolean
  /** X-GeckoMail-Forwarded başlığı: bizim otomatik ilettiğimiz mail */
  autoForwarded?: boolean
  /** yalnız kök yapıdan: gövde indirilmeden bilinir */
  smimeKind?: SmimeKind | null
}

export interface SmimeIdentityRow {
  id: number
  user_id: number
  email: string
  fingerprint: string
  cert_der: Buffer
  /** base64 DER JSON dizisi */
  chain_der: string
  /** encrypt(vaultKey, pkcs8) base64 */
  key_enc: string
  not_before: number
  not_after: number
  can_sign: number
  can_encrypt: number
  created_at: number
}

export interface SmimeContactCertRow {
  id: number
  user_id: number
  email: string
  fingerprint: string
  cert_der: Buffer
  chain_der: string
  not_after: number
  capabilities: string | null
  source: 'auto' | 'manual'
  first_seen_at: number
  last_seen_at: number
}

export interface SmimeAnchorRow {
  fingerprint: string
  cert_der: Buffer
  label: string
  added_by: number | null
  created_at: number
}

export interface SmimeCrlRow {
  url: string
  der: Buffer | null
  this_update: number | null
  next_update: number | null
  fetched_at: number | null
  last_error_at: number | null
}

/** Kuyruğa girerken satırı gizleyen işlemler: iptal ve kalıcı hata satırı geri gösterir */
export const OPTIMISTIC_HIDE_OPS: ReadonlySet<string> = new Set(['trash', 'move', 'move_special', 'move_named'])

export interface OpRow {
  id: number
  account_id: number
  kind: string
  payload_json: string
  attempts: number
}

// eş kroma/parlaklıkta, kürasyonlu bir aile — hiçbiri marka aksanıyla ya da birbiriyle yarışmasın diye
const ACCOUNT_COLORS = ['#b6924f', '#8d7ba6', '#5f8f93', '#ab7561', '#6f85a1', '#96896b', '#85995f', '#a17a9a']

export function colorFor(email: string): string {
  let h = 0
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0
  return ACCOUNT_COLORS[h % ACCOUNT_COLORS.length]
}

export function rowToMessage(r: Record<string, unknown>): MessageRow {
  // enc=1 → kasa hesabı: içerik kolonları ciphertext. Anahtar varsa çöz, yoksa (kilitli) locked=true + içerik null.
  const enc = r.enc === 1
  const key = enc ? getVaultKey() : null
  const locked = enc && !key
  const dec = (v: unknown): string | null => {
    const s = v as string | null
    if (s == null || !enc) return s
    if (!key) return null
    try {
      return decryptText(key, s)
    } catch {
      return null
    }
  }
  return {
    id: r.id as number,
    accountId: r.account_id as number,
    folderId: r.folder_id as number,
    uid: r.uid as number,
    messageId: r.message_id as string | null,
    subject: dec(r.subject),
    fromName: dec(r.from_name),
    fromAddr: dec(r.from_addr),
    toJson: dec(r.to_json),
    date: r.date as number,
    size: r.size as number | null,
    seen: !!r.seen,
    flagged: !!r.flagged,
    answered: !!r.answered,
    hasAttachments: !!r.has_attachments,
    autoForwarded: r.auto_forwarded === 1,
    preview: dec(r.preview),
    threadRoot: (r.thread_root as string | null) ?? null,
    canUnsubscribe: isOneClickUnsubscribe(r.list_unsubscribe as string | null, r.list_unsubscribe_post as string | null),
    locked,
    smimeKind: (r.smime_kind as SmimeKind | null | undefined) ?? null
  }
}
