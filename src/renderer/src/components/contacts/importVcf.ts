// vCard içe aktarma: dosya `END:VCARD` sınırından partilere bölünür, sırayla gönderilir. Kartın içeriği burada yorumlanmaz.
import { t } from '../../../../shared/i18n'
import { rpc } from '../../rpcClient'

export const MAX_IMPORT_BYTES = 20_000_000
export const MAX_IMPORT_CARDS = 20_000
const MAX_BATCH_BYTES = 1_000_000

const utf8Length = (s: string): number => new TextEncoder().encode(s).length

/** Tek başına sınırı aşan kart `oversized` sayılır, gönderilmez */
export function vcfBatches(text: string, maxBytes = MAX_BATCH_BYTES): { batches: string[]; cards: number; oversized: number } {
  const batches: string[] = []
  let cards = 0
  let oversized = 0
  let cur = ''
  let size = 0
  for (const part of text.split(/(?<=^[ \t]*END:VCARD[ \t]*\r?$)\n?/im)) {
    if (!/BEGIN:VCARD/i.test(part)) continue
    const n = utf8Length(part)
    if (n > maxBytes) {
      oversized++
      continue
    }
    cards++
    if (size + n > maxBytes) {
      batches.push(cur)
      cur = ''
      size = 0
    }
    cur += `${part}\n`
    size += n + 1
  }
  if (cur) batches.push(cur)
  return { batches, cards, oversized }
}

export async function importVcf(file: File, collectionId: number, progress: (done: number, total: number) => void): Promise<{ added: number; skipped: number; failed: number }> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error(t('contacts.import.tooLarge'))
  const { batches, cards, oversized } = vcfBatches(await file.text())
  if (cards + oversized > MAX_IMPORT_CARDS) throw new Error(t('contacts.import.tooMany'))
  const sum = { added: 0, skipped: 0, failed: oversized }
  for (let i = 0; i < batches.length; i++) {
    progress(i, batches.length)
    const r = await rpc.call('importContacts', { collectionId, vcards: batches[i] })
    sum.added += r.added
    sum.skipped += r.skipped
    sum.failed += r.failed
  }
  return sum
}
