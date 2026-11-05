// RPC — Kişiler ve takvim kaynakları, koleksiyonlar ve kişisel koleksiyon tercihleri.
import type { PimCollectionInfo, PimCollectionType, PimConnectStatus, PimSourceInfo } from '../../shared/pim'
import { t } from '../../shared/i18n'
import { syncLog as log } from '../log'
import { providerOfAuthType } from '../oauth'
import { accountAuth, basicHeader } from '../pim/davBackend'
import { isAuthFailure } from '../pim/pimScheduler'
import { graphClientFor } from '../pim/graphBackend'
import type { GraphAuthError } from '../pim/graphClient'
import { discoverDav, discoverGoogle, type DiscoverResult } from '../pim/discovery'
import type { AccountRow, PimCollectionPrefRow, PimCollectionRow, PimSourceRow } from '../db/queries'
import type { RpcSession } from '../rpcSession'
import type { Handler } from './common'
import { assertAccountManage, assertCollectionRead, canReadSource, canWriteSource, emitPimChanged, ensureLocalSource, visibleSources } from './pimAuth'

const COLOR = /^#[0-9a-f]{6}$/i

export const supportsThisAndFuture = (src: PimSourceRow): boolean => src.kind === 'dav' || src.kind === 'local'

function sourceInfo(src: PimSourceRow, canManage: boolean): PimSourceInfo {
  return {
    id: src.id, kind: src.kind, accountId: src.account_id, personal: src.owner_user_id != null, label: src.label,
    status: src.status, lastError: src.last_error, lastSyncAt: src.last_sync_at, canManage
  }
}

function collectionInfo(c: PimCollectionRow, src: PimSourceRow, canWrite: boolean, pref: PimCollectionPrefRow | undefined, google: boolean): PimCollectionInfo {
  return {
    id: c.id, sourceId: c.source_id, type: c.type, name: c.name, color: pref?.color ?? c.color, readOnly: !!c.read_only, canWrite: canWrite && !c.read_only,
    hidden: !!pref?.hidden, reminders: pref ? !!pref.reminders : true, windowEnd: c.window_end,
    // Google CardDAV kişi gruplarını taşımaz
    supportsGroups: c.type === 'addressbook' && src.kind !== 'ics' && !google,
    supportsThisAndFuture: c.type === 'calendar' && supportsThisAndFuture(src)
  }
}

export const isGoogle = (s: RpcSession, src: PimSourceRow): boolean =>
  src.account_id != null && s.deps.q.getAccountRow(src.account_id)?.auth_type === 'oauth:google'


/** İlk eşitleme yanıtı bekletmez */
export function syncSoon(s: RpcSession, src: PimSourceRow): void {
  void s.hub.pim.syncNow(src.id).catch((e: Error) => log.warn('kişi ve takvim ilk eşitlemesi başarısız', { sourceId: src.id, error: e.message }))
}

/** Hesabın kaynak satırı; varsa durumu değişmez (eksik izinli yeni belirteç çalışan bağlantıyı düşürmez) */
export function ensureAccountSource(s: RpcSession, row: AccountRow, status: PimSourceRow['status'], grantedScopes: string | null): PimSourceRow {
  const q = s.deps.q
  q.insertAccountPimSource({ accountId: row.id, kind: row.auth_type === 'oauth:microsoft' ? 'graph' : 'dav', label: row.email, status, grantedScopes, now: s.hub.now() })
  return q.getPimSourceByAccount(row.id)!
}

/** Hesaba kaynak bağlar. Microsoft'ta onayın kanıtı Graph denemesidir: kaynak açılır, ilk eşitleme gösterir. Kimlik reddi ve
 *  Google'ın kapsamı tanımaması `needsConsent`; posta bağlantısı bundan etkilenmez. */
