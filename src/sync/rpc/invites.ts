// RPC — Davetler. Posta yoluyla gelen takvim nesnesi alım kapısından (`apply.ts`) geçmez ve göndereni herkes olabilir: boyut ve biçim denetiminden
// sonraki ilk iş `gateCalendars`tır, ayrıştırıcı ana iş parçacığında kapıdan önce çalışmaz. Hiçbir şey tıklamasız uygulanmaz: `getInvite` yalnız okur.
import { readFileSync, statSync } from 'fs'
import type { InviteChange, InviteInfo, InvitePartstat, WriteResult } from '../../shared/pim'
import { isCalendarAttachment } from '../../shared/pim'
import { getLocale, t, tFor } from '../../shared/i18n'
import { downloadAttachmentPart } from '../bodyFetch'
import type { CalendarObjectRow, PimCollectionRow, PimSourceRow, Queries } from '../db/queries'
import { syncLog } from '../log'
import { DEFERRED, gateCalendars } from '../pim/gate'
import { seriesMasterOf } from '../pim/graphMap'
import { parseCalendar, removeOccurrence, setPartstat, type ParsedCalendar } from '../pim/ical'
import { buildReply, mergeUpdate, readInvite, toStorable, type InviteRead } from '../pim/itip'
import { occurrenceOf } from '../pim/recur'
import { isValidTz } from '../pim/tz'
import type { RpcHub } from '../rpcHub'
import type { RpcSession } from '../rpcSession'
import { newMessageId } from '../smtpSend'
import { dropObject, myAddress, putObject, type Target } from './calendar'
import type { Handler } from './common'
import { loadAttachment, attachmentOnDisk } from './mail'
import { assertAccountManage, assertAccountView, assertCollectionWrite, ensureLocalSource, visibleSources } from './pimAuth'
import { syncSoon } from './pimSources'
import { remoteCall, writeBackend, wrote } from './pimWrite'

const MAX_INVITE_BYTES = 1_000_000
/** Gmail aynı daveti hem alternatif parça hem invite.ics olarak yollar; ileti yüzlerce ek taşıyıp kapıyı meşgul edemesin */
const MAX_CANDIDATES = 3
const PARTSTATS: readonly string[] = ['ACCEPTED', 'DECLINED', 'TENTATIVE']
const LOOKS_LIKE_CALENDAR = /^\uFEFF?\s*BEGIN:VCALENDAR/i

type Message = NonNullable<ReturnType<Queries['getMessage']>>
type Attachment = NonNullable<ReturnType<Queries['getAttachment']>>

interface Stored {
  row: CalendarObjectRow
  collection: PimCollectionRow
  source: PimSourceRow
  canWrite: boolean
}

interface Loaded {
  msg: Message
  attachmentId: number
  raw: string
  parsed: ParsedCalendar
  invite: InviteRead
  stored: Stored | null
  vault: boolean
  me: string
}

/** Süreç ömrünce: takılan içerik kartı her açışta 1 sn yedirmez */
const hungByHub = new WeakMap<RpcHub, Set<string>>()
const inFlightByHub = new WeakMap<RpcHub, Set<string>>()
/** Kasa hesabı `invite_responses`a yazmaz: çift yanıt koruması süreç belleğinde */
const vaultAnswers = new WeakMap<RpcHub, Map<string, { sequence: number; partstat: string; responded_at: number }>>()

function memo<K extends RpcHub, V>(map: WeakMap<K, V>, key: K, make: () => V): V {
  const found = map.get(key)
  if (found) return found
  const made = make()
  map.set(key, made)
  return made
}

const notApplicable = (): Error => new Error(t('invite.err.notApplicable'))

async function attachmentText(s: RpcSession, msg: Message, att: Attachment, vault: boolean): Promise<string | null> {
  if ((att.size ?? 0) > MAX_INVITE_BYTES) return null
  if (vault && !att.disk_path) {
    const bytes = await s.deps.scheduler.enqueueInteractive(msg.accountId, async (client) => downloadAttachmentPart(msg, att, client))
    return bytes.length > MAX_INVITE_BYTES ? null : bytes.toString('utf-8')
  }
  const path = await attachmentOnDisk(s.deps, msg, att)
  return statSync(path).size > MAX_INVITE_BYTES ? null : readFileSync(path, 'utf-8')
}

