// Yerelden sunucuya taşımanın ana süreç koşucusu. Düz parola buraya hiç gelmez: motor mühürler, koşucu zarfı sunucuya iletir.
// Olaya yalnız sayı ve etiket yazılır, zarf renderer'a gitmez. Köken onayı her çalıştırmada main'in yerel iletişim kutusundadır,
// onaydan önce ne mühürleme istenir ne de sunucuya gidilir. electron içe aktarılmaz.
import type { ImportBlock, ImportNotice, MigrationEvent, MigrationFailure, PlanItem, Sealed, SealRequest } from '../shared/importTypes'
import { updateMode } from './desktopMode'
import type { ServerLink } from './serverLink'

export type { MigrationEvent } from '../shared/importTypes'

const BATCH = 5
/** Sunucu yanıtı da düşman sayılır: arayüze yalnız bilinen neden kodu gider */
const SERVER_BLOCKS: readonly ImportBlock[] = ['vaultRequired', 'vaultConflict', 'oauthReconnect', 'unmappedAccount', 'invalid', 'groupConflict', 'webhookConflict']
const SERVER_NOTICES: readonly unknown[] = ['scopeDisabled', 'groupDropped'] satisfies ImportNotice[]

export interface MigrationOptions {
  link: Pick<ServerLink, 'call'>
  engine: { plan(): Promise<PlanItem[]>; seal(r: SealRequest): Promise<Sealed[]> }
  confirm(o: { origin: string; accounts: number }): Promise<boolean>
  onEvent(e: MigrationEvent): void
  batch?: number
}

type ItemReply = { status: 'added' | 'updated' | 'kept' | 'blocked'; detail?: ImportBlock; notice?: unknown }

export class MigrationRunner {
  constructor(private readonly o: MigrationOptions) {}

  async run(sourceId: string, origin: string): Promise<void> {
    const { link, engine, onEvent } = this.o
    let plan: PlanItem[]
    try {
      plan = await engine.plan()
    } catch {
      return onEvent({ phase: 'paused', done: 0, total: 0, blocked: [], failed: [], reason: 'localSession' })
    }
    const sendable = plan.filter((i) => !i.blocked)
    const blocked = plan.filter((i) => i.blocked)
    const failed: MigrationEvent['failed'] = []
    const notices: NonNullable<MigrationEvent['notices']> = []
    const note = (it: PlanItem, notice: unknown): void => {
      if (SERVER_NOTICES.includes(notice)) notices.push({ key: it.key, label: it.label, notice: notice as ImportNotice })
    }
    for (const it of sendable) if (it.notice) notices.push({ key: it.key, label: it.label, notice: it.notice })
    let done = 0
    const emit = (phase: MigrationEvent['phase'], reason?: MigrationFailure): void => onEvent({ phase, done, total: sendable.length, blocked: [...blocked], failed: [...failed], notices: [...notices], ...(reason ? { reason } : {}) })
    emit('plan')
    if (!(await this.o.confirm({ origin, accounts: sendable.filter((i) => i.kind === 'account').length }))) return emit('paused')

    let begin: { importId: string; serverKey: string; done: string[]; notices?: { key?: unknown; notice?: unknown }[] }
    try {
      begin = await link.call('importBegin', { sourceId })
    } catch {
      return emit('paused', 'connection')
    }
    if (typeof begin?.importId !== 'string' || typeof begin.serverKey !== 'string') return emit('paused', 'connection')
    const already = new Set(Array.isArray(begin.done) ? begin.done : [])
    const rest = sendable.filter((i) => !already.has(i.key))
    done = sendable.length - rest.length
    if (Array.isArray(begin.notices)) {
      for (const n of begin.notices) {
        const it = sendable.find((i) => i.key === n?.key)
        if (it) note(it, n.notice)
      }
    }

    const size = this.o.batch ?? BATCH
    for (let at = 0; at < rest.length; at += size) {
      const batch = rest.slice(at, at + size)
      let sealed: Sealed[]
      try {
        sealed = await engine.seal({ importId: begin.importId, serverKey: begin.serverKey, keys: batch.map((i) => i.key) })
      } catch {
        return emit('paused', 'localSession')
      }
      const byKey = new Map(sealed.map((s) => [s.key, s]))
      for (const it of batch) {
        const envelope = byKey.get(it.key)
        if (!envelope) {
          failed.push({ key: it.key, label: it.label }) // kasa kilitlendi ya da öge o arada değişti: sonraki çalıştırmada
          continue
        }
        try {
          const r = await link.call<ItemReply>('importItem', { importId: begin.importId, item: envelope })
          if (r.status === 'blocked') blocked.push({ ...it, blocked: SERVER_BLOCKS.includes(r.detail as ImportBlock) ? r.detail! : 'invalid' })
          else {
            done++
            note(it, r.notice)
          }
          emit('sending')
        } catch {
          failed.push({ key: it.key, label: it.label })
          return emit('paused', 'connection')
        }
      }
    }
    if (failed.length) return emit('paused')
    try {
      await link.call('importFinish', { importId: begin.importId })
    } catch {
      return emit('paused', 'connection')
    }
    emit('done')
  }
}

/** Yerel veriye dokunmaz, modu değiştirmez: kullanıcı özetten sonra kendisi geçer */
export function recordImport(dir: string, origin: string, at: number = Date.now()): void {
  updateMode(dir, { importedTo: { origin, at } })
}
