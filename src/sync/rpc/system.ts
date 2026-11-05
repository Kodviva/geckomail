// RPC — Sistem: tercihler, yedek, kasa, cihaz senkronu. Yetki kapısı (giriş / yönetici) RpcSession.handle'da; hesap düzeyi kontroller burada.
import { readFileSync, writeFileSync, rmSync, copyFileSync, statSync } from 'fs'
import { join, isAbsolute } from 'path'
import {
  clearBiometric, createVault, encryptAccountPassword, getBiometricBlob, getVaultStatus, isBiometricEnabled,
  setBiometricBlob, unlockVault, unlockVaultAsync, verifyVaultPassphraseAsync
} from '../vault/manager'
import { checkVaultPassphrase, clearVaultPassphraseFails } from '../vault/throttle'
import { parseVipList } from '../notifyPolicy'
import Database from 'better-sqlite3'
import { MIGRATIONS } from '../db'
import { openBackup, sealBackup } from '../backupFile'
import type { RpcSession } from '../rpcSession'
import { emitPimChanged } from './pimAuth'
import { type Handler, READABLE_PREFS, USER_PREF_KEYS, WRITABLE_PREFS } from './common'
import { AUTOMATION_HOLD_PREF } from '../../shared/importTypes'
import { isLocale, t } from '../../shared/i18n'

function checkPref(k: string, v: unknown): void {
  if (!WRITABLE_PREFS.has(k)) throw new Error(t('sync.pref.notWritable', { key: k }))
  if (typeof v !== 'string' || v.length > (k === 'notifyVip' ? 8000 : 64)) throw new Error(t('sync.pref.invalidValue', { key: k }))
  if ((k === 'require2fa' || k === AUTOMATION_HOLD_PREF) && v !== '0' && v !== '1') throw new Error(t('sync.pref.invalidValue', { key: k }))
  if (k === 'smimeRevocation' && v !== 'crl' && v !== 'off') throw new Error(t('sync.pref.invalidValue', { key: k }))
}

