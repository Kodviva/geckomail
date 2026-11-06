import PostalMime from 'postal-mime'
import { createHash, createHmac } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, extname } from 'path'
import type { ImapFlow } from 'imapflow'
import type { MessageRow } from '../shared/rpc'
import { SEALED_ATTACHMENT_SUFFIX } from '../shared/attachmentFiles'
import { isCalendarAttachment } from '../shared/pim'
import { htmlToText } from '../shared/searchQuery'
import type { AccountRow, Queries } from './db/queries'
import { t } from '../shared/i18n'
import { STREAM_HARD_LIMIT } from './smime/limits'
import { classifyRaw, classifyStructure } from './smime/mime'
import type { SigEvaluator } from './smime/open'
import { closedSmimeEvaluator, isEncryptedRoot, markUnsupported, processSignedFetch } from './smime/receive'
import { readSealed, writeSealed } from './smime/sealedFile'
import { getVaultKey, isVaultUnlocked } from './vault/state'

const WHOLE_FETCH_LIMIT = 1_000_000 // 1MB altı: tüm kaynak tek seferde
/** Kasa ekinin kullanıcı açınca çözülen kopyaları: kilitte ve açılışta silinir */
const VAULT_OPEN_DIR = 'vault-open'

/** Akış sınırı aşıldı: S/MIME iletisi eksik baytla açılmaz, durum notu alır */
export class BodyTooLargeError extends Error {
  constructor() {
    super(t('sync.body.tooLarge'))
    this.name = 'BodyTooLargeError'
  }
}

export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += b.length
    if (total > STREAM_HARD_LIMIT) throw new BodyTooLargeError()
    chunks.push(b)
  }
  return Buffer.concat(chunks)
}

function makePreview(text: string | null, html: string | null): string {
  const src = text && text.trim() ? text : (html ?? '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  return src.replace(/\s+/g, ' ').trim().slice(0, 160)
}

function safeExt(filename: string | null): string {
  const e = filename ? extname(filename) : ''
  return /^\.[a-zA-Z0-9]{1,8}$/.test(e) ? e.toLowerCase() : ''
}

function writeAttachmentFile(dir: string, accountId: number, content: Buffer, filename: string | null, sealed = false): string {
  const sub = join(dir, String(accountId))
  mkdirSync(sub, { recursive: true })
  if (sealed) {
    const key = getVaultKey()
    if (!key) throw new Error(t('sync.vault.locked'))
    // düz özet adı içeriği ele verirdi (bilinen dosya sınaması), uzantı da türü
    const path = join(sub, createHmac('sha256', key).update(content).digest('hex').slice(0, 32) + SEALED_ATTACHMENT_SUFFIX)
    writeSealed(path, content)
    return path
  }
  const name = createHash('sha256').update(content).digest('hex').slice(0, 32) + safeExt(filename)
  const p = join(sub, name)
  writeFileSync(p, content)
  return p
}

/** Önbellekteki ekin baytları: mühürlüyse kasa açık olmalı */
export function readStoredAttachment(path: string): Buffer {
  if (!path.endsWith(SEALED_ATTACHMENT_SUFFIX)) return readFileSync(path)
  if (!isVaultUnlocked()) throw new Error(t('sync.vault.locked'))
  return readSealed(path)
}

/** İşletim sisteminde açmak ya da indirmek için düz kopya. Yalnız kullanıcı isteyince; önbelleğe bağlanmaz */
export function openSealedAttachment(path: string, attachDir: string, att: { id: number; filename: string | null }): string {
  const dir = join(attachDir, VAULT_OPEN_DIR)
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `${att.id}${safeExt(att.filename)}`)
  writeFileSync(out, readStoredAttachment(path), { mode: 0o600 })
  return out
}

export function clearVaultOpen(attachDir: string): void {
  rmSync(join(attachDir, VAULT_OPEN_DIR), { recursive: true, force: true })
}

