import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '../../../shared/i18n'
import type { AccountInfo, BodyResult, MessageRow, SessionUser } from '../../../shared/rpc'

const h = vi.hoisted(() => {
  // mağaza başlangıcı içe aktarmada okur; sırası gelince (beforeEach) test başına yenisi konur
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  return {
  accounts: [] as unknown[],
  rows: [] as unknown[],
  bodies: new Map<number, unknown>(),
  calls: [] as { method: string; params: unknown }[],
  open: true,
  onBeforeCall: null as null | ((method: string) => void),
  webLogout: async () => true,
  listeners: new Map<string, Set<(d: unknown) => void>>(),
  failFast: false,
  transportOpts: null as null | { isSessionGone: () => Promise<boolean> },
  webMe: async (): Promise<unknown> => ({ user: null, setupRequired: false }),
  readList: null as null | (() => Promise<unknown[]>),
  pim: { collections: { addressbook: [], calendar: [] } as unknown, contacts: [] as unknown[], events: [] as unknown[] }
  }
})

vi.mock('../offline/sync', async (orig) => {
  const real = await orig<typeof import('../offline/sync')>()
  return { ...real, readOfflineList: (q: Parameters<typeof real.readOfflineList>[0]) => (h.readList ? h.readList() : real.readOfflineList(q)) }
})

vi.mock('../rpcClient', () => ({
  rpc: {
    get isOpen() {
      return h.open
    },
    setFailFast: (on: boolean) => {
      h.failFast = on
    },
    on: (ev: string, cb: (d: unknown) => void) => {
      if (!h.listeners.has(ev)) h.listeners.set(ev, new Set())
      h.listeners.get(ev)!.add(cb)
      return () => h.listeners.get(ev)!.delete(cb)
    },
    stop: () => {},
    start: () => {},
    call: async (method: string, params: Record<string, unknown>) => {
      h.calls.push({ method, params })
      h.onBeforeCall?.(method)
      if (!h.open) throw new Error('kopuk')
      if (method === 'getAccounts') return h.accounts
      if (method === 'listMessages') {
        const p = params as { accountIds: number[]; folderKind: string; cursor: { date: number; id: number } | null; limit: number }
        const rows = (h.rows as (MessageRow & { kind?: string })[])
          .filter((r) => (r.kind ?? 'inbox') === p.folderKind && p.accountIds.includes(r.accountId))
          .sort((a, b) => b.date - a.date || b.id - a.id)
        const from = p.cursor ? rows.findIndex((r) => r.id === p.cursor!.id) + 1 : 0
        return rows.slice(from, from + p.limit)
      }
      if (method === 'listPimCollections') return (h.pim.collections as Record<string, unknown[]>)[(params as { type: string }).type]
      if (method === 'listContacts') {
        const p = params as { collectionIds: number[]; cursor: { id: number } | null; limit: number }
        const rows = (h.pim.contacts as { id: number; collectionId: number }[]).filter((c) => p.collectionIds.includes(c.collectionId))
        const from = p.cursor ? rows.findIndex((r) => r.id === p.cursor!.id) + 1 : 0
        return rows.slice(from, from + p.limit)
      }
      if (method === 'listEvents') {
        const p = params as { from: number; to: number; collectionIds: number[] }
        return (h.pim.events as { start: number; end: number; collectionId: number }[]).filter((e) => e.start < p.to && e.end > p.from && p.collectionIds.includes(e.collectionId))
      }
      if (method === 'getBody') return h.bodies.get((params as { messageId: number }).messageId) ?? { state: 'error', error: 'yok' }
      throw new Error(`beklenmeyen çağrı: ${method}`)
    }
  }
}))
vi.mock('../platform', () => ({ platform: { kind: 'web', setLocale: () => {} } }))
vi.mock('../webAuth', () => ({ webLogout: () => h.webLogout(), webMe: () => h.webMe() }))
vi.mock('../webNotify', () => ({ closeServerNotifications: () => {}, showServerNotification: () => {} }))
vi.mock('../transport', () => ({
  webSocketTransport: (_url: string, opts: unknown) => {
    h.transportOpts = opts as { isSessionGone: () => Promise<boolean> }
    return {}
  }
}))

import { getCacheKey, openJson, sealJson } from '../offline/cacheCrypto'
import { MAX_OFFLINE_CONTACTS, readOfflineCollections, readOfflineContacts, readOfflineEvents, syncOfflinePim } from '../offline/pim'
import { bodyStats, currentEpoch, DB_NAME, metaKeys, metaPut, deleteMessages, SHELL_PREFIX, wipeOffline } from '../offline/store'
import { MAX_MESSAGES, readOfflineBody, readOfflineList, readOfflineSnapshot, syncOffline } from '../offline/sync'
import { loadOfflineSettings, OFFLINE_KEY, saveOfflineSettings } from '../offline/settings'
import { shellKey, shellRoute, staleShells } from '../offline/swRoutes'
import { guardOfflineWrites } from '../store/offlineGuard'
import { boundedWait, hasOfflineCopy, offlineAccountsChanged, offlineOnHello, offlinePimSourcesChanged, runOfflineSync, setOfflineMode } from '../store/offline'
import { runtime } from '../store/runtime'
import { mailSlice } from '../store/mail'
import { sessionSlice } from '../store/session'
import type { State } from '../store/types'

const DAY = 86_400_000
const USER: SessionUser = { id: 7, username: 'ali', role: 'member', permittedGroupIds: [], manageableGroupIds: [] }

const account = (id: number, secure = false): AccountInfo =>
  ({ id, email: `h${id}@ornek.test`, secure, enabled: true, unread: 0 }) as AccountInfo

