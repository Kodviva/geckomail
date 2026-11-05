import { subjectTemplateKey } from './noise'

export interface IncidentSourceRow {
  id: number
  accountId: number
  subject: string | null
  date: number
}

export interface Incident {
  key: string
  subjectSample: string
  accountIds: number[]
  messageCount: number
  firstDate: number
  lastDate: number
}

// Aynı konu kalıbı ≥minAccounts farklı hesaptan gelirse tek "olay" — 67 kutuya dağılmış
// ortak bir arızayı (paylaşılan upstream kesintisi) tek kartta gösterir. Saf/test edilebilir;
// sorgu penceresi (son N dk) çağıran tarafta (rpcServer) uygulanır.
export function buildIncidents(rows: IncidentSourceRow[], minAccounts = 3): Incident[] {
  const groups = new Map<string, IncidentSourceRow[]>()
  for (const r of rows) {
    const key = subjectTemplateKey(r.subject)
    if (!key) continue
    const arr = groups.get(key)
    if (arr) arr.push(r)
    else groups.set(key, [r])
  }
  const out: Incident[] = []
  for (const [key, msgs] of groups) {
    const accountIds = [...new Set(msgs.map((m) => m.accountId))]
    if (accountIds.length < minAccounts) continue
    out.push({
      key,
      subjectSample: msgs[0].subject ?? '',
      accountIds,
      messageCount: msgs.length,
      firstDate: Math.min(...msgs.map((m) => m.date)),
      lastDate: Math.max(...msgs.map((m) => m.date))
    })
  }
  return out.sort((a, b) => b.accountIds.length - a.accountIds.length || b.lastDate - a.lastDate)
}
