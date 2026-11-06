// RPC — Gönderim: yeni mail, takip, şablonlar, giden kutusu. Yetki kapısı (giriş / yönetici) RpcSession.handle'da; hesap düzeyi kontroller burada.
import { createHash, createHmac, randomBytes } from 'crypto'
import { copyFileSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DraftOut, OutboxItem, SmimeRequest } from '../../shared/rpc'
import { SMIME_MAX_BCC } from '../../shared/smime'
import { addressesOf } from '../smime/build'
import { loadSignKey, ownEncryptCert, resolveRecipients } from '../smime/identity'
import { OPTIMISTIC_HIDE_OPS } from '../db/q/types'
import { sealFile } from '../smime/sealedFile'
import { newMessageId } from '../smtpSend'
import { getVaultStatus } from '../vault/manager'
import type { RpcSession } from '../rpcSession'
import { type Handler, OUTBOX_TOTAL_LIMIT, outboxFileName } from './common'
import { t } from '../../shared/i18n'

/** Aynı dosya sisteminde taşır; değilse kopyalayıp siler */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

const MIME_RE = /^[\w.+-]{1,64}\/[\w.+-]{1,128}$/
const SEND_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Yeniden deneme penceresi: aynı clientSendId bu süre içinde tek gönderimdir */
const SEND_ID_TTL_MS = 24 * 60 * 60 * 1000
const SEND_HASH_PREF = 'send_hash_key'
const isUnsealed = (blob: Uint8Array, plain: string): boolean => Buffer.from(blob).toString('utf-8') === plain

/** Şifreli gönderimlerin özet anahtarı: bir kez üretilir, ev sahibinin şifrelemesiyle mühürlenip tercih olarak saklanır; böylece
 *  yeniden başlatmadan sonraki yeniden deneme de aynı gönderim sayılır (çift teslim olmaz), düz DB okuyan içerik tahmini yapamaz.
 *  Çözülemeyen kayıt (ev sahibi anahtarı değişmiş) yeniden üretilir. Eşzamanlı çağrılar tek yüklemeyi paylaşır.
 *  Mühür gerçek değilse (masaüstü `plain` politikası, encrypt baytları aynen döner) anahtar yalnız bellekte kalır: diskteki düz
 *  anahtar özeti korumazdı. Bedeli: yeniden başlatmadan sonraki yeniden deneme yeni gönderim sayılır. */
function sendHashKey(s: RpcSession): Promise<Buffer> {
  const hub = s.hub
  hub.sendHashKeyLoad ??= (async () => {
    const { q, encrypt, decrypt } = s.deps
    const stored = q.prefGet(SEND_HASH_PREF)
    if (stored) {
      try {
        const bytes = Buffer.from(stored, 'base64')
        const [hex] = await decrypt([new Uint8Array(bytes)])
        if (/^[0-9a-f]{64}$/.test(hex ?? '') && !isUnsealed(bytes, hex)) return Buffer.from(hex, 'hex')
      } catch {
        /* çözülemedi: yeni anahtar */
      }
    }
    const key = randomBytes(32)
    const hex = key.toString('hex')
    const [sealed] = await encrypt([hex])
    q.prefSet(SEND_HASH_PREF, isUnsealed(sealed, hex) ? '' : Buffer.from(sealed).toString('base64'))
    return key
  })().catch((e) => {
    hub.sendHashKeyLoad = undefined // sonraki çağrı yeniden dener
    throw e
  })
  return hub.sendHashKeyLoad
}

/** Gönderimin içerik özeti: aynı kimlikle gelen çağrı gerçekten aynı ileti mi. Ekler ad + boyutla (uploadId yeniden
 *  yüklemede değişir, içerik aynıdır; yükleme ilk çağrıda tüketildiği için boyut sunucudan değil çağrıdan gelir). */