/** Kapıdan geçen ham nesne; geçemezse null. Worker hiç başlamazsa fırlatır: nesne suçlu değil */
async function gatedText(s: RpcSession, msg: Message, att: Attachment, vault: boolean, tz: string): Promise<string | null> {
  const raw = await attachmentText(s, msg, att, vault)
  if (!raw || !LOOKS_LIKE_CALENDAR.test(raw)) return null
  const [verdict] = await gateCalendars([raw], { viewerTz: tz, now: s.hub.now(), workerPath: s.hub.pimDeps().gateWorker, hung: memo(hungByHub, s.hub, () => new Set<string>()) })
  return verdict && verdict !== DEFERRED ? raw : null
}

/** Kopyanın hangi oluşuma ait olduğu: Graph'ta her oluşum ayrı satırdır */
const rowRid = (row: CalendarObjectRow): string | null => parseCalendar(row.raw)?.events[0]?.recurrenceId ?? null

/** Davetin takvimdeki kopyası. Yalnız bu iletinin hesabı ve kullanıcının kendi kaynakları: başka hesabın aynı UID'li kopyası başka posta kutusunun yanıtıdır. */
function findStored(s: RpcSession, accountId: number, uid: string, rid: string | null): Stored | null {
  const { q } = s.deps
  const me = s.currentUser!.id
  const mine = visibleSources(s).filter((v) => v.source.account_id === accountId || v.source.owner_user_id === me)
  const bySource = new Map(mine.map((v) => [v.source.id, v]))
  const collections = new Map(q.listPimCollectionsByType('calendar').filter((c) => bySource.has(c.source_id)).map((c) => [c.id, c]))
  const found = q.calendarObjectsByUid([...collections.keys()], uid).flatMap((row): Stored[] => {
    const collection = collections.get(row.collection_id)!
    const v = bySource.get(collection.source_id)!
    // Graph oluşumları ayrı nesnedir (recurring=0): tek oluşumun daveti yalnız kendi satırıyla eşleşir
    if (v.source.kind === 'graph' && rid && rowRid(row) !== rid) return []
    return [{ row, collection, source: v.source, canWrite: v.canWrite && !collection.read_only }]
  })
  return found.find((x) => x.canWrite) ?? found[0] ?? null
}

/** Karşılaştırılacak SEQUENCE: tek oluşum kendi kopyasıyla (yoksa seriyle), bütünü en yüksekle. Graph SEQUENCE taşımaz. */
function storedSequence(st: Stored, rid: string | null): number | null {
  if (st.source.kind === 'graph') return null
  if (!rid) return st.row.sequence
  const c = parseCalendar(st.row.raw)
  return c?.events.find((e) => e.recurrenceId === rid)?.sequence ?? c?.events.find((e) => !e.recurrenceId)?.sequence ?? st.row.sequence
}

async function loadOne(s: RpcSession, msg: Message, att: Attachment, tz: string): Promise<Loaded | null> {
  const account = s.deps.q.getAccountRow(msg.accountId)
  if (!account) return null
  const vault = !!account.secure
  const raw = await gatedText(s, msg, att, vault, tz)
  if (!raw) return null
  const parsed = parseCalendar(raw)
  const me = account.email.toLowerCase()
  const peek = parsed && readInvite(raw, { fromAddr: msg.fromAddr, myAddr: me, stored: null, viewerTz: tz })
  if (!parsed || !peek) return null
  const stored = vault ? null : findStored(s, msg.accountId, peek.uid, peek.recurrenceId)
  const invite = stored ? readInvite(raw, { fromAddr: msg.fromAddr, myAddr: me, stored: { sequence: storedSequence(stored, peek.recurrenceId), organizer: stored.row.organizer }, viewerTz: tz }) : peek
  return invite ? { msg, attachmentId: att.id, raw, parsed, invite, stored, vault, me } : null
}

function messageFor(s: RpcSession, id: unknown): Message {
  const msg = s.deps.q.getMessage(Number(id))
  if (!msg) throw new Error(t('sync.mail.messageNotFound'))
  return msg
}

/** Eylem RPC'leri: yetki denetiminden sonra, eki iletiye bağlayıp yeniden kapıdan geçirir */
async function loadForAction(s: RpcSession, p: { messageId?: unknown; attachmentId?: unknown }): Promise<Loaded> {
  const msg = messageFor(s, p.messageId)
  assertAccountManage(s, msg.accountId)
  const { att } = loadAttachment(s.deps.q, msg.id, Number(p.attachmentId))
  const found = isCalendarAttachment(att) ? await loadOne(s, msg, att, 'UTC') : null
  if (!found) throw notApplicable()
  return found
}

