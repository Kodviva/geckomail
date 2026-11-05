import { randomBytes } from 'crypto'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { InviteInfo } from '../../shared/pim'
import { initOAuth, TokenCache } from '../oauth'
import { parseCalendar } from '../pim/ical'
import { invitesHandlers as h } from '../rpc/invites'
import { setVaultKey } from '../vault/state'
import { FakeGraph, graphEvent } from './helpers/fakeGraph'
import { buildGateWorker, hangingWorker, removeGateWorkers } from './helpers/gateWorker'
import { CAL, pimHarness, type PimHarness } from './helpers/pimHarness'

const NOW = Date.UTC(2026, 10, 5, 12)
const ics = (lines: string[], method: string | null = 'REQUEST'): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN', ...(method ? [`METHOD:${method}`] : []), 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
const ev = (o: { uid?: string; seq?: number; organizer?: string; mine?: string; more?: string[] } = {}): string[] => [
  `UID:${o.uid ?? 'u1'}`, 'DTSTAMP:20261101T000000Z', 'DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z', 'SUMMARY:Toplanti', `SEQUENCE:${o.seq ?? 1}`,
  `ORGANIZER;CN=Org:${o.organizer ?? 'mailto:org@x.co'}`, `ATTENDEE;PARTSTAT=${o.mine ?? 'NEEDS-ACTION'};RSVP=TRUE:mailto:a@t.co`, ...(o.more ?? [])
]

