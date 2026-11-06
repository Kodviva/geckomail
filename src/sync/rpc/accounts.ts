// RPC — Hesaplar: içe aktarma, ayarlar, durum, bağlantı, tanı. Yetki kapısı (giriş / yönetici) RpcSession.handle'da; hesap düzeyi kontroller burada.
import { rmSync } from 'fs'
import { join } from 'path'
import type { ImportPreviewRow } from '../../shared/rpc'
import { parseImport } from '../importers'
import { encryptAccountPassword, getVaultStatus } from '../vault/manager'
import { describeError } from '../imapClient'
import { readRecentLogLines } from '../logRead'
import { discover, fillDiscovered } from '../autodiscover'
import type { RpcSession } from '../rpcSession'
import { type Handler, READABLE_PREFS, removeAccountOutbox } from './common'
import { t } from '../../shared/i18n'

const SIEVE_ROLLBACK_MS = 10_000
// saklı parolanın ve giden postanın hangi sunucuya gideceğini belirleyen sütunlar
const CONNECTION_COLUMNS = ['imap_host', 'imap_port', 'imap_tls', 'smtp_host', 'smtp_port', 'smtp_tls', 'allow_invalid_certs'] as const
const TICKET_REFUSED_PATCH = ['imapHost', 'imapPort', 'imapTls', 'smtpHost', 'smtpPort', 'smtpTls', 'allowInvalidCerts', 'password'] as const

async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  await Promise.race([work.then(() => {}, () => {}), expired])
  clearTimeout(timer)
}

