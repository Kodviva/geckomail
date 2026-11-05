// Kişiler ve takvim sözleşmesi: renderer yalnız bu türleri görür, ham vCard/iCalendar görmez.
export type PimSourceKind = 'dav' | 'graph' | 'ics' | 'local'
export type PimCollectionType = 'addressbook' | 'calendar'
/** needsConsent: sağlayıcı izni eksik ya da reddetti; notFound: sunucu bulunamadı, arayüz elle adres ister; noSecret: hesabın parolası
 *  çözülemedi; confirmHost: sunucu posta düzeninin dışında, parola gönderilmeden önce kullanıcı adı onaylamalı */
export type PimConnectStatus = 'connected' | 'needsConsent' | 'notFound' | 'noSecret' | 'confirmHost'

export interface PimSourceInfo {
  id: number
  kind: PimSourceKind
  accountId: number | null
  personal: boolean
  label: string
  status: 'ok' | 'needs_reauth' | 'error'
  lastError: string | null
  lastSyncAt: number | null
  canManage: boolean
}

export interface PimCollectionInfo {
  id: number
  sourceId: number
  type: PimCollectionType
  name: string
  color: string | null
  readOnly: boolean
  /** Bu kullanıcı yazabilir: koleksiyon salt okunur değil, kaynakta yetkisi var */
  canWrite: boolean
  hidden: boolean
  reminders: boolean
  windowEnd: number | null
  supportsGroups: boolean
  supportsThisAndFuture: boolean
}

export interface ContactEmail {
  addr: string
  label: string | null
}

export interface ContactSummary {
  id: number
  collectionId: number
  kind: 'individual' | 'group'
  fullName: string
  org: string | null
  emails: ContactEmail[]
}

export interface ContactDetail extends ContactSummary {
  etag: string | null
  given: string | null
  family: string | null
  phones: { value: string; label: string | null }[]
  addresses: { value: string; label: string | null }[]
  note: string | null
  birthday: string | null
  photoDataUrl: string | null
  memberIds: number[]
}

export type ContactDraft = Pick<ContactDetail, 'fullName' | 'given' | 'family' | 'org' | 'emails' | 'phones' | 'addresses' | 'note' | 'birthday'> & {
  kind: 'individual' | 'group'
  memberIds?: number[]
}

export interface EventOccurrence {
  key: string
  objectId: number
  collectionId: number
  uid: string
  recurrenceId: string | null
  title: string
  location: string | null
  start: number
  end: number
  allDay: boolean
  startDate: string | null
  endDate: string | null
  tz: string | null
  cancelled: boolean
  recurring: boolean
  canEdit: boolean
  myPartstat: string | null
}

export interface RecurrenceInput {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval: number
  byDay?: string[]
  count?: number
  until?: string
}

/** start/end duvar saati `YYYY-MM-DDTHH:mm`, tüm günde `YYYY-MM-DD` */
export interface EventDraft {
  title: string
  location: string | null
  description: string | null
  allDay: boolean
  start: string
  end: string
  tz: string
  rrule: RecurrenceInput | null
  rruleRaw?: string
  alarmMinutes: number | null
}

export interface EventDetail {
  occurrence: EventOccurrence
  etag: string | null
  draft: EventDraft
  /** Düz metin; arayüz HTML olarak işlemez */
  description: string | null
  organizer: { addr: string; name: string | null } | null
  attendees: { addr: string; name: string | null; partstat: string }[]
}

export type WriteResult<T> = ({ ok: true } & T) | { ok: false; conflict: true }
export type EditScope = 'all' | 'this' | 'thisAndFuture'

export interface PimChangedEvent {
  kind: 'contacts' | 'calendar' | 'sources'
  sourceId: number
  accountId: number | null
}

export type InviteWarning = 'organizerMismatch' | 'noOrganizer' | 'attendeeNotFound' | 'stale'
export type InviteChange = 'time' | 'title' | 'location'
export type InvitePartstat = 'ACCEPTED' | 'DECLINED' | 'TENTATIVE'

/** Postadaki davet. Kalıcı satırı yoktur; her açılışta ekten okunur. `organizer` tek geçerli mailto adresi değilse null. */
export interface InviteInfo {
  attachmentId: number
  method: 'REQUEST' | 'CANCEL' | 'REPLY' | 'PUBLISH'
  uid: string
  sequence: number
  recurrenceId: string | null
  title: string
  location: string | null
  start: number
  end: number
  allDay: boolean
  startDate: string | null
  endDate: string | null
  tz: string | null
  recurring: boolean
  organizer: { addr: string; name: string | null } | null
  attendees: { addr: string; name: string | null; partstat: string }[]
  replyFrom: { addr: string; partstat: string } | null
  warnings: InviteWarning[]
  existing: { objectId: number; collectionId: number; sequence: number; canWrite: boolean } | null
  isUpdate: boolean
  /** Yalnız güncellemede: takvimdeki kopyaya göre değişenler */
  changes: InviteChange[]
  response: { partstat: string; respondedAt: number } | null
  canAddToCalendar: boolean
  canRespond: boolean
}

export const isCalendarAttachment = (a: { mime: string | null; filename: string | null }): boolean => {
  const mime = (a.mime ?? '').split(';')[0].trim().toLowerCase()
  return mime === 'text/calendar' || mime === 'application/ics' || /\.ics$/i.test(a.filename ?? '')
}
