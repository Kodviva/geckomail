// RPC — Mail: liste, gövde, arama, işaretleme, taşıma, silme, abonelikler. Yetki kapısı (giriş / yönetici) RpcSession.handle'da; hesap düzeyi kontroller burada.
import { existsSync } from 'fs'
import { SEALED_ATTACHMENT_SUFFIX } from '../../shared/attachmentFiles'
import type { BodyResult, FolderKind, ListParams, SmartView } from '../../shared/rpc'
import { BodyTooLargeError, fetchAttachmentPart, fetchBody, fetchRawHeaders, fetchRawSource, fetchSmimeRaw, openSealedAttachment, readStoredAttachment } from '../bodyFetch'
import { invalidateFolderList, pollFolder as pollFolderOnce } from '../imapPoll'
import { buildIncidents } from '../../shared/incident'
import { buildHourlySeries } from '../../shared/volume'
import { describeError, isMissingMailbox } from '../imapClient'
import { safeFetch } from '../net/safeFetch'
import type { RpcSession } from '../rpcSession'
import type { RpcServerDeps } from '../rpcHub'
import type { Queries } from '../db/queries'
import { type Handler, INLINE_DATA_LIMIT, UNDO_WINDOW_MS } from './common'
import { mergedContacts } from './contacts'
import { t } from '../../shared/i18n'
import type { SmimeInfo } from '../../shared/smime'
import { parseCert, sameAddress } from '../smime/certInfo'
import type { DecryptedBody } from '../smime/decryptCache'
import { encodeChain } from '../smime/identity'
import { decryptForUser, evaluatorFor, harvestContactCert, type StoredSmime } from '../smime/receive'
import { getVaultStatus } from '../vault/manager'
import { isVaultUnlocked } from '../vault/state'

type MessageOf = NonNullable<ReturnType<Queries['getMessage']>>
type AttachmentOf = NonNullable<ReturnType<Queries['getAttachment']>>

/** İleti + ona ait ek; ek başka iletininse bulunamadı. Görme yetkisi çağıranda (iletinin hesabı). */
export function loadAttachment(q: Queries, messageId: number, attachmentId: number): { msg: MessageOf; att: AttachmentOf } {
  const msg = q.getMessage(messageId)
  if (!msg) throw new Error(t('sync.mail.messageNotFound'))
  const att = q.getAttachment(attachmentId)
  if (!att || att.message_id !== msg.id) throw new Error(t('sync.mail.attachmentNotFound'))
  return { msg, att }
}

/** Kasa kilitliyken kasa hesabının eki verilmez */
function assertAttachmentReadable(q: Queries, accountId: number): void {
  if (q.getAccountRow(accountId)?.secure && !isVaultUnlocked()) throw new Error(t('sync.vault.locked'))
}

/** Ekin diskteki düz yolu; önbellekte yoksa (ya da dosyası silinmişse) IMAP'ten çekilip yazılır. Kasa hesabında önbellek
 *  mühürlüdür, düz kopya kilitte silinir. Yetki denetimi çağıranda. RPC getAttachment ve sunucunun HTTP ek ucu aynı yolu kullanır. */
export async function attachmentOnDisk(deps: RpcServerDeps, msg: MessageOf, att: AttachmentOf): Promise<string> {
  // ek o iletinin değilse (başka hesabın eki) ne verilir ne de o iletinin klasöründen çekilip önbelleğe yazılır:
  // görme yetkisi iletinin hesabında denetlenir, ek kimliği buna bağlı olmalı
  if (att.message_id !== msg.id) throw new Error(t('sync.mail.attachmentNotFound'))
  assertAttachmentReadable(deps.q, msg.accountId)
  const stored = att.disk_path && existsSync(att.disk_path)
    ? att.disk_path
    : await deps.scheduler.enqueueInteractive(msg.accountId, async (client, row) => fetchAttachmentPart(deps.q, row, msg, att, client, deps.attachDir))
  return stored.endsWith(SEALED_ATTACHMENT_SUFFIX) ? openSealedAttachment(stored, deps.attachDir, att) : stored
}

