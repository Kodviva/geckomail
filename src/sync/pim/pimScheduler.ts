// Kaynakların arka plan eşitlemesi. Reddedilen kimlik hiç yeniden denenmez: yanlış parola sunucuda IP engeli yaratır,
// yalnız kullanıcı eylemi (parola değişimi, yeniden yetkilendirme) kaynağı geri açar.
import { t } from '../../shared/i18n'
import type { PimCollectionRow, PimSourceRow } from '../db/queries'
import { syncLog as log } from '../log'
import { syncBatch } from './apply'
import { backendFor, type PimDeps } from './backend'
import { DavAuthError } from './davClient'
import { GraphAuthError } from './graphClient'
import { sourceReady } from './davBackend'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const MAX_PARALLEL = 4
const MAX_PER_HOST = 2
/** Tek kaynağın turu: asılı kalan kaynak paralellik yuvasını tutmasın */
const RUN_DEADLINE_MS = 10 * MINUTE

/** Zamanlayıcının eşitlediği türler; yerel kaynakta eşitlenecek bir şey yok */
const SYNC_KINDS: ReadonlySet<string> = new Set(['dav', 'ics', 'graph'])

export const backoffMs = (failCount: number): number => Math.min(MINUTE * 2 ** Math.min(failCount - 1, 16), 6 * HOUR)

export const isAuthFailure = (e: unknown): boolean => e instanceof DavAuthError || (e as { authenticationFailed?: boolean }).authenticationFailed === true

/** Paralellik sınırının anahtarı. Abonelik etiketi akışın gerçek ana makinesidir: boş anahtar bütün akışları tek sıraya sokardı */
export function pimHostKey(src: Pick<PimSourceRow, 'kind' | 'label' | 'caldav_url' | 'carddav_url'>): string {
  if (src.kind === 'graph') return 'graph.microsoft.com'
  if (src.kind === 'ics') return src.label.toLowerCase()
  try {
    return new URL(src.caldav_url ?? src.carddav_url ?? '').host
  } catch {
    return ''
  }
}

export class PimScheduler {
  private readonly running = new Map<number, Promise<void>>()
  private readonly hosts = new Map<string, number>()
  /** Alım kapısında takılan içerikler: ertelenen nesneler sonraki turda bunların yerine denenir */
  private readonly hung = new Set<string>()
  private stopped = false

  private readonly runDeadlineMs: number

  constructor(private readonly d: PimDeps, o: { runDeadlineMs?: number } = {}) {
    this.runDeadlineMs = o.runDeadlineMs ?? RUN_DEADLINE_MS
  }

  private intervalOf(src: PimSourceRow): number {
    const google = src.account_id != null && this.d.q.getAccountRow(src.account_id)?.auth_type === 'oauth:google'
    if (google) return 10 * MINUTE
    return src.kind === 'ics' ? 6 * HOUR : 5 * MINUTE
  }

  /** Vakti gelen kaynakları sınırlar içinde başlatır */
  tick(): void {
    if (this.stopped || this.d.offline()) return
    for (const src of this.d.q.duePimSources(this.d.now())) {
      if (this.running.size >= MAX_PARALLEL) return
      if (!SYNC_KINDS.has(src.kind) || this.running.has(src.id) || !sourceReady(this.d, src)) continue
      if ((this.hosts.get(pimHostKey(src)) ?? 0) >= MAX_PER_HOST) continue
      void this.start(src)
    }
  }

  /** Kullanıcının isteği: bekleme atlanır, reddedilmiş kimlik yine de denenmez */
  syncNow(sourceId: number): Promise<void> {
    const src = this.d.q.getPimSource(sourceId)
    if (this.stopped || !src || !SYNC_KINDS.has(src.kind) || src.status === 'needs_reauth' || this.d.offline() || !sourceReady(this.d, src)) return Promise.resolve()
    return this.running.get(src.id) ?? this.start(src)
  }

  stop(): void {
    this.stopped = true
  }

  private start(src: PimSourceRow): Promise<void> {
    const host = pimHostKey(src)
    this.hosts.set(host, (this.hosts.get(host) ?? 0) + 1)
    const p = this.bounded(src)
      .catch((e) => {
        if (!this.stopped) log.warn('kişi ve takvim kaynağı işlenemedi', { sourceId: src.id, error: (e as Error).message })
      })
      .finally(() => {
        this.running.delete(src.id)
        const left = (this.hosts.get(host) ?? 1) - 1
        if (left > 0) this.hosts.set(host, left)
        else this.hosts.delete(host)
      })
    this.running.set(src.id, p)
    return p
  }

  /** Süre dolunca yuva boşalır, kaynak hata sayılır; geride kalan tur `live` ile sonuç yazmaz */
  private async bounded(src: PimSourceRow): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = { live: true }
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        run.live = false
        this.d.q.markPimSourceFailed(src.id, t('sync.net.timeout'), src.fail_count + 1, this.d.now() + backoffMs(src.fail_count + 1))
        this.d.emit(src, 'sources')
        resolve()
      }, this.runDeadlineMs)
    })
    await Promise.race([this.run(src, run).catch(() => {}), expired]).finally(() => clearTimeout(timer))
  }

  private async run(src: PimSourceRow, state: { live: boolean }): Promise<void> {
    const { q } = this.d
    const dead = (): boolean => this.stopped || !state.live
    try {
      const backend = backendFor(this.d, src)
      const remote = await backend.listCollections()
      if (dead()) return
      const collections: PimCollectionRow[] = q.reconcilePimCollections(src.id, remote)
      const changedKinds = new Set<'contacts' | 'calendar'>()
      let skipped = 0
      let deferred = 0
      const denied: GraphAuthError[] = []
      for (const c of collections) {
        const batch = syncBatch(this.d, c, this.hung)
        try {
          await backend.sync(c, batch.sink)
        } catch (e) {
          // paylaşılan tek takvimin 403'ü kaynağı durdurmaz; hepsi reddedilirse izin gerçekten yoktur
          if (e instanceof GraphAuthError && e.status === 403) {
            denied.push(e)
            continue
          }
          throw e
        }
        if (dead()) return
        const r = await batch.commit()
        if (dead()) return
        skipped += r.skipped
        deferred += r.deferred
        if (r.changed) changedKinds.add(c.type === 'addressbook' ? 'contacts' : 'calendar')
      }
      if (denied.length && denied.length === collections.length) throw denied[0]
      if (skipped || deferred) log.warn('kişi ve takvim: ayrıştırılamayan nesneler atlandı', { sourceId: src.id, skipped, deferred })
      // ertelenenler altı saatlik akışta da yakında yinelenir
      const interval = deferred ? Math.min(this.intervalOf(src), 5 * MINUTE) : this.intervalOf(src)
      q.markPimSourceSynced(src.id, this.d.now(), this.d.now() + interval)
      for (const kind of changedKinds) this.d.emit(src, kind)
      this.d.emit(src, 'sources')
    } catch (e) {
      if (dead()) return
      // hizmet yavaşlatıyor: hata değil, belirtilen süre beklenir
      const retryAfter = (e as { retryAfterMs?: number }).retryAfterMs
      if (retryAfter) {
        q.deferPimSource(src.id, this.d.now() + retryAfter)
        return
      }
      const message = String((e as Error).message ?? e).slice(0, 200)
      if (isAuthFailure(e)) q.markPimSourceNeedsReauth(src.id, message || t('pim.err.davAuth'))
      else q.markPimSourceFailed(src.id, message, src.fail_count + 1, this.d.now() + backoffMs(src.fail_count + 1))
      this.d.emit(src, 'sources')
    }
  }
}
