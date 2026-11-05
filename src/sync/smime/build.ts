// Giden S/MIME: imza-sonra-şifre. Bcc alıcısının sertifika kimliği RecipientInfo'da göründüğü için aynı zarfa konmaz: her Bcc'ye
// ayrı zarf gider, başlıkta Bcc hiç yoktur. Gönderen her zarfa eklenir, Gönderilenler kopyası böylece okunur.
import { randomBytes } from 'node:crypto'
import addressparser from 'nodemailer/lib/addressparser'
import type { DraftOut } from '../../shared/rpc'
import type { AccountRow, Queries } from '../db/queries'
import { composeEntity, type OutboxAttachment, type SendMeta } from '../smtpSend'
import { encryptEnveloped, signDetached, type RecipientCert } from './cms'
import { SmimeBlockedError, SmimePendingError } from './errors'
import { loadSignKey, ownEncryptCert, resolveRecipients } from './identity'

export interface SmimePart {
  raw: Buffer
  envelopeTo: string[]
  forSent: boolean
}

/** Kimlik, alıcı ve imza hazır; şifreli zarf gönderim anında üretilir */
export interface LazySmimePart {
  raw(): Promise<Buffer>
  envelopeTo: string[]
  forSent: boolean
}

const flat = (list: ReturnType<typeof addressparser>): string[] =>
  list.flatMap((a) => ('group' in a && a.group ? flat(a.group) : 'address' in a && a.address ? [a.address] : []))

/** Görünen ad ve gruplar açılır; yalnız adresler */
export const addressesOf = (v: string | undefined): string[] => [...new Set(flat(addressparser(v ?? '')).map((a) => a.toLowerCase()))]

function base64Lines(der: Buffer): string {
  return der.toString('base64').replace(/.{1,76}/g, '$&\r\n')
}

function freshBoundary(entity: Buffer): string {
  for (;;) {
    const b = `----=_smime_${randomBytes(12).toString('hex')}`
    if (!entity.includes(b)) return b
  }
}

/** İmzalı varlık baytı değişmez: alıcı aynı baytı özetler */
export function wrapSigned(entity: Buffer, signatureDer: Buffer, micalg: string): Buffer {
  const b = freshBoundary(entity)
  return Buffer.concat([
    Buffer.from(`Content-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=${micalg};\r\n boundary="${b}"\r\n\r\n--${b}\r\n`, 'latin1'),
    entity,
    Buffer.from(
      `\r\n--${b}\r\nContent-Type: application/pkcs7-signature; name="smime.p7s"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="smime.p7s"\r\n\r\n` +
      `${base64Lines(signatureDer)}\r\n--${b}--\r\n`,
      'latin1'
    )
  ])
}

export function wrapEnveloped(der: Buffer): Buffer {
  return Buffer.from(
    `Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="smime.p7m"\r\n\r\n${base64Lines(der)}`,
    'latin1'
  )
}

const withOuter = (outer: string, body: Buffer): Buffer => Buffer.concat([Buffer.from(outer, 'latin1'), body])

function certsFor(q: Queries, userId: number, addresses: string[], now: number): RecipientCert[] {
  const resolved = resolveRecipients(q, { userId, addresses, now })
  const statuses = addresses.map((a) => resolved.get(a)?.status)
  if (statuses.some((st) => st !== 'ok' && st !== 'crl_pending')) throw new SmimeBlockedError()
  if (statuses.includes('crl_pending')) throw new SmimePendingError()
  return addresses.map((a) => resolved.get(a)!.cert!)
}

/** Kriptonun tek yeri: op kuyruğunda çalışır, her denemede kimlik ve alıcılar yeniden denetlenir. Sıra sabittir: ana parça, sonra Bcc'ler. */
export async function prepareSmimeParts(o: {
  account: AccountRow
  draft: DraftOut
  attachments: OutboxAttachment[]
  meta: SendMeta
  req: { sign: boolean; encrypt: boolean; userId: number }
  deps: { q: Queries; now: () => number }
}): Promise<LazySmimePart[]> {
  const { account, draft, req } = o
  const { q } = o.deps
  const now = o.deps.now()
  const main = [...new Set([...addressesOf(draft.to), ...addressesOf(draft.cc)])]
  const bcc = addressesOf(draft.bcc).filter((a) => !main.includes(a))
  const key = loadSignKey(q, req.userId, account.email, now)
  const own = req.encrypt ? ownEncryptCert(q, req.userId, account.email, now) : null
  if (req.encrypt && !own) throw new SmimeBlockedError()
  const mainCerts = req.encrypt ? certsFor(q, req.userId, main, now) : []
  const bccCerts = req.encrypt ? certsFor(q, req.userId, bcc, now) : []

  const { outer, entity } = await composeEntity(account, draft, o.attachments, o.meta)
  const { der, micalg } = await signDetached(entity, key)
  const signed = wrapSigned(entity, der, micalg)
  const signedPart = async (): Promise<Buffer> => withOuter(outer, signed)
  if (!req.encrypt) return [{ raw: signedPart, envelopeTo: [...main, ...bcc], forSent: true }]

  const sealedFor = (certs: RecipientCert[]): Promise<Buffer> => Promise.resolve().then(() => withOuter(outer, wrapEnveloped(encryptEnveloped(signed, [...certs, own as RecipientCert]))))
  return [
    { raw: () => sealedFor(mainCerts), envelopeTo: main, forSent: true },
    ...bcc.map((address, i) => ({ raw: () => sealedFor([bccCerts[i]]), envelopeTo: [address], forSent: false }))
  ]
}

/** Tüm parçalar bellekte. Kuyruk prepareSmimeParts kullanır: 25 MB ve 20 Bcc'de gönderilmiş parça yeniden üretilmez. */
export async function buildSmimeParts(o: Parameters<typeof prepareSmimeParts>[0]): Promise<SmimePart[]> {
  const parts = await prepareSmimeParts(o)
  return Promise.all(parts.map(async (p) => ({ raw: await p.raw(), envelopeTo: p.envelopeTo, forSent: p.forSent })))
}