/** Klasör süzgeci: geçersiz kimlik reddedilir (0 sorguda süzgeçsiz sayılırdı), olmayan klasör boş sonuç, var olan için görme yetkisi */
function folderInScope(s: RpcSession, folderId: unknown): boolean {
  if (typeof folderId !== 'number' || !Number.isInteger(folderId) || folderId <= 0) throw new Error(t('sync.pref.invalidValue', { key: 'folderId' }))
  const f = s.deps.q.getFolderById(folderId)
  if (!f) return false
  s.assertCanView(f.account_id)
  return true
}

const smimeState = (o: Partial<SmimeInfo>): SmimeInfo => ({ sig: 'none', enc: 'none', notes: [], signer: null, canSaveCert: false, ...o })

const noContent = (smime: SmimeInfo): BodyResult => ({ state: 'ready', textPlain: null, html: null, attachments: [], smime })

function decryptedResult(b: DecryptedBody): BodyResult {
  return {
    state: 'ready', textPlain: b.textPlain, html: b.html, smime: b.info,
    attachments: b.attachments.map((a) => ({
      id: -1 - a.index, smimeIndex: a.index, filename: a.filename, mime: a.mime, size: a.content.length, contentId: a.contentId, diskPath: null
    }))
  }
}

/** Şifreli ileti: bodies'e bakılmaz, kullanıcının önbelleği ya da IMAP'ten çözüm. Yalnız açılınca çalışır. */
function encryptedBody(s: RpcSession, msg: MessageOf): BodyResult {
  const { q, scheduler } = s.deps
  const userId = s.currentUser!.id
  const cached = s.hub.smimeCache.get(userId, msg.id)
  if (cached) return decryptedResult(cached)
  if (getVaultStatus(q) === 'locked') return noContent(smimeState({ enc: 'locked' }))
  if (!q.listIdentities(userId).length) return noContent(smimeState({ enc: 'no_key' }))
  const key = `${userId}:${msg.id}`
  const inflight = s.hub.smimeInflight.get(key)
  if (inflight === 'fetching') return { state: 'fetching' }
  if (typeof inflight === 'string') {
    s.hub.smimeInflight.delete(key)
    return { state: 'error', error: inflight }
  }
  s.hub.smimeInflight.set(key, 'fetching')
  const stamp = s.hub.smimeCache.stamp(userId)
  const done = (): void => s.broadcast('body:ready', { messageId: msg.id, accountId: msg.accountId })
  void scheduler
    .enqueueInteractive(msg.accountId, (client) => fetchSmimeRaw(msg, client))
    .then(async ({ raw, internalDate }) => decryptForUser(s.deps, userId, msg, raw, internalDate))
    .then((body) => {
      s.hub.smimeCache.setIfCurrent(userId, msg.id, stamp, body)
      s.hub.smimeInflight.delete(key)
      done()
    })
    .catch((e) => {
      if (e instanceof BodyTooLargeError) {
        s.hub.smimeCache.setIfCurrent(userId, msg.id, stamp, { textPlain: null, html: null, attachments: [], signers: [], info: smimeState({ enc: 'failed', notes: ['too_large'] }) })
        s.hub.smimeInflight.delete(key)
      } else s.hub.smimeInflight.set(key, describeError(e))
      done()
    })
  return { state: 'fetching' }
}

/** İmzalı iletinin durumu her açılışta güncel güven deposuyla: CRL gelince not kalkar. Toplama açan kullanıcıya aittir. */
async function signedInfo(s: RpcSession, msg: MessageOf): Promise<SmimeInfo | undefined> {
  const { q } = s.deps
  const stored = q.getMessageSmime(msg.id) as StoredSmime | null
  if (!stored) return undefined
  const { info, harvest } = await s.hub.smimeVerdicts.current(s.deps, msg.id, stored)
  if (!harvest) return info
  if (q.getAccountRow(msg.accountId)?.secure !== 0) return { ...info, canSaveCert: true } // kasa hesabında otomatik toplama yok
  harvestContactCert(q, s.currentUser!.id, msg, harvest, harvest.capabilities)
  return info
}

function onlyVisible<T extends { accountId: number }>(s: RpcSession, rows: T[]): T[] {
  const visible = s.resolveAccountIds(null)
  if (visible === null) return rows
  const set = new Set(visible)
  return rows.filter((m) => set.has(m.accountId))
}