const row = (id: number, o: Partial<MessageRow> & { kind?: string } = {}): MessageRow =>
  ({
    id, accountId: 1, folderId: 1, uid: id, messageId: null, subject: `konu-${id}`, fromName: 'Gönderen', fromAddr: 'g@ornek.test',
    toJson: null, date: Date.now() - id * 1000, size: 10, seen: false, flagged: false, answered: false, hasAttachments: false,
    preview: `önizleme-${id}`, threadRoot: null, canUnsubscribe: false, locked: false, ...o
  }) as MessageRow

const ready = (text: string, html: string | null = null): BodyResult => ({ state: 'ready', textPlain: text, html, attachments: [] })

/** Ham IndexedDB kayıtları: şifrelenmemiş metin arama için */
function rawDump(): Promise<string> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME)
    r.onerror = () => rej(r.error)
    r.onsuccess = async () => {
      const db = r.result
      const out: unknown[] = []
      for (const name of Array.from(db.objectStoreNames)) {
        await new Promise<void>((done) => {
          const q = db.transaction(name).objectStore(name).getAll()
          q.onsuccess = () => {
            out.push(q.result)
            done()
          }
        })
      }
      db.close()
      res(
        JSON.stringify(out, (_k, v: unknown) => {
          if (v instanceof ArrayBuffer) return new TextDecoder('latin1').decode(v)
          if (v instanceof CryptoKey) return 'key'
          return v
        })
      )
    }
  })
}

const dbExists = async (): Promise<boolean> => (await indexedDB.databases()).some((d) => d.name === DB_NAME)

function fakeCaches(names: string[]) {
  const set = new Set(names)
  return {
    keys: async () => [...set],
    delete: async (n: string) => set.delete(n),
    names: set
  }
}

beforeEach(async () => {
  await wipeOffline()
  h.accounts = [account(1)]
  h.rows = []
  h.bodies = new Map()
  h.calls = []
  h.open = true
  h.onBeforeCall = null
  h.webLogout = async () => true
  h.webMe = async () => ({ user: null, setupRequired: false })
  h.listeners.clear()
  h.failFast = false
  runtime.offlineLastSync = 0
  runtime.offlineVisible = null
  runtime.helloUserId = null
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k)
  })
  const tab = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => tab.get(k) ?? null,
    setItem: (k: string, v: string) => tab.set(k, v),
    removeItem: (k: string) => tab.delete(k)
  })
  vi.stubGlobal('caches', fakeCaches([]))
})

describe('şifreleme', () => {
  it('key not extractable', async () => {
    const key = await getCacheKey()
    expect(key.extractable).toBe(false)
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
  })

  it('anahtar kalıcı: ikinci çağrı aynı anahtarı verir, eşzamanlı üretim tek anahtarda buluşur', async () => {
    const [a, b] = await Promise.all([getCacheKey(), getCacheKey()])
    const sealed = await sealJson(a, { x: 1 })
    expect(await openJson(b, sealed)).toEqual({ x: 1 })
    expect(await openJson(await getCacheKey(), sealed)).toEqual({ x: 1 })
  })

  it('seal/open roundtrip', async () => {
    const key = await getCacheKey()
    const v = { a: 'Şifreli İçerik', n: [1, 2], o: null }
    const b = await sealJson(key, v)
    expect(b).toBeInstanceOf(ArrayBuffer)
    expect(await openJson(key, b)).toEqual(v)
  })

  it('her kayıtta yeni nonce; değiştirilmiş kayıt açılmaz', async () => {
    const key = await getCacheKey()
    const a = new Uint8Array(await sealJson(key, 'aynı'))
    const b = new Uint8Array(await sealJson(key, 'aynı'))
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
    expect(Buffer.from(a.slice(0, 12)).equals(Buffer.from(b.slice(0, 12)))).toBe(false)
    a[a.length - 1] ^= 1
    await expect(openJson(key, a.buffer)).rejects.toThrow()
  })
})

