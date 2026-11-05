import type { RuleAction, RuleCondition } from '../shared/rpc'
import type { RuleRow } from './db/queries'
import { t } from '../shared/i18n'

// Saf değerlendirme — IO yok, DB yok, ağ yok. imapPoll.ts/scheduler.ts'e sıfır dokunuş:
// kurallar sadece watermark bazlı yeniden-sorguyla çalışır (bkz. rulesRunner.ts).
export interface RuleMatchInput {
  fromAddr: string | null
  subject: string | null
  hasAttachments: boolean
}

export interface MatchedAction {
  ruleId: number
  ruleName: string
  action: RuleAction
}

export function evaluateRules(msg: RuleMatchInput, rules: RuleRow[]): MatchedAction[] {
  const out: MatchedAction[] = []
  for (const rule of rules) {
    if (!rule.enabled) continue
    let cond: RuleCondition
    try {
      cond = JSON.parse(rule.conditions_json)
    } catch {
      continue
    }
    if (!matchesAll(msg, cond)) continue
    let actions: RuleAction[]
    try {
      actions = JSON.parse(rule.actions_json)
    } catch {
      continue
    }
    for (const action of actions) out.push({ ruleId: rule.id, ruleName: rule.name, action })
  }
  return out
}

// Rule içindeki tüm koşullar AND'lenir (belirtilmeyen alan = "fark etmez"); OR ayrı kurallarla sağlanır.
function matchesAll(m: RuleMatchInput, c: RuleCondition): boolean {
  if (c.senderContains && !(m.fromAddr ?? '').toLowerCase().includes(c.senderContains.toLowerCase())) return false
  if (c.domainEquals) {
    const domain = (m.fromAddr ?? '').split('@')[1]?.toLowerCase() ?? ''
    if (domain !== c.domainEquals.replace(/^@/, '').toLowerCase()) return false
  }
  if (c.subjectContains && !(m.subject ?? '').toLowerCase().includes(c.subjectContains.toLowerCase())) return false
  if (c.hasAttachment !== undefined && m.hasAttachments !== c.hasAttachment) return false
  return true
}

const RELOCATING = new Set(['move', 'archive', 'spam'])

// Taşıyıcı aksiyonlar (move/archive/spam) her zaman son çalışır — aksi halde aynı mesaj için
// hem "okundu işaretle" hem "taşı" varsa, taşıma önce giderse okundu-işaretleme kaybolur.
export function orderActions(matched: MatchedAction[]): MatchedAction[] {
  return [...matched].sort((a, b) => Number(RELOCATING.has(a.action.type)) - Number(RELOCATING.has(b.action.type)))
}

/** Etki satırda zaten varsa true: sunucu ya da başka cihaz yapmıştır, IMAP işlemi kuyruğa girmez */
export function effectAlreadyApplied(row: { seen: boolean; flagged: boolean }, action: RuleAction): boolean {
  if (action.type === 'markRead') return row.seen
  if (action.type === 'markUnread') return !row.seen
  if (action.type === 'flag') return row.flagged
  return false
}

/** İzlenen klasördeki satır için: taşıma sunucuda oldu, taşıma eylemleri atılır, kalanlar kalır */
export function clientPartAfterServerMove(matched: MatchedAction[]): MatchedAction[] {
  return matched.filter((m) => !RELOCATING.has(m.action.type))
}

/** Eşleşen kurallardan biri bu klasöre taşıyor mu. Eşleme opQueue move_named ile aynı */
export function matchesServerMove(matched: MatchedAction[], folder: { path: string; kind: string }): boolean {
  const path = folder.path.toLowerCase()
  return matched.some(({ action: a }) => {
    if (a.type === 'archive') return folder.kind === 'archive'
    if (a.type === 'spam') return folder.kind === 'junk'
    if (a.type !== 'move') return false
    const wanted = a.folderName.trim().toLowerCase()
    return path === wanted || path.replace(/^inbox\.?/, '') === wanted
  })
}

export function actionLabel(a: RuleAction): string {
  switch (a.type) {
    case 'move':
      return t('sync.rule.moved', { folder: a.folderName })
    case 'archive':
      return t('sync.rule.archived')
    case 'spam':
      return t('sync.rule.spam')
    case 'markRead':
      return t('sync.rule.markedRead')
    case 'markUnread':
      return t('sync.rule.markedUnread')
    case 'flag':
      return t('sync.rule.flagged')
    case 'forward':
      return t('sync.rule.forwarded', { to: a.to })
    case 'webhook':
      return t('sync.rule.webhook')
    case 'notify':
      return t(a.urgent ? 'sync.rule.notifyUrgent' : 'sync.rule.notify')
  }
}