export function sendContentHash(draft: DraftOut, sendAt: number | undefined, smime?: SmimeRequest, key?: Buffer): string {
  // şifreli iletide düz özet diskte tahmin sınaması olurdu: HMAC, anahtarı sendHashKey verir (kalıcı, mühürlü). Anahtarsız şifreli
  // özet düz özete düşmez
  if (smime?.encrypt && !key) throw new Error('sendContentHash: şifreli gönderim için anahtar gerekir')
  const digest = smime?.encrypt ? createHmac('sha256', key!) : createHash('sha256')
  const addrs = (v: string | undefined): string[] => (v ?? '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean)
  const body = (v: string | undefined): string => (v ?? '').replace(/\r\n/g, '\n').trimEnd()
  return digest.update(JSON.stringify([
    draft.accountId, addrs(draft.to), addrs(draft.cc), addrs(draft.bcc), draft.subject.trim(), body(draft.text), body(draft.html),
    sendAt ?? null, (draft.attachments ?? []).map((a) => [a.filename, a.size ?? a.data?.byteLength ?? null]),
    ...(smime?.sign || smime?.encrypt ? [!!smime.sign || !!smime.encrypt, !!smime.encrypt] : [])
  ])).digest('hex')
}

/** Kuyruğa girmeden zaman uyumlu denetim (sendMail await içermez). Kripto op kuyruğundadır, orada yinelenir. */
function checkSmime(s: RpcSession, email: string, draft: DraftOut, smime: SmimeRequest | undefined): { sign: boolean; encrypt: boolean; userId: number } | null {
  if (!smime?.sign && !smime?.encrypt) return null
  const { q } = s.deps
  const userId = s.currentUser!.id
  const encrypt = !!smime.encrypt
  const vault = getVaultStatus(q)
  if (vault !== 'unlocked') throw new Error(t(vault === 'none' ? 'sync.smime.vaultNone' : 'sync.smime.vaultLocked'))
  const now = s.hub.now()
  try {
    loadSignKey(q, userId, email, now)
  } catch {
    throw new Error(t('sync.smime.noIdentity'))
  }
  if (encrypt) {
    const bcc = addressesOf(draft.bcc)
    if (bcc.length > SMIME_MAX_BCC) throw new Error(t('sync.smime.tooManyBcc', { max: String(SMIME_MAX_BCC) }))
    if (!ownEncryptCert(q, userId, email, now)) throw new Error(t('sync.smime.ownCertMissing'))
    const addresses = [...addressesOf(draft.to), ...addressesOf(draft.cc), ...bcc]
    const resolved = resolveRecipients(q, { userId, addresses, now })
    const statuses = addresses.map((a) => resolved.get(a)?.status)
    if (statuses.some((st) => st !== 'ok' && st !== 'crl_pending')) throw new Error(t('sync.smime.recipientBlocked'))
    if (statuses.includes('crl_pending')) throw new Error(t('sync.smime.recipientPending'))
  }
  return { sign: true, encrypt, userId } // şifreli gönderim her zaman imzalı
}

export const composeHandlers: Record<string, Handler> = {
  async sendMail(s: RpcSession, params: unknown) {
    const { q, opq, attachDir } = s.deps
    const { draft, sendAt, followupDays, closeFollowupId, clientSendId, smime } = params as {
      draft: DraftOut; sendAt?: number; followupDays?: number; closeFollowupId?: number; clientSendId?: string; smime?: SmimeRequest
    }
    // tek await ve en başta: kalan denetim, yineleme bakışı ve kuyruğa alma kesintisiz (zaman uyumlu) çalışır
    const hashKey = smime?.encrypt ? await sendHashKey(s) : undefined
    s.assertCanManage(draft.accountId)
    if (!draft.to.trim()) throw new Error(t('sync.compose.noRecipient'))
    // tekrar denetiminden önce: silinen hesaba yeniden deneme yanlış başarı dönüp taslağı silmesin
    const from = q.getAccountRow(draft.accountId)
    if (!from) throw new Error(t('sync.err.accountNotFound'))
    // yanıtı kaybolan çağrının yeniden denemesi: aynı içerik kuyrukta ya da gönderilmişse başarı döner. Eklerden önce:
    // yüklemeler ilk çağrıda tüketildi. İçerik değiştiyse ya da işlem başarısız olduysa bu yeni bir gönderimdir (düzenleme
    // sessizce kaybolmasın; yanıtı kaybolan ilki de gitmişse iki sürüm gider, o geri alınamaz). Biçimsiz kimlik yok sayılır
    const sendId = typeof clientSendId === 'string' && SEND_ID_RE.test(clientSendId) ? clientSendId : null
    const senderId = s.currentUser!.id
    const contentHash = sendContentHash(draft, sendAt, smime, hashKey)
    if (sendId) {
      const prior = q.sendIdRecord(sendId, senderId, Date.now() - SEND_ID_TTL_MS)
      if (prior && prior.contentHash === contentHash && !prior.failed) return null
    }
    const smimeReq = checkSmime(s, from.email, draft, smime)
    const files = draft.attachments ?? []
    // web: { uploadId } eki önceden HTTP ile yüklenmiştir; yalnız yükleyen web oturumu kullanabilir (kimlik tahmini
    // ya da başka oturumun kimliği işe yaramaz). Hepsi doğrulanmadan hiçbiri tüketilmez.
    const seen = new Set<string>()
    const resolved = files.map((f) => {
      if (f.uploadId == null) {
        // sunucu modunda (web) içerik yalnız HTTP yüklemesiyle gelir: JSON'daki "data" keyfî bir nesnedir
        // ({length: 2e9} boyutu 0 sayılır, Buffer.from 2 GB ayırırdı)
        if (s.hub.mode === 'server' || s.webSessionId != null) throw new Error(t('sync.compose.uploadInvalid'))
        if (!(f.data instanceof Uint8Array) || typeof f.filename !== 'string') throw new Error(t('sync.compose.attachmentInvalid'))
        return { f, up: null, size: f.data.byteLength }
      }
      const id = String(f.uploadId)
      const up = s.webSessionId && !seen.has(id) ? (s.hub.uploads?.get(id, s.webSessionId) ?? null) : null
      if (!up) throw new Error(t('sync.compose.uploadInvalid'))
      seen.add(id)
      return { f, up: { id, ...up }, size: up.size }
    })
    const total = resolved.reduce((n, r) => n + r.size, 0)
    if (total > OUTBOX_TOTAL_LIMIT) throw new Error(t('sync.compose.attachmentsTooLarge'))
    // ek verisi kuyruğa değil diske: op payload yalnızca yol taşır. Biri başarısız olursa öncekiler geri alınır
    // (yüklenenler geçici yerine döner, yazılanlar silinir); hata yol içermez.
    const outAttachments: { path: string; filename: string; mime: string; sealed?: boolean }[] = []
    const undo: { path: string; back: string | null }[] = []
    try {
      const dir = join(attachDir, '..', 'outbox')
      mkdirSync(dir, { recursive: true })
      resolved.forEach(({ f, up }, i) => {
        const filename = up ? up.filename : f.filename
        // şifreli iletide dosya adı da gizlidir (K9)
        const diskName = smimeReq?.encrypt ? randomBytes(12).toString('hex') : filename.replace(/[^\w.-]/g, '_').slice(-60)
        const path = join(dir, outboxFileName(draft.accountId, `${Date.now()}-${s.undoSeq}-${i}-${diskName}`))
        if (up) {
          // yüklenen geçici dosya kuyruğun dosyası olur: gönderim onu tüketir
          moveFile(up.path, path)
          undo.push({ path, back: up.path })
          outAttachments.push({ path, filename, mime: MIME_RE.test(f.mime ?? '') ? f.mime : 'application/octet-stream' })
        } else {
          undo.push({ path, back: null })
          writeFileSync(path, f.data!)
          outAttachments.push({ path, filename, mime: f.mime })
        }
      })
      if (smimeReq?.encrypt) {
        outAttachments.forEach((a, i) => {
          sealFile(a.path)
          a.sealed = true
          undo[i].back = null // mühürlü dosya yükleme yerine dönemez
        })
      }
    } catch {
      for (const u of undo) {
        try {
          if (u.back) moveFile(u.path, u.back)
          else rmSync(u.path, { force: true })
        } catch {
          rmSync(u.path, { force: true })
        }
      }
      throw new Error(t('sync.compose.attachmentsSaveFailed'))
    }
    for (const r of resolved) if (r.up) s.hub.uploads!.consume(r.up.id)
    const draftMeta = { ...draft }
    delete draftMeta.attachments
    // Message-ID kuyruğa alınırken sabitlenir: yeniden deneme aynı maili aynı kimlikle gönderir
    const payload = { draft: draftMeta, attachments: outAttachments, senderId, meta: { messageId: newMessageId(from.email) }, ...(smimeReq ? { smime: smimeReq } : {}) }
    // sonra-gönder: gelecekteki not_before ile kuyruğa al; drain döngüsü zamanı gelince gönderir
    const scheduled = typeof sendAt === 'number' && sendAt > Date.now() + 30_000
    const seal = { seal: !!smimeReq } // S/MIME op'u kasa dışı hesapta da mühürlüdür
    const opId = scheduled ? q.enqueueOpDelayed(draft.accountId, 'smtp_send', payload, sendAt, seal) : q.enqueueOp(draft.accountId, 'smtp_send', payload, seal)
    // işleyici await içermez: denetim ve kayıt arasına aynı kimlikli başka çağrı giremez
    if (sendId) q.recordSendId(sendId, senderId, contentHash, opId)
    // takip (R30): gönderim anından itibaren N gün içinde yanıt gelmezse hatırlat
    const days = Number(followupDays)
    if (Number.isFinite(days) && days >= 1 && days <= 60) {
      q.addFollowup({
        accountId: draft.accountId, opId, messageId: payload.meta.messageId, subject: draft.subject || null, to: draft.to, userId: s.currentUser?.id,
        dueAt: (scheduled ? sendAt : Date.now()) + Math.round(days) * 86_400_000
      })
    }
    if (closeFollowupId) {
      const f = q.getFollowup(Number(closeFollowupId))
      if (f && f.account_id === draft.accountId) {
        q.closeFollowup(f.id)
        s.broadcast('followups:changed', {})
      }
    }
    if (!scheduled) opq.kick()
    return null
  },

  async listFollowups(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    return q.listFollowups(s.resolveAccountIds(null))
  },

  async closeFollowup(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const f = q.getFollowup(Number((params as { id: number }).id))
    if (!f) return { ok: true }
    s.assertCanManage(f.account_id)
    q.closeFollowup(f.id)
    s.broadcast('followups:changed', {})
    return { ok: true }
  },

  async snoozeFollowup(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { id, days } = params as { id: number; days: number }
    const f = q.getFollowup(Number(id))
    if (!f) throw new Error(t('sync.compose.followupNotFound'))
    s.assertCanManage(f.account_id)
    q.snoozeFollowup(f.id, Date.now() + Math.min(Math.max(Number(days) || 1, 1), 60) * 86_400_000)
    s.broadcast('followups:changed', {})
    return { ok: true }
  },

  async listTemplates(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    return q.listTemplates(s.currentUser!.id)
  },

  async saveTemplate(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { name, subject, body, shared } = params as { name: string; subject: string | null; body: string; shared?: boolean }
    const nm = String(name ?? '').trim().slice(0, 120)
    if (!nm) throw new Error(t('sync.compose.templateNameEmpty'))
    if (typeof body !== 'string' || body.length > 100_000) throw new Error(t('sync.compose.templateBodyInvalid'))
    // paylaşılan şablonu yalnız admin yazar. Belirtilmezse admin paylaşılan kaydeder (masaüstündeki gibi
    // herkese ortak ve cihaz senkronunda), üye kişisel
    const isAdmin = s.currentUser!.role === 'admin'
    if (shared && !isAdmin) throw new Error(t('sync.perm.adminRequired'))
    const isShared = shared ?? isAdmin
    q.saveTemplate({ name: nm, subject: subject ? String(subject).slice(0, 500) : null, body, shared: isShared }, isShared ? null : s.currentUser!.id)
    return { ok: true }
  },

  async deleteTemplate(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { name: raw, shared } = params as { name: string; shared?: boolean }
    const name = String(raw ?? '')
    const me = s.currentUser!
    // shared verilmezse: önce kişisel kopya, yoksa paylaşılan (yalnız admin)
    const target = shared ?? !q.templateExists(name, me.id)
    if (!target) {
      q.deleteTemplate(name, me.id)
      return { ok: true }
    }
    if (shared == null && !q.templateExists(name, null)) return { ok: true } // hiç yok: etkisiz
    if (me.role !== 'admin') throw new Error(t('sync.perm.adminRequired'))
    q.deleteTemplate(name, null)
    return { ok: true }
  },

  async listOutbox(s: RpcSession, _params: unknown) {
    const { q } = s.deps
    const visible = s.resolveAccountIds(null)
    // istek anındaki dilde (arayüz dili değişebilir; modül düzeyinde sabit tutulmaz)
    const KIND: Record<string, string> = {
      smtp_send: t('sync.opKind.smtpSend'), append_sent: t('sync.opKind.appendSent'), store_flags: t('sync.opKind.storeFlags'),
      trash: t('sync.opKind.trash'), move: t('sync.opKind.move'), move_special: t('sync.opKind.moveSpecial'),
      move_named: t('sync.opKind.moveNamed'), forward: t('sync.opKind.forward'), mark_all_seen: t('sync.opKind.markAllSeen'),
      call_webhook: t('sync.opKind.callWebhook')
    }
    return q.listOps(visible).map((o): OutboxItem => {
      const p = JSON.parse(o.payload_json) as { draft?: DraftOut; uids?: number[]; to?: string }
      return {
        id: o.id, accountId: o.account_id, email: q.getAccountRow(o.account_id)?.email ?? null, kind: o.kind,
        kindLabel: KIND[o.kind] ?? o.kind, state: o.state === 'failed' ? 'failed' : 'pending',
        to: o.locked ? null : (p.draft?.to ?? p.to ?? null), subject: o.locked ? null : (p.draft?.subject ?? null),
        count: Array.isArray(p.uids) ? p.uids.length : null,
        scheduledAt: o.not_before && o.not_before > Date.now() + 30_000 ? o.not_before : null,
        attempts: o.attempts, lastError: o.last_error, createdAt: o.created_at, locked: o.locked
      }
    })
  },

  async cancelOp(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { id } = params as { id: number }
    const op = q.getOp(id)
    if (!op) throw new Error(t('sync.compose.opNotFoundMaybeDone'))
    s.assertCanManage(op.account_id)
    if (op.state === 'running') throw new Error(t('sync.compose.opNotFoundMaybeDone')) // işleniyor: artık iptal edilemez
    const p = JSON.parse(op.payload_json) as { attachments?: { path: string }[]; folderPath?: string; uids?: number[] }
    // kayıtlar işlem satırıyla eşleştirilir: satır silinmeden
    if (op.kind === 'smtp_send') {
      q.deleteFollowupsForOp(id) // gönderilmeyen mailin takibi olmaz
      q.forgetSendIdForOp(id)
    }
    q.opDone(id)
    if (op.kind === 'smtp_send') for (const a of p.attachments ?? []) rmSync(a.path, { force: true })
    // taşıma/silme iptal (bekleyen ya da başarısız): iyimser gizlenen mesajlar geri görünsün
    if (OPTIMISTIC_HIDE_OPS.has(op.kind) && p.folderPath && p.uids) {
      q.unhideByFolderUids(op.account_id, p.folderPath, p.uids)
      s.broadcast('messages:changed', { accountId: op.account_id })
    }
    return null
  },

  async retryOp(s: RpcSession, params: unknown) {
    const { q, opq } = s.deps
    const { id } = params as { id: number }
    const op = q.getOp(id)
    if (!op) throw new Error(t('sync.compose.opNotFound'))
    s.assertCanManage(op.account_id)
    if (op.state === 'running') return null // işleniyor: ikinci kopya çalışmasın
    q.opResetForRetry(id)
    opq.kick()
    return null
  },

  async getOpDraft(s: RpcSession, params: unknown) {
    const { q } = s.deps
    const { id } = params as { id: number }
    const op = q.getOp(id)
    if (!op || op.kind !== 'smtp_send') return null
    s.assertCanManage(op.account_id)
    const p = JSON.parse(op.payload_json) as { draft: DraftOut; smime?: { sign: boolean; encrypt: boolean; userId: number }; smimeSent?: number }
    if ((p.smimeSent ?? 0) > 0) return null // ana parça gitti: taslağa dönüşürse To/Cc ikinci kez alır
    // şifreli taslak yalnız gönderenindir: düz metin görmeyecek yetkili de iptal/yeniden dene yapabilir, okuyamaz
    if (p.smime?.encrypt && p.smime.userId !== s.currentUser!.id) return null
    // bayraklar taslakla döner: şifreli taslak oluşturucuda da şifreli kalır, cihaza düz yazılmaz
    return p.smime ? { ...p.draft, smime: { sign: p.smime.sign, encrypt: p.smime.encrypt } } : p.draft
  }
}