describe('eşitleme', () => {
  it('store has no plaintext subject', async () => {
    h.rows = [row(1, { subject: 'Çok gizli konu', preview: 'gizli önizleme', fromAddr: 'gizli@gonderen.test' })]
    h.bodies.set(1, ready('gizli gövde'))
    await syncOffline({ days: 30, accountIds: [1] })
    const dump = await rawDump()
    expect(dump.length).toBeGreaterThan(100)
    for (const s of ['Çok gizli konu', 'gizli önizleme', 'gizli@gonderen.test', 'gizli gövde', 'h1@ornek.test', 'konu', 'subject', 'accountId'])
      expect(dump).not.toContain(s)
    expect((await readOfflineList({ folderKind: 'inbox' })).map((r) => r.subject)).toEqual(['Çok gizli konu'])
    expect(await readOfflineBody(1)).toEqual(ready('gizli gövde'))
  })

  it('vault accounts never cached', async () => {
    h.accounts = [account(1), account(2, true)]
    h.rows = [row(1), row(2, { accountId: 2, subject: 'kasa konusu' })]
    h.bodies.set(1, ready('normal'))
    h.bodies.set(2, ready('kasa gövdesi'))
    const r = await syncOffline({ days: 30, accountIds: [1, 2] })
    expect(r.messages).toBe(1)
    expect(h.calls.filter((c) => c.method === 'listMessages').every((c) => !(c.params as { accountIds: number[] }).accountIds.includes(2))).toBe(true)
    expect(h.calls.some((c) => c.method === 'getBody' && (c.params as { messageId: number }).messageId === 2)).toBe(false)
    expect((await readOfflineList({ folderKind: 'inbox' })).map((r) => r.id)).toEqual([1])
  })

  it('sunucu yine de kasa ya da kilitli satır dönerse saklanmaz', async () => {
    h.accounts = [account(1), account(2, true)]
    h.rows = [row(1), row(2, { locked: true })]
    await syncOffline({ days: 30, accountIds: [1] })
    expect((await readOfflineList({ folderKind: 'inbox' })).map((r) => r.id)).toEqual([1])
  })

  it('hesap kasaya alınınca ya da görünürlüğü kalkınca önceki kopyası silinir', async () => {
    h.accounts = [account(1), account(2)]
    h.rows = [row(1), row(2, { accountId: 2 })]
    h.bodies.set(2, ready('sonra kasaya alınacak'))
    await syncOffline({ days: 30, accountIds: [1, 2] })
    expect(await readOfflineBody(2)).not.toBeNull()
    h.accounts = [account(1), account(2, true)]
    await syncOffline({ days: 30, accountIds: [1, 2] })
    expect((await readOfflineList({ folderKind: 'inbox' })).map((r) => r.id)).toEqual([1])
    expect(await readOfflineBody(2)).toBeNull()
    expect((await readOfflineSnapshot())?.accounts.map((a) => a.id)).toEqual([1])
  })

  it('gün sınırı dışındaki iletiler alınmaz, sunucudan silinenler yerelden de gider', async () => {
    const now = Date.now()
    h.rows = [row(1, { date: now - DAY }), row(2, { date: now - 2 * DAY }), row(3, { date: now - 10 * DAY })]
    await syncOffline({ days: 7, accountIds: [1] })
    expect((await readOfflineList({ folderKind: 'inbox' })).map((r) => r.id)).toEqual([1, 2])
    h.rows = [row(2, { date: now - 2 * DAY })]
    await syncOffline({ days: 7, accountIds: [1] })
    expect((await readOfflineList({ folderKind: 'inbox' })).map((r) => r.id)).toEqual([2])
  })

  it(`en fazla ${MAX_MESSAGES} ileti`, async () => {
    h.rows = Array.from({ length: MAX_MESSAGES + 150 }, (_, i) => row(i + 1, { date: Date.now() - i * 1000 }))
    const r = await syncOffline({ days: 30, accountIds: [1], pauseMs: 0 })
    expect(r.messages).toBe(MAX_MESSAGES)
    const stored = await readOfflineList({ folderKind: 'inbox' })
    expect(stored).toHaveLength(MAX_MESSAGES)
    expect(stored[0].id).toBe(1) // en yeniler kalır
  })

  it('gövde kotası: yeniden eskiye dolar, aşınca durur', async () => {
    h.rows = [row(1), row(2), row(3)]
    for (const id of [1, 2, 3]) h.bodies.set(id, ready('x'.repeat(1000)))
    await syncOffline({ days: 30, accountIds: [1], maxBodyBytes: 1500 })
    expect(await readOfflineBody(1)).not.toBeNull()
    expect(await readOfflineBody(2)).toBeNull()
    expect((await readOfflineList({ folderKind: 'inbox' })).length).toBe(3)
  })

  it('gövde sunucuda hazır değilse hazır olayı beklenir, sırayla yürür', async () => {
    h.rows = [row(1)]
    let n = 0
    h.bodies.set(1, { state: 'fetching' })
    h.onBeforeCall = (m) => {
      if (m === 'getBody' && ++n === 1) setTimeout(() => {
        h.bodies.set(1, ready('geç geldi'))
        h.listeners.get('body:ready')?.forEach((cb) => cb({ messageId: 1 }))
      }, 5)
    }
    await syncOffline({ days: 30, accountIds: [1] })
    expect(n).toBe(2)
    expect(await readOfflineBody(1)).toEqual(ready('geç geldi'))
  })

  it('sırayla yürür: gövde istekleri tek tek, bağlantı kopunca durur', async () => {
    h.rows = Array.from({ length: 30 }, (_, i) => row(i + 1))
    for (let i = 1; i <= 30; i++) h.bodies.set(i, ready(`gövde ${i}`))
    let bodies = 0
    h.onBeforeCall = (m) => {
      if (m === 'getBody' && ++bodies === 5) h.open = false
    }
    await syncOffline({ days: 30, accountIds: [1], pauseMs: 0 })
    expect(bodies).toBe(5)
    h.open = true
    expect((await readOfflineList({ folderKind: 'inbox' })).length).toBe(30) // satırlar yazılmıştı
  })

  it('eşitleme sürerken silme: veritabanı geri gelmez', async () => {
    h.rows = Array.from({ length: 5 }, (_, i) => row(i + 1))
    for (let i = 1; i <= 5; i++) h.bodies.set(i, ready(`gövde ${i}`))
    let wiped: Promise<void> | null = null
    h.onBeforeCall = (m) => {
      if (m === 'getBody' && !wiped) wiped = wipeOffline()
    }
    await syncOffline({ days: 30, accountIds: [1], pauseMs: 0 })
    await wiped
    expect(await dbExists()).toBe(false)
  })

  it('çevrimdışı liste süzgeçleri: hesap, klasör türü, okunmamış, arama', async () => {
    h.accounts = [account(1), account(2)]
    h.rows = [
      row(1, { subject: 'Fatura', seen: true }),
      row(2, { accountId: 2, subject: 'Toplantı' }),
      row(3, { subject: 'Giden', kind: 'sent' } as Partial<MessageRow>)
    ]
    await syncOffline({ days: 30, accountIds: [1, 2] })
    expect((await readOfflineList({ folderKind: 'sent' })).map((r) => r.id)).toEqual([3])
    expect((await readOfflineList({ folderKind: 'inbox', accountIds: [2] })).map((r) => r.id)).toEqual([2])
    expect((await readOfflineList({ folderKind: 'inbox', unreadOnly: true })).map((r) => r.id)).toEqual([2])
    expect((await readOfflineList({ folderKind: 'inbox', query: 'FATU' })).map((r) => r.id)).toEqual([1])
  })

  it('anlık görüntü kullanıcı ve görünür hesapları tutar', async () => {
    h.rows = [row(1)]
    await syncOffline({ days: 30, accountIds: [1], user: USER })
    const snap = await readOfflineSnapshot()
    expect(snap?.user).toEqual(USER)
    expect(snap?.accounts.map((a) => a.id)).toEqual([1])
    expect(snap?.count).toBe(1)
  })
})