export async function connectAccountSource(s: RpcSession, row: AccountRow, grantedScopes: string | null, confirm: { host?: string; found?: string } = {}): Promise<PimConnectStatus> {
  const { q, creds } = s.deps
  const provider = providerOfAuthType(row.auth_type)
  const save = (found: Pick<DiscoverResult, 'caldavHome' | 'carddavHome' | 'serverSchedules'>, kind: 'dav' | 'graph'): PimSourceRow =>
    q.upsertAccountPimSource({
      accountId: row.id, kind, label: row.email, caldavUrl: found.caldavHome, carddavUrl: found.carddavHome, serverSchedules: found.serverSchedules,
      grantedScopes, now: s.hub.now()
    })
  const secret = creds.get(row.id)
  if (!secret) return 'noSecret'
  if (provider === 'microsoft') {
    // kapsamlar yalnız ilk kaynağı gösterir: onayın kanıtı /me denemesidir
    try {
      await graphClientFor(s.hub.pimDeps(), row.id).get('/v1.0/me')
    } catch (e) {
      if (!isAuthFailure(e)) log.warn('Graph bağlantısı denenemedi', { accountId: row.id, error: (e as Error).message })
      if ((e as GraphAuthError).status === 403) {
        const src = ensureAccountSource(s, row, 'needs_reauth', grantedScopes)
        q.markPimSourceNeedsReauth(src.id, (e as Error).message)
        emitPimChanged(s.hub, src, 'sources')
      }
      return 'needsConsent'
    }
    const src = save({ caldavHome: null, carddavHome: null, serverSchedules: false }, 'graph')
    emitPimChanged(s.hub, src, 'sources')
    syncSoon(s, src)
    return 'connected'
  }
  const net = s.hub.pimDeps().net({ ics: false })
  const auth = accountAuth(row, secret)
  let found: DiscoverResult
  try {
    found = provider === 'google'
      ? await discoverGoogle(row.email, auth, net)
      : await discoverDav({ email: row.email, hostHints: [row.imap_host], auth, basic: true, net, confirmedHost: confirm.host, ...s.hub.pimDiscoverOptions })
  } catch (e) {
    if (isAuthFailure(e)) {
      if (provider === 'google' || q.getPimSourceByAccount(row.id)) {
        const src = ensureAccountSource(s, row, 'needs_reauth', grantedScopes)
        q.markPimSourceNeedsReauth(src.id, t('pim.err.davAuth'))
        emitPimChanged(s.hub, src, 'sources')
      }
      return 'needsConsent'
    }
    log.warn('kişi ve takvim keşfi başarısız', { accountId: row.id, error: (e as Error).message })
    return 'notFound'
  }
  if (found.confirmHost) {
    confirm.found = found.confirmHost
    return 'confirmHost'
  }
  if (!found.caldavHome && !found.carddavHome) return 'notFound'
  const src = save(found, 'dav')
  emitPimChanged(s.hub, src, 'sources')
  syncSoon(s, src)
  return 'connected'
}

const MAX_PERSONAL_SOURCES = 10