function changesFrom(l: Loaded, tz: string): InviteChange[] {
  if (!l.invite.isUpdate || !l.stored) return []
  const c = parseCalendar(l.stored.row.raw)
  const ev = c?.events.find((e) => e.recurrenceId === l.invite.recurrenceId) ?? c?.events.find((e) => !e.recurrenceId)
  const occ = c && occurrenceOf(c, l.invite.recurrenceId, tz)
  const out: InviteChange[] = []
  if (!occ || occ.start !== l.invite.start || occ.end !== l.invite.end) out.push('time')
  if ((ev?.summary ?? '') !== l.invite.title) out.push('title')
  if ((ev?.location ?? null) !== l.invite.location) out.push('location')
  return out
}

const answerKey = (accountId: number, uid: string, rid: string | null): string => `${accountId}\n${uid}\n${rid ?? ''}`

function priorAnswer(s: RpcSession, l: Loaded): { sequence: number; partstat: string; responded_at: number } | undefined {
  const { uid, recurrenceId } = l.invite
  if (l.vault) return vaultAnswers.get(s.hub)?.get(answerKey(l.msg.accountId, uid, recurrenceId))
  return s.deps.q.inviteResponse(l.msg.accountId, uid, recurrenceId)
}

function saveAnswer(s: RpcSession, l: Loaded, partstat: string): void {
  const { uid, recurrenceId, sequence } = l.invite
  const now = s.hub.now()
  if (l.vault) memo(vaultAnswers, s.hub, () => new Map()).set(answerKey(l.msg.accountId, uid, recurrenceId), { sequence, partstat, responded_at: now })
  else s.deps.q.saveInviteResponse({ accountId: l.msg.accountId, uid, recurrenceId, sequence, partstat, userId: s.currentUser!.id, now })
}

function hasWritableCalendar(s: RpcSession): boolean {
  ensureLocalSource(s)
  const writable = new Set(visibleSources(s).filter((v) => v.canWrite).map((v) => v.source.id))
  return s.deps.q.listPimCollectionsByType('calendar').some((c) => writable.has(c.source_id) && !c.read_only)
}

const storedOrganizerDiffers = (l: Loaded): boolean => !!l.stored?.row.organizer && l.stored.row.organizer !== l.invite.organizer?.addr
const isStale = (i: InviteRead): boolean => i.warnings.includes('stale')

function info(s: RpcSession, l: Loaded, tz: string): InviteInfo {
  const { invite, stored, vault, msg } = l
  const canManage = canManageAccount(s, msg.accountId)
  const answer = priorAnswer(s, l)
  const addable = invite.method === 'REQUEST' || invite.method === 'PUBLISH'
  return {
    ...invite, attachmentId: l.attachmentId,
    existing: stored && { objectId: stored.row.id, collectionId: stored.collection.id, sequence: stored.row.sequence, canWrite: stored.canWrite && canManage },
    changes: changesFrom(l, tz),
    response: answer && answer.sequence === invite.sequence ? { partstat: answer.partstat, respondedAt: answer.responded_at } : null,
    canAddToCalendar: addable && !vault && canManage && !stored && !isStale(invite) && hasWritableCalendar(s),
    canRespond: invite.method === 'REQUEST' && canManage && !!invite.organizer && !isStale(invite) && !storedOrganizerDiffers(l)
  }
}

function canManageAccount(s: RpcSession, accountId: number): boolean {
  try {
    assertAccountManage(s, accountId)
    return true
  } catch {
    return false
  }
}

const targetOf = (s: RpcSession, st: Stored): Target => {
  const { collection, source } = assertCollectionWrite(s, st.collection.id)
  return { s, collection, source, backend: writeBackend(s, source) }
}