describe('silme', () => {
  const webSession = (over: Partial<State> = {}) => {
    const replace = vi.fn()
    vi.stubGlobal('window', { location: { replace } })
    let state = { currentUser: USER, serverRestarting: false, toast: vi.fn(), ...over } as unknown as State
    const set = (p: Partial<State>): void => {
      state = { ...state, ...p }
    }
    const get = (): State => state
    return { slice: sessionSlice(set as never, get as never), get, set, replace }
  }

  const seed = async (): Promise<void> => {
    h.rows = [row(1)]
    h.bodies.set(1, ready('gövde'))
    await syncOffline({ days: 30, accountIds: [1] })
    expect(await dbExists()).toBe(true)
  }

  it('logout wipes cache', async () => {
    const c = fakeCaches([`${SHELL_PREFIX}abc`, `${SHELL_PREFIX}eski`, 'baska-uygulama'])
    vi.stubGlobal('caches', c)
    await seed()
    const { slice, get } = webSession()
    await slice.logout()
    await vi.waitFor(async () => expect(await dbExists()).toBe(false))
    expect([...c.names]).toEqual(['baska-uygulama'])
    expect(get().currentUser).toBeNull()
  })

  it('web çıkışı: taslak ve ekrandaki kullanıcı verisi gider, silmeler bitince sayfa yenilenir', async () => {
    await seed()
    localStorage.setItem('gecko-draft', JSON.stringify({ to: 'a@b.c', subject: 's', text: 't' }))
    const { slice, get, replace } = webSession({
      composer: { to: 'a@b.c' } as never, contacts: [{ address: 'a@b.c' }] as never, savedSearches: [{ name: 'a', query: 'b' }], usersOpen: true
    })
    const toast = get().toast
    await slice.logout()
    expect(replace).toHaveBeenCalledExactlyOnceWith('/')
    expect(await dbExists()).toBe(false)
    expect(localStorage.getItem('gecko-draft')).toBeNull()
    expect(get()).toMatchObject({ composer: null, contacts: [], savedSearches: [], usersOpen: false, currentUser: null })
    expect(sessionStorage.getItem('gecko-signout-reason')).toBeNull() // kendi çıkışı: bildirim yok
    expect(toast).not.toHaveBeenCalled()
  })

  it('çevrimdışı çıkış: sunucuya ulaşılamasa da yerel kopya silinir, sunucu çıkışı sonraya kalır', async () => {
    await seed()
    h.webLogout = async () => false
    localStorage.setItem('gecko-draft', JSON.stringify({ to: 'a@b.c', subject: 's', text: 't' }))
    const { slice, get, replace } = webSession({ offlineMode: true })
    const toast = get().toast
    await slice.logout()
    await vi.waitFor(async () => expect(await dbExists()).toBe(false))
    expect(get().currentUser).toBeNull()
    expect(localStorage.getItem('gecko-offline-logout')).toBe('1')
    expect(localStorage.getItem('gecko-draft')).toBeNull()
    // kabuk silindi, sunucu yok: yenileme hata sayfası açardı; bildirim burada gösterilir
    expect(replace).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(t('common.offlineSignedOut'), 'info')
  })

  it('çevrimdışı çıkış: sürmekte olan kopya okuması sıfırlanan listeye yazmaz', async () => {
    h.webLogout = async () => false
    const { slice, get, set } = webSession({
      offlineMode: true, folderKind: 'inbox', messages: [], selectedAccountIds: null, selectedFolderId: null, unreadOnly: false, searchQuery: '', smartView: null
    })
    let finish!: (rows: unknown[]) => void
    h.readList = () => new Promise((r) => (finish = r))
    try {
      const reading = mailSlice(set as never, get as never).refreshList(true)
      await slice.logout()
      expect(get().currentUser).toBeNull()
      finish([row(1)]) // A'nın satırları çıkıştan sonra gelir
      await reading
      expect(get().messages).toEqual([])
    } finally {
      h.readList = null
    }
  })

  it('çevrimiçi çıkış başarısızsa kullanıcı içeride kalır, kopya durur', async () => {
    await seed()
    h.webLogout = async () => false
    const { slice, get } = webSession({ offlineMode: false })
    await slice.logout()
    expect(get().currentUser).toEqual(USER)
    expect(await dbExists()).toBe(true)
  })

  it('wipeOffline önbellek API yoksa da veritabanını siler', async () => {
    await seed()
    vi.stubGlobal('caches', undefined)
    await wipeOffline()
    expect(await dbExists()).toBe(false)
  })
})

describe('gövde kotası sayacı', () => {
  it('gövdeler belleğe okunmaz; toplam yazma ve silmeyle tutarlı', async () => {
    h.rows = [row(1), row(2)]
    h.bodies.set(1, ready('a'.repeat(500)))
    h.bodies.set(2, ready('b'.repeat(900)))
    await syncOffline({ days: 30, accountIds: [1] })
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll')
    const stats = await bodyStats()
    expect(getAll).not.toHaveBeenCalled()
    getAll.mockRestore()
    expect([...stats.ids].sort()).toEqual([1, 2])
    expect(stats.bytes).toBeGreaterThan(1400)
    expect(stats.bytes).toBeLessThan(1600)
    await deleteMessages([2], currentEpoch())
    const after = await bodyStats()
    expect([...after.ids]).toEqual([1])
    expect(after.bytes).toBeGreaterThan(500)
    expect(after.bytes).toBeLessThan(700)
    await deleteMessages([1], currentEpoch())
    expect((await bodyStats()).bytes).toBe(0)
  })
})