/** Kasadan çıkan hesap: mühürlü ekler hesabın düz gövdeleriyle aynı kurala döner, kasa kilitliyken de okunur */
export function unsealAccountAttachments(q: Queries, accountId: number, attachDir: string): void {
  const sealed = new Set<string>()
  for (const a of q.sealedAttachmentsOf(accountId)) {
    if (!existsSync(a.disk_path)) continue
    q.setAttachmentPath(a.id, writeAttachmentFile(attachDir, accountId, readStoredAttachment(a.disk_path), a.filename))
    sealed.add(a.disk_path)
  }
  for (const p of sealed) rmSync(p, { force: true })
}

const P7_SIGNATURE = /^application\/(x-)?pkcs7-signature$/

interface BodyPartRef {
  part: string
  type: string
}

// bodyStructure ağacından text parçaları ve ek listesi çıkar (büyük mesaj yolu)
function walkStructure(node: unknown, out: { texts: BodyPartRef[]; attachments: Array<{ part: string; filename: string | null; mime: string | null; size: number | null; contentId: string | null }> }): void {
  if (!node || typeof node !== 'object') return
  const n = node as {
    part?: string
    type?: string
    disposition?: string
    size?: number
    id?: string
    childNodes?: unknown[]
    dispositionParameters?: { filename?: string }
    parameters?: { name?: string }
  }
  if (n.childNodes?.length) {
    for (const c of n.childNodes) walkStructure(c, out)
    return
  }
  const part = n.part ?? '1'
  const type = (n.type ?? '').toLowerCase()
  if (P7_SIGNATURE.test(type)) return // imza eki listelenmez
  const named = n.dispositionParameters?.filename || n.parameters?.name || null
  // takvim parçası çoğu daveti adsız gelir: gövde değil, karta okunacak ektir
  if (n.disposition === 'attachment' || (named && !type.startsWith('text/')) || isCalendarAttachment({ mime: type, filename: named })) {
    out.attachments.push({ part, filename: named, mime: type || null, size: n.size ?? null, contentId: n.id ?? null })
  } else if ((type === 'text/plain' || type === 'text/html') && !out.texts.some((t) => t.type === type)) {
    out.texts.push({ part, type })
  }
}

function decodeText(buf: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf)
  } catch {
    return buf.toString('utf-8')
  }
}

type BodyMessage = MessageRow & { folderPath?: string }

/** Şifreli ileti diske hiç düz yazılmaz: gövde, ek, önizleme ve gövde indeksi yoktur; dış konu ve adresler FTS'te kalır */
function saveEncrypted(q: Queries, message: BodyMessage, size: number): void {
  q.tx(() => {
    q.saveBody(message.id, null, null, size)
    q.clearAttachments(message.id)
    q.setPreview(message.id, '')
    q.setHasAttachments(message.id, false)
    q.setSmimeKind(message.id, 'encrypted')
    q.ftsUpsert(message.id, message.subject, `${message.fromName ?? ''} ${message.fromAddr ?? ''}`, message.toJson, null)
  })
}

async function parseAndSave(q: Queries, account: AccountRow, message: BodyMessage, source: Buffer, size: number, attachDir: string): Promise<void> {
  const parsed = await PostalMime.parse(source)
  const text = parsed.text ?? null
  const html = parsed.html ?? null
  q.tx(() => {
    q.saveBody(message.id, text, html, size)
    q.clearAttachments(message.id)
    let anyAttachment = false
    for (const a of parsed.attachments ?? []) {
      // postal-mime metin eklerini Uint8Array verir: String() onları "66,69,71" diye yazardı
      const content = typeof a.content === 'string' ? Buffer.from(a.content) : Buffer.from(ArrayBuffer.isView(a.content) ? a.content : new Uint8Array(a.content))
      const diskPath = content.length ? writeAttachmentFile(attachDir, account.id, content, a.filename ?? null, !!account.secure) : null
      q.insertAttachment({
        messageId: message.id,
        partId: null,
        filename: a.filename ?? null,
        mime: a.mimeType ?? null,
        size: content.length || null,
        contentId: a.contentId?.replace(/[<>]/g, '') ?? null,
        diskPath
      })
      if (a.disposition !== 'inline' || !a.contentId) anyAttachment = true
    }
    q.setHasAttachments(message.id, anyAttachment)
    q.setPreview(message.id, makePreview(text, html))
    q.ftsUpsert(
      message.id,
      message.subject,
      `${message.fromName ?? ''} ${message.fromAddr ?? ''}`,
      message.toJson,
      text?.trim() ? text : htmlToText(html ?? '')
    )
  })
}

