import { credentialFor, xoauth2 } from './oauth'
import { randomUUID } from 'crypto'
import MailComposer from 'nodemailer/lib/mail-composer'
import SMTPConnection from 'nodemailer/lib/smtp-connection'
import { mailEndpoint } from './net/mailNet'
import type { DraftOut } from '../shared/rpc'
import type { AccountRow } from './db/queries'
import { t } from '../shared/i18n'
import { readSealed } from './smime/sealedFile'

export function splitAddresses(s: string | undefined): string[] {
  return (s ?? '')
    .split(/[,;]/)
    .map((a) => a.trim())
    .filter(Boolean)
}

// Otomatik iletilen maile konur; kural motoru bu başlığı taşıyan mailde forward çalıştırmaz
// (A→B, B→A iletme kuralları sonsuz döngü / mail fırtınası kurmasın).
export const FORWARD_MARK_HEADER = 'X-GeckoMail-Forwarded'

/** Kuyruğa alınırken bir kez üretilir: yeniden denemede aynı mail aynı kimlikle gider (alıcı tekilleştirir). */
export function newMessageId(fromEmail: string): string {
  const domain = fromEmail.split('@')[1]?.replace(/[^a-z0-9.-]/gi, '') || 'geckomail.local'
  return `<${randomUUID()}@${domain}>`
}

export interface OutboxAttachment {
  path: string
  filename: string
  mime: string
  /** şifreli gönderimde dosya kasa anahtarıyla mühürlüdür */
  sealed?: boolean
}

export interface SendMeta {
  messageId: string
  date: number
  autoForwarded?: boolean
  /** RFC 6047: gövdenin yanına text/calendar alternatifi */
  ical?: { method: 'REPLY'; content: string }
}

export async function composeRaw(
  account: AccountRow,
  draft: DraftOut,
  attachments: OutboxAttachment[] = [],
  meta?: SendMeta
): Promise<Buffer> {
  const mail = new MailComposer({
    from: account.display_name ? { name: account.display_name, address: account.email } : account.email,
    to: draft.to,
    cc: draft.cc || undefined,
    bcc: draft.bcc || undefined,
    subject: draft.subject,
    text: draft.text,
    html: draft.html || undefined,
    inReplyTo: draft.inReplyTo || undefined,
    references: draft.references || undefined,
    messageId: meta?.messageId,
    date: meta ? new Date(meta.date) : undefined,
    headers: meta?.autoForwarded ? { [FORWARD_MARK_HEADER]: '1' } : undefined,
    icalEvent: meta?.ical,
    attachments: attachments.length
      ? attachments.map((a) => ({ filename: a.filename, path: a.path, contentType: a.mime || undefined }))
      : undefined
  })
  return await mail.compile().build()
}

const MIME_HEADER = /^content-/i

/** "From " satırı mbox aktarımında ">From" olur, imza kırılır. Yalnız QP gövdede bulunabilir (başlıklar ":" taşır, base64 boşluk taşımaz). */
const protectFromLines = (b: string): string => b.replace(/^From /gm, '=46rom ')

/** Oluşturucu LF gönderir; SMTP DATA akışı çıplak LF'yi CRLF yapar. İmza bu dönüşümden önce atıldığı için gövde önceden kanonik olmalı. */
const crlf = (s: string): string => s.replace(/\r\n?|\n/g, '\r\n')

/** İmzalanacak MIME varlığı + dış başlıklar. Tüm gövdeler QP veya base64: taşıma sırasında bayt değişirse imza kırılırdı.
 *  Bcc hiçbir parçada yoktur. composeRaw davranışı değişmez. */
export async function composeEntity(account: AccountRow, draft: DraftOut, attachments: OutboxAttachment[], meta: SendMeta): Promise<{ outer: string; entity: Buffer }> {
  const qp = (content: string) => ({ content, contentTransferEncoding: 'quoted-printable' })
  const options = {
    from: account.display_name ? { name: account.display_name, address: account.email } : account.email,
    to: draft.to,
    cc: draft.cc || undefined,
    subject: draft.subject,
    text: qp(crlf(draft.text)),
    html: draft.html ? qp(crlf(draft.html)) : undefined,
    inReplyTo: draft.inReplyTo || undefined,
    references: draft.references || undefined,
    messageId: meta.messageId,
    date: new Date(meta.date),
    headers: meta.autoForwarded ? { [FORWARD_MARK_HEADER]: '1' } : undefined,
    icalEvent: meta.ical ? { ...meta.ical, content: crlf(meta.ical.content), contentTransferEncoding: 'quoted-printable' } : undefined,
    attachments: attachments.length
      ? attachments.map((a) => ({
          filename: a.filename,
          contentType: a.mime || undefined,
          contentTransferEncoding: 'base64',
          ...(a.sealed ? { content: readSealed(a.path) } : { path: a.path })
        }))
      : undefined
  }
  const built = (await new MailComposer(options as ConstructorParameters<typeof MailComposer>[0]).compile().build()).toString('latin1')
  const split = built.indexOf('\r\n\r\n')
  const lines = built.slice(0, split).split('\r\n')
  const outer: string[] = []
  const inner: string[] = []
  let target = outer
  for (const line of lines) {
    if (!/^[ \t]/.test(line)) target = MIME_HEADER.test(line) ? inner : outer
    target.push(line)
  }
  const body = protectFromLines(built.slice(split + 4))
  return {
    outer: `${outer.join('\r\n')}\r\n`,
    entity: Buffer.from(`${inner.join('\r\n')}\r\n\r\n${body}`, 'latin1')
  }
}

