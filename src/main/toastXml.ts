// Windows toast içeriği. Konu, gönderen ve sunucu modunda bütün alanlar saldırgan kontrolündedir: her değer kaçırılır, `arguments` yalnız
// sayısal kimlik taşır (sınır `parseServerNotify`, burada ikinci kez zorlanır).
// Metin içerikten argümana hiç geçmez, geri dönen argüman da sıkı biçimle ayrıştırılır. electron içe aktarılmaz.
import type { PushActionId } from '../shared/pushTypes'

/** XML 1.0'da yazılabilen kod noktası. Yazılamayan tek denetim karakteri ya da eşsiz vekil bütün toast'ı düşürürdü */
const xmlChar = (c: number): boolean => c === 9 || c === 10 || c === 13 || (c >= 0x20 && c <= 0xD7FF) || (c >= 0xE000 && c <= 0xFFFD) || c >= 0x10000
const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }

export function escapeXml(s: string): string {
  return [...s].filter((c) => xmlChar(c.codePointAt(0)!)).join('').replace(/[&<>"']/g, (c) => ENTITIES[c])
}

const ACTIONS: readonly string[] = ['read', 'archive', 'reply']
const num = (n: unknown): number | '' => (Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : '')
const args = (action: string, messageId: number | null, accountId: number | null): string => escapeXml(`gecko:${action}:${num(messageId)}:${num(accountId)}`)

export function buildToastXml(i: { title: string; body: string; messageId: number | null; accountId: number | null; actions: PushActionId[]; labels: Record<PushActionId, string>; urgent: boolean; iconPath: string | null }): string {
  const buttons = num(i.messageId) === '' ? [] : [...new Set(i.actions)].filter((a) => ACTIONS.includes(a)).map((a) => {
    // okundu ve arşiv pencere açmaz; yanıtla yazma penceresini açar
    const activation = a === 'reply' ? 'foreground' : 'background'
    return `<action content="${escapeXml(i.labels[a])}" arguments="${args(a, i.messageId, i.accountId)}" activationType="${activation}"/>`
  })
  // düğmesiz hatırlatıcıyı Windows olağan toast sayar: kapat düğmesi ekranda kalmasını sağlar
  if (i.urgent && !buttons.length) buttons.push('<action content="" arguments="dismiss" activationType="system"/>')
  const icon = i.iconPath ? `<image placement="appLogoOverride" src="${escapeXml(i.iconPath)}"/>` : ''
  return `<toast launch="${args('open', i.messageId, i.accountId)}" activationType="foreground"${i.urgent ? ' scenario="reminder"' : ''}>` +
    `<visual><binding template="ToastGeneric"><text>${escapeXml(i.title)}</text><text>${escapeXml(i.body)}</text>${icon}</binding></visual>` +
    (buttons.length ? `<actions>${buttons.join('')}</actions>` : '') + '</toast>'
}

const ARGS = /^gecko:(open|read|archive|reply):(\d*):(\d*)$/

function id(s: string): number | null | undefined {
  if (!s) return null
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : undefined
}

export function parseToastArgs(raw: string): { action: 'open' | PushActionId; messageId: number | null; accountId: number | null } | null {
  const m = ARGS.exec(raw)
  if (!m || raw.endsWith('\n')) return null
  const [messageId, accountId] = [id(m[2]), id(m[3])]
  if (messageId === undefined || accountId === undefined) return null
  return { action: m[1] as 'open' | PushActionId, messageId, accountId }
}
