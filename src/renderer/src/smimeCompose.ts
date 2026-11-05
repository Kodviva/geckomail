// Oluşturucunun S/MIME kuralları (store/DOM bağımsız). Kripto motordadır; burada yalnız bayraklar ve Gönder kararı var.
// Son söz sunucunundur: sendMail aynı denetimleri yeniden yapar, buradaki karar kullanıcıya nedeni erken göstermek içindir.
import type { DraftOut, RpcMethods, SmimeRequest } from '../../shared/rpc'
import { SMIME_MAX_BCC } from '../../shared/smime'
import { t } from '../../shared/i18n'
import type { ComposerState } from './store/types'

export type SmimeCheck = ReturnType<RpcMethods['smimeCheckRecipients']>
/** res null: denetim başarısız, karar sendMail'e kalır */
export interface SmimeCheckResult { key: string; res: SmimeCheck | null }

const splitList = (v: string): string[] => v.match(/(?:"[^"]*"|[^,;])+/g) ?? []

function bare(token: string): string {
  const inAngle = /<([^<>]+)>\s*$/.exec(token)
  return (inAngle ? inAngle[1] : token).trim().toLowerCase()
}

const addressesOf = (v: string): string[] => splitList(v).map(bare).filter(Boolean)

/** Görünen ad atılır, küçük harf, yinelenmeden */
export function composerAddresses(c: Pick<ComposerState, 'to' | 'cc' | 'bcc'>): string[] {
  return [...new Set([c.to, c.cc, c.bcc].flatMap(addressesOf))]
}

export const smimeCheckKey = (c: ComposerState): string => JSON.stringify([c.fromAccountId, composerAddresses(c)])

export function smimeRequest(c: ComposerState): SmimeRequest | undefined {
  if (!c.smimeSign && !c.smimeEncrypt) return undefined
  return { sign: !!c.smimeSign || !!c.smimeEncrypt, encrypt: !!c.smimeEncrypt }
}

/** Şifre açıkken imza da açıktır: şifreli gönderim her zaman imzalı */
export function setEncrypt(c: ComposerState, on: boolean): ComposerState {
  return on ? { ...c, smimeEncrypt: true, smimeSign: true } : { ...c, smimeEncrypt: false }
}

/** Düz metni cihaza yazılmayacak taslak: şifrelenecek ya da şifreli iletiden alıntı taşıyor */
export const draftIsSensitive = (c: ComposerState): boolean => !!c.smimeEncrypt || !!c.smimeSensitive

/** Gönder neden kapalı; null ise açık */
export function smimeSendBlock(c: ComposerState, check: SmimeCheckResult | null, key: string): string | null {
  if (!c.smimeSign && !c.smimeEncrypt) return null
  if (c.smimeEncrypt && addressesOf(c.bcc).length > SMIME_MAX_BCC) return t('sync.smime.tooManyBcc', { max: String(SMIME_MAX_BCC) })
  if (!check || check.key !== key) return t('smime.compose.checking')
  const res = check.res
  if (!res) return null
  if (c.smimeEncrypt) {
    if (res.blocked) return t(`smime.blocked.${res.blocked}`)
    const bad = res.recipients.find((r) => r.status !== 'ok')
    return bad ? `${bad.address}: ${t(`smime.recipient.${bad.status}`)}` : null
  }
  return res.canSign ? null : t(`smime.blocked.${res.blocked ?? 'no_identity'}`)
}

/** Kuyruktan dönen taslak. Şifreli op'un taslağı bayraklarıyla döner, böylece localStorage'a inmez */
export function composerFromDraft(d: DraftOut & { smime?: SmimeRequest }, restored = false): ComposerState {
  return {
    fromAccountId: d.accountId,
    to: d.to,
    cc: d.cc ?? '',
    bcc: d.bcc ?? '',
    subject: d.subject,
    text: d.text,
    rich: !!d.html,
    html: d.html ?? '',
    inReplyTo: d.inReplyTo,
    references: d.references,
    attachments: [],
    ...(restored ? { restored } : {}),
    ...(d.smime?.sign ? { smimeSign: true } : {}),
    ...(d.smime?.encrypt ? { smimeSign: true, smimeEncrypt: true, smimeSensitive: true } : {})
  }
}
