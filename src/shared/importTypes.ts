// Yerelden sunucuya taşımanın ortak türleri: motor, ana süreç ve arayüz kullanır. Sır taşımaz; `Sealed` yalnız motor, ana süreç ve sunucu arasında gezer.
export type ImportKind = 'group' | 'webhook' | 'account' | 'rule' | 'trigger' | 'template' | 'pref' | 'userPref' | 'notifyRule' | 'notifyAccountPref' | 'signature'
/** Yerelde bilinen engel */
export type BlockReason = 'vaultLocked' | 'oauthReconnect' | 'noPassword' | 'unmappedAccount' | 'duplicateName'
/** Sunucunun verdiği engel */
export type ImportBlock = 'vaultRequired' | 'vaultConflict' | 'oauthReconnect' | 'unmappedAccount' | 'invalid' | 'groupConflict' | 'webhookConflict'
/** Öge taşındı ama kapsamı daraltıldı: `scopeDisabled` kapalı geldi, `groupDropped` grupsuz geldi. `sieveLeft` yerel planda yazılır:
 *  posta sunucusundaki betik yerinde kalır, sunucuda Sieve kapalı olduğundan istemci yarısı çalışmaz */
export type ImportNotice = 'scopeDisabled' | 'groupDropped' | 'sieveLeft'

export interface PlanItem {
  key: string
  kind: ImportKind
  label: string
  blocked: BlockReason | ImportBlock | null
  notice?: ImportNotice
}

/** Tek öge için mühürlü zarf: `key` şifresiz ama AAD ile bağlı */
export interface Sealed {
  key: string
  pub: string
  iv: string
  ct: string
}

export interface SealRequest {
  importId: string
  serverKey: string
  keys: string[]
}

/** Yerelde kalan, taşınmayan işler */
export interface ImportStaying {
  scheduled: number
  pending: number
}

export type MigrationFailure = 'connection' | 'notAdmin' | 'localSession'

export interface MigrationEvent {
  phase: 'plan' | 'sending' | 'done' | 'paused'
  done: number
  total: number
  blocked: PlanItem[]
  failed: { key: string; label: string }[]
  notices?: { key: string; label: string; notice: ImportNotice }[]
  reason?: MigrationFailure
  staying?: ImportStaying
  origin?: string
}

/** Motordaki otomasyon kapısı. Kural ya da tetikleyici her mühürlendiğinde yazılır, Ayarlar'dan açılır */
export const AUTOMATION_HOLD_PREF = 'automation_paused_after_import'
