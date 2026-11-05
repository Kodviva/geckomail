// Yeni mail turu (R31 + §10.1): otomasyon kuralları hesapta bir kez çalışır, işlem bitince yeni iletiler ve
// "Bildir" eylemi nedenleri bildirim hattına geçer. Kişi başına karar hatta (notifyPipeline).
import type { MessageRow } from '../shared/rpc'
import type { Queries } from './db/queries'
import type { NotifyPipeline } from './notifyPipeline'
import type { OpQueue } from './opQueue'
import type { RpcHub } from './rpcHub'
import { RULES_BATCH, runRulesForAccount } from './rulesRunner'

export interface NewMailCtx {
  q: Queries
  opq: OpQueue
  hub: RpcHub
  pipeline: Pick<NotifyPipeline, 'onNewMail'>
}

export async function notifyNewMail(ctx: NewMailCtx, accountId: number): Promise<void> {
  // dolu tur: büyük varışın kalanı bir sonraki postayı beklemesin. Watermark ilerlediği için döngü biter
  for (;;) {
    let rows: MessageRow[] = []
    let reasons: ReadonlyMap<number, 'rule' | 'rule-urgent'> = new Map()
    let scanned = 0
    try {
      await runRulesForAccount(ctx.q, ctx.opq, accountId, (ev) => ctx.hub.broadcast('rule:matched', ev), (batch, why, count) => {
        rows = batch
        reasons = why
        scanned = count
      })
    } catch (e) {
      console.error('sync: kural kontrolü başarısız', e)
    }
    if (rows.length) await ctx.pipeline.onNewMail(accountId, rows, reasons)
    if (scanned < RULES_BATCH) return // süzülen satır sayısı turu erken bitirirdi
  }
}
