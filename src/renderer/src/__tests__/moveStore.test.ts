import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { State } from '../store/types'

const call = vi.hoisted(() => vi.fn())
vi.mock('../rpcClient', () => ({ rpc: { call } }))

import { mailSlice } from '../store/mail'

function harness(over: Partial<State> = {}) {
  let state = {
    messages: [{ id: 1 }, { id: 2 }, { id: 3 }],
    checkedIds: [2, 3],
    selectedMessageId: 3,
    body: { state: 'ready' },
    folderKind: 'inbox',
    folders: [],
    toast: vi.fn(),
    refreshList: vi.fn(async () => {}),
    ...over
  } as unknown as State
  const set = (p: Partial<State>): void => void (state = { ...state, ...p })
  const slice = mailSlice(set as never, (() => state) as never)
  state = { ...state, moveMessages: slice.moveMessages } as State
  return { slice, get: () => state }
}

describe('moveMessages', () => {
  beforeEach(() => call.mockReset())

  it('reddedilen taşımada satırlar geri gelir', async () => {
    call.mockRejectedValueOnce(new Error('yetki yok'))
    const h = harness()
    h.slice.moveMessages([2], 9)
    expect(h.get().messages.map((m) => m.id)).toEqual([1, 3])
    await vi.waitFor(() => expect(h.get().refreshList).toHaveBeenCalledWith(false))
    expect(h.get().toast).toHaveBeenCalledWith('yetki yok')
  })

  it('taşınmayan seçim ve açık ileti korunur', () => {
    call.mockResolvedValue({ moved: 1, skipped: 0 })
    const h = harness()
    h.slice.moveMessages([1], 9)
    expect(h.get().checkedIds).toEqual([2, 3])
    expect(h.get().selectedMessageId).toBe(3)
  })

  it('açık ileti taşınırsa kapanır', () => {
    call.mockResolvedValue({ moved: 1, skipped: 0 })
    const h = harness()
    h.slice.moveMessages([3], 9)
    expect(h.get().selectedMessageId).toBeNull()
  })
})

describe('moveRows', () => {
  beforeEach(() => call.mockReset())

  it('konu satırı klasördeki bütün iletilerine açılır', async () => {
    call.mockImplementation(async (m: string) =>
      m === 'getThreadMembers'
        ? [{ id: 1, accountId: 10, folderId: 100 }, { id: 7, accountId: 10, folderId: 100 }, { id: 8, accountId: 10, folderId: 500 }]
        : { moved: 2, skipped: 0 }
    )
    const h = harness()
    await h.slice.moveRows([{ id: 1, accountId: 10, folderId: 100, threadRoot: '<k>', threadCount: 3 }, { id: 2, accountId: 10, folderId: 100 }], 9)
    expect(call).toHaveBeenCalledWith('getThreadMembers', { threadRoot: '<k>', folderKind: 'inbox' })
    expect(call).toHaveBeenCalledWith('moveMessages', { messageIds: [1, 7, 2], targetFolderId: 9 })
  })

  it('özel klasörde konu satırın klasör türüyle aranır', async () => {
    call.mockResolvedValue([])
    const h = harness({ folders: [{ id: 100, path: 'X', kind: 'other', display: 'X' }] })
    await h.slice.moveRows([{ id: 1, accountId: 10, folderId: 100, threadRoot: '<k>', threadCount: 2 }], 9)
    expect(call).toHaveBeenCalledWith('getThreadMembers', { threadRoot: '<k>', folderKind: 'other' })
  })

  it('konu alınamazsa hiçbir şey taşınmaz, hata gösterilir', async () => {
    call.mockRejectedValueOnce(new Error('kopuk'))
    const h = harness()
    await h.slice.moveRows([{ id: 1, accountId: 10, folderId: 100, threadRoot: '<k>', threadCount: 2 }], 9)
    expect(h.get().messages).toHaveLength(3)
    expect(h.get().toast).toHaveBeenCalledWith('kopuk')
  })
})