describe('kapsam ve kullanıcı değişimi', () => {
  const enable = (userId = 7): void => saveOfflineSettings({ on: true, days: 30, userId })
  const storeWith = (o: Partial<State> = {}) => {
    const state = { currentUser: USER, offlineMode: false, accounts: [], ...o } as unknown as State
    return { state, get: () => state }
  }
  beforeEach(() => vi.stubGlobal('navigator', { serviceWorker: { ready: new Promise(() => {}) } }))

  it('sürmekte olan tur hesap daralınca kesilir, yeni seçeneklerle yeniden çalışır', async () => {
    h.accounts = [account(1), account(2)]
    h.rows = Array.from({ length: 6 }, (_, i) => row(i + 1, { accountId: i % 2 ? 2 : 1 }))
    for (let i = 1; i <= 6; i++) h.bodies.set(i, ready(`gövde ${i}`))
    let bodies = 0
    let restart: Promise<{ messages: number }> | null = null
    h.onBeforeCall = (m) => {
      if (m !== 'getBody') return
      if (++bodies === 2) {
        h.accounts = [account(1), account(2, true)]
        restart = syncOffline({ days: 30, accountIds: [1], restart: true })
      }
    }
    const first = syncOffline({ days: 30, accountIds: [1, 2], pauseMs: 0 })
    await first
    await restart
    const left = await readOfflineList({ folderKind: 'inbox' })
    expect(left.every((r) => r.accountId === 1)).toBe(true)
    expect(left).toHaveLength(3)
    expect((await bodyStats()).ids.size).toBeLessThanOrEqual(3)
    expect(h.calls.filter((c) => c.method === 'getBody' && (c.params as { messageId: number }).messageId % 2 === 0).length).toBeLessThanOrEqual(2)
  })

  it('offlineAccountsChanged kasaya alınan hesabı süren turda da düşürür', async () => {
    enable()
    h.accounts = [account(1), account(2)]
    h.rows = [row(1), row(2, { accountId: 2 })]
    const { state, get } = storeWith({ accounts: [account(1), account(2)] })
    offlineAccountsChanged(get)
    await runOfflineSync(get, 0)
    expect((await readOfflineList({ folderKind: 'inbox' }))).toHaveLength(2)
    h.accounts = [account(1), account(2, true)]
    state.accounts = h.accounts as AccountInfo[]
    offlineAccountsChanged(get)
    await vi.waitFor(async () => expect((await readOfflineList({ folderKind: 'inbox' })).map((r) => r.id)).toEqual([1]))
  })

  it('getAccounts beklenirken ayar kapatılırsa veritabanı geri gelmez', async () => {
    enable()
    h.rows = [row(1)]
    const { get } = storeWith()
    let off: Promise<void> | null = null
    h.onBeforeCall = (m) => {
      if (m === 'getAccounts' && !off) off = setOfflineMode(get, false, 30)
    }
    await runOfflineSync(get, 0)
    await off
    expect(h.calls.some((c) => c.method === 'listMessages')).toBe(false)
    expect(await dbExists()).toBe(false)
    expect(loadOfflineSettings().on).toBe(false)
  })

  it('getAccounts beklenirken kullanıcı değişirse eşitlenmez', async () => {
    enable()
    const { state, get } = storeWith()
    h.onBeforeCall = (m) => {
      if (m === 'getAccounts') state.currentUser = { ...USER, id: 8 }
    }
    await runOfflineSync(get, 0)
    expect(h.calls.some((c) => c.method === 'listMessages')).toBe(false)
  })

  it('offlineOnHello: başka kullanıcının kopyası silinir, tercih temizlenir', async () => {
    enable(7)
    h.rows = [row(1)]
    await syncOffline({ days: 30, accountIds: [1], user: USER })
    const other = { ...USER, id: 8 }
    const { get } = storeWith({ currentUser: other })
    offlineOnHello(other, get)
    await vi.waitFor(async () => expect(await dbExists()).toBe(false))
    expect(loadOfflineSettings()).toEqual({ on: false, days: 30, userId: null })
    expect(h.calls.filter((c) => c.method === 'getAccounts').length).toBe(1) // yeni eşitleme başlamaz
  })

  it('offlineOnHello: aynı kullanıcıda kopya kalır, eşitleme döner', async () => {
    enable(7)
    h.rows = [row(1)]
    await syncOffline({ days: 30, accountIds: [1], user: USER })
    const { get } = storeWith()
    offlineOnHello(USER, get)
    await vi.waitFor(() => expect(h.calls.filter((c) => c.method === 'getAccounts').length).toBeGreaterThan(1))
    expect(await dbExists()).toBe(true)
    expect(loadOfflineSettings().on).toBe(true)
  })
})