export const pimSourcesHandlers: Record<string, Handler> = {
  async listPimSources(s: RpcSession, _params: unknown) {
    ensureLocalSource(s)
    return visibleSources(s).map((v) => sourceInfo(v.source, v.canWrite))
  },

  async listPimCollections(s: RpcSession, params: unknown) {
    const { type } = params as { type: PimCollectionType }
    if (type !== 'addressbook' && type !== 'calendar') throw new Error(t('pim.err.invalid'))
    ensureLocalSource(s)
    const sources = new Map(visibleSources(s).map((v) => [v.source.id, v]))
    const prefs = new Map(s.deps.q.listPimCollectionPrefs(s.currentUser!.id).map((p) => [p.collection_id, p]))
    return s.deps.q.listPimCollectionsByType(type).flatMap((c) => {
      const v = sources.get(c.source_id)
      return v ? [collectionInfo(c, v.source, v.canWrite, prefs.get(c.id), isGoogle(s, v.source))] : []
    })
  },

  async setPimCollectionPref(s: RpcSession, params: unknown) {
    const p = params as { collectionId: number; hidden?: unknown; color?: unknown; reminders?: unknown }
    const collectionId = Number(p.collectionId)
    assertCollectionRead(s, collectionId)
    if (p.hidden !== undefined && typeof p.hidden !== 'boolean') throw new Error(t('pim.err.invalid'))
    if (p.reminders !== undefined && typeof p.reminders !== 'boolean') throw new Error(t('pim.err.invalid'))
    if (p.color !== undefined && p.color !== null && !(typeof p.color === 'string' && COLOR.test(p.color))) throw new Error(t('pim.err.invalid'))
    s.deps.q.setPimCollectionPref(s.currentUser!.id, collectionId, { hidden: p.hidden, color: p.color, reminders: p.reminders } as { hidden?: boolean; color?: string | null; reminders?: boolean })
    return null
  },

  async connectAccountPim(s: RpcSession, params: unknown) {
    const accountId = Number((params as { accountId?: unknown }).accountId)
    assertAccountManage(s, accountId)
    const row = s.deps.q.getAccountRow(accountId)
    if (!row) throw new Error(t('sync.err.accountNotFound'))
    if (row.secure) throw new Error(t('pim.err.vaultAccount'))
    // OAuth izni yalnız `pim: true` akışında verilir
    if (providerOfAuthType(row.auth_type) && !s.deps.q.getPimSourceByAccount(accountId)) return { status: 'needsConsent' }
    const host = (params as { confirmedHost?: unknown }).confirmedHost
    const confirm: { host?: string; found?: string } = { host: typeof host === 'string' ? host : undefined }
    const status = await connectAccountSource(s, row, null, confirm)
    return status === 'confirmHost' ? { status, host: confirm.found } : { status }
  },

  /** Reddedilmiş kişisel kaynak: yeni parola bir kez denenir, kabul edilmezse kaynak durur */
  async updatePersonalDavPassword(s: RpcSession, params: unknown) {
    const p = params as { id?: unknown; password?: unknown }
    const source = s.deps.q.getPimSource(Number(p.id))
    if (!source || source.owner_user_id !== s.currentUser!.id || source.kind !== 'dav') throw new Error(t('pim.err.noAccess'))
    if (typeof p.password !== 'string' || !p.password || p.password.length > 1000) throw new Error(t('pim.err.invalid'))
    const url = source.caldav_url ?? source.carddav_url
    if (!url) throw new Error(t('pim.err.invalid'))
    const password = p.password
    try {
      await discoverDav({ url, auth: { header: async () => basicHeader(source.username ?? '', password) }, basic: true, net: s.hub.pimDeps().net({ ics: false }) })
    } catch (e) {
      if (isAuthFailure(e)) return { status: 'needsConsent' }
      throw e
    }
    const [enc] = await s.deps.encrypt([password])
    s.deps.q.setPersonalPimSecret(source.id, Buffer.from(enc))
    const fresh = s.deps.q.getPimSource(source.id)!
    emitPimChanged(s.hub, fresh, 'sources')
    syncSoon(s, fresh)
    return { status: 'connected' }
  },

  async addPersonalDav(s: RpcSession, params: unknown) {
    const p = params as { url?: unknown; username?: unknown; password?: unknown }
    if (typeof p.url !== 'string' || typeof p.username !== 'string' || typeof p.password !== 'string') throw new Error(t('pim.err.invalid'))
    const url = p.url.trim()
    const username = p.username.trim()
    if (!url || url.length > 2000 || !username || username.length > 320 || !p.password || p.password.length > 1000) throw new Error(t('pim.err.invalid'))
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(t('pim.err.invalid'))
    }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) throw new Error(t('pim.err.invalid'))
    const password = p.password
    const userId = s.currentUser!.id
    if (s.deps.q.countPersonalDavSources(userId) >= MAX_PERSONAL_SOURCES) throw new Error(t('pim.err.tooManySources'))
    const net = s.hub.pimDeps().net({ ics: false })
    let found: DiscoverResult
    try {
      found = await discoverDav({ url, auth: { header: async () => basicHeader(username, password) }, basic: true, net })
    } catch (e) {
      if (isAuthFailure(e)) return { status: 'needsConsent' }
      throw e
    }
    if (!found.caldavHome && !found.carddavHome) return { status: 'notFound' }
    const [enc] = await s.deps.encrypt([password])
    if (s.deps.q.countPersonalDavSources(userId) >= MAX_PERSONAL_SOURCES) throw new Error(t('pim.err.tooManySources'))
    const src = s.deps.q.insertPersonalPimSource({
      userId, label: parsed.hostname, caldavUrl: found.caldavHome, carddavUrl: found.carddavHome, serverSchedules: found.serverSchedules,
      username, secretEnc: Buffer.from(enc), now: s.hub.now()
    })
    emitPimChanged(s.hub, src, 'sources')
    syncSoon(s, src)
    return { status: 'connected' }
  },

  async removePimSource(s: RpcSession, params: unknown) {
    const src = s.deps.q.getPimSource(Number((params as { id?: unknown }).id))
    if (!src || !canReadSource(s, src)) throw new Error(t('pim.err.noAccess'))
    if (!canWriteSource(s, src)) throw new Error(t('pim.err.noWrite'))
    if (src.kind === 'local') throw new Error(t('pim.err.invalid'))
    s.deps.q.deletePimSource(src.id)
    emitPimChanged(s.hub, src, 'sources')
    return null
  },

  async syncPimSource(s: RpcSession, params: unknown) {
    const src = s.deps.q.getPimSource(Number((params as { id?: unknown }).id))
    if (!src || !canReadSource(s, src)) throw new Error(t('pim.err.noAccess'))
    if (!canWriteSource(s, src)) throw new Error(t('pim.err.noWrite'))
    await s.hub.pim.syncNow(src.id)
    return null
  }
}
