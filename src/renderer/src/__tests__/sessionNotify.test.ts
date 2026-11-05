import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (data: unknown) => void>()
vi.mock('../rpcClient', () => ({
  rpc: {
    on: (event: string, cb: (data: unknown) => void) => void handlers.set(event, cb),
    init: vi.fn(), start: vi.fn(), stop: vi.fn(), setFailFast: vi.fn(), isOpen: false, call: vi.fn(async () => [])
  }
}))
const showServerNotification = vi.fn()
vi.mock('../webNotify', () => ({ showServerNotification, closeServerNotifications: vi.fn() }))
const resyncPush = vi.fn(async () => {})
const setPushUser = vi.fn()
vi.mock('../webPushClient', () => ({ resyncPush, setPushUser, suspendPush: vi.fn(async () => {}) }))
vi.mock('../webAuth', () => ({ webMe: vi.fn(async () => ({ user: null, setupRequired: false })), webLogout: vi.fn(async () => true) }))
vi.mock('../offline/store', () => ({ wipeOffline: vi.fn(async () => {}) }))
vi.mock('../offline/settings', () => ({ clearPendingLogout: vi.fn(), LOGOUT_KEY: 'k', markPendingLogout: vi.fn(), pendingLogout: () => false }))
vi.mock('../store/offline', () => ({
  bootFromCopy: vi.fn(), boundedWait: <T,>(p: Promise<T>) => p, enterOffline: vi.fn(), hasOfflineCopy: vi.fn(async () => false),
  leaveOffline: vi.fn(), offlineEnabled: () => false, offlineOnHello: vi.fn(), runOfflineSync: vi.fn()
}))
vi.mock('../store/compose', () => ({ clearDraft: vi.fn(), newSendId: () => 'x' }))
vi.mock('../store/mail', () => ({ invalidateListReads: vi.fn() }))
vi.mock('../store/savedSearches', () => ({ dropUnscopedSavedSearches: vi.fn(), readSavedSearches: () => [] }))
vi.mock('../store/initial', () => ({ initialState: {} }))
vi.mock('../transport', () => ({ webSocketTransport: vi.fn() }))

type W = Record<string, unknown>
const g = globalThis as unknown as { window?: W; document?: W; sessionStorage?: W }

async function boot(win: W): Promise<void> {
  g.window = { addEventListener() {}, location: { protocol: 'https:', host: 'x', replace() {} }, ...win }
  g.document = { documentElement: { dataset: {} }, visibilityState: 'hidden', hasFocus: () => false }
  g.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  vi.resetModules()
  const { sessionSlice } = await import('../store/session')
  const state: W = { theme: 'auto', currentUser: { id: 1 }, refreshAccounts: async () => {}, refreshList: async () => {}, refreshVaultState: async () => {}, toast: () => {} }
  const s = sessionSlice((p: unknown) => void Object.assign(state, p), (() => state) as never)
  s.init()
}

describe('server:notify oturum davranışı', () => {
  const notify = { title: 'T', body: 'B', accountId: 1, messageId: 2, level: 'normal', tag: 't', count: 1, actions: [], seq: 1 }
  const hello = { accountCount: 1, usersCount: 1, user: { id: 1, username: 'a', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] } }

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })
  afterEach(() => {
    delete g.window
    delete g.document
    delete g.sessionStorage
  })

  it('renderer stays silent with native notifications', async () => {
    await boot({ geckoDesktop: { wallboard: { open() {}, push() {} }, openSystemBrowser() {}, onLocalEvent() {}, rendererReady() {} } })
    handlers.get('server:notify')!(notify)
    expect(showServerNotification).not.toHaveBeenCalled()
    handlers.get('sync:hello')!(hello)
    expect(setPushUser).not.toHaveBeenCalled()
    expect(resyncPush.mock.calls.length).toBeLessThanOrEqual(1) // yalnız oturumsuz açılışın temizliği, abonelik kaydı değil
  })

  it('tarayıcıda bildirim ve push kaydı sürer', async () => {
    await boot({})
    handlers.get('server:notify')!(notify)
    expect(showServerNotification).toHaveBeenCalledTimes(1)
    handlers.get('sync:hello')!(hello)
    expect(setPushUser).toHaveBeenCalledWith(1)
  })
})