describe('davet RPC', () => {
  let worker: string
  let t: PimHarness
  let uid = 1

  beforeAll(() => {
    worker = buildGateWorker()
  })
  afterAll(removeGateWorkers)
  beforeEach(async () => {
    t = await pimHarness(worker)
    t.hub.now = () => NOW
  })
  afterEach(async () => {
    setVaultKey(null)
    await t.close()
  })

  /** Ekli ileti: kimlikleri döner */
  const mail = (raw: string, from: string | null = 'org@x.co'): { messageId: number; attachmentId: number } => {
    const folder = t.q.upsertFolder(t.acc, 'INBOX', 'inbox')
    const n = uid++
    const messageId = Number(t.db.prepare(`INSERT INTO messages (folder_id, account_id, folder_kind, uid, message_id, subject, from_addr, date) VALUES (?, ?, 'inbox', ?, ?, 'd', ?, 1)`).run(folder, t.acc, n, `<m${n}@x.co>`, from).lastInsertRowid)
    const diskPath = join(t.dir, `davet-${n}.ics`)
    writeFileSync(diskPath, raw)
    const attachmentId = t.q.insertAttachment({ messageId, partId: null, filename: 'invite.ics', mime: 'text/calendar', size: Buffer.byteLength(raw), contentId: null, diskPath })
    return { messageId, attachmentId: attachmentId ?? (t.db.prepare(`SELECT id FROM attachments WHERE message_id = ?`).get(messageId) as { id: number }).id }
  }
  const invite = async (m: { messageId: number }, user = t.manager): Promise<InviteInfo | null> => (await h.getInvite(t.session(user), { messageId: m.messageId, tz: 'UTC' })) as InviteInfo | null
  const respond = (m: object, o: object = {}, user = t.manager) => h.respondInvite(t.session(user), { ...m, partstat: 'ACCEPTED', sendReply: true, ...o })
  const objects = (): number => (t.db.prepare(`SELECT COUNT(*) AS n FROM calendar_objects`).get() as { n: number }).n
  const replies = (): { draft: { to: string; subject: string; inReplyTo: string }; meta: { messageId: string; date: number; ical: { method: string; content: string } } }[] =>
    (t.db.prepare(`SELECT payload_json FROM op_queue WHERE kind = 'smtp_send'`).all() as { payload_json: string }[]).map((r) => JSON.parse(r.payload_json))
  const puts = () => t.dav.requests.filter((r) => r.method === 'PUT')
  const stored = (raw: string): void => {
    t.dav.seed(`${CAL}1.ics`, raw)
  }
  const seeded = async (raw = ics(ev(), null)): Promise<void> => {
    stored(raw)
    await t.sync()
  }
  const responses = (): number => (t.db.prepare(`SELECT COUNT(*) AS n FROM invite_responses`).get() as { n: number }).n

  it('getInvite denied without view', async () => {
    const m = mail(ics(ev()))
    await expect(invite(m, t.stranger)).rejects.toThrow()
    await expect(respond(m, {}, t.stranger)).rejects.toThrow()
  })

  it('view-only member cannot respond', async () => {
    await t.sync()
    const m = mail(ics(ev()))
    expect(await invite(m, t.viewer)).toMatchObject({ canRespond: false, canAddToCalendar: false })
    await expect(respond(m, {}, t.viewer)).rejects.toThrow()
    expect(replies()).toEqual([])
  })

  it('attachment of another message is refused', async () => {
    const a = mail(ics(ev()))
    const b = mail(ics(ev()))
    await expect(respond({ messageId: a.messageId, attachmentId: b.attachmentId })).rejects.toThrow()
  })

  it('nothing applied without click', async () => {
    await seeded(ics(ev({ uid: 'var', seq: 3 }), null))
    const before = objects()
    const bodies = [ics(ev({ uid: 'var', seq: 9 })), ics(ev({ uid: 'var', seq: 9 }), 'CANCEL'), ics(ev({ uid: 'yeni' }))]
    for (const raw of bodies) await invite(mail(raw))
    expect(objects()).toBe(before)
    expect(puts()).toEqual([])
    expect(t.dav.requests.filter((r) => r.method === 'DELETE')).toEqual([])
    expect(replies()).toEqual([])
    expect(responses()).toBe(0)
  })

  it('hostile calendar never reaches the parser on the main thread', async () => {
    t.hub.deps.pimGateWorker = hangingWorker()
    const m = mail(ics(ev({ more: ['X-HANG:1'] })))
    expect(await invite(m)).toBeNull()
    await expect(respond(m)).rejects.toThrow()
    expect(replies()).toEqual([])
  })

  it('not a calendar and oversized attachment make no card', async () => {
    expect(await invite(mail('merhaba'))).toBeNull()
    expect(await invite(mail(`${ics(ev())}${' '.repeat(1_000_001)}`))).toBeNull()
  })

  it('reply goes to the organizer, in the thread, with REPLY part', async () => {
    const m = mail(ics(ev()))
    expect(await respond(m)).toEqual({ sent: 'mail' })
    const [r] = replies()
    expect(r.draft).toMatchObject({ to: 'org@x.co', inReplyTo: `<m${uid - 1}@x.co>` })
    expect(r.draft.subject).toContain('Toplanti')
    expect(r.meta).toMatchObject({ date: NOW, ical: { method: 'REPLY' } })
    expect(r.meta.messageId).toMatch(/@t\.co>$/)
    const c = parseCalendar(r.meta.ical.content)!
    expect(c.events[0].attendees).toEqual([expect.objectContaining({ addr: 'a@t.co', partstat: 'ACCEPTED' })])
    expect(await invite(m)).toMatchObject({ response: { partstat: 'ACCEPTED', respondedAt: NOW } })
  })

  it('double click one reply', async () => {
    const m = mail(ics(ev()))
    await respond(m)
    expect(await respond(m)).toEqual({ sent: 'none' })
    expect(replies()).toHaveLength(1)
  })

  it('double click at the same moment one reply', async () => {
    const m = mail(ics(ev()))
    const r = await Promise.all([respond(m), respond(m), respond(m)])
    expect(replies()).toHaveLength(1)
    expect(r.filter((x) => (x as { sent: string }).sent === 'mail')).toHaveLength(1)
  })

  it('changed answer sends second reply', async () => {
    const m = mail(ics(ev()))
    await respond(m)
    expect(await respond(m, { partstat: 'DECLINED' })).toEqual({ sent: 'mail' })
    expect(replies()).toHaveLength(2)
  })

  it('newer sequence answers again', async () => {
    await respond(mail(ics(ev({ seq: 1 }))))
    expect(await respond(mail(ics(ev({ seq: 2 }))))).toEqual({ sent: 'mail' })
    expect(replies()).toHaveLength(2)
  })

  it('server-scheduled source sends no mail', async () => {
    t.db.prepare(`UPDATE pim_sources SET server_schedules = 1 WHERE id = ?`).run(t.source.id)
    await seeded()
    const m = mail(ics(ev()))
    expect(await respond(m)).toEqual({ sent: 'server' })
    expect(replies()).toEqual([])
    expect(puts()).toHaveLength(1)
    expect(puts()[0].headers['if-match']).toBeTruthy()
    expect(parseCalendar(t.dav.objects.get(`${CAL}1.ics`)!.data)!.events[0].attendees[0].partstat).toBe('ACCEPTED')
  })

  it('server-scheduled source: alias not among attendees falls back to mail', async () => {
    t.db.prepare(`UPDATE pim_sources SET server_schedules = 1 WHERE id = ?`).run(t.source.id)
    const other = ev().map((l) => l.replace('mailto:a@t.co', 'mailto:takma@t.co'))
    await seeded(ics(other, null))
    expect(await respond(mail(ics(other)))).toEqual({ sent: 'mail' })
    expect(puts()).toEqual([])
    expect(replies()).toHaveLength(1)
  })

  it('google source sends mail and puts partstat', async () => {
    await seeded()
    expect(await respond(mail(ics(ev())))).toEqual({ sent: 'mail' })
    expect(replies()).toHaveLength(1)
    expect(puts()).toHaveLength(1)
    expect(parseCalendar(t.dav.objects.get(`${CAL}1.ics`)!.data)!.events[0].attendees[0].partstat).toBe('ACCEPTED')
  })

  it('failed partstat put does not drop the reply', async () => {
    await seeded()
    t.dav.accept = ['Basic baska']
    expect(await respond(mail(ics(ev())))).toEqual({ sent: 'mail' })
    expect(replies()).toHaveLength(1)
  })

  it('accepted added to chosen calendar without METHOD, reply queued', async () => {
    await t.sync()
    const m = mail(ics(ev()))
    expect((await invite(m))!.canAddToCalendar).toBe(true)
    await respond(m, { calendarId: t.calendar().id })
    expect(objects()).toBe(1)
    const raw = (t.db.prepare(`SELECT raw FROM calendar_objects`).get() as { raw: string }).raw
    expect(raw).not.toContain('METHOD')
    expect(parseCalendar(raw)!.events[0].attendees[0].partstat).toBe('ACCEPTED')
    expect(await invite(m)).toMatchObject({ canAddToCalendar: false, existing: expect.objectContaining({ canWrite: true }) })
  })

  it('add without reply sends nothing and a later answer still goes', async () => {
    await t.sync()
    const m = mail(ics(ev()))
    expect(await respond(m, { sendReply: false, calendarId: t.calendar().id })).toEqual({ sent: 'none' })
    expect(replies()).toEqual([])
    expect(objects()).toBe(1)
    expect(await respond(m)).toEqual({ sent: 'mail' })
  })

  it('failed add keeps the reply and does not send it twice', async () => {
    await t.sync()
    const m = mail(ics(ev()))
    t.dav.accept = ['Basic baska']
    await expect(respond(m, { calendarId: t.calendar().id })).rejects.toThrow()
    t.dav.accept = null
    expect(replies()).toHaveLength(1)
    t.q.clearPimNeedsReauth(t.acc)
    await respond(m, { calendarId: t.calendar().id })
    expect(replies()).toHaveLength(1)
    expect(objects()).toBe(1)
  })

  it('declined not added', async () => {
    await t.sync()
    await respond(mail(ics(ev())), { partstat: 'DECLINED', calendarId: t.calendar().id })
    expect(objects()).toBe(0)
    expect(replies()).toHaveLength(1)
  })

  it('declined keeps an existing object', async () => {
    await seeded()
    await respond(mail(ics(ev())), { partstat: 'DECLINED' })
    expect(objects()).toBe(1)
  })

  it('publish added without reply', async () => {
    await t.sync()
    const m = mail(ics(ev(), 'PUBLISH'))
    expect(await invite(m)).toMatchObject({ method: 'PUBLISH', canRespond: false, canAddToCalendar: true })
    await expect(respond(m)).rejects.toThrow()
    await respond(m, { sendReply: false, calendarId: t.calendar().id })
    expect(objects()).toBe(1)
    expect(replies()).toEqual([])
  })

  it('reply and cancel messages take no action', async () => {
    for (const raw of [ics(ev(), 'CANCEL'), ics(['UID:u1', 'DTSTAMP:20261101T000000Z', 'DTSTART:20261120T100000Z', 'ORGANIZER:mailto:a@t.co', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:o@x.co'], 'REPLY')]) {
      await expect(respond(mail(raw, 'o@x.co'))).rejects.toThrow()
    }
    expect(replies()).toEqual([])
  })

  it('update applied by organizer, then answered again', async () => {
    await seeded(ics(ev({ mine: 'ACCEPTED' }), null))
    const m = mail(ics(ev({ seq: 2, more: ['LOCATION:Yeni oda'] }).map((l) => (l.startsWith('DTSTART') ? 'DTSTART:20261120T120000Z' : l.startsWith('DTEND') ? 'DTEND:20261120T130000Z' : l))))
    const i = (await invite(m))!
    expect(i).toMatchObject({ isUpdate: true, changes: ['time', 'location'] })
    expect(await h.applyInviteUpdate(t.session(t.manager), m)).toMatchObject({ ok: true })
    expect(puts()).toHaveLength(1)
    expect(puts()[0].headers['if-match']).toBeTruthy()
    const raw = t.dav.objects.get(`${CAL}1.ics`)!.data
    expect(raw).not.toContain('METHOD')
    expect(parseCalendar(raw)!.events[0].attendees[0].partstat).toBe('NEEDS-ACTION')
    expect(await invite(m)).toMatchObject({ isUpdate: false, canRespond: true })
  })

  it('update with different organizer refused', async () => {
    await seeded()
    const forged = mail(ics(ev({ seq: 5, organizer: 'mailto:saldirgan@evil.co' })), 'saldirgan@evil.co')
    expect(await invite(forged)).toMatchObject({ canRespond: false })
    expect((await invite(forged))!.warnings).toContain('organizerMismatch')
    await expect(h.applyInviteUpdate(t.session(t.manager), forged)).rejects.toThrow()
    await expect(respond(forged)).rejects.toThrow()
    const spoofed = mail(ics(ev({ seq: 5 })), 'saldirgan@evil.co')
    await expect(h.applyInviteUpdate(t.session(t.manager), spoofed)).rejects.toThrow()
    expect(puts()).toEqual([])
    expect(replies()).toEqual([])
  })

  it('cancel from organizer removes the object', async () => {
    await seeded()
    const m = mail(ics(ev({ seq: 2 }), 'CANCEL'))
    expect(await h.applyInviteCancel(t.session(t.manager), m)).toEqual({ ok: true })
    expect(objects()).toBe(0)
  })

  it('cancel of one occurrence keeps the series', async () => {
    await seeded(ics(ev({ more: ['RRULE:FREQ=WEEKLY;COUNT=4'] }), null))
    const m = mail(ics(ev({ seq: 2, more: ['RECURRENCE-ID:20261127T100000Z'] }), 'CANCEL'))
    expect(await h.applyInviteCancel(t.session(t.manager), m)).toEqual({ ok: true })
    expect(objects()).toBe(1)
    expect(t.dav.objects.get(`${CAL}1.ics`)!.data).toContain('EXDATE:20261127T100000Z')
  })

  it('cancel from non-organizer refused', async () => {
    await seeded()
    for (const m of [mail(ics(ev({ seq: 2, organizer: 'mailto:saldirgan@evil.co' }), 'CANCEL'), 'saldirgan@evil.co'), mail(ics(ev({ seq: 2 }), 'CANCEL'), 'saldirgan@evil.co')]) {
      await expect(h.applyInviteCancel(t.session(t.manager), m)).rejects.toThrow()
    }
    expect(objects()).toBe(1)
  })

  it('cancel for an object without organizer refused', async () => {
    await seeded(ics(['UID:u1', 'DTSTAMP:20261101T000000Z', 'DTSTART:20261120T100000Z', 'SUMMARY:kendi'], null))
    await expect(h.applyInviteCancel(t.session(t.manager), mail(ics(ev({ seq: 2 }), 'CANCEL')))).rejects.toThrow()
    expect(objects()).toBe(1)
  })

  it('lower sequence stale', async () => {
    await seeded(ics(ev({ seq: 4 }), null))
    for (const m of [mail(ics(ev({ seq: 2 }))), mail(ics(ev({ seq: 2 }), 'CANCEL'))]) {
      const i = (await invite(m))!
      expect(i.warnings).toContain('stale')
      expect(i).toMatchObject({ canRespond: false, canAddToCalendar: false })
      await expect(respond(m)).rejects.toThrow()
      await expect(h.applyInviteCancel(t.session(t.manager), m)).rejects.toThrow()
    }
    expect(objects()).toBe(1)
  })

  it('vault account: no calendar add, nothing persisted', async () => {
    await seeded()
    const m = mail(ics(ev()))
    t.q.setAccountSecureFlag(t.acc, true)
    setVaultKey(randomBytes(32))
    const i = (await invite(m))!
    expect(i).toMatchObject({ canAddToCalendar: false, canRespond: true, existing: null })
    await expect(respond(m, { calendarId: t.calendar().id })).rejects.toThrow()
    expect(await respond(m)).toEqual({ sent: 'mail' })
    expect(await respond(m)).toEqual({ sent: 'none' })
    expect(responses()).toBe(0)
    expect(puts()).toEqual([])
    const row = t.db.prepare(`SELECT payload_json FROM op_queue WHERE kind = 'smtp_send'`).all() as { payload_json: string }[]
    expect(row).toHaveLength(1)
    expect(row[0].payload_json.startsWith('vault:')).toBe(true)
    await expect(h.applyInviteUpdate(t.session(t.manager), mail(ics(ev({ seq: 9 }))))).rejects.toThrow()
  })

  it('vault account reply never queues in the clear', async () => {
    await seeded()
    const m = mail(ics(ev()))
    t.q.setAccountSecureFlag(t.acc, true)
    setVaultKey(null)
    await expect(respond(m)).rejects.toThrow()
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM op_queue WHERE kind = 'smtp_send'`).get()).toEqual({ n: 0 })
  })

  it('offline reply queued like normal send', async () => {
    t.hub.deps.scheduler = { ...t.hub.deps.scheduler, net: { state: 'offline' } } as never
    expect(t.hub.pimDeps().offline()).toBe(true)
    expect(await respond(mail(ics(ev())))).toEqual({ sent: 'mail' })
    expect(replies()).toHaveLength(1)
  })

  it('read-only calendar not offered', async () => {
    await t.sync()
    t.db.prepare(`UPDATE pim_collections SET read_only = 1 WHERE type = 'calendar'`).run()
    const m = mail(ics(ev()))
    await expect(respond(m, { calendarId: t.calendar().id })).rejects.toThrow()
    expect(replies()).toEqual([])
    expect(objects()).toBe(0)
  })

  it('address book is not a calendar', async () => {
    await t.sync()
    await expect(respond(mail(ics(ev())), { calendarId: t.book().id })).rejects.toThrow()
  })

  it('invalid organizer no respond', async () => {
    for (const organizer of ['http://evil.co/x', 'mailto:a@x.co,b@x.co']) {
      const m = mail(ics(ev({ organizer })))
      const i = (await invite(m))!
      expect(i).toMatchObject({ canRespond: false, organizer: null })
      await expect(respond(m)).rejects.toThrow()
    }
    expect(replies()).toEqual([])
  })

  describe('Microsoft 365', () => {
    let graph: FakeGraph
    const OCC = { start: { dateTime: '2026-11-27T10:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-27T11:00:00.0000000', timeZone: 'UTC' } }
    const posts = () => graph.requests.filter((r) => r.method === 'POST')

    beforeEach(async () => {
      graph = await FakeGraph.start()
      initOAuth(new TokenCache(() => ({ clientId: 'c' }), undefined, (async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'b', expires_in: 3600 }) })) as never, undefined, () => true))
      t.db.prepare(`UPDATE accounts SET auth_type = 'oauth:microsoft' WHERE id = ?`).run(t.acc)
      t.db.prepare(`UPDATE pim_sources SET kind = 'graph', caldav_url = NULL, carddav_url = NULL WHERE id = ?`).run(t.source.id)
      t.hub.deps.pimGraphBase = graph.url
      const org = { organizer: { emailAddress: { address: 'org@x.co' } }, attendees: [{ emailAddress: { address: 'a@t.co' } }] }
      graph.events.get('takvim')!.push(
        graphEvent('tek', { iCalUId: 'u1', ...org }),
        graphEvent('o1', { iCalUId: 'seri', type: 'occurrence', seriesMasterId: 'ana', originalStart: '2026-11-20T10:00:00Z', ...org }),
        graphEvent('o2', { iCalUId: 'seri', type: 'occurrence', seriesMasterId: 'ana', originalStart: '2026-11-27T10:00:00Z', ...OCC, ...org })
      )
      await t.sync()
    })
    afterEach(() => graph.close())

    it('graph source uses accept endpoint', async () => {
      expect(await respond(mail(ics(ev())))).toEqual({ sent: 'graph' })
      expect(posts().map((r) => r.url)).toEqual(['/v1.0/me/events/tek/accept'])
      expect(replies()).toEqual([])
      expect(puts()).toEqual([])
    })

    it('series invite answers the master, not one occurrence', async () => {
      expect(await respond(mail(ics(ev({ uid: 'seri', more: ['RRULE:FREQ=WEEKLY;COUNT=2'] }))), { partstat: 'DECLINED' })).toEqual({ sent: 'graph' })
      expect(posts().map((r) => r.url)).toEqual(['/v1.0/me/events/ana/decline'])
    })

    it('occurrence invite answers only that occurrence', async () => {
      await respond(mail(ics(ev({ uid: 'seri', more: ['RECURRENCE-ID:20261127T100000Z'] }))))
      expect(posts().map((r) => r.url)).toEqual(['/v1.0/me/events/o2/accept'])
    })

    it('occurrence outside the synced rows falls back to mail, never the series', async () => {
      expect(await respond(mail(ics(ev({ uid: 'seri', more: ['RECURRENCE-ID:20270101T100000Z'] }))))).toEqual({ sent: 'mail' })
      expect(posts()).toEqual([])
    })

    it('stored sequence unknown: invite is neither update nor stale', async () => {
      expect(await invite(mail(ics(ev({ seq: 7 }))))).toMatchObject({ isUpdate: false, warnings: [] })
      await expect(h.applyInviteUpdate(t.session(t.manager), mail(ics(ev({ seq: 7 }))))).rejects.toThrow()
    })

    it('add without reply does not answer Exchange', async () => {
      expect(await respond(mail(ics(ev())), { sendReply: false })).toEqual({ sent: 'none' })
      expect(posts()).toEqual([])
    })

    it('series cancel deletes the master', async () => {
      const m = mail(ics(ev({ uid: 'seri', seq: 2, more: ['RRULE:FREQ=WEEKLY;COUNT=2'] }), 'CANCEL'))
      expect(await h.applyInviteCancel(t.session(t.manager), m)).toEqual({ ok: true })
      expect(graph.requests.filter((r) => r.method === 'DELETE').map((r) => r.url)).toEqual(['/v1.0/me/events/ana'])
    })
  })
})