export const mailHandlers: Record<string, Handler> = {
  async getIncidents(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    const visible = s.resolveAccountIds(null)
    let rows = q.getRecentInboxMessages(Date.now() - 60 * 60_000, 5000)
    if (visible !== null) {
      const set = new Set(visible)
      rows = rows.filter((r) => set.has(r.accountId))
    }
    return buildIncidents(rows, 3)
  },

  async listSmart(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { view, accountIds, unreadOnly } = params as { view: SmartView; accountIds: number[] | null; unreadOnly?: boolean }
    if (!['starred', 'snoozed', 'attachments'].includes(view)) throw new Error(t('sync.mail.invalidView'))
    const ids = s.resolveAccountIds(accountIds)
    if (ids !== null && ids.length === 0) return []
    return q.listSmart(view, ids, !!unreadOnly)
  },

  async getAttachments(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    const ids = s.resolveAccountIds(null)
    if (ids !== null && ids.length === 0) return []
    return q.listAttachments(ids, 500)
  },

  async getContacts(s: RpcSession, _params: unknown) {
    return mergedContacts(s)
  },

  async getHourlyVolume(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    const ids = s.resolveAccountIds(null)
    const since = Date.now() - 24 * 3600_000
    // boş liste "tümü" demek değil: görebildiği hesabı olmayan üye sıfır serisi alır
    const rows = ids !== null && ids.length === 0 ? [] : q.getHourlyMessageCounts(since, ids)
    return buildHourlySeries(rows, since, Date.now())
  },

  async listMessages(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const p = params as ListParams
    if (p.folderId != null) {
      if (!folderInScope(s, p.folderId)) return []
      return q.listMessages(p)
    }
    const ids = s.resolveAccountIds(p.accountIds)
    if (ids !== null && ids.length === 0) return []
    return q.listMessages({ ...p, accountIds: ids })
  },

  async listThreads(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const p = params as ListParams
    if (p.folderId != null) {
      if (!folderInScope(s, p.folderId)) return []
      return q.listThreads(p)
    }
    const ids = s.resolveAccountIds(p.accountIds)
    if (ids !== null && ids.length === 0) return []
    return q.listThreads({ ...p, accountIds: ids })
  },

  async getThread(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { threadRoot, folderKind } = params as { threadRoot: string; folderKind: FolderKind }
    // thread_root bir Message-ID: aynı mail birden çok hesaba düşebilir (catch-all/alias) —
    // üye yalnız görebildiği hesaplardaki parçaları alır
    return onlyVisible(s, q.getThread(threadRoot, folderKind))
  },

  async getThreadMembers(s: RpcSession, params: unknown) {
    const { threadRoot, folderKind } = params as { threadRoot: string; folderKind: FolderKind }
    return onlyVisible(s, s.deps.q.getThreadMembers(threadRoot, folderKind))
  },

  async getBody(s: RpcSession, params: unknown) {
    const { q, scheduler, attachDir } = s.deps
    const { messageId } = params as { messageId: number }
    const msg = q.getMessage(messageId)
    if (!msg) throw new Error(t('sync.mail.messageNotFound'))
    s.assertCanView(msg.accountId)
    if (msg.smimeKind === 'encrypted') return encryptedBody(s, msg)
    const cached = q.getBodyRow(messageId)
    if (cached) {
      const atts = q.attachmentsFor(messageId)
      const smime = await signedInfo(s, msg)
      const res: BodyResult = {
        state: 'ready',
        textPlain: cached.text_plain,
        html: cached.html,
        attachments: atts.map((a) => ({
          id: a.id, filename: a.filename, mime: a.mime, size: a.size, contentId: a.content_id, diskPath: a.disk_path
        })),
        ...(smime ? { smime } : {})
      }
      return res
    }
    const inflight = s.bodyInflight.get(messageId)
    if (inflight === 'fetching') return { state: 'fetching' } satisfies BodyResult
    if (typeof inflight === 'string') {
      s.bodyInflight.delete(messageId)
      return { state: 'error', error: inflight } satisfies BodyResult
    }
    s.bodyInflight.set(messageId, 'fetching')
    void scheduler
      .enqueueInteractive(msg.accountId, async (client, row) => {
        await fetchBody(q, row, msg, client, attachDir, evaluatorFor(s.deps))
      })
      .then(() => {
        s.bodyInflight.delete(messageId)
        s.broadcast('body:ready', { messageId, accountId: msg.accountId })
      })
      .catch((e) => {
        s.bodyInflight.set(messageId, describeError(e))
        s.broadcast('body:ready', { messageId, accountId: msg.accountId })
      })
    return { state: 'fetching' } satisfies BodyResult
  },

  async getSmimeAttachment(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { messageId, index } = params as { messageId: number; index: number }
    const msg = q.getMessage(Number(messageId))
    if (!msg) throw new Error(t('sync.mail.messageNotFound'))
    s.assertCanView(msg.accountId)
    const att = s.hub.smimeCache.get(s.currentUser!.id, msg.id)?.attachments.find((a) => a.index === Number(index))
    if (!att) throw new Error(t('sync.smime.attachmentGone'))
    if (s.hub.mode === 'server' && att.content.length > INLINE_DATA_LIMIT) throw new Error(t('sync.mail.attachmentTooLargeInline'))
    return { filename: att.filename ?? 'ek', mime: att.mime ?? 'application/octet-stream', base64: att.content.toString('base64') }
  },

  async smimeSaveContactCert(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { messageId, fingerprint } = params as { messageId: number; fingerprint: string }
    const msg = q.getMessage(Number(messageId))
    if (!msg) throw new Error(t('sync.mail.messageNotFound'))
    s.assertCanView(msg.accountId)
    const userId = s.currentUser!.id
    const stored = q.getMessageSmime(msg.id) as StoredSmime | null
    const signers = [
      ...(s.hub.smimeCache.get(userId, msg.id)?.signers ?? []).map((r) => ({ signer: r.signer as Uint8Array, certs: r.certs, capabilities: r.capabilities })),
      ...(stored?.evidence?.signers ?? []).map((r) => ({
        signer: new Uint8Array(Buffer.from(r.signer, 'base64')), certs: r.certs.map((c) => new Uint8Array(Buffer.from(c, 'base64'))), capabilities: r.capabilities
      }))
    ]
    for (const r of signers) {
      const c = parseCert(r.signer)
      if (c.fingerprint !== fingerprint) continue
      // K11: sahte Kimden ile gelen sertifika sonraki şifreli postayı saldırgana açmasın
      const email = c.emails.find((e) => msg.fromAddr && sameAddress(e, msg.fromAddr))
      if (!email) throw new Error(t('smime.sig.addressMismatch'))
      q.upsertContactCert({
        userId, email, fingerprint: c.fingerprint, certDer: Buffer.from(c.der),
        chainDer: encodeChain(r.certs.filter((d) => Buffer.compare(d, c.der) !== 0)), notAfter: c.notAfter,
        capabilities: r.capabilities.length ? JSON.stringify(r.capabilities) : null, source: 'manual'
      })
      return { ok: true }
    }
    throw new Error(t('sync.smime.notFound'))
  },

  async getAttachment(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { messageId, attachmentId } = params as { messageId: number; attachmentId: number }
    const msg = q.getMessage(Number(messageId))
    if (!msg) throw new Error(t('sync.mail.messageNotFound'))
    s.assertCanView(msg.accountId)
    const { att } = loadAttachment(q, msg.id, Number(attachmentId))
    return { diskPath: await attachmentOnDisk(s.deps, msg, att) }
  },

  async getAttachmentData(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { messageId, attachmentId } = params as { messageId?: number; attachmentId: number }
    const att = q.getAttachment(Number(attachmentId))
    if (!att) throw new Error(t('sync.mail.attachmentNotFound'))
    // ileti verildiyse ek ona ait olmalı; yetki her durumda ekin gerçek sahibi iletinin hesabında
    if (messageId != null && att.message_id !== Number(messageId)) throw new Error(t('sync.mail.attachmentNotFound'))
    const owner = q.getMessage(att.message_id)
    if (!owner) throw new Error(t('sync.mail.attachmentNotFound'))
    s.assertCanView(owner.accountId)
    assertAttachmentReadable(q, owner.accountId)
    if (!att.disk_path) throw new Error(t('sync.mail.attachmentNotOnDisk'))
    if ((att.size ?? 0) > INLINE_DATA_LIMIT) throw new Error(t('sync.mail.attachmentTooLargeInline'))
    const buf = readStoredAttachment(att.disk_path)
    return { base64: buf.toString('base64'), mime: att.mime }
  },

  async getRawHeaders(s: RpcSession, params: unknown) {
    const { q, scheduler } = s.deps
    const { messageId } = params as { messageId: number }
    const msg = q.getMessage(messageId)
    if (!msg) throw new Error(t('sync.mail.messageNotFound'))
    s.assertCanView(msg.accountId)
    const raw = await scheduler.enqueueInteractive(msg.accountId, async (client) => fetchRawHeaders(msg, client))
    return { raw }
  },

  async getRawSource(s: RpcSession, params: unknown) {
    const { q, scheduler } = s.deps
    const { messageId } = params as { messageId: number }
    const msg = q.getMessage(messageId)
    if (!msg) throw new Error(t('sync.mail.messageNotFound'))
    s.assertCanView(msg.accountId)
    const buf = await scheduler.enqueueInteractive(msg.accountId, async (client) => fetchRawSource(msg, client))
    const safeSubject = (msg.subject ?? 'mesaj').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 60).trim() || 'mesaj'
    return { filename: `${safeSubject}.eml`, data: new Uint8Array(buf) }
  },

  async listSubscriptions(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { accountIds, days } = params as { accountIds: number[] | null; days?: number }
    const ids = s.resolveAccountIds(accountIds)
    if (ids !== null && ids.length === 0) return []
    const span = Math.min(Math.max(Number(days) || 90, 7), 730)
    return q.subscriptionSenders(ids, Date.now() - span * 86_400_000)
  },

  async unsubscribeSenders(s: RpcSession, params: unknown) {
    const { q } = s.deps
    // her gönderen için kullanıcının açık seçimi; tek-tık (RFC 8058) olmayanlara dokunulmaz.
    // Sıralı ve üst sınırlı: toplu seçim bir anda yüzlerce dış isteğe dönüşmesin.
    const { accountIds, addrs } = params as { accountIds: number[] | null; addrs: string[] }
    const ids = s.resolveAccountIds(accountIds)
    if (ids !== null && ids.length === 0) return []
    const out: { addr: string; ok: boolean; error?: string }[] = []
    for (const raw of (Array.isArray(addrs) ? addrs : []).slice(0, 200)) {
      const addr = String(raw).toLowerCase()
      const msgId = q.latestOneClickFrom(addr, ids)
      if (!msgId) {
        out.push({ addr, ok: false, error: t('sync.unsub.oneClickUnsupported') })
        continue
      }
      const r = await s.oneClickUnsubscribe(msgId)
      q.recordUnsubscribe(addr, r.ok, r.ok ? null : (r.error ?? null))
      out.push({ addr, ...r })
    }
    return out
  },

  async unsubscribe(s: RpcSession, params: unknown) {
    const { q } = s.deps
    // RFC 8058 tek-tık: her zaman sync sürecinden POST edilir, renderer'a asla URL sızmaz.
    // Şüpheli/scam mailde bile buraya yalnızca kullanıcının kendi tıklaması ile ulaşılır — otomatik tetiklenmez.
    const { messageId } = params as { messageId: number }
    const msg = q.getMessage(messageId)
    if (!msg) throw new Error(t('sync.mail.messageNotFound'))
    s.assertCanView(msg.accountId)
    const r = await s.oneClickUnsubscribe(messageId)
    if (msg.fromAddr) q.recordUnsubscribe(msg.fromAddr, r.ok, r.ok ? null : (r.error ?? null))
    return r
  },

  async search(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { query, accountIds, sort } = params as { query: string; accountIds: number[] | null; sort?: 'relevance' | 'date' }
    const ids = s.resolveAccountIds(accountIds)
    if (ids !== null && ids.length === 0) return []
    return q.ftsSearch(String(query).slice(0, 500), ids, 200, { sort: sort === 'date' ? 'date' : 'relevance' })
  },

  async fetchRemoteImages(s: RpcSession, params: unknown) {
    const { q } = s.deps
    // uzak resimleri çerezsiz/parmak izsiz indirip data: URI olarak döndür —
    // mail iframe'i ağa hiç çıkmaz, CSP img-src data: sabit kalır
    const { messageId } = params as { messageId: number }
    const owner = q.getMessage(messageId)
    if (owner) s.assertCanView(owner.accountId)
    if (owner?.smimeKind === 'encrypted') return { images: {} } // şifreli görünümde ağ yok: EFAIL sızıntı kanalı
    const body = q.getBodyRow(messageId)
    if (!body?.html) return { images: {} }
    const urls = [...new Set([...body.html.matchAll(/src\s*=\s*["'](https?:[^"']+)["']/gi)].map((m) => m[1]))].slice(0, 20)
    const images: Record<string, string> = {}
    await Promise.allSettled(
      urls.map(async (url) => {
        // URL mailin göndereninden gelir: yalnız genel internet (iç ağa SSRF yok), en fazla 5 MB
        const res = await safeFetch(url, {
          timeoutMs: 10_000,
          maxBytes: 5_000_000,
          headers: { 'user-agent': 'Mozilla/5.0', accept: 'image/*' }
        })
        if (!res.ok) return
        const mime = String(res.headers['content-type'] ?? '').split(';')[0].trim()
        if (!mime.startsWith('image/')) return
        const buf = res.body
        images[url] = `data:${mime};base64,${buf.toString('base64')}`
      })
    )
    return { images }
  },

  async markSeen(s: RpcSession, params: unknown) {
    const { q, opq } = s.deps
    const { messageIds, seen } = params as { messageIds: number[]; seen: boolean }
    const msgs = q.getMessages(messageIds)
    for (const accId of new Set(msgs.map((m) => m.accountId))) s.assertCanView(accId)
    q.setSeenLocal(messageIds, seen)
    const groups = new Map<string, { accountId: number; folderPath: string; uids: number[] }>()
    for (const m of msgs) {
      const key = `${m.accountId}|${m.folderPath}`
      const g = groups.get(key) ?? { accountId: m.accountId, folderPath: m.folderPath, uids: [] }
      g.uids.push(m.uid)
      groups.set(key, g)
    }
    for (const g of groups.values())
      q.enqueueOp(g.accountId, 'store_flags', { folderPath: g.folderPath, uids: g.uids, seen })
    opq.kick()
    s.broadcastDebounced('counts:changed', {}, 100)
    return null
  },

  async markFlagged(s: RpcSession, params: unknown) {
    const { q, opq } = s.deps
    const { messageIds, flagged } = params as { messageIds: number[]; flagged: boolean }
    const msgs = q.getMessages(messageIds)
    for (const accId of new Set(msgs.map((m) => m.accountId))) s.assertCanView(accId)
    q.setFlaggedLocal(messageIds, flagged)
    const groups = new Map<string, { accountId: number; folderPath: string; uids: number[] }>()
    for (const m of msgs) {
      const key = `${m.accountId}|${m.folderPath}`
      const g = groups.get(key) ?? { accountId: m.accountId, folderPath: m.folderPath, uids: [] }
      g.uids.push(m.uid)
      groups.set(key, g)
    }
    for (const g of groups.values())
      q.enqueueOp(g.accountId, 'store_flags', { folderPath: g.folderPath, uids: g.uids, flagged })
    opq.kick()
    return null
  },

  async snoozeMessages(s: RpcSession, params: unknown) {
    const { q } = s.deps
    // yerel ertele: maili `until`'e kadar gizle (0 = geri getir). Sunucuya dokunmaz.
    const { messageIds, until } = params as { messageIds: number[]; until: number }
    const msgs = q.getMessages(messageIds)
    for (const accId of new Set(msgs.map((m) => m.accountId))) s.assertCanView(accId)
    q.snoozeMessages(messageIds, Math.max(0, Math.floor(until)))
    s.broadcastDebounced('counts:changed', {}, 100)
    return null
  },

  async deleteMessages(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { messageIds } = params as { messageIds: number[] }
    const msgs = q.getMessages(messageIds)
    for (const accId of new Set(msgs.map((m) => m.accountId))) s.assertCanManage(accId)
    const groups = new Map<string, { accountId: number; folderPath: string; uids: number[]; ids: number[] }>()
    for (const m of msgs) {
      const key = `${m.accountId}|${m.folderPath}`
      const g = groups.get(key) ?? { accountId: m.accountId, folderPath: m.folderPath, uids: [], ids: [] }
      g.uids.push(m.uid)
      g.ids.push(m.id)
      groups.set(key, g)
    }
    // soft-delete + gecikmeli op = Geri Al penceresi; satırlar sunucu silmesi
    // onaylanınca sıradaki poll'un expunge taramasıyla yerelden düşer
    q.setHidden(messageIds, true)
    const undo = [...groups.values()].map((g) => ({
      messageIds: g.ids,
      opId: q.enqueueOpDelayed(g.accountId, 'trash', { folderPath: g.folderPath, uids: g.uids }, Date.now() + UNDO_WINDOW_MS)
    }))
    const undoToken = ++s.undoSeq
    s.undoState.set(undoToken, undo)
    setTimeout(() => s.undoState.delete(undoToken), UNDO_WINDOW_MS + 60_000)
    s.broadcastDebounced('counts:changed', {}, 100)
    return { undoToken }
  },

  async undoDelete(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { undoToken } = params as { undoToken: number }
    const st = s.undoState.get(undoToken)
    if (!st) throw new Error(t('sync.mail.undoExpired'))
    s.undoState.delete(undoToken)
    // işlenmeye başlamış op geri alınamaz; iptal edilen gruplar yine görünür olmalı
    const cancelled = st.filter((g) => q.deletePendingOps([g.opId]) === 1)
    if (cancelled.length) q.setHidden(cancelled.flatMap((g) => g.messageIds), false)
    s.broadcast('messages:changed', { accountId: null })
    s.broadcastDebounced('counts:changed', {}, 100)
    if (cancelled.length < st.length) throw new Error(t('sync.mail.undoTooLate'))
    return null
  },

  async markAllSeen(s: RpcSession, params: unknown) {
    const { q, opq } = s.deps
    const { accountIds, folderKind } = params as { accountIds: number[] | null; folderKind: FolderKind }
    const ids = s.resolveAccountIds(accountIds)
    if (ids !== null && ids.length === 0) return null
    q.markAllSeenLocal(ids, folderKind)
    const targets = ids ?? q.getAccountRows().map((r) => r.id)
    for (const id of targets) q.enqueueOp(id, 'mark_all_seen', { folderKind })
    opq.kick()
    s.broadcast('messages:changed', { accountId: null })
    s.broadcastDebounced('counts:changed', {}, 100)
    return null
  },

  async getFoldersOf(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { accountId } = params as { accountId: number }
    s.assertCanView(accountId)
    return q
      .getFolders(accountId)
      .map((f) => ({ id: f.id, path: f.path, kind: f.kind, display: f.path.replace(/^INBOX\./i, '') }))
      .sort((a, b) => a.display.localeCompare(b.display, 'tr'))
  },

  async syncFolder(s: RpcSession, params: unknown) {
    const { q, scheduler } = s.deps
    const { folderId } = params as { folderId: number }
    const folder = q.getFolderById(folderId)
    if (!folder) throw new Error(t('sync.mail.folderNotFound'))
    s.assertCanView(folder.account_id)
    void scheduler
      .enqueueInteractive(folder.account_id, async (client, row) => {
        const fresh = q.getFolderById(folderId)
        if (fresh) await pollFolderOnce(q, row, fresh, client, 1)
      })
      .then(() => {
        s.broadcastDebounced('messages:changed', { accountId: folder.account_id })
        s.broadcastDebounced('counts:changed', {})
      })
      .catch((e) => {
        // sunucuda artık yok: yerel kopyayı düşür, listeyi tazelet
        if (!isMissingMailbox(e)) return
        q.deleteFolder(folderId)
        invalidateFolderList(q, folder.account_id)
        s.broadcastDebounced('messages:changed', { accountId: folder.account_id })
      })
    return null
  },

  async moveMessages(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { messageIds, targetFolderId } = params as { messageIds: number[]; targetFolderId: number }
    const target = q.getFolderById(targetFolderId)
    if (!target) throw new Error(t('sync.mail.targetFolderNotFound'))
    s.assertCanManage(target.account_id)
    const msgs = q.getMessages(messageIds)
    const groups = new Map<string, { accountId: number; folderPath: string; uids: number[]; ids: number[] }>()
    const moved: number[] = []
    for (const m of msgs) {
      if (m.accountId !== target.account_id) continue // farklı hesaba taşınamaz
      if (m.folderPath === target.path) continue // zaten orada
      const key = `${m.accountId}|${m.folderPath}`
      const g = groups.get(key) ?? { accountId: m.accountId, folderPath: m.folderPath, uids: [], ids: [] }
      g.uids.push(m.uid)
      g.ids.push(m.id)
      groups.set(key, g)
      moved.push(m.id)
    }
    // yalnız gerçekten taşınanlar gizlenir: atlanan (başka hesabın) mesajlar sunucuda yerinde
    // kaldığı halde yerelde kalıcı olarak kayboluyordu
    // silmeyle aynı Geri Al penceresi: op gecikmeli girer, süre dolunca kuyruk işler
    const undo = q.tx(() => {
      if (moved.length) q.setHidden(moved, true)
      return [...groups.values()].map((g) => ({
        accountId: g.accountId,
        messageIds: g.ids,
        opId: q.enqueueOpDelayed(g.accountId, 'move', { folderPath: g.folderPath, uids: g.uids, targetPath: target.path }, Date.now() + UNDO_WINDOW_MS)
      }))
    })
    s.broadcast('messages:changed', { accountId: target.account_id }) // diğer sekme ve kullanıcılar
    s.broadcastDebounced('counts:changed', {}, 100)
    const result = { moved: moved.length, skipped: messageIds.length - moved.length }
    if (!undo.length) return result
    const undoToken = ++s.undoSeq
    s.moveUndo.set(undoToken, undo)
    setTimeout(() => s.moveUndo.delete(undoToken), UNDO_WINDOW_MS + 60_000)
    return { ...result, undoToken }
  },

  async undoMove(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { undoToken } = params as { undoToken: number }
    const groups = s.moveUndo.get(undoToken)
    if (!groups) throw new Error(t('sync.mail.undoExpired'))
    for (const g of groups) s.assertCanManage(g.accountId) // yetki pencere içinde kalkmış olabilir
    s.moveUndo.delete(undoToken)
    // işlenmeye başlamış op geri alınamaz; iptal edilen gruplar yine görünür olmalı
    const cancelled = groups.filter((g) => q.deletePendingOps([g.opId]) === 1)
    if (cancelled.length) q.setHidden(cancelled.flatMap((g) => g.messageIds), false)
    s.broadcast('messages:changed', { accountId: null })
    s.broadcastDebounced('counts:changed', {}, 100)
    if (cancelled.length < groups.length) throw new Error(t('sync.mail.undoMoveTooLate'))
    return null
  },

  async moveSpecial(s: RpcSession, params: unknown) {
    const { q, opq } = s.deps
    const { messageIds, special } = params as { messageIds: number[]; special: 'archive' | 'junk' }
    const msgs = q.getMessages(messageIds)
    for (const accId of new Set(msgs.map((m) => m.accountId))) s.assertCanManage(accId)
    const groups = new Map<string, { accountId: number; folderPath: string; uids: number[] }>()
    for (const m of msgs) {
      const key = `${m.accountId}|${m.folderPath}`
      const g = groups.get(key) ?? { accountId: m.accountId, folderPath: m.folderPath, uids: [] }
      g.uids.push(m.uid)
      groups.set(key, g)
    }
    q.setHidden(messageIds, true)
    for (const g of groups.values())
      q.enqueueOp(g.accountId, 'move_special', { folderPath: g.folderPath, uids: g.uids, special })
    opq.kick()
    s.broadcastDebounced('counts:changed', {}, 100)
    return null
  },

  async setViewed(s: RpcSession, params: unknown) {
    const { scheduler } = s.deps
    const { accountIds } = params as { accountIds: number[] | null }
    scheduler.setViewed(s.resolveAccountIds(accountIds))
    return null
  },

  async pollNow(s: RpcSession, params: unknown) {
    const { scheduler } = s.deps
    const { accountIds } = params as { accountIds: number[] | null }
    const ids = s.resolveAccountIds(accountIds)
    if (ids) ids.forEach((id) => scheduler.pollSoon(id, 0))
    else scheduler.pollAllSoon()
    return null
  }
}