export const systemHandlers: Record<string, Handler> = {
  async getPrefs(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    const all = q.getAllPrefs()
    const out = Object.fromEntries(Object.entries(all).filter(([k]) => READABLE_PREFS.has(k) && !USER_PREF_KEYS.has(k)))
    // kişisel anahtarlar oturumun kullanıcısından; hiç yazmamışsa genel değer (göç öncesi varsayılan)
    for (const k of USER_PREF_KEYS) {
      const v = q.userPrefGet(s.currentUser!.id, k) ?? all[k]
      if (v != null) out[k] = v
    }
    return out
  },

  async setPrefs(s: RpcSession, params: unknown) {
    const { q, scheduler } = s.deps
    const { values } = params as { values: Record<string, string> }
    // yalnız ayarlar ekranının anahtarları: iç durum (watermark, biyometrik/senkron blob'ları,
    // klasör önbelleği) renderer'dan ezilemez; kişisel bildirim tercihleri setMyPrefs'ten
    for (const [k, v] of Object.entries(values)) {
      if (USER_PREF_KEYS.has(k)) throw new Error(t('sync.pref.useMyPrefs'))
      checkPref(k, v)
    }
    for (const [k, v] of Object.entries(values)) q.prefSet(k, v)
    scheduler.applyPrefs()
    return null
  },

  async setMyPrefs(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const values = (params ?? {}) as Record<string, string>
    for (const [k, v] of Object.entries(values)) {
      if (!USER_PREF_KEYS.has(k)) throw new Error(t('sync.pref.notWritable', { key: k }))
      checkPref(k, v)
    }
    // VIP listesi normalize saklanır (geçersiz satırlar atılır, küçük harf, tekil)
    for (const [k, v] of Object.entries(values)) q.userPrefSet(s.currentUser!.id, k, k === 'notifyVip' ? parseVipList(v).join('\n') : v)
    return null
  },

  // web oturumunun dili; masaüstünde dil süreç genelidir (main → sync setLocale), burada dokunulmaz
  async setSessionLocale(s: RpcSession, params: unknown) {
    const { locale } = (params ?? {}) as { locale?: unknown }
    if (!isLocale(locale)) throw new Error(t('sync.pref.invalidValue', { key: 'locale' }))
    if (s.hub.mode === 'server') {
      s.locale = locale
      // bildirim hattı oturum yokken de kullanıcının dilinde yazar
      if (s.currentUser) s.deps.q.userPrefSet(s.currentUser.id, 'locale', locale)
    }
    return null
  },

  async backupToFile(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { path, passphrase } = params as { path: string; passphrase?: string }
    if (!isAbsolute(path) || !/\.(sqlite|geckobak)$/i.test(path)) throw new Error(t('sync.backup.invalidPath'))
    const tmpPath = join(s.deps.userData, `yedek-${Date.now()}.tmp`)
    try {
      await q.backupTo(tmpPath) // SQLite çevrimiçi yedek API'si: tutarlı anlık görüntü
      if (passphrase) writeFileSync(path, sealBackup(readFileSync(tmpPath), passphrase))
      else copyFileSync(tmpPath, path)
      return { bytes: statSync(path).size }
    } finally {
      rmSync(tmpPath, { force: true })
    }
  },

  async stageRestore(s: RpcSession, params: unknown) {
    const { path, passphrase } = params as { path: string; passphrase?: string }
    if (!isAbsolute(path)) throw new Error(t('sync.backup.invalidFilePath'))
    const plain = openBackup(readFileSync(path), passphrase)
    const staged = join(s.deps.userData, 'restore-pending.db')
    writeFileSync(staged, plain)
    // doğrula: gerçek bir GeckoMail veritabanı mı, bu sürüm açabilir mi
    // ("daha yeni sürüm" hatası metinle değil akışla ayrılır: ileti arayüz dilinde)
    let info: { accounts: number; schemaVersion: number }
    try {
      const probe = new Database(staged, { readonly: true })
      const schemaVersion = probe.pragma('user_version', { simple: true }) as number
      const accounts = (probe.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n
      probe.close()
      info = { accounts, schemaVersion }
    } catch {
      rmSync(staged, { force: true })
      throw new Error(t('sync.backup.unreadable'))
    }
    if (info.schemaVersion > MIGRATIONS.length) {
      rmSync(staged, { force: true })
      throw new Error(t('sync.backup.tooNew', { schema: String(info.schemaVersion) }))
    }
    return info
  },

  async getVaultState(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    return { state: getVaultStatus(q), biometricEnabled: isBiometricEnabled(q) }
  },

  async enableVaultBiometric(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { passphrase } = params as { passphrase: string }
    if (!(await checkVaultPassphrase(q, s.currentUser!, s.hub.now(), () => verifyVaultPassphraseAsync(q, passphrase)))) throw new Error(t('sync.vault.wrongPassphrase'))
    const [blob] = await s.deps.encrypt([passphrase])
    setBiometricBlob(q, Buffer.from(blob).toString('base64'))
    return { ok: true }
  },

  async disableVaultBiometric(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    clearBiometric(q)
    return null
  },

  async unlockVaultBiometric(s: RpcSession, _params: unknown) {
    const { q, scheduler } = s.deps
    // Touch ID challenge'ı renderer main süreçte yapar; buraya yalnızca başarıdan sonra gelinir.
    const blobB64 = getBiometricBlob(q)
    if (!blobB64) throw new Error(t('sync.vault.touchIdNotSetUp'))
    const [pass] = await s.deps.decrypt([new Uint8Array(Buffer.from(blobB64, 'base64'))])
    const ok = pass ? unlockVault(q, s.deps.creds, pass) : false
    if (ok) {
      scheduler.reloadAccounts()
      for (const id of q.getSecureAccountIds()) scheduler.pollSoon(id, 0)
      s.deps.sieve?.schedulePending()
    }
    const state = getVaultStatus(q)
    if (ok) s.broadcast('vault:state', { state })
    return { ok, state }
  },

  async createVault(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { password } = params as { password: string }
    createVault(q, password)
    const state = getVaultStatus(q)
    s.broadcast('vault:state', { state })
    return { state }
  },

  async unlockVault(s: RpcSession, params: unknown) {
    const { q, scheduler } = s.deps
    const { password } = params as { password: string }
    const ok = await checkVaultPassphrase(q, s.currentUser!, s.hub.now(), () => unlockVaultAsync(q, s.deps.creds, password))
    if (ok) {
      scheduler.reloadAccounts()
      for (const id of q.getSecureAccountIds()) scheduler.pollSoon(id, 0)
      s.deps.sieve?.schedulePending()
    }
    const state = getVaultStatus(q)
    if (ok) s.broadcast('vault:state', { state })
    return { ok, state }
  },

  async clearVaultPassphraseFails(s: RpcSession, _params: unknown) {
    clearVaultPassphraseFails(s.deps.q, s.currentUser!, s.hub.now())
    return { ok: true }
  },

  async lockVault(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    s.lockVaultNow()
    const state = getVaultStatus(q)
    s.broadcast('vault:state', { state })
    return { state }
  },

  async setAccountSecure(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { accountId, secure } = params as { accountId: number; secure: boolean }
    s.assertCanManage(accountId)
    if (getVaultStatus(q) !== 'unlocked') throw new Error(t('sync.vault.unlockFirst'))
    const plain = s.deps.creds.get(accountId)
    if (!plain) throw new Error(t('sync.vault.passwordNotInMemory'))
    if (secure) {
      // canlı→kasa: tüm sync mutasyonlar await'siz ardışık (araya poll giremez → atomik)
      q.updateAccountFields(accountId, { password_enc: encryptAccountPassword(plain) })
      q.convertAccountToSecure(accountId)
      q.setAccountSecureFlag(accountId, true)
      // kasa hesabında kişi ve takvim yok: yerel kopya silinir, sunucudaki veri durur
      const pim = q.getPimSourceByAccount(accountId)
      if (pim) {
        q.deletePimSource(pim.id)
        emitPimChanged(s.hub, pim, 'sources')
      }
    } else {
      // kasa→canlı: safeStorage şifreleme async → önce onu al, sonra sync mutasyonlar
      const [enc] = await s.deps.encrypt([plain])
      q.updateAccountFields(accountId, { password_enc: Buffer.from(enc) })
      q.convertAccountToLive(accountId)
      q.setAccountSecureFlag(accountId, false)
    }
    s.broadcast('messages:changed', { accountId: null })
    return null
  },

  async syncPush(s: RpcSession, params: unknown) {
    const { anchorAccountId, passphrase } = params as { anchorAccountId: number; passphrase: string }
    if (passphrase.length < 8) throw new Error(t('sync.deviceSync.passphraseTooShort'))
    return s.doSyncPush(anchorAccountId, passphrase)
  },

  async syncPull(s: RpcSession, params: unknown) {
    const { anchorAccountId, passphrase } = params as { anchorAccountId: number; passphrase: string }
    return s.doSyncPull(anchorAccountId, passphrase)
  },

  async setSyncAuto(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { enabled, anchorAccountId, passphrase } = params as { enabled: boolean; anchorAccountId: number; passphrase: string }
    if (enabled) {
      if (passphrase.length < 8) throw new Error(t('sync.deviceSync.passphraseTooShort'))
      const [blob] = await s.deps.encrypt([passphrase])
      q.prefSet('sync_passphrase_blob', Buffer.from(blob).toString('base64'))
      q.prefSet('sync_anchor_account', String(anchorAccountId))
      q.prefSet('sync_auto', '1')
    } else {
      q.prefSet('sync_auto', '0')
      q.prefSet('sync_passphrase_blob', '')
    }
    return null
  }
}