describe('oturum olayları', () => {
  const session = async (over: Partial<State> = {}, me: unknown = { user: USER }) => {
    const win = Object.assign(new EventTarget(), { location: { protocol: 'https:', host: 'ornek.test', replace: vi.fn() } })
    vi.stubGlobal('window', win)
    let state = {
      currentUser: USER, serverRestarting: false, theme: 'auto', messages: [row(1)], accounts: [account(1)], selectedAccountIds: [1],
      selectedFolderId: 3, folders: [{ id: 3 }], selectedMessageId: 1, toast: vi.fn(), refreshAccounts: vi.fn(), refreshList: vi.fn(),
      refreshVaultState: vi.fn(), refreshBody: vi.fn(), ...over
    } as unknown as State
    const set = (p: Partial<State>): void => {
      state = { ...state, ...p }
    }
    const get = (): State => state
    h.webMe = async () => me
    sessionSlice(set as never, get as never).init()
    await new Promise((r) => setTimeout(r, 0))
    const fire = (ev: string, d: unknown = {}): void => h.listeners.get(ev)?.forEach((cb) => cb(d))
    return { win, get, fire }
  }

  it('IndexedDB açılışta takılırsa kopya beklemesi sınırlı; açılış sunucuya geçer', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { ready: new Promise(() => {}) } })
    saveOfflineSettings({ on: true, days: 7, userId: USER.id })
    // engellenen silmenin arkasında kalan open: hiç olay gelmez
    const stuck = {} as IDBOpenDBRequest
    await wipeOffline()
    const open = vi.spyOn(indexedDB, 'open').mockImplementation(() => stuck)
    vi.useFakeTimers()
    try {
      const result = hasOfflineCopy()
      await vi.advanceTimersByTimeAsync(5001)
      await expect(result).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
      open.mockRestore()
      // takılı tutamaç sonraki testlere kalmasın
      stuck.onerror?.(new Event('error'))
    }
  })

  it('bağlantı gelince bekleyen çevrimdışı çıkış uygulanır: sunucuda kapanır, sekme çıkar', async () => {
    const logout = vi.fn(async () => true)
    h.webLogout = logout
    const { get, fire } = await session()
    localStorage.setItem('gecko-offline-logout', '1')
    fire('local:connected')
    expect(get().currentUser).toBeNull()
    await vi.waitFor(() => expect(localStorage.getItem('gecko-offline-logout')).toBeNull())
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('başka sekme çevrimdışı çıkınca bu sekme hemen çıkar', async () => {
    const { win, get } = await session()
    h.webLogout = async () => false
    win.dispatchEvent(Object.assign(new Event('storage'), { key: 'gecko-offline', newValue: '{}' }))
    expect(get().currentUser).not.toBeNull()
    win.dispatchEvent(Object.assign(new Event('storage'), { key: 'gecko-offline-logout', newValue: '1' }))
    expect(get().currentUser).toBeNull()
  })

  it('giriş ekranında kalan sekme bağlantı gelince bekleyen çıkışı sunucuya iletir', async () => {
    const logout = vi.fn(async () => true)
    const { win } = await session({ currentUser: null }, { user: null, setupRequired: false })
    h.webLogout = logout
    localStorage.setItem('gecko-offline-logout', '1')
    win.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(localStorage.getItem('gecko-offline-logout')).toBeNull())
  })

  it('hello başka kullanıcıyla gelirse önceki kullanıcının bütün ekran verisi gider', async () => {
    const { get, fire } = await session()
    fire('sync:hello', { accountCount: 1, usersCount: 2, user: { ...USER, id: 8 } })
    const s = get()
    expect(s.currentUser?.id).toBe(8)
    expect(s.accounts).toEqual([])
    expect(s.messages).toEqual([])
    expect(s.selectedMessageId).toBeNull()
    expect(s.selectedAccountIds).toBeNull()
    expect(s.selectedFolderId).toBeNull()
    expect(s.folders).toEqual([])
  })

  it('taşıma hiç açılamadan sunucu giderse kopuş olayı beklenmez, kopyaya geçilir', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { ready: new Promise(() => {}) } })
    saveOfflineSettings({ on: true, days: 30, userId: USER.id })
    h.rows = [row(1)]
    await syncOffline({ days: 30, accountIds: [1], user: USER })
    h.open = false
    const { get } = await session()
    expect(get().offlineMode).toBeFalsy()
    h.webMe = async () => {
      throw new Error('ağ yok')
    }
    await expect(h.transportOpts!.isSessionGone()).rejects.toThrow()
    await vi.waitFor(() => expect(get().offlineMode).toBe(true))
    expect(h.failFast).toBe(true)
  })

  it('boundedWait: kopya varsa sunucu sınırsız beklenmez', async () => {
    vi.useFakeTimers()
    try {
      const hang = new Promise<never>(() => {})
      const p = boundedWait(hang, true)
      const check = expect(p).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(5000)
      await check
      await expect(boundedWait(Promise.resolve(1), false)).resolves.toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ayarlar', () => {
  it('varsayılan kapalı, bozuk kayıt kapalı sayılır, gün yalnız 7/30/90', () => {
    expect(loadOfflineSettings()).toEqual({ on: false, days: 30, userId: null })
    localStorage.setItem(OFFLINE_KEY, '{bozuk')
    expect(loadOfflineSettings().on).toBe(false)
    localStorage.setItem(OFFLINE_KEY, JSON.stringify({ on: true, days: 5, userId: 3 }))
    expect(loadOfflineSettings()).toEqual({ on: true, days: 30, userId: 3 })
    saveOfflineSettings({ on: true, days: 90, userId: 7 })
    expect(loadOfflineSettings()).toEqual({ on: true, days: 90, userId: 7 })
  })
})

describe('service worker yönlendirmesi', () => {
  const o = 'https://posta.ornek.test'
  it('API, RPC ve OAuth hiçbir zaman önbelleğe girmez', () => {
    for (const p of ['/api/me', '/api/attachment/1/2', '/api', '/rpc', '/oauth/callback', '/oauth', '/sw.js', '/healthz']) {
      expect(shellRoute('GET', 'navigate', o + p, o), p).toBe('pass')
      expect(shellRoute('GET', 'cors', o + p, o), p).toBe('pass')
    }
  })
  it('gezinme ağ öncelikli, hash\'li dosya önbellek öncelikli, manifest ve simge ağ öncelikli', () => {
    expect(shellRoute('GET', 'navigate', `${o}/`, o)).toBe('network')
    expect(shellRoute('GET', 'navigate', `${o}/?x=1`, o)).toBe('network')
    expect(shellRoute('GET', 'no-cors', `${o}/assets/index-abc.js`, o)).toBe('cache')
    expect(shellRoute('GET', 'cors', `${o}/manifest.webmanifest`, o)).toBe('network')
    expect(shellRoute('GET', 'no-cors', `${o}/icons/icon-192.png`, o)).toBe('network')
  })
  it('GET dışı ve başka köken dokunulmaz', () => {
    expect(shellRoute('POST', 'cors', `${o}/assets/a.js`, o)).toBe('pass')
    expect(shellRoute('GET', 'cors', 'https://baska.test/assets/a.js', o)).toBe('pass')
  })
})

describe('service worker önbellek kuralları', () => {
  it('sekmede açılan simge ya da manifest kabuk sayfasını ezmez', () => {
    expect(shellKey('navigate', '/', 'text/html; charset=utf-8')).toBe('/')
    expect(shellKey('navigate', '/icons/icon-192.png', 'image/png')).toBeNull()
    expect(shellKey('navigate', '/manifest.webmanifest', 'application/manifest+json')).toBeNull()
    expect(shellKey('no-cors', '/icons/icon-192.png', 'image/png')).toBe('/icons/icon-192.png')
  })
  it('yeni kabuk hazır olmadan eskisi silinmez', () => {
    expect(staleShells(['s-a', 's-b'], 's-b', false)).toEqual([])
    expect(staleShells(['s-a', 's-b'], 's-b', true)).toEqual(['s-a'])
  })
})

describe('salt okunur koruma', () => {
  it('çevrimdışıyken yazma eylemleri çalışmaz, açıklama gösterilir; bağlıyken geçer', () => {
    const del = vi.fn()
    const toast = vi.fn()
    let offlineMode = true
    const s = guardOfflineWrites({ deleteMessages: del, select: vi.fn() } as unknown as State, () => ({ offlineMode, toast }) as unknown as State)
    s.deleteMessages([1])
    expect(del).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledTimes(1)
    offlineMode = false
    s.deleteMessages([1])
    expect(del).toHaveBeenCalledTimes(1)
  })
})

describe('kişi ve takvim kopyası', () => {
  const NOW = new Date()
  const at = (months: number, day = 10): number => new Date(NOW.getFullYear(), NOW.getMonth() + months, day, 10).getTime()
  const book = { id: 1, type: 'addressbook', name: 'Rehber', hidden: false }
  const calA = { id: 2, type: 'calendar', name: 'İş', hidden: false }
  const calB = { id: 3, type: 'calendar', name: 'Gizli', hidden: true }
  const contact = (id: number, name = `Kişi ${id}`) => ({ id, collectionId: 1, kind: 'individual', fullName: name, org: null, emails: [{ addr: `k${id}@ornek.test`, label: null }], note: 'not', photoDataUrl: 'x' })
  const event = (id: number, start: number, collectionId = 2, title = `Etkinlik ${id}`) => ({ key: `${id}:`, objectId: id, collectionId, uid: `u${id}`, recurrenceId: null, title, location: null, start, end: start + 3_600_000, allDay: false, startDate: null, endDate: null, tz: 'UTC', cancelled: false, recurring: false, canEdit: true, myPartstat: null })
  const run = async (): Promise<{ contacts: number; months: number }> => syncOfflinePim({ alive: () => true, at: currentEpoch(), key: await getCacheKey() })

  beforeEach(() => {
    h.pim = { collections: { addressbook: [book], calendar: [calA, calB] }, contacts: [contact(1, 'Ayşe Gizliad')], events: [event(1, at(0), 2, 'Gizli toplantı başlığı'), event(2, at(1)), event(3, at(0), 3, 'Saklı takvim')] }
  })

  it('pim blobs have no plaintext', async () => {
    await run()
    const raw = await rawDump()
    for (const secret of ['Ayşe Gizliad', 'k1@ornek.test', 'Gizli toplantı başlığı', 'Rehber']) expect(raw).not.toContain(secret)
    expect(await readOfflineContacts()).toHaveLength(1)
    expect((await readOfflineContacts('ayşe'))[0]).toMatchObject({ fullName: 'Ayşe Gizliad' })
    expect((await readOfflineContacts())[0]).not.toHaveProperty('note')
    expect((await readOfflineContacts())[0]).not.toHaveProperty('photoDataUrl')
    expect((await readOfflineCollections())?.calendar).toHaveLength(2)
  })

  it('hidden calendars are not stored', async () => {
    await run()
    const all = await readOfflineEvents(at(-1), at(3))
    expect(all.map((e) => e.objectId)).toEqual([1, 2])
  })

  it('window is -1 to +6 months and old months go', async () => {
    const old = `pim:events:1999-01`
    await metaPut(old, new ArrayBuffer(1), currentEpoch())
    expect(await run()).toMatchObject({ months: 8 })
    expect(await metaKeys('pim:events:')).toHaveLength(8)
    expect(await metaKeys('pim:events:')).not.toContain(old)
  })

  it('logout wipes pim', async () => {
    await run()
    await wipeOffline()
    expect(await readOfflineContacts()).toEqual([])
    expect(await readOfflineEvents(at(-1), at(3))).toEqual([])
    expect(await metaKeys('pim:')).toEqual([])
  })

  it('permission loss drops events on next sync', async () => {
    await run()
    h.pim = { collections: { addressbook: [], calendar: [] }, contacts: [], events: [] }
    await run()
    expect(await readOfflineEvents(at(-1), at(3))).toEqual([])
    expect(await readOfflineContacts()).toEqual([])
  })

  describe('kopya temizliği', () => {
    const failing = (fail: (type: string) => boolean) => {
      h.onBeforeCall = (method) => {
        const last = h.calls[h.calls.length - 1]
        if (method === 'listPimCollections' && fail((last.params as { type: string }).type)) throw new Error('yasak')
      }
    }
    const listed = (): string[] => h.calls.map((c) => c.method).filter((m) => m === 'listContacts' || m === 'listEvents')

    it('list failure drops the blobs of that type before any listing', async () => {
      await run()
      h.calls = []
      failing((type) => type === 'calendar')
      await run()
      expect(await metaKeys('pim:events:')).toEqual([])
      expect(await metaKeys('pim:collections')).toEqual([])
      expect(await readOfflineContacts()).toHaveLength(1)
      expect(listed().every((m) => m === 'listContacts')).toBe(true)
    })

    it('both lists failing drops everything and lists nothing', async () => {
      await run()
      h.calls = []
      failing(() => true)
      await run()
      expect(await metaKeys('pim:')).toEqual([])
      expect(listed()).toEqual([])
    })

    it('a dropped connection keeps the copy', async () => {
      await run()
      h.onBeforeCall = () => {
        h.open = false
      }
      await syncOfflinePim({ alive: () => h.open, at: currentEpoch(), key: await getCacheKey() })
      h.open = true
      expect(await readOfflineContacts()).toHaveLength(1)
      expect(await metaKeys('pim:events:')).toHaveLength(8)
    })

    it('a collection gone from view is dropped before listing', async () => {
      const open = { ...calB, hidden: false }
      h.pim.collections = { addressbook: [book], calendar: [calA, open] }
      h.pim.events = [event(1, at(0), 2), event(2, at(1), 3)]
      await run()
      h.pim.collections = { addressbook: [{ ...book, hidden: true }], calendar: [open] }
      h.onBeforeCall = (method) => {
        if (method === 'listEvents') throw new Error('hata')
      }
      await run().catch(() => {})
      expect(await readOfflineContacts()).toEqual([])
      expect((await readOfflineEvents(at(-1), at(3))).map((e) => e.objectId)).toEqual([2])
    })

    it('kept collections keep their blobs when the event list fails', async () => {
      await run()
      h.onBeforeCall = (method) => {
        if (method === 'listEvents') throw new Error('hata')
      }
      await run().catch(() => {})
      expect(await metaKeys('pim:events:')).toHaveLength(8)
    })

    it('runs when the mail phase cannot', async () => {
      saveOfflineSettings({ on: true, days: 30, userId: USER.id })
      h.onBeforeCall = (method) => {
        if (method === 'getAccounts') throw new Error('hata')
      }
      await syncOffline({ days: 30, accountIds: [1] })
      expect(await readOfflineContacts()).toHaveLength(1)
    })

    it('runs when the message list fails', async () => {
      h.onBeforeCall = (method) => {
        if (method === 'listMessages') throw new Error('hata')
      }
      await syncOffline({ days: 30, accountIds: [1] })
      expect(await readOfflineContacts()).toHaveLength(1)
    })

    it('scope change deletes pim blobs before the connection is needed', async () => {
      await run()
      h.open = false
      await syncOffline({ days: 30, accountIds: [1], restart: true })
      h.open = true
      expect(await metaKeys('pim:')).toEqual([])
    })

    it('a normal tour keeps pim blobs while it rewrites them', async () => {
      await run()
      h.open = false
      await syncOffline({ days: 30, accountIds: [1] })
      h.open = true
      expect(await readOfflineContacts()).toHaveLength(1)
    })

    it('pim:changed sources restarts the sync when the visible set changed, not on status events', async () => {
      saveOfflineSettings({ on: true, days: 30, userId: USER.id })
      const state = { currentUser: USER, offlineMode: false, pimCollections: { addressbook: [book], calendar: [calA] } }
      const get = (() => state) as never
      await offlinePimSourcesChanged(get)
      h.calls = []
      runtime.offlineLastSync = Date.now()
      await offlinePimSourcesChanged(get)
      expect(h.calls).toEqual([])
      state.pimCollections = { addressbook: [book], calendar: [] }
      await offlinePimSourcesChanged(get)
      expect(h.calls.some((c) => c.method === 'listPimCollections')).toBe(true)
    })
  })

  it('contact cap 5000', async () => {
    h.pim.contacts = Array.from({ length: MAX_OFFLINE_CONTACTS + 700 }, (_, i) => contact(i + 1))
    expect(await run()).toMatchObject({ contacts: MAX_OFFLINE_CONTACTS })
    expect(await readOfflineContacts()).toHaveLength(MAX_OFFLINE_CONTACTS)
  })

  it('readOfflineEvents returns only requested months', async () => {
    await run()
    expect((await readOfflineEvents(at(0, 1), at(0, 28))).map((e) => e.objectId)).toEqual([1])
    expect((await readOfflineEvents(at(1, 1), at(1, 28))).map((e) => e.objectId)).toEqual([2])
  })

  it('event spanning a month edge comes once', async () => {
    const edge = new Date(NOW.getFullYear(), NOW.getMonth() + 1, 1).getTime() - 1800_000
    h.pim.events = [event(9, edge)]
    await run()
    expect(await readOfflineEvents(at(0, 1), at(1, 28))).toHaveLength(1)
  })

  it('stale run writes nothing after epoch change', async () => {
    const key = await getCacheKey()
    const stale = currentEpoch() - 1
    expect(await syncOfflinePim({ alive: () => true, at: stale, key })).toEqual({ contacts: 0, months: 0 })
    expect(await metaKeys('pim:')).toEqual([])
  })

  it('write guarded offline', async () => {
    const calls: string[] = []
    const fn = (name: string) => () => { calls.push(name) }
    const s = { saveEventDraft: fn('e'), removeEvent: fn('r'), saveContactDraft: fn('c'), removeContact: fn('d'), offlineMode: true, toast: () => {} } as unknown as State
    const g = guardOfflineWrites(s, () => s)
    for (const name of ['saveEventDraft', 'removeEvent', 'saveContactDraft', 'removeContact'] as const) (g[name] as unknown as () => void)()
    expect(calls).toEqual([])
  })
})
