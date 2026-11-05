// Sorgular — Kişiler ve takvim: kaynaklar, koleksiyonlar, kişiye ait koleksiyon tercihleri. Yetki pimAuth'ta.
import type { PimCollectionType, PimSourceKind } from '../../../shared/pim'
import type { RemoteCollection, SyncState } from '../../pim/backend'
import type { ParsedCard } from '../../pim/vcard'
import type { QCtx } from './ctx'

export interface PimSourceRow {
  id: number
  kind: PimSourceKind
  account_id: number | null
  owner_user_id: number | null
  label: string
  caldav_url: string | null
  carddav_url: string | null
  ics_url_enc: Buffer | null
  ics_etag: string | null
  ics_last_modified: string | null
  username: string | null
  secret_enc: Buffer | null
  auth: 'none' | 'basic' | 'account'
  server_schedules: number
  granted_scopes: string | null
  status: 'ok' | 'needs_reauth' | 'error'
  last_error: string | null
  last_sync_at: number | null
  next_sync_at: number
  fail_count: number
  created_at: number
}

export interface PimCollectionRow {
  id: number
  source_id: number
  type: PimCollectionType
  remote_id: string
  name: string
  color: string | null
  read_only: number
  ctag: string | null
  sync_token: string | null
  delta_link: string | null
  window_start: number | null
  window_end: number | null
}

export interface PimCollectionPrefRow {
  user_id: number
  collection_id: number
  hidden: number
  color: string | null
  reminders: number
}

export interface ContactRow {
  id: number
  collection_id: number
  remote_id: string
  etag: string | null
  uid: string
  kind: 'individual' | 'group'
  raw: string
  full_name: string
  org: string | null
  updated_at: number
}

export interface CalendarObjectRow {
  id: number
  collection_id: number
  remote_id: string
  etag: string | null
  uid: string
  raw: string
  range_start: number
  range_end: number | null
  recurring: number
  sequence: number
  organizer: string | null
  next_alarm_at: number | null
  updated_at: number
}

export interface DueAlarmRow {
  id: number
  raw: string
  next_alarm_at: number
  collection_id: number
  account_id: number | null
  owner_user_id: number | null
}

export type ContactListRow = Omit<ContactRow, 'raw' | 'remote_id' | 'etag' | 'uid' | 'updated_at'>

const marks = (a: readonly unknown[]): string => a.map(() => '?').join(',')