/** Yanıtımı kopyaya yazar. 'absent': adresim katılımcı değil (takma ad), yazacak bir şey yok */
async function putPartstat(s: RpcSession, st: Stored, l: Loaded, partstat: string): Promise<'ok' | 'conflict' | 'absent'> {
  const me = myAddress(s, st.source) ?? l.me
  const next = setPartstat(st.row.raw, me, partstat, s.hub.now(), l.invite.recurrenceId)
  if (next === st.row.raw) return 'absent'
  const r = await putObject(targetOf(s, st), st.row.remote_id, next, st.row.etag)
  if (r === 'conflict') return r
  wrote(s, st.source, 'calendar')
  return 'ok'
}

function queueReply(s: RpcSession, l: Loaded, partstat: InvitePartstat): void {
  const { q, opq } = s.deps
  const account = q.getAccountRow(l.msg.accountId)!
  const locale = getLocale()
  const title = l.invite.title || tFor(locale, 'calendar.noTitle')
  const content = buildReply(l.parsed, { attendee: { addr: account.email, name: account.display_name }, partstat, now: s.hub.now() })
  const draft = {
    accountId: account.id, to: l.invite.organizer!.addr, subject: tFor(locale, `invite.subject.${partstat.toLowerCase()}`, { title }), text: tFor(locale, `invite.body.${partstat.toLowerCase()}`, { title }),
    ...(l.msg.messageId ? { inReplyTo: l.msg.messageId, references: l.msg.messageId } : {})
  }
  // Message-ID ve tarih kuyruğa alınırken sabitlenir: yeniden deneme aynı yanıtı aynı kimlikle gönderir.
  // Kasa hesabında mühür zorunlu: kilitliyken düz yazmak yerine hata verir, takvim ayrıntısı op_queue'ya düz girmez
  q.enqueueOp(account.id, 'smtp_send', { draft, attachments: [], senderId: s.currentUser?.id, meta: { messageId: newMessageId(account.email), date: s.hub.now(), ical: { method: 'REPLY', content } } }, { seal: l.vault })
  opq.kick()
}

/** Graph yanıtı seri ana kaydına gider: oluşum satırına verilen yanıt yalnız o oluşumu kapsar */
async function replyViaGraph(s: RpcSession, st: Stored, partstat: InvitePartstat, l: Loaded): Promise<void> {
  const { collection, source, backend } = targetOf(s, st)
  const id = (!l.invite.recurrenceId && seriesMasterOf(st.row.raw)) || st.row.remote_id
  await remoteCall(s, source, () => backend.respond!(collection, id, partstat))
  wrote(s, source, 'calendar')
}

async function sendAnswer(s: RpcSession, l: Loaded, partstat: InvitePartstat): Promise<'mail' | 'server' | 'graph'> {
  const st = l.stored?.canWrite ? l.stored : null
  if (st?.source.kind === 'graph') {
    await replyViaGraph(s, st, partstat, l)
    return 'graph'
  }
  if (st?.source.kind === 'dav' && st.source.server_schedules) {
    const r = await putPartstat(s, st, l, partstat)
    if (r === 'conflict') {
      syncSoon(s, st.source)
      throw new Error(t('invite.err.conflict'))
    }
    if (r === 'ok') return 'server'
  }
  queueReply(s, l, partstat)
  if (st && st.source.kind !== 'ics') {
    // yanıt yola çıktı: kopyayı işaretlemek ek iş, başarısızlığı yanıtı düşürmez
    await putPartstat(s, st, l, partstat).catch((e: Error) => syncLog.warn('davet: katılım durumu takvime yazılamadı', { error: e.message }))
  }
  return 'mail'
}

async function addToCalendar(s: RpcSession, l: Loaded, target: Target, partstat: string | null): Promise<void> {
  const now = s.hub.now()
  const ics = toStorable(l.parsed, l.raw, { myAddr: l.me, partstat, now })
  const r = await putObject(target, null, ics, null, { uid: l.invite.uid })
  // aynı UID hedefte var: başka yoldan gelmiş, eklenecek bir şey kalmadı
  if (r !== 'conflict') wrote(s, target.source, 'calendar')
}

/** Güncelleme ve iptal yalnız kaydedilen düzenleyenden: başkasının gönderdiği ileti takvimi değiştiremez */
function requireOrganizer(l: Loaded): Stored {
  const st = l.stored
  if (l.vault || !st || !st.row.organizer || st.row.organizer !== l.invite.organizer?.addr || l.invite.warnings.includes('organizerMismatch')) throw new Error(t('invite.err.notOrganizer'))
  if (isStale(l.invite)) throw notApplicable()
  return st
}

