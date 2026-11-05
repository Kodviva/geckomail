import { describe, expect, it, vi } from 'vitest'
import { canDrop, canManageAccount, dragIds, DRAG_TYPE, isThreadRow, mailCount, moveTargets, rowMap, sameAccount, threadMemberIds, watchDragEnd } from '../moveDrag'
import type { SessionUser } from '../../../shared/rpc'

const rows = rowMap([
  { id: 1, accountId: 10, folderId: 100 },
  { id: 2, accountId: 10, folderId: 100 },
  { id: 3, accountId: 10, folderId: 101 },
  { id: 4, accountId: 20, folderId: 200 }
])

describe('dragIds', () => {
  it('seçili satır tüm seçimi sürükler', () => expect(dragIds(2, [1, 2, 3])).toEqual([1, 2, 3]))
  it('seçili olmayan satır yalnız kendini sürükler', () => expect(dragIds(4, [1, 2])).toEqual([4]))
  it('seçim yoksa yalnız satır', () => expect(dragIds(1, [])).toEqual([1]))
})

describe('canDrop', () => {
  it('aynı hesapta başka klasöre bırakılır', () => expect(canDrop([1, 2], rows, { id: 101, accountId: 10 })).toBe(true))
  it('başka hesaba bırakılmaz', () => expect(canDrop([1], rows, { id: 200, accountId: 20 })).toBe(false))
  it('aynı klasöre bırakılmaz', () => expect(canDrop([1, 2], rows, { id: 100, accountId: 10 })).toBe(false))
  it('karışık hesap seçimi hiçbir yere bırakılmaz', () => {
    expect(canDrop([1, 4], rows, { id: 101, accountId: 10 })).toBe(false)
    expect(canDrop([1, 4], rows, { id: 200, accountId: 20 })).toBe(false)
  })
  it('farklı klasörlerden seçimde en az biri taşınacaksa bırakılır', () => expect(canDrop([1, 3], rows, { id: 100, accountId: 10 })).toBe(true))
  it('listede olmayan ileti ya da boş seçim bırakılmaz', () => {
    expect(canDrop([99], rows, { id: 101, accountId: 10 })).toBe(false)
    expect(canDrop([], rows, { id: 101, accountId: 10 })).toBe(false)
  })
})

describe('sameAccount', () => {
  it('tek hesap', () => expect(sameAccount([1, 3], rows)).toBe(true))
  it('karışık hesap', () => expect(sameAccount([1, 4], rows)).toBe(false))
})

describe('moveTargets', () => {
  const folders = [
    { id: 100, path: 'INBOX', kind: 'inbox', display: 'INBOX' },
    { id: 101, path: 'Projeler', kind: 'other', display: 'Projeler' }
  ] as const
  it('kaynak klasör listelenmez', () => expect(moveTargets([...folders], [1], rows, 10).map((f) => f.id)).toEqual([101]))
})

describe('watchDragEnd', () => {
  const setup = () => {
    const target = new EventTarget() as unknown as Window
    let now = 1000
    const onEnd = vi.fn()
    const stop = watchDragEnd(onEnd, target, () => now)
    return { target, onEnd, stop, tick: (ms: number) => (now += ms) }
  }
  it('dragend ve bırakma sürüklemeyi bitirir', () => {
    const { target, onEnd } = setup()
    target.dispatchEvent(new Event('dragend'))
    target.dispatchEvent(new Event('drop'))
    expect(onEnd).toHaveBeenCalledTimes(2)
  })
  it('kaynak satır DOM\'dan düşüp dragend gelmezse fare hareketi bitirir', () => {
    const { target, onEnd, tick } = setup()
    tick(100)
    target.dispatchEvent(new Event('dragover'))
    tick(100)
    target.dispatchEvent(new Event('mousemove')) // sürükleme başlarken kaçak olay: bitirmez
    expect(onEnd).not.toHaveBeenCalled()
    tick(1000)
    target.dispatchEvent(new Event('mousemove'))
    expect(onEnd).toHaveBeenCalledTimes(1)
  })
  it('durdurulunca dinlemez', () => {
    const { target, onEnd, stop } = setup()
    stop()
    target.dispatchEvent(new Event('dragend'))
    expect(onEnd).not.toHaveBeenCalled()
  })
})

it('DRAG_TYPE sabit', () => expect(DRAG_TYPE).toBe('application/x-gecko-messages'))

describe('konu satırı', () => {
  const row = { id: 1, accountId: 10, folderId: 100, threadRoot: '<k>', threadCount: 3 }
  it('yalnız satırın klasöründeki iletiler taşınır', () => {
    const thread = [
      { id: 1, accountId: 10, folderId: 100 },
      { id: 2, accountId: 10, folderId: 100 },
      { id: 3, accountId: 10, folderId: 555 }, // Gönderilenler
      { id: 4, accountId: 20, folderId: 200 } // aynı ileti başka hesapta
    ]
    expect(threadMemberIds(row, thread)).toEqual([1, 2])
  })
  it('satır her durumda taşınır', () => expect(threadMemberIds(row, [])).toEqual([1]))
  it('tek iletili satır konu değildir', () => {
    expect(isThreadRow(row)).toBe(true)
    expect(isThreadRow({ ...row, threadCount: 1 })).toBe(false)
    expect(isThreadRow({ ...row, threadRoot: null })).toBe(false)
  })
  it('sayaç konu iletilerini sayar', () => expect(mailCount([row, { id: 2, accountId: 10, folderId: 100 }])).toBe(4))
})

describe('canManageAccount', () => {
  const member: SessionUser = { id: 2, username: 'u', role: 'member', permittedGroupIds: [1, 2], manageableGroupIds: [1] }
  it('yönetici her hesabı', () => expect(canManageAccount({ ...member, role: 'admin', manageableGroupIds: [] }, { groupId: null })).toBe(true))
  it('üye yalnız yönetebildiği grubu', () => {
    expect(canManageAccount(member, { groupId: 1 })).toBe(true)
    expect(canManageAccount(member, { groupId: 2 })).toBe(false)
    expect(canManageAccount(member, { groupId: null })).toBe(false)
    expect(canManageAccount(member, undefined)).toBe(false)
    expect(canManageAccount(null, { groupId: 1 })).toBe(false)
  })
})