export function pimQueries(c: QCtx) {
  const { prep } = c
  return {
    getPimSource(id: number): PimSourceRow | undefined {
      return prep(`SELECT * FROM pim_sources WHERE id = ?`).get(id) as PimSourceRow | undefined
    },

    /** Yetki süzgecinden geçecek adaylar: tüm hesap kaynakları + kullanıcının kişisel kaynakları */
    pimSourceCandidates(userId: number): PimSourceRow[] {
      return prep(`SELECT * FROM pim_sources WHERE account_id IS NOT NULL OR owner_user_id = ? ORDER BY id`).all(userId) as PimSourceRow[]
    },

    getPimSourceByAccount(accountId: number): PimSourceRow | undefined {
      return prep(`SELECT * FROM pim_sources WHERE account_id = ?`).get(accountId) as PimSourceRow | undefined
    },

    /** Yeniden bağlama bağlantı bilgisini tazeler ve kullanıcı eylemi sayılır: reddedilmiş kaynak açılır */
    upsertAccountPimSource(o: { accountId: number; kind: PimSourceKind; label: string; caldavUrl: string | null; carddavUrl: string | null; serverSchedules: boolean; grantedScopes: string | null; now: number }): PimSourceRow {
      prep(
        `INSERT INTO pim_sources (kind, account_id, label, caldav_url, carddav_url, server_schedules, auth, granted_scopes, created_at)
         VALUES (@kind, @accountId, @label, @caldavUrl, @carddavUrl, @serverSchedules, 'account', @grantedScopes, @now)
         ON CONFLICT (account_id) WHERE account_id IS NOT NULL DO UPDATE SET kind = excluded.kind, caldav_url = excluded.caldav_url,
           carddav_url = excluded.carddav_url, server_schedules = excluded.server_schedules,
           granted_scopes = COALESCE(excluded.granted_scopes, granted_scopes), status = 'ok', last_error = NULL, fail_count = 0, next_sync_at = 0`
      ).run({ ...o, serverSchedules: o.serverSchedules ? 1 : 0 })
      return prep(`SELECT * FROM pim_sources WHERE account_id = ?`).get(o.accountId) as PimSourceRow
    },

    insertPersonalPimSource(o: { userId: number; label: string; caldavUrl: string | null; carddavUrl: string | null; serverSchedules: boolean; username: string; secretEnc: Buffer; now: number }): PimSourceRow {
      const id = prep(
        `INSERT INTO pim_sources (kind, owner_user_id, label, caldav_url, carddav_url, server_schedules, username, secret_enc, auth, created_at)
         VALUES ('dav', @userId, @label, @caldavUrl, @carddavUrl, @serverSchedules, @username, @secretEnc, 'basic', @now)`
      ).run({ ...o, serverSchedules: o.serverSchedules ? 1 : 0 }).lastInsertRowid
      return prep(`SELECT * FROM pim_sources WHERE id = ?`).get(id) as PimSourceRow
    },

    deletePimSource(id: number): void {
      prep(`DELETE FROM pim_sources WHERE id = ?`).run(id)
    },

    duePimSources(now: number): PimSourceRow[] {
      return prep(`SELECT * FROM pim_sources WHERE status != 'needs_reauth' AND next_sync_at <= ? ORDER BY next_sync_at, id`).all(now) as PimSourceRow[]
    },

    markPimSourceSynced(id: number, now: number, nextAt: number): void {
      prep(`UPDATE pim_sources SET status = 'ok', last_error = NULL, fail_count = 0, last_sync_at = ?, next_sync_at = ? WHERE id = ?`).run(now, nextAt, id)
    },

    deferPimSource(id: number, nextAt: number): void {
      prep(`UPDATE pim_sources SET next_sync_at = ? WHERE id = ?`).run(nextAt, id)
    },

    markPimSourceFailed(id: number, error: string, failCount: number, nextAt: number): void {
      prep(`UPDATE pim_sources SET status = 'error', last_error = ?, fail_count = ?, next_sync_at = ? WHERE id = ?`).run(error, failCount, nextAt, id)
    },

    markPimSourceNeedsReauth(id: number, error: string): void {
      prep(`UPDATE pim_sources SET status = 'needs_reauth', last_error = ? WHERE id = ?`).run(error, id)
    },

    /** Parola değişti: reddedilmiş hesap kaynağı yeniden denenir */
    clearPimNeedsReauth(accountId: number): void {
      prep(`UPDATE pim_sources SET status = 'ok', last_error = NULL, fail_count = 0, next_sync_at = 0 WHERE account_id = ? AND status = 'needs_reauth'`).run(accountId)
    },

    /** Uzak listeyi yansıtır: eşitleme durumu korunur, listeden çıkan koleksiyon nesneleriyle silinir */
    reconcilePimCollections(sourceId: number, remote: RemoteCollection[]): PimCollectionRow[] {
      return c.db.transaction(() => {
        const upsert = prep(
          `INSERT INTO pim_collections (source_id, type, remote_id, name, color, read_only) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (source_id, type, remote_id) DO UPDATE SET name = excluded.name, color = excluded.color, read_only = excluded.read_only`
        )
        for (const r of remote) upsert.run(sourceId, r.type, r.remoteId, r.name, r.color, r.readOnly ? 1 : 0)
        const keep = new Set(remote.map((r) => `${r.type}\n${r.remoteId}`))
        const all = prep(`SELECT * FROM pim_collections WHERE source_id = ? ORDER BY id`).all(sourceId) as PimCollectionRow[]
        for (const row of all) if (!keep.has(`${row.type}\n${row.remote_id}`)) prep(`DELETE FROM pim_collections WHERE id = ?`).run(row.id)
        return all.filter((row) => keep.has(`${row.type}\n${row.remote_id}`))
      })()
    },

    pimTransaction(fn: () => void): void {
      c.db.transaction(fn)()
    },

    /** Yalnız verilen alanlar değişir; `null` temizler */
    setPimCollectionState(id: number, s: SyncState): void {
      const columns: [unknown, string][] = [[s.ctag, 'ctag'], [s.syncToken, 'sync_token'], [s.deltaLink, 'delta_link'], [s.windowStart, 'window_start'], [s.windowEnd, 'window_end']]
      for (const [value, column] of columns) if (value !== undefined) prep(`UPDATE pim_collections SET ${column} = ? WHERE id = ?`).run(value, id)
    },

    setPimFeedState(sourceId: number, etag: string | null, lastModified: string | null): void {
      prep(`UPDATE pim_sources SET ics_etag = ?, ics_last_modified = ? WHERE id = ?`).run(etag, lastModified, sourceId)
    },

    pimContactEtags(collectionId: number): Map<string, string | null> {
      const rows = prep(`SELECT remote_id, etag FROM contacts WHERE collection_id = ?`).all(collectionId) as { remote_id: string; etag: string | null }[]
      return new Map(rows.map((r) => [r.remote_id, r.etag]))
    },

    pimEventEtags(collectionId: number): Map<string, string | null> {
      const rows = prep(`SELECT remote_id, etag FROM calendar_objects WHERE collection_id = ?`).all(collectionId) as { remote_id: string; etag: string | null }[]
      return new Map(rows.map((r) => [r.remote_id, r.etag]))
    },

    deletePimContact(collectionId: number, remoteId: string): number {
      return prep(`DELETE FROM contacts WHERE collection_id = ? AND remote_id = ?`).run(collectionId, remoteId).changes
    },

    deletePimEvent(collectionId: number, remoteId: string): number {
      return prep(`DELETE FROM calendar_objects WHERE collection_id = ? AND remote_id = ?`).run(collectionId, remoteId).changes
    },

    /** transaction içinde çağrılır: e-postalar ve grup üyeleri kartla birlikte yenilenir */
    upsertPimContact(collectionId: number, o: { remoteId: string; etag: string | null; raw: string; card: ParsedCard; now: number }): void {
      const { id } = prep(
        `INSERT INTO contacts (collection_id, remote_id, etag, uid, kind, raw, full_name, org, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (collection_id, remote_id) DO UPDATE SET etag = excluded.etag, uid = excluded.uid, kind = excluded.kind, raw = excluded.raw,
           full_name = excluded.full_name, org = excluded.org, updated_at = excluded.updated_at RETURNING id`
      ).get(collectionId, o.remoteId, o.etag, o.card.uid, o.card.kind, o.raw, o.card.fullName, o.card.org, o.now) as { id: number }
      prep(`DELETE FROM contact_emails WHERE contact_id = ?`).run(id)
      prep(`DELETE FROM contact_group_members WHERE group_id = ?`).run(id)
      const email = prep(`INSERT OR IGNORE INTO contact_emails (contact_id, addr, label, pos) VALUES (?, ?, ?, ?)`)
      o.card.emails.forEach((e, pos) => email.run(id, e.addr, e.label, pos))
      const member = prep(`INSERT OR IGNORE INTO contact_group_members (group_id, member_uid) VALUES (?, ?)`)
      for (const uid of o.card.memberUids) member.run(id, uid)
    },

    upsertPimEvent(collectionId: number, o: { remoteId: string; etag: string | null; raw: string; nextAlarmAt: number | null; now: number; fields: { uid: string; rangeStart: number; rangeEnd: number | null; recurring: boolean; sequence: number; organizer: string | null } }): void {
      const f = o.fields
      prep(
        `INSERT INTO calendar_objects (collection_id, remote_id, etag, uid, raw, range_start, range_end, recurring, sequence, organizer, next_alarm_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (collection_id, remote_id) DO UPDATE SET etag = excluded.etag, uid = excluded.uid, raw = excluded.raw, range_start = excluded.range_start,
           range_end = excluded.range_end, recurring = excluded.recurring, sequence = excluded.sequence, organizer = excluded.organizer,
           next_alarm_at = CASE WHEN calendar_objects.next_alarm_at <= excluded.updated_at THEN calendar_objects.next_alarm_at ELSE excluded.next_alarm_at END,
           updated_at = excluded.updated_at`
      ).run(collectionId, o.remoteId, o.etag, f.uid, o.raw, f.rangeStart, f.rangeEnd, f.recurring ? 1 : 0, f.sequence, f.organizer, o.nextAlarmAt, o.now)
    },

    getPimContact(id: number): ContactRow | undefined {
      return prep(`SELECT * FROM contacts WHERE id = ?`).get(id) as ContactRow | undefined
    },

    pimContactIdByRemote(collectionId: number, remoteId: string): number | undefined {
      return (prep(`SELECT id FROM contacts WHERE collection_id = ? AND remote_id = ?`).get(collectionId, remoteId) as { id: number } | undefined)?.id
    },

    /** Ada göre sıralı sayfa; imleç son satırın (ad, kimlik) ikilisi */
    pimContactPage(collectionIds: number[], cursor: { name: string; id: number } | null, limit: number): ContactListRow[] {
      if (!collectionIds.length) return []
      const after = cursor ? `AND (full_name > ? COLLATE NOCASE OR (full_name = ? COLLATE NOCASE AND id > ?))` : ''
      const args = cursor ? [cursor.name, cursor.name, cursor.id] : []
      return prep(
        `SELECT id, collection_id, kind, full_name, org FROM contacts WHERE collection_id IN (${marks(collectionIds)}) ${after}
         ORDER BY full_name COLLATE NOCASE, id LIMIT ?`
      ).all(...collectionIds, ...args, limit) as ContactListRow[]
    },

    pimContactEmails(contactIds: number[]): { contact_id: number; addr: string; label: string | null }[] {
      if (!contactIds.length) return []
      return prep(`SELECT contact_id, addr, label FROM contact_emails WHERE contact_id IN (${marks(contactIds)}) ORDER BY contact_id, pos`).all(...contactIds) as { contact_id: number; addr: string; label: string | null }[]
    },

    pimContactRaws(collectionId: number): { uid: string; raw: string }[] {
      return prep(`SELECT uid, raw FROM contacts WHERE collection_id = ? ORDER BY full_name COLLATE NOCASE, id`).all(collectionId) as { uid: string; raw: string }[]
    },

    pimContactIdByEmail(collectionId: number, addr: string): number | undefined {
      return (prep(`SELECT c.id FROM contacts c JOIN contact_emails e ON e.contact_id = c.id WHERE c.collection_id = ? AND e.addr = ? ORDER BY c.id LIMIT 1`).get(collectionId, addr) as { id: number } | undefined)?.id
    },

    /** Grup üyeliği aynı defter içinde UID ile çözülür */
    pimContactUidsOfIds(collectionId: number, ids: number[]): string[] {
      if (!ids.length) return []
      return (prep(`SELECT uid FROM contacts WHERE collection_id = ? AND id IN (${marks(ids)})`).all(collectionId, ...ids) as { uid: string }[]).map((r) => r.uid)
    },

    pimGroupMemberIds(groupId: number, collectionId: number): number[] {
      return (prep(
        `SELECT c.id FROM contact_group_members m JOIN contacts c ON c.collection_id = ? AND c.uid = m.member_uid WHERE m.group_id = ? ORDER BY c.full_name COLLATE NOCASE, c.id`
      ).all(collectionId, groupId) as { id: number }[]).map((r) => r.id)
    },

    /** Otomatik tamamlama: kartların adresleri */
    pimCardAddresses(collectionIds: number[], limit: number): { contact_id: number; addr: string; full_name: string }[] {
      if (!collectionIds.length) return []
      return prep(
        `SELECT e.contact_id, e.addr, c.full_name FROM contact_emails e JOIN contacts c ON c.id = e.contact_id
         WHERE c.collection_id IN (${marks(collectionIds)}) AND c.kind = 'individual' ORDER BY c.full_name COLLATE NOCASE, e.contact_id, e.pos LIMIT ?`
      ).all(...collectionIds, limit) as { contact_id: number; addr: string; full_name: string }[]
    },

    /** Otomatik tamamlama: gruplar ve üyelerinin ilk adresi */
    pimGroupAddresses(collectionIds: number[]): { id: number; full_name: string; addr: string }[] {
      if (!collectionIds.length) return []
      return prep(
        `SELECT g.id, g.full_name, (SELECT e.addr FROM contact_emails e WHERE e.contact_id = c.id ORDER BY e.pos LIMIT 1) AS addr
         FROM contacts g JOIN contact_group_members m ON m.group_id = g.id JOIN contacts c ON c.collection_id = g.collection_id AND c.uid = m.member_uid
         WHERE g.collection_id IN (${marks(collectionIds)}) AND g.kind = 'group' ORDER BY g.full_name COLLATE NOCASE, g.id, c.full_name COLLATE NOCASE`
      ).all(...collectionIds) as { id: number; full_name: string; addr: string }[]
    },

    getCalendarObject(id: number): CalendarObjectRow | undefined {
      return prep(`SELECT * FROM calendar_objects WHERE id = ?`).get(id) as CalendarObjectRow | undefined
    },

    pimEventIdByRemote(collectionId: number, remoteId: string): number | undefined {
      return (prep(`SELECT id FROM calendar_objects WHERE collection_id = ? AND remote_id = ?`).get(collectionId, remoteId) as { id: number } | undefined)?.id
    },

    /** Aralığa değebilecek nesneler; `range_end` NULL sonsuz seri */
    calendarObjectsByUid(collectionIds: number[], uid: string): CalendarObjectRow[] {
      if (!collectionIds.length) return []
      return prep(`SELECT * FROM calendar_objects WHERE uid = ? AND collection_id IN (${marks(collectionIds)}) ORDER BY id`).all(uid, ...collectionIds) as CalendarObjectRow[]
    },

    inviteResponse(accountId: number, uid: string, recurrenceId: string | null): { sequence: number; partstat: string; responded_at: number } | undefined {
      return prep(`SELECT sequence, partstat, responded_at FROM invite_responses WHERE account_id = ? AND uid = ? AND recurrence_id = ?`).get(accountId, uid, recurrenceId ?? '') as
        | { sequence: number; partstat: string; responded_at: number }
        | undefined
    },

    saveInviteResponse(o: { accountId: number; uid: string; recurrenceId: string | null; sequence: number; partstat: string; userId: number; now: number }): void {
      prep(
        `INSERT INTO invite_responses (account_id, uid, recurrence_id, sequence, partstat, responded_by, responded_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, uid, recurrence_id) DO UPDATE SET sequence = excluded.sequence, partstat = excluded.partstat, responded_by = excluded.responded_by, responded_at = excluded.responded_at`
      ).run(o.accountId, o.uid, o.recurrenceId ?? '', o.sequence, o.partstat, o.userId, o.now)
    },

    calendarObjectsInRange(collectionIds: number[], from: number, to: number): CalendarObjectRow[] {
      if (!collectionIds.length) return []
      return prep(`SELECT * FROM calendar_objects WHERE collection_id IN (${marks(collectionIds)}) AND (range_end IS NULL OR range_end >= ?) AND range_start < ?`).all(...collectionIds, from, to) as CalendarObjectRow[]
    },

    dueAlarms(now: number, limit: number): DueAlarmRow[] {
      return prep(
        `SELECT o.id, o.raw, o.next_alarm_at, o.collection_id, s.account_id, s.owner_user_id FROM calendar_objects o
         JOIN pim_collections c ON c.id = o.collection_id JOIN pim_sources s ON s.id = c.source_id
         WHERE o.next_alarm_at IS NOT NULL AND o.next_alarm_at <= ? ORDER BY o.next_alarm_at LIMIT ?`
      ).all(now, limit) as DueAlarmRow[]
    },

    setNextAlarm(objectId: number, at: number | null): void {
      prep(`UPDATE calendar_objects SET next_alarm_at = ? WHERE id = ?`).run(at, objectId)
    },

    reminderOffUsers(collectionId: number): Set<number> {
      return new Set((prep(`SELECT user_id FROM pim_collection_prefs WHERE collection_id = ? AND reminders = 0`).all(collectionId) as { user_id: number }[]).map((r) => r.user_id))
    },

    countPersonalDavSources(userId: number): number {
      return (prep(`SELECT COUNT(*) AS n FROM pim_sources WHERE owner_user_id = ? AND kind = 'dav'`).get(userId) as { n: number }).n
    },

    setPersonalPimSecret(id: number, secretEnc: Buffer): void {
      prep(`UPDATE pim_sources SET secret_enc = ?, status = 'ok', last_error = NULL, fail_count = 0, next_sync_at = 0 WHERE id = ?`).run(secretEnc, id)
    },

    /** Yenileme belirteci Graph kaynağı da taşıyabilir: kaynak kaldırılsa bile posta kapsamı açıkça istenir */
    markMailScopeExplicit(accountId: number): void {
      prep(`UPDATE accounts SET mail_scope_explicit = 1 WHERE id = ?`).run(accountId)
    },

    mailScopeExplicit(accountId: number): boolean {
      return !!(prep(`SELECT mail_scope_explicit AS f FROM accounts WHERE id = ?`).get(accountId) as { f: number } | undefined)?.f || !!prep(`SELECT 1 FROM pim_sources WHERE account_id = ?`).get(accountId)
    },

    countIcsSources(userId: number): number {
      return (prep(`SELECT COUNT(*) AS n FROM pim_sources WHERE kind = 'ics' AND owner_user_id = ?`).get(userId) as { n: number }).n
    },

    pimCollectionsOfSource(sourceId: number): PimCollectionRow[] {
      return prep(`SELECT * FROM pim_collections WHERE source_id = ? ORDER BY id`).all(sourceId) as PimCollectionRow[]
    },

    /** Abonelik: kişiye ait, tek salt okunur takvim. Adres şifreli saklanır, çoğu özel belirteç taşır */
    insertIcsPimSource(o: { userId: number; label: string; urlEnc: Buffer; name: string; color: string | null; now: number }): PimSourceRow {
      return c.db.transaction(() => {
        const id = Number(
          prep(`INSERT INTO pim_sources (kind, owner_user_id, label, ics_url_enc, auth, created_at) VALUES ('ics', ?, ?, ?, 'none', ?)`).run(o.userId, o.label, o.urlEnc, o.now).lastInsertRowid
        )
        prep(`INSERT INTO pim_collections (source_id, type, remote_id, name, color, read_only) VALUES (?, 'calendar', 'feed', ?, ?, 1)`).run(id, o.name, o.color)
        return prep(`SELECT * FROM pim_sources WHERE id = ?`).get(id) as PimSourceRow
      })()
    },

    /** Hesapta kaynak zaten varsa dokunmaz */
    insertAccountPimSource(o: { accountId: number; kind: PimSourceKind; label: string; status: PimSourceRow['status']; grantedScopes: string | null; now: number }): void {
      prep(
        `INSERT INTO pim_sources (kind, account_id, label, auth, status, granted_scopes, created_at) VALUES (?, ?, ?, 'account', ?, ?, ?)
         ON CONFLICT (account_id) WHERE account_id IS NOT NULL DO NOTHING`
      ).run(o.kind, o.accountId, o.label, o.status, o.grantedScopes, o.now)
    },

    getLocalPimSource(userId: number): PimSourceRow | undefined {
      return prep(`SELECT * FROM pim_sources WHERE kind = 'local' AND owner_user_id = ? ORDER BY id LIMIT 1`).get(userId) as PimSourceRow | undefined
    },

    insertLocalPimSource(o: { userId: number; label: string; contactsName: string; calendarName: string; now: number }): PimSourceRow {
      return c.db.transaction(() => {
        const id = Number(
          prep(`INSERT INTO pim_sources (kind, owner_user_id, label, auth, created_at) VALUES ('local', ?, ?, 'none', ?)`).run(o.userId, o.label, o.now).lastInsertRowid
        )
        const add = prep(`INSERT INTO pim_collections (source_id, type, remote_id, name) VALUES (?, ?, ?, ?)`)
        add.run(id, 'addressbook', 'local', o.contactsName)
        add.run(id, 'calendar', 'local', o.calendarName)
        return prep(`SELECT * FROM pim_sources WHERE id = ?`).get(id) as PimSourceRow
      })()
    },

    getPimCollection(id: number): PimCollectionRow | undefined {
      return prep(`SELECT * FROM pim_collections WHERE id = ?`).get(id) as PimCollectionRow | undefined
    },

    listPimCollectionsByType(type: PimCollectionType): PimCollectionRow[] {
      return prep(`SELECT * FROM pim_collections WHERE type = ? ORDER BY source_id, name, id`).all(type) as PimCollectionRow[]
    },

    listPimCollectionPrefs(userId: number): PimCollectionPrefRow[] {
      return prep(`SELECT * FROM pim_collection_prefs WHERE user_id = ?`).all(userId) as PimCollectionPrefRow[]
    },

    /** Yalnız verilen alanlar değişir; `color: null` kişisel rengi kaldırır */
    setPimCollectionPref(userId: number, collectionId: number, patch: { hidden?: boolean; color?: string | null; reminders?: boolean }): void {
      c.db.transaction(() => {
        prep(`INSERT OR IGNORE INTO pim_collection_prefs (user_id, collection_id) VALUES (?, ?)`).run(userId, collectionId)
        if (patch.hidden !== undefined) prep(`UPDATE pim_collection_prefs SET hidden = ? WHERE user_id = ? AND collection_id = ?`).run(patch.hidden ? 1 : 0, userId, collectionId)
        if (patch.color !== undefined) prep(`UPDATE pim_collection_prefs SET color = ? WHERE user_id = ? AND collection_id = ?`).run(patch.color, userId, collectionId)
        if (patch.reminders !== undefined) prep(`UPDATE pim_collection_prefs SET reminders = ? WHERE user_id = ? AND collection_id = ?`).run(patch.reminders ? 1 : 0, userId, collectionId)
      })()
    }
  }
}
