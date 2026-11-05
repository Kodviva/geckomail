import { describe, expect, it } from 'vitest'
import { mergeFirstPage } from '../listMerge'

const r = (id: number, date: number) => ({ id, date })

describe('mergeFirstPage', () => {
  it('yeni gelenleri başa koyar, kuyruğu korur', () => {
    const loaded = [r(5, 50), r(4, 40), r(3, 30), r(2, 20), r(1, 10)]
    const fresh = [r(6, 60), r(5, 50), r(4, 40)]
    expect(mergeFirstPage(fresh, loaded).map((x) => x.id)).toEqual([6, 5, 4, 3, 2, 1])
  })
  it('ilk sayfa penceresinden kaybolanı düşürür, kuyruktakine dokunmaz', () => {
    const loaded = [r(5, 50), r(4, 40), r(3, 30), r(2, 20), r(1, 10)]
    const fresh = [r(5, 50), r(3, 30)] // 4 silindi/taşındı
    expect(mergeFirstPage(fresh, loaded).map((x) => x.id)).toEqual([5, 3, 2, 1])
  })
  it('güncellenen satır taze haliyle gelir, çift olmaz', () => {
    const loaded = [r(3, 30), r(2, 20), r(1, 10)].map((x) => ({ ...x, seen: false }))
    const fresh = [{ ...r(3, 30), seen: true }, { ...r(2, 20), seen: false }]
    const out = mergeFirstPage(fresh, loaded)
    expect(out.map((x) => x.id)).toEqual([3, 2, 1])
    expect(out[0].seen).toBe(true)
  })
  it('aynı tarihte id sırasını korur', () => {
    const loaded = [r(3, 10), r(2, 10), r(1, 10)]
    expect(mergeFirstPage([r(3, 10)], loaded).map((x) => x.id)).toEqual([3, 2, 1])
  })
  it('boş ilk sayfa listeyi boşaltır', () => {
    expect(mergeFirstPage([], [r(1, 1)])).toEqual([])
  })
})