/** Doğrulama anı IMAP INTERNALDATE: Date: ve signingTime gönderenin elindedir */
async function internalDateOf(client: ImapFlow, uid: number): Promise<number> {
  const one = await client.fetchOne(String(uid), { uid: true, internalDate: true }, { uid: true })
  const at = one && typeof one !== 'boolean' && one.internalDate ? new Date(one.internalDate).getTime() : NaN
  if (!Number.isFinite(at)) throw new Error(t('sync.body.downloadFailed'))
  return at
}

/** Kök S/MIME ise işler. false: eski görünüm yolu sürer (rozeti `unsupported`). */
async function saveSmime(q: Queries, account: AccountRow, message: BodyMessage, raw: Buffer, client: ImapFlow, attachDir: string, evaluate: SigEvaluator): Promise<boolean> {
  if (isEncryptedRoot(raw)) {
    saveEncrypted(q, message, raw.length)
    return true
  }
  const opened = await processSignedFetch(q, message, raw, await internalDateOf(client, message.uid), evaluate)
  if (!opened) return false
  if (opened.nestedEncrypted) saveEncrypted(q, message, raw.length)
  else await parseAndSave(q, account, message, opened.signedEntity, raw.length, attachDir)
  return true
}

export async function fetchBody(
  q: Queries,
  account: AccountRow,
  message: BodyMessage,
  client: ImapFlow,
  attachDir: string,
  evaluate: SigEvaluator = closedSmimeEvaluator
): Promise<void> {
  const lock = await client.getMailboxLock(message.folderPath ?? 'INBOX')
  try {
    if ((message.size ?? 0) < WHOLE_FETCH_LIMIT) {
      const dl = await client.download(String(message.uid), undefined, { uid: true })
      if (!dl?.content) throw new Error(t('sync.body.downloadFailed'))
      const raw = await streamToBuffer(dl.content)
      if (classifyRaw(raw) !== 'none' && (await saveSmime(q, account, message, raw, client, attachDir, evaluate))) return
      await parseAndSave(q, account, message, raw, raw.length, attachDir)
      return
    }

    // Büyük mesaj: sadece text parçaları; ekler tıklanınca parça parça
    const one = await client.fetchOne(String(message.uid), { uid: true, bodyStructure: true }, { uid: true })
    const structure = one && typeof one !== 'boolean' ? one.bodyStructure : undefined
    const kind = message.smimeKind ?? classifyStructure(structure)
    if (kind) {
      // imza ve şifre tüm ham iletiyi ister
      try {
        const dl = await client.download(String(message.uid), undefined, { uid: true })
        if (!dl?.content) throw new Error(t('sync.body.downloadFailed'))
        if (await saveSmime(q, account, message, await streamToBuffer(dl.content), client, attachDir, evaluate)) return
      } catch (e) {
        if (!(e instanceof BodyTooLargeError)) throw e
        if (kind === 'encrypted') {
          saveEncrypted(q, message, message.size ?? 0)
          return
        }
        markUnsupported(q, message.id, ['too_large']) // doğrulanamadı: görünüm eski büyük yoldan
      }
    }
    const refs = { texts: [] as BodyPartRef[], attachments: [] as Array<{ part: string; filename: string | null; mime: string | null; size: number | null; contentId: string | null }> }
    walkStructure(structure, refs)
    let text: string | null = null
    let html: string | null = null
    for (const t of refs.texts) {
      const dl = await client.download(String(message.uid), t.part, { uid: true })
      if (!dl?.content) continue
      const buf = await streamToBuffer(dl.content)
      const meta = dl.meta as { charset?: string } | undefined
      const decoded = decodeText(buf, meta?.charset)
      if (t.type === 'text/plain') text = decoded
      else html = decoded
    }
    q.tx(() => {
      q.saveBody(message.id, text, html, message.size ?? 0)
      q.clearAttachments(message.id)
      for (const a of refs.attachments) {
        q.insertAttachment({
          messageId: message.id,
          partId: a.part,
          filename: a.filename,
          mime: a.mime,
          size: a.size,
          contentId: a.contentId?.replace(/[<>]/g, '') ?? null,
          diskPath: null
        })
      }
      q.setHasAttachments(message.id, refs.attachments.length > 0)
      q.setPreview(message.id, makePreview(text, html))
      q.ftsUpsert(
        message.id,
        message.subject,
        `${message.fromName ?? ''} ${message.fromAddr ?? ''}`,
        message.toJson,
        text?.trim() ? text : htmlToText(html ?? '')
      )
    })
  } finally {
    lock.release()
  }
}