export const invitesHandlers: Record<string, Handler> = {
  async getInvite(s, params) {
    const p = params as { messageId?: unknown; tz?: unknown }
    const msg = messageFor(s, p.messageId)
    assertAccountView(s, msg.accountId)
    const tz = typeof p.tz === 'string' && isValidTz(p.tz) ? p.tz : 'UTC'
    for (const att of s.deps.q.attachmentsFor(msg.id).filter(isCalendarAttachment).slice(0, MAX_CANDIDATES)) {
      try {
        const found = await loadOne(s, msg, att, tz)
        if (found) return info(s, found, tz)
      } catch (e) {
        // kart çıkmaz, ek çip olarak kalır
        syncLog.warn('davet okunamadı', { error: (e as Error).message })
        return null
      }
    }
    return null
  },

  async respondInvite(s, params) {
    const p = params as { messageId?: unknown; attachmentId?: unknown; partstat?: unknown; sendReply?: unknown; calendarId?: unknown }
    if (typeof p.partstat !== 'string' || !PARTSTATS.includes(p.partstat) || typeof p.sendReply !== 'boolean') throw new Error(t('pim.err.invalid'))
    const partstat = p.partstat as InvitePartstat
    const l = await loadForAction(s, p)
    const { invite } = l
    if (invite.method !== 'REQUEST' && invite.method !== 'PUBLISH') throw notApplicable()
    if (isStale(invite)) throw notApplicable()
    if (p.sendReply && (invite.method !== 'REQUEST' || !invite.organizer || storedOrganizerDiffers(l))) throw notApplicable()
    let target: Target | null = null
    if (p.calendarId != null) {
      if (l.vault) throw new Error(t('pim.err.vaultAccount'))
      const { collection, source } = assertCollectionWrite(s, Number(p.calendarId))
      if (collection.type !== 'calendar') throw new Error(t('pim.err.invalid'))
      target = { s, collection, source, backend: writeBackend(s, source) }
    }
    const inFlight = memo(inFlightByHub, s.hub, () => new Set<string>())
    const key = answerKey(l.msg.accountId, invite.uid, invite.recurrenceId)
    // adımlar arasında await var: çift tıkın ikincisi denetimi birlikte geçmesin
    if (inFlight.has(key)) return { sent: 'none' }
    inFlight.add(key)
    try {
      const prior = priorAnswer(s, l)
      const repeated = prior?.sequence === invite.sequence && prior.partstat === partstat
      let sent: 'mail' | 'server' | 'graph' | 'none' = 'none'
      if (p.sendReply && !repeated) {
        sent = await sendAnswer(s, l, partstat)
        // takvime ekleme hata alsa da yanıt gitti: yeniden deneme ikinci yanıt üretmesin
        saveAnswer(s, l, partstat)
      }
      if (target && !l.stored && partstat !== 'DECLINED') await addToCalendar(s, l, target, invite.method === 'REQUEST' ? partstat : null)
      return { sent }
    } finally {
      inFlight.delete(key)
    }
  },

  async applyInviteUpdate(s, params): Promise<WriteResult<{ objectId: number }>> {
    const l = await loadForAction(s, params as object)
    const st = requireOrganizer(l)
    if (!l.invite.isUpdate) throw notApplicable()
    const r = await putObject(targetOf(s, st), st.row.remote_id, mergeUpdate(st.row.raw, l.raw, { myAddr: l.me, now: s.hub.now() }), st.row.etag)
    if (r === 'conflict') return { ok: false, conflict: true }
    wrote(s, st.source, 'calendar')
    return { ok: true, objectId: r.objectId }
  },

  async applyInviteCancel(s, params): Promise<WriteResult<object>> {
    const l = await loadForAction(s, params as object)
    if (l.invite.method !== 'CANCEL') throw notApplicable()
    const st = requireOrganizer(l)
    const target = targetOf(s, st)
    const rid = l.invite.recurrenceId
    const rest = rid && st.source.kind !== 'graph' ? removeOccurrence(st.row.raw, rid, 'this', s.hub.now()) : null
    const r = rest ? await putObject(target, st.row.remote_id, rest, st.row.etag) : await dropObject(target, st.row, st.row.etag, rid ? 'this' : undefined)
    if (r === 'conflict') return { ok: false, conflict: true }
    wrote(s, st.source, 'calendar')
    return { ok: true }
  }
}