export const accountsHandlers: Record<string, Handler> = {
  async discoverMailServers(_s: RpcSession, params: unknown) {
    return discover(String((params as { email: string }).email ?? '').slice(0, 254))
  },

  async importPreview(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { kind, content } = params as { kind: 'mobileconfig' | 'csv'; content: string }
    const rows = await fillDiscovered(parseImport(kind, content))
    return rows.map((r) => ({
      email: r.email,
      imapHost: r.imapHost,
      imapPort: r.imapPort,
      smtpHost: r.smtpHost,
      smtpPort: r.smtpPort,
      hasPassword: !!r.password,
      exists: q.accountExists(r.email)
    })) satisfies ImportPreviewRow[]
  },

  async importAccounts(s: RpcSession, params: unknown) {
    const { q, scheduler, creds, encrypt } = s.deps
    const { kind, content } = params as { kind: 'mobileconfig' | 'csv'; content: string }
    const all = await fillDiscovered(parseImport(kind, content))
    const rows = all.filter((r) => r.password && r.imapHost)
    if (!rows.length) return { added: 0, updated: 0, skipped: all.length }
    const encrypted = await encrypt(rows.map((r) => r.password as string))
    let added = 0
    let updated = 0
    let skippedSecure = 0
    const passwordChanged: number[] = []
    q.tx(() => {
      rows.forEach((r, i) => {
        const existingId = q.getAccountIdByEmail(r.email)
        if (existingId != null) {
          // kasa hesabı: şifresi kasa anahtarıyla saklı — safeStorage ile ezmek hesabı bozar
          if (q.getAccountRow(existingId)?.secure) {
            skippedSecure++
            return
          }
          updated++
          // aynı şifre: damgayı ilerletme (eski dosya, başka cihazdaki yeni şifreyi senkronda yenmesin)
          if (creds.get(existingId) === r.password) return
          // farklı şifre (ya da Keychain anahtarı değişmiş, bellekte yok): tazele — kendini onarır
          q.updateAccountPassword(r.email, Buffer.from(encrypted[i]))
          creds.set(existingId, r.password as string)
          passwordChanged.push(existingId)
          return
        }
        const id = q.insertAccount({
          email: r.email,
          displayName: r.displayName,
          imapHost: r.imapHost,
          imapPort: r.imapPort,
          smtpHost: r.smtpHost,
          smtpPort: r.smtpPort,
          passwordEnc: Buffer.from(encrypted[i])
        })
        creds.set(id, r.password as string)
        added++
      })
    })
    scheduler.reloadAccounts()
    // şifresi yenilenen hesap: auth durdurmasını kaldır, eski oturumu at, yeni şifreyle dene
    for (const id of passwordChanged) {
      scheduler.retryAccount(id)
      s.deps.sieve?.onCredentialsChanged(id)
    }
    scheduler.pollAllSoon()
    s.broadcast('counts:changed', {})
    return { added, updated, skipped: all.length - rows.length + skippedSecure }
  },

  async getAccounts(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    // etkin imza kişiye göre (§10.1): `signature` hesabın varsayılanı kalır (hesap düzenleme onu yazar),
    // `mySignature` kullanıcının kendi imzası varsa o
    const mine = q.userSignatureMap(s.currentUser!.id)
    const all = q.getAccountInfos().map((a) => (mine.has(a.id) ? { ...a, mySignature: mine.get(a.id)! } : a))
    if (s.currentUser!.role === 'admin') return all
    const visible = new Set(s.resolveAccountIds(null)!)
    return all.filter((a) => visible.has(a.id))
  },

  async setMySignature(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { accountId, signature } = params as { accountId: number; signature: string | null }
    s.assertCanView(accountId)
    if (signature != null && (typeof signature !== 'string' || signature.length > 20_000)) throw new Error(t('sync.pref.invalidValue', { key: 'signature' }))
    q.setUserSignature(s.currentUser!.id, accountId, signature?.trim() ? signature : null)
    return null
  },

  async setAccountEnabled(s: RpcSession, params: unknown) {
    const { q, scheduler } = s.deps
    const { accountId, enabled } = params as { accountId: number; enabled: boolean }
    s.assertCanManage(accountId)
    q.setAccountEnabled(accountId, enabled)
    scheduler.setEnabled(accountId, enabled)
    s.broadcast('counts:changed', {})
    return null
  },

  async setAccountStarred(s: RpcSession, params: unknown) {
    const { q, scheduler } = s.deps
    const { accountId, starred } = params as { accountId: number; starred: boolean }
    s.assertCanManage(accountId)
    q.setAccountStarred(accountId, starred)
    scheduler.refreshHot() // yıldızlılar IDLE sıcak setine girer
    return null
  },

  async retryAccount(s: RpcSession, params: unknown) {
    const { scheduler } = s.deps
    const { accountId } = params as { accountId: number }
    s.assertCanManage(accountId)
    scheduler.retryAccount(accountId)
    return null
  },

  async updateAccount(s: RpcSession, params: unknown) {
    const { q, scheduler, creds, encrypt } = s.deps
    const { accountId, patch, abandonSieve } = params as {
      accountId: number
      patch: {
        displayName?: string | null
        color?: string
        signature?: string | null
        imapHost?: string
        imapPort?: number
        smtpHost?: string
        smtpPort?: number
        imapTls?: string
        smtpTls?: string
        allowInvalidCerts?: boolean
        password?: string
      }
      abandonSieve?: boolean
    }
    s.assertCanManage(accountId)
    // saklı parola başka sunucuya gidemesin: biletli soketten yalnız görünüm alanları değişir
    if (s.ticket && TICKET_REFUSED_PATCH.some((k) => patch[k] !== undefined)) throw new Error(t('sync.perm.browserRequired'))
    const row = q.getAccountRow(accountId)
    if (!row) throw new Error(t('sync.err.accountNotFound'))
    const host = (h: string | undefined, label: string) => {
      const v = (h ?? '').trim().toLowerCase()
      if (!/^[a-z0-9.-]+$/.test(v) || !v.includes('.')) throw new Error(t('sync.acct.invalidHost', { proto: label }))
      return v
    }
    const port = (n: number | undefined, label: string) => {
      if (!Number.isInteger(n) || n! < 1 || n! > 65535) throw new Error(t('sync.acct.invalidPort', { proto: label }))
      return n!
    }
    const tls = (v: string | undefined, label: string) => {
      if (v !== 'tls' && v !== 'starttls') throw new Error(t('sync.acct.invalidTls', { proto: label }))
      return v
    }
    const fields: Record<string, unknown> = {}
    if ('displayName' in patch) fields.display_name = patch.displayName
    if (patch.color) fields.color = patch.color
    if ('signature' in patch) fields.signature = patch.signature
    if (patch.imapHost !== undefined) fields.imap_host = host(patch.imapHost, 'IMAP')
    if (patch.imapPort !== undefined) fields.imap_port = port(patch.imapPort, 'IMAP')
    if (patch.imapTls !== undefined) fields.imap_tls = tls(patch.imapTls, 'IMAP')
    if (patch.smtpHost !== undefined) fields.smtp_host = host(patch.smtpHost, 'SMTP')
    if (patch.smtpPort !== undefined) fields.smtp_port = port(patch.smtpPort, 'SMTP')
    if (patch.smtpTls !== undefined) fields.smtp_tls = tls(patch.smtpTls, 'SMTP')
    if ('allowInvalidCerts' in patch) fields.allow_invalid_certs = patch.allowInvalidCerts ? 1 : 0
    // Bağlantı yalnız yönetici değiştirir. Üye değişmemiş değeri gönderebilir (form tümünü yollar). Yeni parolayla birlikte de
    // açılmaz: gönderilen postalar yeni sunucudan geçer. Parola tek başına üyeye açık kalır, sunucu taşınması yöneticinin işidir
    if (s.currentUser?.role !== 'admin' && CONNECTION_COLUMNS.some((k) => k in fields && fields[k] !== row[k])) throw new Error(t('sync.perm.adminRequired'))
    if (patch.password) {
      if (row.secure) {
        // kasa hesabı: şifre kasa anahtarıyla saklanır (safeStorage ile değil) — yoksa kasa
        // bir sonraki açılışta çözemez ve hesap bağlanamaz
        if (getVaultStatus(q) !== 'unlocked') throw new Error(t('sync.acct.unlockVaultToChangePassword'))
        fields.password_enc = encryptAccountPassword(patch.password)
      } else {
        const [enc] = await encrypt([patch.password])
        fields.password_enc = Buffer.from(enc)
      }
      fields.password_changed_at = Date.now() // cihazlar arası senkronda "hangisi yeni" kararı
      creds.set(accountId, patch.password)
    }
    const hostChanged = fields.imap_host !== undefined && fields.imap_host !== row.imap_host
    // eski parola ve eski adresle: yazıldıktan sonra eski sunucudaki betikler yetim kalır. Ulaşılamazsa değişiklik reddedilir
    // yalnız yönetici, eski sunucuya ulaşılamadığında betiğin orada kalmasını onaylayabilir
    const sieveLeft = hostChanged ? !!(await s.deps.sieve?.prepareHostChange(accountId, !!abandonSieve && s.currentUser?.role === 'admin')) : false
    q.updateAccountFields(accountId, fields)
    if (patch.password) q.clearPimNeedsReauth(accountId)
    // bağlantıyı etkileyen bir şey değiştiyse: auth durdurmasını kaldır, oturumu yeniden kur
    const connChanged = ['password_enc', 'imap_host', 'imap_port', 'imap_tls', 'allow_invalid_certs'].some((k) => k in fields)
    if (connChanged) scheduler.retryAccount(accountId)
    if (hostChanged) s.deps.sieve?.onAccountHostChanged(accountId)
    if (patch.password) s.deps.sieve?.onCredentialsChanged(accountId)
    s.broadcast('counts:changed', {})
    return sieveLeft ? { sieveLeft: true } : null
  },

  async updateAccountsServer(s: RpcSession, params: unknown) {
    const { accountIds, patch } = params as { accountIds: number[]; patch: Record<string, unknown> }
    // tek hesaplık yolla aynı doğrulama + yeniden deneme (her hesabın login'i governor'dan geçer)
    const allowed = ['imapHost', 'imapPort', 'imapTls', 'smtpHost', 'smtpPort', 'smtpTls', 'allowInvalidCerts']
    const clean = Object.fromEntries(Object.entries(patch).filter(([k, v]) => allowed.includes(k) && v !== undefined && v !== ''))
    if (!Object.keys(clean).length) throw new Error(t('sync.acct.noServerFields'))
    let updated = 0
    const failed: { accountId: number; error: string }[] = []
    for (const accountId of accountIds) {
      try {
        await s.handle('updateAccount', { accountId, patch: clean })
        updated++
      } catch (e) {
        failed.push({ accountId, error: describeError(e) })
      }
    }
    return { updated, failed }
  },

  async retryAccounts(s: RpcSession, params: unknown) {
    const { q, scheduler } = s.deps
    const { accountIds } = params as { accountIds: number[] }
    let retried = 0
    let skippedAuthFailed = 0
    for (const id of accountIds) {
      s.assertCanManage(id)
      // şifre hatalı hesabı yeniden denemek yalnız bir başarısız login daha üretir (sunucu banı)
      if (q.getAccountRow(id)?.status === 'auth_failed') {
        skippedAuthFailed++
        continue
      }
      scheduler.retryAccount(id)
      retried++
    }
    return { retried, skippedAuthFailed }
  },

  async getAccountStatusHistory(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { accountId } = params as { accountId: number }
    s.assertCanView(accountId)
    return q.accountStatusHistory(accountId, 20)
  },

  async getConnectionStats(s: RpcSession, _params: unknown) {
    const { scheduler } = s.deps
    // host adları ve sayılar; üye yalnız görebildiği hesapların başarısızlıklarını görür
    const stats = scheduler.getConnectionStats()
    const visible = s.resolveAccountIds(null)
    if (visible !== null) {
      const set = new Set(visible)
      stats.recentFailures = stats.recentFailures.filter((f) => f.accountId == null || set.has(f.accountId))
    }
    return stats
  },

  async exportDiagnostics(s: RpcSession, _params: unknown) {
    const { q, scheduler } = s.deps
    // Uzaktan destek / olay analizi için tek dosya. Şifre, blob, mail içeriği YOK; e-postaların
    // yerel kısmı maskeli (alan adı ve sunucu teşhis için gerekli).
    const mask = (email: string) => email.replace(/^(.)[^@]*(@.*)$/, '$1***$2')
    const logs = readRecentLogLines(join(s.deps.userData, 'logs'), 400)
    const diag = {
      generatedAt: new Date().toISOString(),
      app: { version: process.env.GECKO_APP_VERSION ?? null, electron: process.versions.electron ?? null, node: process.versions.node, platform: process.platform },
      schemaVersion: s.deps.dbSchemaVersion(),
      prefs: Object.fromEntries(Object.entries(q.getAllPrefs()).filter(([k]) => READABLE_PREFS.has(k))),
      accounts: q.getAccountRows().map((a) => ({
        id: a.id, email: mask(a.email), imap: `${a.imap_host}:${a.imap_port}/${a.imap_tls}`, smtp: `${a.smtp_host}:${a.smtp_port}/${a.smtp_tls}`,
        enabled: !!a.enabled, secure: !!a.secure, allowInvalidCerts: !!a.allow_invalid_certs, status: a.status,
        statusDetail: a.status_detail, statusSince: a.status_since, lastSuccessAt: a.last_success_at
      })),
      connection: (() => {
        const c = scheduler.getConnectionStats()
        return { ...c, recentFailures: c.recentFailures.map((f) => ({ ...f, email: f.email ? mask(f.email) : null })) }
      })(),
      logs
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    return { filename: `geckomail-tani-${stamp}.json`, data: new Uint8Array(Buffer.from(JSON.stringify(diag, null, 2))) }
  },

  async getAccountServer(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { accountId } = params as { accountId: number }
    s.assertCanManage(accountId)
    const row = q.getAccountRow(accountId)
    if (!row) throw new Error(t('sync.err.accountNotFound'))
    return {
      imapHost: row.imap_host,
      imapPort: row.imap_port,
      imapTls: row.imap_tls === 'starttls' ? 'starttls' : 'tls',
      smtpHost: row.smtp_host,
      smtpPort: row.smtp_port,
      smtpTls: row.smtp_tls === 'starttls' ? 'starttls' : 'tls',
      allowInvalidCerts: !!row.allow_invalid_certs
    }
  },

  async deleteAccount(s: RpcSession, params: unknown) {
    const { q, scheduler, creds, attachDir, sieve, opq } = s.deps
    const { accountId } = params as { accountId: number }
    s.assertCanManage(accountId)
    // K24: parola hâlâ elimizdeyken sunucudaki kurallar kaldırılır. En iyi çaba: silmeyi hiçbir hata engellemez
    const sieveRow = q.getSieveAccount(accountId)
    if (sieve && sieveRow && (sieveRow.enabled || sieveRow.script_hash !== null || sieveRow.wrapper_of !== null)) await settleWithin(sieve.rollback(accountId), SIEVE_ROLLBACK_MS)
    const outboxFiles = q.deleteAccount(accountId)
    opq.dropHeldSent(accountId)
    creds.delete(accountId)
    scheduler.removeAccount(accountId)
    // disktekiler: hesabın ek önbelleği ve bekleyen gönderimlerin giden-kutusu dosyaları
    rmSync(join(attachDir, String(accountId)), { recursive: true, force: true })
    for (const p of outboxFiles) rmSync(p, { force: true })
    removeAccountOutbox(join(attachDir, '..', 'outbox'), accountId)
    s.broadcast('messages:changed', { accountId: null })
    s.broadcast('counts:changed', {})
    return null
  }
}
