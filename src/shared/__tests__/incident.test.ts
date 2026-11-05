import { describe, expect, it } from 'vitest'
import { buildIncidents, type IncidentSourceRow } from '../incident'

function row(id: number, accountId: number, subject: string, date: number): IncidentSourceRow {
  return { id, accountId, subject, date }
}

describe('buildIncidents', () => {
  it('≥minAccounts farklı hesaptan aynı kalıp gelirse olay üretir', () => {
    const rows = [
      row(1, 10, 'SLA gecikmesi: 3 açık arıza', 1000),
      row(2, 11, 'SLA gecikmesi: 1 açık arıza', 1100),
      row(3, 12, 'SLA gecikmesi: 7 açık arıza', 1200)
    ]
    const incidents = buildIncidents(rows, 3)
    expect(incidents).toHaveLength(1)
    expect(incidents[0].accountIds.sort()).toEqual([10, 11, 12])
    expect(incidents[0].messageCount).toBe(3)
  })

  it('minAccounts eşiğinin altındaki kalıpları atlar', () => {
    const rows = [row(1, 10, 'Fatura kesildi', 1000), row(2, 11, 'Fatura kesildi', 1100)]
    expect(buildIncidents(rows, 3)).toHaveLength(0)
  })

  it('aynı hesaptan tekrar eden mailler tek hesap olarak sayılır', () => {
    const rows = [
      row(1, 10, 'DMARC raporu', 1000),
      row(2, 10, 'DMARC raporu', 1100),
      row(3, 11, 'DMARC raporu', 1200),
      row(4, 12, 'DMARC raporu', 1300)
    ]
    const incidents = buildIncidents(rows, 3)
    expect(incidents).toHaveLength(1)
    expect(incidents[0].accountIds).toHaveLength(3)
    expect(incidents[0].messageCount).toBe(4)
  })

  it('en çok hesabı etkileyen olay önce gelir', () => {
    const rows = [
      row(1, 10, 'Küçük olay', 1000),
      row(2, 11, 'Küçük olay', 1000),
      row(3, 12, 'Küçük olay', 1000),
      row(4, 20, 'Büyük olay', 2000),
      row(5, 21, 'Büyük olay', 2000),
      row(6, 22, 'Büyük olay', 2000),
      row(7, 23, 'Büyük olay', 2000)
    ]
    const incidents = buildIncidents(rows, 3)
    expect(incidents[0].subjectSample).toBe('Büyük olay')
  })
})
