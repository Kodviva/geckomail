// Kişiler ve takvim RPC yüzeyi: `RpcMethods extends PimRpcMethods` (rpc.ts birleştirmelerde küçük kalsın).
import type { ContactDetail, ContactDraft, ContactSummary, EditScope, EventDetail, EventDraft, EventOccurrence, InviteInfo, InvitePartstat, PimCollectionInfo, PimCollectionType, PimConnectStatus, PimSourceInfo, WriteResult } from './pim'

export interface PimRpcMethods {
  listPimSources(params: Record<string, never>): PimSourceInfo[]
  listPimCollections(params: { type: PimCollectionType }): PimCollectionInfo[]
  setPimCollectionPref(params: { collectionId: number; hidden?: boolean; color?: string | null; reminders?: boolean }): void
  connectAccountPim(params: { accountId: number; confirmedHost?: string }): { status: PimConnectStatus; host?: string }
  addPersonalDav(params: { url: string; username: string; password: string }): { status: PimConnectStatus }
  updatePersonalDavPassword(params: { id: number; password: string }): { status: PimConnectStatus }
  removePimSource(params: { id: number }): void
  syncPimSource(params: { id: number }): void
  listContacts(params: { collectionIds: number[] | null; query?: string; cursor?: { name: string; id: number } | null; limit?: number }): ContactSummary[]
  getContact(params: { id: number }): ContactDetail
  saveContact(params: { collectionId: number; id?: number; etag?: string | null; draft: ContactDraft }): WriteResult<{ id: number; etag: string | null }>
  deleteContact(params: { id: number; etag?: string | null }): WriteResult<object>
  importContacts(params: { collectionId: number; vcards: string }): { added: number; skipped: number; failed: number }
  exportContacts(params: { collectionId: number }): { filename: string; data: Uint8Array }
  promoteCollected(params: { addr: string; name: string | null; collectionId: number }): { id: number }
  mergeContacts(params: { keepId: number; dropIds: number[] }): WriteResult<{ id: number }>
  listEvents(params: { from: number; to: number; tz: string; collectionIds?: number[] | null }): EventOccurrence[]
  getEvent(params: { objectId: number; recurrenceId?: string | null; tz: string }): EventDetail
  saveEvent(params: { collectionId: number; objectId?: number; etag?: string | null; draft: EventDraft; scope?: EditScope; recurrenceId?: string }): WriteResult<{ objectId: number; etag: string | null }>
  deleteEvent(params: { objectId: number; etag?: string | null; scope?: EditScope; recurrenceId?: string }): WriteResult<object>
  addIcsSubscription(params: { url: string; name: string; color?: string }): { sourceId: number }
  getInvite(params: { messageId: number; tz: string }): InviteInfo | null
  respondInvite(params: { messageId: number; attachmentId: number; partstat: InvitePartstat; sendReply: boolean; calendarId?: number | null }): { sent: 'mail' | 'server' | 'graph' | 'none' }
  applyInviteUpdate(params: { messageId: number; attachmentId: number }): WriteResult<{ objectId: number }>
  applyInviteCancel(params: { messageId: number; attachmentId: number }): WriteResult<object>
}
