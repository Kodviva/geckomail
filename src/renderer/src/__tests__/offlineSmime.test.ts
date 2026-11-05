import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import type { AccountInfo, BodyResult, MessageRow } from '../../../shared/rpc'

const h = vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  return { calls: [] as { method: string; params: unknown }[] }
})

const row = (id: number, smimeKind: MessageRow['smimeKind']): MessageRow =>
  ({ id, accountId: 1, date: Date.now() - id * 1000, subject: `k${id}`, locked: false, smimeKind }) as MessageRow
const ready: BodyResult = { state: 'ready', textPlain: 'x', html: null, attachments: [] }
// imzalı kabuğun içi şifreli: satır "signed" görünür, gövde bu kullanıcının önbelleğinden düz gelir
const nested: BodyResult = { ...ready, textPlain: 'GIZLI-IC-GOVDE', smime: { sig: 'verified', enc: 'decrypted', notes: [], signer: null, canSaveCert: false } }

vi.mock('../rpcClient', () => ({
  rpc: {
    isOpen: true,
    on: () => () => {},
    call: async (method: string, params: unknown) => {
      h.calls.push({ method, params })
      if (method === 'getAccounts') return [{ id: 1, email: 'a@b.c', secure: false, enabled: true, unread: 0 } as AccountInfo]
      if (method === 'listMessages') return (params as { folderKind: string }).folderKind === 'inbox' ? [row(1, null), row(2, 'encrypted'), row(3, 'signed')] : []
      if (method === 'getBody') return (params as { messageId: number }).messageId === 3 ? nested : ready
      return null
    }
  }
}))

describe('çevrimdışı eşitleme', () => {
  it('offline sync skips encrypted', async () => {
    const { syncOffline } = await import('../offline/sync')
    await syncOffline({ days: 30, accountIds: [1], pauseMs: 0 })
    const bodies = h.calls.filter((c) => c.method === 'getBody').map((c) => (c.params as { messageId: number }).messageId)
    expect(bodies.sort()).toEqual([1, 3])
    const { bodyStats } = await import('../offline/store')
    const { ids } = await bodyStats()
    expect([...ids].sort()).toEqual([1])
  })
})
