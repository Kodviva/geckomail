import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '../../../shared/rpc'
import { t } from '../../../shared/i18n'
import type { RpcTransport } from '../transport'

type State = 'open' | 'closed' | 'revoked'

// Sahte taşıma: testten açılır/kapanır, gönderilenleri tutar
class FakeTransport implements RpcTransport {
  sent: unknown[] = []
  started = false
  closed = false
  private onMsg: ((m: unknown) => void) | null = null
  private onState: ((s: State) => void) | null = null
  start(onMessage: (m: unknown) => void, onState: (s: State) => void): void {
    this.started = true
    this.onMsg = onMessage
    this.onState = onState
  }
  send(m: unknown): void {
    this.sent.push(m)
  }
  close(): void {
    this.closed = true
  }
  state(s: State): void {
    this.onState?.(s)
  }
  emit(m: unknown): void {
    this.onMsg?.(m)
  }
}

const user: SessionUser = { id: 7, username: 'ayse', role: 'member', permittedGroupIds: [1], manageableGroupIds: [] }

describe('RpcClient', () => {
  it('çevrimdışı modda taşıma kapalıyken çağrı kuyruğa girmez, hemen reddedilir; açılınca normal', async () => {
    const { RpcClient } = await import('../rpcClient')
    const c = new RpcClient()
    const tr = new FakeTransport()
    c.start(tr)
    const queued = c.call('markSeen', { messageIds: [1], seen: true })
    c.setFailFast(true)
    await expect(queued).rejects.toThrow(t('common.offlineReadOnly')) // kopuşta kuyruğa girmiş yazma da gitmez
    await expect(c.call('getAccounts', {})).rejects.toThrow(t('common.offlineReadOnly'))
    tr.state('open')
    expect(tr.sent).toEqual([])
    void c.call('getAccounts', {}).catch(() => {})
    expect(tr.sent).toHaveLength(1)
    c.stop()
  })

  it('kuyrukta zaman aşımına uğrayan çağrı yeniden bağlanınca gönderilmez', async () => {
    vi.useFakeTimers()
    try {
      const { RpcClient } = await import('../rpcClient')
      const c = new RpcClient()
      const tr = new FakeTransport()
      c.start(tr)
      const p = c.call('markSeen', { messageIds: [1], seen: true })
      const rejected = expect(p).rejects.toThrow(t('common.rpcTimeout', { method: 'markSeen' }))
      await vi.advanceTimersByTimeAsync(30_001)
      await rejected
      tr.state('open')
      expect(tr.sent).toEqual([])
      c.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('oturum düştükten sonra eski kuyruk yeni start ile gönderilmez', async () => {
    const { RpcClient } = await import('../rpcClient')
    const c = new RpcClient()
    const old = new FakeTransport()
    c.start(old)
    const p = c.call('markSeen', { messageIds: [1], seen: true })
    // stop() kuyruğu boşaltır; start() de kendi başına boşaltmalı: stop'tan geçmeyen yol sahte kuyrukla sınanır
    ;(c as unknown as { sendQueue: Array<() => void>; transport: unknown }).transport = null
    const fresh = new FakeTransport()
    c.start(fresh)
    fresh.state('open')
    expect(fresh.sent).toEqual([])
    c.stop()
    await expect(p).rejects.toThrow(t('common.rpcDisconnected'))
  })

  it('kopmada bekleyen çağrı common.rpcDisconnected ile reddedilir', async () => {
    const { RpcClient } = await import('../rpcClient')
    const c = new RpcClient()
    const tr = new FakeTransport()
    c.start(tr)
    tr.state('open')
    const p = c.call('getAccounts', {})
    expect(tr.sent).toEqual([{ id: 1, method: 'getAccounts', params: {} }])
    tr.state('closed')
    await expect(p).rejects.toThrow(t('common.rpcDisconnected'))
  })

  it('kapalıyken çağrı kuyruğa girer; yeniden açılınca gönderilir ve local:connected yayılır', async () => {
    const { RpcClient } = await import('../rpcClient')
    const c = new RpcClient()
    const tr = new FakeTransport()
    const connected = vi.fn()
    c.on('local:connected', connected)
    c.start(tr)
    tr.state('open')
    tr.state('closed')
    const p = c.call('getAccounts', {})
    expect(tr.sent).toEqual([])
    tr.state('open')
    expect(connected).toHaveBeenCalledTimes(2)
    expect(tr.sent).toEqual([{ id: 1, method: 'getAccounts', params: {} }])
    tr.emit({ id: 1, ok: true, result: [] })
    await expect(p).resolves.toEqual([])
  })

  it('revoked: bekleyen reddedilir, local:revoked yayılır', async () => {
    const { RpcClient } = await import('../rpcClient')
    const c = new RpcClient()
    const tr = new FakeTransport()
    const revoked = vi.fn()
    c.on('local:revoked', revoked)
    c.start(tr)
    tr.state('open')
    const p = c.call('getAccounts', {})
    tr.state('revoked')
    await expect(p).rejects.toThrow(t('common.rpcDisconnected'))
    expect(revoked).toHaveBeenCalledTimes(1)
  })

  it('stop taşımayı kapatır, bekleyeni reddeder', async () => {
    const { RpcClient } = await import('../rpcClient')
    const c = new RpcClient()
    const tr = new FakeTransport()
    c.start(tr)
    tr.state('open')
    const p = c.call('getAccounts', {})
    c.stop()
    expect(tr.closed).toBe(true)
    await expect(p).rejects.toThrow(t('common.rpcDisconnected'))
  })
})

// Web oturumu: mağaza + sahte WebSocket taşıması + sahte webAuth
const fake = { tr: null as FakeTransport | null, opts: null as { isSessionGone?: () => Promise<boolean> } | null }
const auth = { me: null as SessionUser | null, setupRequired: false, logoutOk: true }

vi.mock('../platform', () => ({
  platform: { kind: 'web', setLocale: vi.fn(), biometricAvailable: async () => false, promptBiometric: async () => false }
}))
vi.mock('../transport/webSocket', () => ({
  webSocketTransport: (_url: string, opts?: { isSessionGone?: () => Promise<boolean> }) => {
    fake.tr = new FakeTransport()
    fake.opts = opts ?? null
    return fake.tr
  }
}))
vi.mock('../webAuth', () => ({
  webMe: vi.fn(async () => (auth.me ? { user: auth.me } : { user: null, setupRequired: auth.setupRequired })),
  webLogin: vi.fn(async () => ({ ok: true, user })),
  webLogout: vi.fn(async () => auth.logoutOk)
}))

const g = globalThis as unknown as Record<string, unknown>

describe('web oturumu', () => {
  beforeEach(() => {
    vi.resetModules()
    fake.tr = null
    fake.opts = null
    auth.me = null
    auth.setupRequired = false
    auth.logoutOk = true
    replace.mockClear()
    g.window = { location: { protocol: 'https:', host: 'posta.example', replace }, addEventListener: () => {} }
    g.document = { documentElement: { dataset: {} } }
    const mem = new Map<string, string>()
    g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) }
    session.clear()
    g.sessionStorage = { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v), removeItem: (k: string) => void session.delete(k) }
  })
  afterEach(() => {
    delete g.window
    delete g.document
    delete g.localStorage
    delete g.sessionStorage
  })

  const replace = vi.fn()
  const session = new Map<string, string>()
  /** Çıkış sayfa yenilemesiyle biter; bildirim nedeni yenilemeye taşınır */
  const reloadReason = async (): Promise<string | undefined> => {
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    return session.get('gecko-signout-reason')
  }

  const boot = async () => {
    const { useStore } = await import('../store')
    useStore.getState().init()
    await vi.waitFor(() => expect(fake.tr?.started).toBe(true))
    return useStore
  }
  const sentMethods = (name: string): unknown[] => fake.tr!.sent.filter((m) => (m as { method?: string }).method === name)
  const hello = (u: SessionUser | null) =>
    fake.tr!.emit({ event: 'sync:hello', data: { accountCount: 2, usersCount: 3, user: u } })

  it('her yeni kanalda oturum dili bildirilir (oturum bağlantıya bağlı), girişsiz hello bildirmez', async () => {
    auth.me = user
    await boot()
    const { platform } = await import('../platform')
    const setLocale = vi.mocked(platform.setLocale)
    setLocale.mockClear()
    hello(null)
    expect(setLocale).not.toHaveBeenCalled()
    hello(user)
    hello(user) // yeniden bağlanış
    expect(setLocale).toHaveBeenCalledTimes(2)
    expect(setLocale).toHaveBeenCalledWith('tr')
  })

  it('server:notify: sekme arka plandaysa bildirim, tıklayınca hesap filtresi', async () => {
    auth.me = user
    const made: { title: string; onclick: (() => void) | null; close(): void }[] = []
    class N {
      static permission = 'granted'
      onclick: (() => void) | null = null
      close(): void {}
      constructor(readonly title: string) {
        made.push(this)
      }
    }
    vi.stubGlobal('Notification', N)
    const focus = vi.fn()
    Object.assign(g.window as object, { focus })
    Object.assign(g.document as object, { visibilityState: 'visible', hasFocus: () => false })
    const store = await boot()
    hello(user)
    fake.tr!.emit({ event: 'server:notify', data: { title: 'Yeni', body: 'Ali', accountId: 5 } })
    expect(made.map((n) => n.title)).toEqual(['Yeni'])
    made[0].onclick!()
    expect(focus).toHaveBeenCalled()
    expect(store.getState().selectedAccountIds).toEqual([5])

    // odaktayken gösterilmez
    Object.assign(g.document as object, { hasFocus: () => true })
    fake.tr!.emit({ event: 'server:notify', data: { title: 'İkinci', body: 'x', accountId: 5 } })
    expect(made).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('bildirim tıklaması iletiyi açar: listedeyse seçer, değilse hesabın gelen kutusuna geçer', async () => {
    auth.me = user
    const made: { onclick: (() => void) | null; close(): void }[] = []
    class N {
      static permission = 'granted'
      onclick: (() => void) | null = null
      close(): void {}
      constructor() {
        made.push(this)
      }
    }
    vi.stubGlobal('Notification', N)
    Object.assign(g.window as object, { focus: vi.fn() })
    Object.assign(g.document as object, { visibilityState: 'visible', hasFocus: () => false })
    const store = await boot()
    hello(user)
    const row = (id: number) => ({ id, seen: true, locked: false }) as never
    store.setState({ messages: [row(9)], refreshBody: async () => {} })
    fake.tr!.emit({ event: 'server:notify', data: { title: 'A', body: 'x', accountId: 5, messageId: 9, level: 'normal', tag: 'msg:9', count: 1 } })
    made[0].onclick!()
    await vi.waitFor(() => expect(store.getState().selectedMessageId).toBe(9))
    expect(store.getState().selectedAccountIds).not.toEqual([5])

    store.setState({ refreshList: async () => store.setState({ messages: [row(10)] }), folderKind: 'sent', smartView: null })
    fake.tr!.emit({ event: 'local:open-message', data: { messageId: 10, accountId: 5 } })
    await vi.waitFor(() => expect(store.getState().selectedMessageId).toBe(10))
    expect(store.getState().selectedAccountIds).toEqual([5])
    expect(store.getState().folderKind).toBe('inbox')

    // silinmiş ileti: seçim değişmez, hesapta kalınır
    fake.tr!.emit({ event: 'local:open-message', data: { messageId: 11, accountId: 5 } })
    await new Promise((r) => setTimeout(r, 0))
    expect(store.getState().selectedMessageId).toBeNull()
    vi.unstubAllGlobals()
  })

  it('çıkışta bildirim kapanır; başka kullanıcı girdikten sonra tıklama iş yapmaz', async () => {
    auth.me = user
    const made: { onclick: (() => void) | null; closed: boolean; close(): void }[] = []
    class N {
      static permission = 'granted'
      onclick: (() => void) | null = null
      closed = false
      close(): void {
        this.closed = true
      }
      constructor() {
        made.push(this)
      }
    }
    vi.stubGlobal('Notification', N)
    Object.assign(g.window as object, { focus: () => {} })
    Object.assign(g.document as object, { visibilityState: 'visible', hasFocus: () => false })
    const store = await boot()
    hello(user)
    fake.tr!.emit({ event: 'server:notify', data: { title: 'A', body: 'x', accountId: 5 } })
    const stale = made[0].onclick!
    store.getState().setAccountFilter([1])

    // sunucu oturumu kapatır: bildirim kapanır
    fake.tr!.state('revoked')
    expect(made[0].closed).toBe(true)

    // aynı sekmede başka kullanıcı: eski tıklama filtreye dokunmaz
    store.getState().completeWebLogin({ ...user, id: user.id + 1 })
    await vi.waitFor(() => expect(fake.tr?.started).toBe(true))
    store.setState({ selectedAccountIds: [9] })
    stale()
    expect(store.getState().selectedAccountIds).toEqual([9])
    vi.unstubAllGlobals()
  })

  it('çerez geçerliyse açılışta WS başlar, sync:hello.user ile girilir', async () => {
    auth.me = user
    const store = await boot()
    fake.tr!.state('open')
    hello(user)
    expect(store.getState().currentUser).toEqual(user)
    expect(store.getState().needsBootstrap).toBe(false)
  })

  it('çerez yoksa WS başlamaz; giriş başarılı olunca başlar', async () => {
    const { useStore } = await import('../store')
    useStore.getState().init()
    await new Promise((r) => setTimeout(r, 0))
    expect(fake.tr).toBeNull()
    expect(useStore.getState().currentUser).toBeNull()
    // giriş akışı WebLogin'de (webLoginFlow); başarıda mağazaya kullanıcı verilir
    useStore.getState().completeWebLogin(user)
    expect(fake.tr?.started).toBe(true)
    expect(useStore.getState().currentUser).toEqual(user)
  })

  it('reconnect keeps user', async () => {
    auth.me = user
    const store = await boot()
    fake.tr!.state('open')
    hello(user)
    fake.tr!.state('closed')
    expect(store.getState().currentUser).toEqual(user)
    fake.tr!.state('open')
    hello(user) // yeni kanal: oturum sunucuda geçerli, giriş ekranına dönülmez
    expect(store.getState().currentUser).toEqual(user)
  })

  it('4401 logs out', async () => {
    auth.me = user
    const store = await boot()
    fake.tr!.state('open')
    hello(user)
    fake.tr!.state('revoked')
    expect(store.getState().currentUser).toBeNull()
    expect(store.getState().accounts).toEqual([])
    expect(store.getState().connected).toBe(false)
    expect(await reloadReason()).toBe('expired')
  })

  it('yenilemeyle taşınan çıkış nedeni açılışta gösterilir, bir kez', async () => {
    session.set('gecko-signout-reason', 'expired')
    const { useStore } = await import('../store')
    useStore.getState().init()
    expect(useStore.getState().toasts.map((x) => x.text)).toEqual([t('acct.session.expired')])
    expect(session.has('gecko-signout-reason')).toBe(false)
  })

  it('bilinmeyen çıkış nedeni yok sayılır', async () => {
    session.set('gecko-signout-reason', '<b>uydurma</b>')
    const { useStore } = await import('../store')
    useStore.getState().init()
    expect(useStore.getState().toasts).toEqual([])
  })

  it('açılışta oturum yoksa kalan taslak silinir; eski kayıtlı aramalar da', async () => {
    localStorage.setItem('gecko-draft', '{"to":"a@b.c"}')
    localStorage.setItem('gecko-saved-searches', '[{"name":"a","query":"b"}]')
    const { useStore } = await import('../store')
    useStore.getState().init()
    expect(localStorage.getItem('gecko-saved-searches')).toBeNull()
    await vi.waitFor(() => expect(localStorage.getItem('gecko-draft')).toBeNull())
    expect(useStore.getState().savedSearches).toEqual([])
  })

  it('hello gelmeden kaydedilen arama diskteki listeyi ezmez', async () => {
    localStorage.setItem(`gecko-saved-searches:${user.id}`, '[{"name":"eski","query":"x"}]')
    auth.me = user
    const store = await boot() // kullanıcı belli, sync:hello henüz gelmedi
    expect(store.getState().savedSearches).toEqual([{ name: 'eski', query: 'x' }])
    store.setState({ searchQuery: 'yeni' })
    store.getState().saveCurrentSearch('ikinci')
    expect(JSON.parse(localStorage.getItem(`gecko-saved-searches:${user.id}`)!)).toEqual([
      { name: 'eski', query: 'x' }, { name: 'ikinci', query: 'yeni' }
    ])
  })

  it('op:failed açık oluşturucunun gönderim kimliğini yeniler', async () => {
    auth.me = user
    const store = await boot()
    fake.tr!.state('open')
    hello(user)
    const c = { fromAccountId: 1, to: 'a@b.c', cc: '', bcc: '', subject: 's', text: 't', rich: false, html: '', attachments: [], clientSendId: 'eski-kimlik' }
    store.setState({ composer: c })
    fake.tr!.emit({ event: 'op:failed', data: { accountId: 1, kind: 'store_flags', error: 'x' } })
    expect(store.getState().composer?.clientSendId).toBe('eski-kimlik')
    fake.tr!.emit({ event: 'op:failed', data: { accountId: 1, kind: 'smtp_send', error: 'x' } })
    expect(store.getState().composer?.clientSendId).toMatch(/^[0-9a-f-]{36}$/)
    expect(store.getState().composer?.to).toBe('a@b.c')
  })

  it('op:failed taslağı yalnız gönderen ister', async () => {
    auth.me = user
    const store = await boot()
    fake.tr!.state('open')
    hello(user)
    fake.tr!.sent.length = 0
    fake.tr!.emit({ event: 'op:failed', data: { accountId: 1, kind: 'smtp_send', error: 'x', id: 7 } })
    expect(sentMethods('getOpDraft')).toEqual([])
    fake.tr!.emit({ event: 'op:failed', data: { accountId: 1, kind: 'smtp_send', error: 'x', id: 7, own: true } })
    expect(sentMethods('getOpDraft')).toHaveLength(1)
    expect(store.getState().composer).toBeFalsy()
  })

  it('followups:changed sayacı oturumun görebildiği listeden sayar', async () => {
    auth.me = user
    await boot()
    fake.tr!.state('open')
    hello(user)
    fake.tr!.sent.length = 0
    fake.tr!.emit({ event: 'followups:changed', data: {} })
    expect(sentMethods('listFollowups')).toHaveLength(1)
  })

  it('kayıtlı aramalar girişte kullanıcıya göre yüklenir', async () => {
    localStorage.setItem(`gecko-saved-searches:${user.id}`, '[{"name":"bana","query":"x"}]')
    localStorage.setItem('gecko-saved-searches:999', '[{"name":"baskasi","query":"y"}]')
    auth.me = user
    const store = await boot()
    fake.tr!.state('open')
    hello(user)
    expect(store.getState().savedSearches).toEqual([{ name: 'bana', query: 'x' }])
  })

  it('2FA kapatılınca sunucu oturumu kapatır: "oturum sona erdi" değil, 2FA bildirimi', async () => {
    auth.me = user
    const store = await boot()
    fake.tr!.state('open')
    hello(user)
    const p = store.getState().disableTwoFactor('123456')
    // yanıt gelmeden sunucu 4401 ile kapatır (onUserRevoked handler içinde)
    fake.tr!.state('revoked')
    await expect(p).resolves.toBe(true)
    expect(store.getState().currentUser).toBeNull()
    expect(await reloadReason()).toBe('twoFactorOff')
  })

  it('2FA kapatma reddedilirse (yanlış kod) oturum sürer, sonraki iptal yine "sona erdi" der', async () => {
    auth.me = user
    const store = await boot()
    fake.tr!.state('open')
    hello(user)
    const p = store.getState().disableTwoFactor('000000')
    const sent = fake.tr!.sent.at(-1) as { id: number }
    fake.tr!.emit({ id: sent.id, ok: false, error: 'kod hatalı' })
    await expect(p).resolves.toBe(false)
    expect(store.getState().currentUser).toEqual(user)
    fake.tr!.state('revoked')
    expect(await reloadReason()).toBe('expired')
  })

  it('kopuşta oturum sorulur: çerez geçersizse çıkış yapılır', async () => {
    auth.me = user
    const store = await boot()
    fake.tr!.state('open')
    hello(user)
    auth.me = null
    fake.tr!.state('closed')
    await vi.waitFor(() => expect(store.getState().currentUser).toBeNull())
    expect(fake.tr!.closed).toBe(true)
    expect(await reloadReason()).toBe('expired')
  })

  it('kopuşta oturum geçerliyse kullanıcı kalır', async () => {
    auth.me = user
    const store = await boot()
    fake.tr!.state('open')
    hello(user)
    fake.tr!.state('closed')
    await new Promise((r) => setTimeout(r, 0))
    expect(store.getState().currentUser).toEqual(user)
    expect(fake.tr!.closed).toBe(false)
  })

  it('taşımaya oturum sorgusu verilir: webMe null → true, kullanıcı varsa false', async () => {
    auth.me = user
    await boot()
    expect(await fake.opts!.isSessionGone!()).toBe(false)
    auth.me = null
    expect(await fake.opts!.isSessionGone!()).toBe(true)
  })

  it('hiç kullanıcı yoksa açılışta kurulum bilgisi (needsBootstrap)', async () => {
    auth.setupRequired = true
    const { useStore } = await import('../store')
    useStore.getState().init()
    await vi.waitFor(() => expect(useStore.getState().needsBootstrap).toBe(true))
    expect(fake.tr).toBeNull()
    expect(useStore.getState().currentUser).toBeNull()
  })

  it('çıkış: webLogout + taşıma kapanır, RPC logout çağrılmaz', async () => {
    auth.me = user
    const store = await boot()
    fake.tr!.state('open')
    hello(user)
    const { webLogout } = await import('../webAuth')
    await store.getState().logout()
    expect(webLogout).toHaveBeenCalled()
    expect(fake.tr!.closed).toBe(true)
    expect(fake.tr!.sent.some((m) => (m as { method?: string }).method === 'logout')).toBe(false)
    expect(store.getState().currentUser).toBeNull()
    expect(store.getState().connected).toBe(false)
    // kendi çıkışımız "oturum sona erdi" demez
    expect(await reloadReason()).toBeUndefined()
  })

  it('çıkış sırasında sunucunun 4401 kapatması "oturum sona erdi" göstermez', async () => {
    auth.me = user
    const store = await boot()
    fake.tr!.state('open')
    hello(user)
    const { webLogout } = await import('../webAuth')
    vi.mocked(webLogout).mockImplementationOnce(async () => {
      fake.tr!.state('revoked') // sunucu çıkışta soketi 4401 ile kapatır
      return true
    })
    await store.getState().logout()
    expect(store.getState().currentUser).toBeNull()
    expect(await reloadReason()).toBeUndefined()
  })

  it('çıkış sunucuda başarısızsa oturum açık kalır, yeniden dene eylemli uyarı', async () => {
    auth.me = user
    const store = await boot()
    fake.tr!.state('open')
    hello(user)
    auth.logoutOk = false
    await store.getState().logout()
    expect(store.getState().currentUser).toEqual(user)
    expect(fake.tr!.closed).toBe(false)
    const toast = store.getState().toasts.find((x) => x.text === t('acct.session.logoutFailed'))
    expect(toast?.action?.label).toBe(t('action.retry'))
    // yeniden dene: bu kez başarılı
    auth.logoutOk = true
    toast!.action!.fn()
    await vi.waitFor(() => expect(store.getState().currentUser).toBeNull())
    expect(fake.tr!.closed).toBe(true)
  })
})

describe('messagePortTransport', () => {
  afterEach(() => {
    delete g.window
  })

  it('close pencere dinleyicisini kaldırır', async () => {
    const listeners = new Set<unknown>()
    g.window = {
      addEventListener: (_: string, f: unknown) => void listeners.add(f),
      removeEventListener: (_: string, f: unknown) => void listeners.delete(f)
    }
    const { messagePortTransport } = await import('../transport/messagePort')
    const tr = messagePortTransport()
    tr.start(() => {}, () => {})
    expect(listeners.size).toBe(1)
    tr.close()
    expect(listeners.size).toBe(0)
  })

  it('preload ileti açma sinyalini yerel olaya çevirir', async () => {
    let listener: (e: unknown) => void = () => {}
    g.window = { addEventListener: (_: string, f: (e: unknown) => void) => void (listener = f), removeEventListener: () => {} }
    const { messagePortTransport } = await import('../transport/messagePort')
    const got: unknown[] = []
    messagePortTransport().start((m) => got.push(m), () => {})
    listener({ source: g.window, data: { type: 'gecko-open-message', messageId: 9, accountId: 5 } })
    listener({ source: {}, data: { type: 'gecko-open-message', messageId: 1 } }) // başka kaynak yok sayılır
    expect(got).toEqual([{ event: 'local:open-message', data: { messageId: 9, accountId: 5 } }])
  })
})
