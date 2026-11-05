// Eşitleme sonucunu tek transaction'da uygular: tur hata alırsa satırlar ve belirteç birlikte eski kalır, kısmi tur saklanmaz.
// Ayrıştırılamayan nesne atlanır ve sayılır; eski satırı varsa durur, tur düşmez. Takvim nesnesi ana iş parçacığında ayrıştırılmaz:
// dizin alanları ve hatırlatma alım kapısının worker'ından gelir. Kapı nesne erteledi ise geçenler saklanır ama eşitleme durumu
// ilerlemez: sunucu ertelenenleri bir daha bildirmezdi.
import { t } from '../../shared/i18n'
import type { PimCollectionRow } from '../db/queries'
import type { PimDeps, RemoteObject, SyncSink, SyncState } from './backend'
import { DEFERRED, gateCalendars } from './gate'
import { parseCard, type ParsedCard } from './vcard'

const MAX_OBJECT_BYTES = 1_000_000

export const viewerZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export interface SyncBatch {
  sink: SyncSink
  /** changed: yazılan ya da silinen; skipped: reddedilen; deferred: denenmeyen, sonraki turda yeniden gelir */
  commit(): Promise<{ changed: number; skipped: number; deferred: number }>
}

/** `hung`: takılan içeriklerin zamanlayıcıda tutulan özeti */
export function syncBatch(d: PimDeps, c: PimCollectionRow, hung?: Set<string>): SyncBatch {
  const { q } = d
  const upserts = new Map<string, RemoteObject>()
  const removes = new Set<string>()
  let replace = false
  const kept = new Set<string>()
  let state: SyncState = {}

  const sink: SyncSink = {
    etags: () => (c.type === 'addressbook' ? q.pimContactEtags(c.id) : q.pimEventEtags(c.id)),
    upsert(o) {
      removes.delete(o.remoteId)
      upserts.set(o.remoteId, o)
    },
    remove(remoteId) {
      upserts.delete(remoteId)
      removes.add(remoteId)
    },
    keep(remoteId) {
      kept.add(remoteId)
    },
    replaceAll(os) {
      replace = true
      upserts.clear()
      removes.clear()
      for (const o of os) upserts.set(o.remoteId, o)
    },
    setState(s) {
      state = { ...state, ...s }
    }
  }

  async function commit(): Promise<{ changed: number; skipped: number; deferred: number }> {
    const now = d.now()
    const tz = viewerZone()
    let skipped = 0
    const contacts: { o: RemoteObject; card: ParsedCard }[] = []
    const objects = [...upserts.values()].filter((o) => {
      if (Buffer.byteLength(o.data) <= MAX_OBJECT_BYTES) return true
      skipped++
      return false
    })
    if (c.type === 'addressbook') {
      for (const o of objects) {
        const card = parseCard(o.data)
        if (card) contacts.push({ o, card })
        else skipped++
      }
    }
    const gated = c.type === 'calendar' ? await gateCalendars(objects.map((o) => o.data), { viewerTz: tz, now, workerPath: d.gateWorker, hung }) : []
    const events = gated.flatMap((g, i) => (g && g !== DEFERRED ? [{ o: objects[i], gate: g }] : []))
    const deferred = gated.filter((g) => g === DEFERRED).length
    skipped += gated.length - events.length - deferred
    // bozuk gövde eski veriyi korur: "hiç nesne yok" ile "hepsi reddedildi" aynı şey değildir
    if (replace && upserts.size && !contacts.length && !events.length) throw new Error(t('pim.err.feedEmpty'))
    let changed = 0
    q.pimTransaction(() => {
      // tur sürerken kaynak kaldırılmışsa yazılacak bir şey yok
      if (!q.getPimCollection(c.id)) return
      if (replace) {
        const keep = new Set([...upserts.keys(), ...kept])
        for (const remoteId of sink.etags().keys()) if (!keep.has(remoteId)) removes.add(remoteId)
      }
      for (const remoteId of removes) changed += c.type === 'addressbook' ? q.deletePimContact(c.id, remoteId) : q.deletePimEvent(c.id, remoteId)
      for (const { o, card } of contacts) {
        q.upsertPimContact(c.id, { remoteId: o.remoteId, etag: o.etag, raw: o.data, card, now })
        changed++
      }
      for (const { o, gate } of events) {
        q.upsertPimEvent(c.id, { remoteId: o.remoteId, etag: o.etag, raw: o.data, fields: gate.fields, nextAlarmAt: gate.nextAlarmAt, now })
        changed++
      }
      if (deferred) return
      q.setPimCollectionState(c.id, state)
      if (state.feedEtag !== undefined) q.setPimFeedState(c.source_id, state.feedEtag, state.feedLastModified ?? null)
    })
    return { changed, skipped, deferred }
  }

  return { sink, commit }
}