/** Çözüm için ham ileti + INTERNALDATE. Sınır aşılırsa BodyTooLargeError. */
export async function fetchSmimeRaw(message: BodyMessage, client: ImapFlow): Promise<{ raw: Buffer; internalDate: number }> {
  const lock = await client.getMailboxLock(message.folderPath ?? 'INBOX')
  try {
    const dl = await client.download(String(message.uid), undefined, { uid: true })
    if (!dl?.content) throw new Error(t('sync.body.downloadFailed'))
    return { raw: await streamToBuffer(dl.content), internalDate: await internalDateOf(client, message.uid) }
  } finally {
    lock.release()
  }
}

/** Bildirim kuralı için ileti metni: önbellekte yoksa indirir. Kasa hesabına dokunmaz. */
export async function fetchNotifyBodyText(
  q: Queries,
  messageId: number,
  download: (message: MessageRow & { folderPath?: string }) => Promise<void>
): Promise<string | null> {
  const msg = q.getMessage(messageId)
  if (!msg || msg.smimeKind === 'encrypted' || q.getAccountRow(msg.accountId)?.secure !== 0) return null
  if (!q.getBodyRow(messageId)) await download(msg)
  const body = q.getBodyRow(messageId)
  if (!body) return null
  return body.text_plain?.trim() ? body.text_plain : htmlToText(body.html ?? '')
}

export async function fetchRawHeaders(message: MessageRow & { folderPath?: string }, client: ImapFlow): Promise<string> {
  const lock = await client.getMailboxLock(message.folderPath ?? 'INBOX')
  try {
    const one = await client.fetchOne(String(message.uid), { uid: true, headers: true }, { uid: true })
    if (!one || typeof one === 'boolean' || !one.headers) return ''
    return Buffer.isBuffer(one.headers) ? one.headers.toString('utf-8') : String(one.headers)
  } finally {
    lock.release()
  }
}

export async function fetchRawSource(message: MessageRow & { folderPath?: string }, client: ImapFlow): Promise<Buffer> {
  const lock = await client.getMailboxLock(message.folderPath ?? 'INBOX')
  try {
    const dl = await client.download(String(message.uid), undefined, { uid: true })
    if (!dl?.content) throw new Error(t('sync.body.downloadFailed'))
    return await streamToBuffer(dl.content)
  } finally {
    lock.release()
  }
}

/** Ek parçasını diske yazmadan okur: kasa hesabında davet kartı kalıcı dosya bırakmaz */
export async function downloadAttachmentPart(
  message: MessageRow & { folderPath?: string },
  attachment: { part_id: string | null },
  client: ImapFlow
): Promise<Buffer> {
  if (!attachment.part_id) throw new Error(t('sync.body.noPartId'))
  const lock = await client.getMailboxLock(message.folderPath ?? 'INBOX')
  try {
    const dl = await client.download(String(message.uid), attachment.part_id, { uid: true })
    if (!dl?.content) throw new Error(t('sync.body.attachmentDownloadFailed'))
    return await streamToBuffer(dl.content)
  } finally {
    lock.release()
  }
}

export async function fetchAttachmentPart(
  q: Queries,
  account: AccountRow,
  message: MessageRow & { folderPath?: string },
  attachment: { id: number; part_id: string | null; filename: string | null },
  client: ImapFlow,
  attachDir: string
): Promise<string> {
  const buf = await downloadAttachmentPart(message, attachment, client)
  const p = writeAttachmentFile(attachDir, account.id, buf, attachment.filename, !!account.secure)
  q.setAttachmentPath(attachment.id, p)
  return p
}
