// Konu önekleri: yanıt/iletme önekleri dile göre değişir (Re/AW/SV/RV/回复, Fwd/İlt/WG/TR/Enc/RV/转发 …).
// Başka istemcilerden gelen yerelleştirilmiş önekler de tanınsın ki önek iki kez eklenmesin ve
// şablon değişkeni {konu} yalın konuyu versin.
import { t } from './i18n'

const PREFIX = String.raw`(?:re|aw|sv|antw|odp|ynt|回复|答复|返信|fwd?|[iİ]lt|wg|tr|enc|rv|doorst|pd|转发|転送)\s*(?:\[\d+\])?\s*[:：]\s*`
const LEADING = new RegExp(`^(?:${PREFIX})+`, 'i')
const FWD = /^(?:fwd?|[iİ]lt|wg|tr|enc|rv|doorst|pd|转发|転送)\s*[:：]/i
const REPLY = /^(?:re|aw|sv|antw|odp|ynt|回复|答复|返信)\s*(?:\[\d+\])?\s*[:：]/i

/** Baştaki tüm yanıt/iletme öneklerini atar */
export function stripSubjectPrefixes(subject: string): string {
  return subject.replace(LEADING, '').trim()
}

/** İletme konusu: zaten iletme önekiyle başlıyorsa olduğu gibi, yoksa arayüz dilinin önekiyle */
export function forwardSubject(subject: string): string {
  return FWD.test(subject) ? subject : t('sync.forward.subject', { subject })
}

/** Yanıt konusu: "Re:" her dilde anlaşılır; RFC 5322 de onu önerir */
export function replySubject(subject: string): string {
  return REPLY.test(subject) ? subject : `Re: ${subject}`
}