// Gönderim aşamaları: hata hangi aşamada olduğunu taşır. 'send' aşamasında (DATA sonrası) ağ kopması
// belirsizdir — mail alıcıya ulaşmış olabilir; otomatik yeniden deneme çift mail üretir.
export type SmtpPhase = 'connect' | 'auth' | 'send'

function tag(err: unknown, phase: SmtpPhase): Error {
  const e = (err instanceof Error ? err : new Error(String(err))) as Error & { phase?: SmtpPhase }
  e.phase = phase
  return e
}

/** envelopeTo: S/MIME parçasının alıcıları; verilmezse taslağın tüm alıcıları */
export async function smtpSendRaw(account: AccountRow, secret: string, draft: DraftOut, raw: Buffer, envelopeTo?: string[]): Promise<void> {
  const cred = await credentialFor(account, secret)
  const secure = account.smtp_tls !== 'starttls'
  const endpoint = await mailEndpoint(account.smtp_host, account.smtp_port).catch((e) => {
    throw tag(e, 'connect')
  })
  const conn = new SMTPConnection({
    host: endpoint.host,
    ...(endpoint.servername ? { servername: endpoint.servername } : {}),
    port: account.smtp_port,
    secure,
    // STARTTLS hesabında sunucu TLS'i reddederse şifreyi düz metin gönderme (indirgeme saldırısı)
    requireTLS: !secure,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    tls: { rejectUnauthorized: !account.allow_invalid_certs }
  })
  // Bağlantı/soket hataları çoğu zaman callback'e değil yalnız 'error' olayına gelir (nodemailer'ın kendi
  // transport'u da böyle dinler) — dinlemezsek aşama sözü hiç çözülmez ve op sonsuza dek asılı kalır.
  let phase: SmtpPhase = 'connect'
  let failCurrent: ((e: Error) => void) | null = null
  let pendingError: Error | null = null
  conn.on('error', (err) => {
    const e = tag(err, phase)
    if (failCurrent) failCurrent(e)
    else pendingError = e
  })
  const step = <T>(p: SmtpPhase, run: (done: (err?: Error | null, v?: T) => void) => void, timeoutMs: number): Promise<T> => {
    phase = p
    return new Promise<T>((ok, fail) => {
      if (pendingError) return fail(pendingError)
      const timer = setTimeout(() => fail(tag(Object.assign(new Error(t('sync.smtp.timeout')), { code: 'ETIMEDOUT' }), p)), timeoutMs)
      failCurrent = (e) => {
        clearTimeout(timer)
        fail(e)
      }
      run((err, v) => {
        clearTimeout(timer)
        failCurrent = null
        if (err) fail(tag(err, p))
        else ok(v as T)
      })
    })
  }
  try {
    await step<void>('connect', (done) => conn.connect((err) => done(err)), 40_000)
    const auth =
      cred.kind === 'oauth'
        ? {
            user: account.email,
            // nodemailer'ın XOAUTH2 kancası: belirteci biz sağlarız (yenileme TokenCache'te)
            oauth2: {
              getToken: (renew: boolean, cb: (err: Error | null, token?: string) => void) => {
                if (!renew) return cb(null, cred.accessToken)
                credentialFor(account, secret, true).then(
                  (c) => cb(null, c.kind === 'oauth' ? c.accessToken : undefined),
                  (e: Error) => cb(e)
                )
              },
              buildXOAuth2Token: (token: string) => xoauth2(account.email, token)
            }
          }
        : { user: account.email, pass: cred.password }
    await step<void>('auth', (done) => conn.login(auth as Parameters<typeof conn.login>[0], (err) => done(err)), 40_000)
    const to = envelopeTo ?? [...splitAddresses(draft.to), ...splitAddresses(draft.cc), ...splitAddresses(draft.bcc)]
    await step<void>('send', (done) => conn.send({ from: account.email, to }, raw, (err) => done(err)), 5 * 60_000)
    conn.quit()
  } finally {
    try {
      conn.close()
    } catch {
      /* umursanmaz */
    }
  }
}
