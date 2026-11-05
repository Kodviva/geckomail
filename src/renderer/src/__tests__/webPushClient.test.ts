import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'

const KEY = Buffer.alloc(65, 7)
const KEY_B64 = KEY.toString('base64url')

// modül durumu (kullanıcı, etkin bayrak) testler arasında taşınmasın
let m: typeof import('../webPushClient')

type Sub = { endpoint: string; options: { applicationServerKey: ArrayBuffer | null }; toJSON(): unknown; unsubscribe: ReturnType<typeof vi.fn> }

function fakeSub(endpoint: string, key: Uint8Array = KEY): Sub {
  return {
    endpoint,
    options: { applicationServerKey: new Uint8Array(key).buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => true)
  }
}

function env(o: { ua?: string; permission?: string; answer?: string; sub?: Sub | null; standalone?: boolean; noSw?: boolean; devices?: unknown[]; subscribeFails?: boolean; postStatus?: number } = {}) {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k)
  })
  class N {
    static permission = o.permission ?? 'granted'
    static requestPermission = vi.fn(async () => {
      N.permission = o.answer ?? 'granted'
      return N.permission
    })
  }
  vi.stubGlobal('Notification', N)
  const shown = [{ close: vi.fn() }]
  const pm = {
    sub: o.sub ?? null,
    getSubscription: vi.fn(async () => pm.sub),
    subscribe: vi.fn(async () => {
      if (o.subscribeFails) throw new Error('push servisi yok')
      pm.sub = fakeSub('https://fcm.googleapis.com/fcm/send/yeni')
      return pm.sub
    })
  }
  const reg = { pushManager: pm, getNotifications: vi.fn(async () => shown) }
  vi.stubGlobal('navigator', {
    userAgent: o.ua ?? CHROME, maxTouchPoints: 0, standalone: o.standalone,
    ...(o.noSw ? {} : { serviceWorker: { ready: Promise.resolve(reg), getRegistration: vi.fn(async () => reg) } })
  })
  vi.stubGlobal('window', { PushManager: class {}, matchMedia: () => ({ matches: false }) })
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = []
  const state = { devices: o.devices, devicesDown: false, postStatus: o.postStatus }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ path, method, body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined })
    if (path === '/api/push/key') return new Response(JSON.stringify({ publicKey: KEY_B64 }), { status: 200 })
    if (path === '/api/push/devices') {
      if (state.devicesDown) throw new TypeError('ağ')
      return new Response(JSON.stringify({ devices: state.devices ?? (pm.sub ? [{ id: 1, current: true }] : []) }), { status: 200 })
    }
    if (method === 'POST') return new Response('{}', { status: state.postStatus ?? 200 })
    return new Response(null, { status: 204 })
  }))
  return { pm, reg, N, calls, store, shown, state, posted: () => calls.filter((c) => c.path === '/api/push/subscribe') }
}

beforeEach(async () => {
  vi.resetModules()
  m = await import('../webPushClient')
})
afterEach(() => vi.unstubAllGlobals())

describe('pushSupport', () => {
  it('masaüstü ve Android Chrome: ok', () => {
    env()
    expect(m.pushSupport()).toBe('ok')
    env({ ua: ANDROID })
    expect(m.pushSupport()).toBe('ok')
  })

  it('needsInstall on iOS tab', () => {
    env({ ua: IPHONE, standalone: false })
    expect(m.pushSupport()).toBe('needsInstall')
  })

  it('iOS ana ekrana eklenmiş: ok', () => {
    env({ ua: IPHONE, standalone: true })
    expect(m.pushSupport()).toBe('ok')
  })

  it('iPadOS kendini Mac gösterir: dokunma sayısından anlaşılır', () => {
    env({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', standalone: false })
    vi.stubGlobal('navigator', { ...navigator, maxTouchPoints: 5 })
    expect(m.pushSupport()).toBe('needsInstall')
  })

  it('service worker yoksa unsupported', () => {
    env({ noSw: true })
    expect(m.pushSupport()).toBe('unsupported')
  })
})

describe('enablePush', () => {
  it('izin ister, abone olur, sunucuya kaydeder', async () => {
    const e = env({ permission: 'default' })
    m.setPushUser(5)
    expect(await m.enablePush()).toBe('on')
    expect(e.N.requestPermission).toHaveBeenCalled()
    const [opts] = e.pm.subscribe.mock.calls[0] as unknown as [{ userVisibleOnly: boolean; applicationServerKey: Uint8Array }]
    expect(opts.userVisibleOnly).toBe(true)
    expect(Buffer.from(opts.applicationServerKey).equals(KEY)).toBe(true)
    expect(e.posted()[0].body).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/yeni', keys: { p256dh: 'p', auth: 'a' } })
  })

  it('izin reddedilirse abonelik yok', async () => {
    const e = env({ permission: 'default', answer: 'denied' })
    m.setPushUser(5)
    expect(await m.enablePush()).toBe('denied')
    expect(e.pm.subscribe).not.toHaveBeenCalled()
  })

  it('iOS sekmesinde unsupported, izin sorulmaz', async () => {
    const e = env({ ua: IPHONE, standalone: false, permission: 'default' })
    m.setPushUser(5)
    expect(await m.enablePush()).toBe('unsupported')
    expect(e.N.requestPermission).not.toHaveBeenCalled()
  })

  it('abonelik başarısız: failed', async () => {
    env({ subscribeFails: true })
    m.setPushUser(5)
    expect(await m.enablePush()).toBe('failed')
  })

  it('sunucu reddederse tarayıcıda abonelik kalmaz', async () => {
    const e = env({ postStatus: 400 })
    m.setPushUser(5)
    expect(await m.enablePush()).toBe('failed')
    expect(e.pm.sub?.unsubscribe).toHaveBeenCalled()
  })
})

describe('resyncPush', () => {
  it('resync re-registers changed subscription', async () => {
    const e = env()
    m.setPushUser(5)
    await m.enablePush()
    e.calls.length = 0
    e.pm.sub = fakeSub('https://fcm.googleapis.com/fcm/send/degisti')
    await m.resyncPush()
    expect(e.posted()[0].body).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/degisti' })
  })

  it('oturum açılınca çıkışta iptal edilen abonelik yeniden kurulur', async () => {
    const e = env()
    m.setPushUser(5)
    await m.enablePush()
    await m.suspendPush()
    e.pm.sub = null
    e.calls.length = 0
    m.setPushUser(5)
    await m.resyncPush()
    expect(e.pm.subscribe).toHaveBeenCalledTimes(2)
    expect(e.posted()).toHaveLength(1)
  })

  it('başka kullanıcı girer: önceki kullanıcının tercihi ona geçmez, kalan abonelik iptal edilir', async () => {
    const e = env()
    m.setPushUser(5)
    await m.enablePush()
    const left = e.pm.sub!
    e.calls.length = 0
    m.setPushUser(6)
    await m.resyncPush()
    expect(left.unsubscribe).toHaveBeenCalled()
    expect(e.posted()).toHaveLength(0)
  })

  it('VAPID anahtarı değişmiş: abonelik yenilenir', async () => {
    const e = env()
    m.setPushUser(5)
    await m.enablePush()
    const old = fakeSub('https://fcm.googleapis.com/fcm/send/eski', Buffer.alloc(65, 9))
    e.pm.sub = old
    e.calls.length = 0
    await m.resyncPush()
    expect(old.unsubscribe).toHaveBeenCalled()
    expect(e.posted()[0].body).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/yeni' })
  })

  it('izin geri alındıysa kayıt yok', async () => {
    const e = env()
    m.setPushUser(5)
    await m.enablePush()
    e.N.permission = 'denied'
    e.calls.length = 0
    await m.resyncPush()
    expect(e.posted()).toHaveLength(0)
  })

  it("izin yoksa pushManager'a gidilmez", async () => {
    const e = env({ permission: 'default' })
    m.setPushUser(5)
    await m.resyncPush()
    await m.suspendPush()
    expect(await m.pushEnabled()).toBe(false)
    expect(e.pm.getSubscription).not.toHaveBeenCalled()
  })

  it('ağ hatası sessiz: fırlatmaz, sekme içi bildirim sürer', async () => {
    env()
    m.setPushUser(5)
    await m.enablePush()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('ağ') }))
    await expect(m.resyncPush()).resolves.toBeUndefined()
  })
})

describe('geçici sunucu hatası', () => {
  it('resync 5xx ve 429 sağlam aboneliği öldürmez', async () => {
    for (const status of [500, 503, 429]) {
      const e = env()
      m.setPushUser(5)
      await m.enablePush()
      const sub = e.pm.sub!
      e.state.postStatus = status
      await m.resyncPush()
      expect(sub.unsubscribe).not.toHaveBeenCalled()
    }
  })

  it('resync 4xx kayıtsız aboneliği kaldırır', async () => {
    const e = env()
    m.setPushUser(5)
    await m.enablePush()
    const sub = e.pm.sub!
    e.state.postStatus = 400
    await m.resyncPush()
    expect(sub.unsubscribe).toHaveBeenCalled()
  })
})

describe('asılı işlem', () => {
  it('asılı subscribe kuyruğu kilitlemez, anahtar failed görür; geç gelen abonelik kalmaz', async () => {
    vi.useFakeTimers()
    try {
      const e = env()
      m.setPushUser(5)
      let finish!: (s: Sub) => void
      e.pm.subscribe.mockImplementationOnce(() => new Promise((r) => (finish = r)) as never)
      const first = m.enablePush()
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(first).resolves.toBe('failed')
      const late = fakeSub('https://fcm.googleapis.com/fcm/send/gec')
      finish(late)
      await vi.advanceTimersByTimeAsync(0)
      expect(late.unsubscribe).toHaveBeenCalled()
      expect(e.posted()).toHaveLength(0)
      await expect(m.enablePush()).resolves.toBe('on') // kuyruk açık
    } finally {
      vi.useRealTimers()
    }
  })

  it('asılı resync sonrası kapatma çalışır', async () => {
    vi.useFakeTimers()
    try {
      const e = env()
      m.setPushUser(5)
      await m.enablePush()
      e.pm.getSubscription.mockImplementationOnce(() => new Promise(() => {}) as never)
      void m.resyncPush()
      const sub = e.pm.sub!
      const off = m.disablePush()
      await vi.advanceTimersByTimeAsync(15_000)
      await off
      expect(sub.unsubscribe).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('oturumsuz açılış ve kullanıcı değişimi', () => {
  it('oturumsuz açılış: kalan abonelik iptal edilir, görünen bildirimler kapanır, sunucuya gidilmez', async () => {
    const e = env()
    m.setPushUser(5)
    await m.enablePush()
    const sub = e.pm.sub!
    e.calls.length = 0
    m.setPushUser(null)
    await m.resyncPush()
    expect(sub.unsubscribe).toHaveBeenCalled()
    expect(e.shown[0].close).toHaveBeenCalled()
    expect(e.calls).toEqual([])
    expect(e.store.get('gecko-push-wanted:5')).toBe('1') // tercih durur
  })

  it('aynı kullanıcı yeniden açınca bildirimler kapanmaz', async () => {
    const e = env()
    m.setPushUser(5)
    await m.enablePush()
    await m.resyncPush()
    await m.resyncPush()
    expect(e.shown[0].close).not.toHaveBeenCalled()
  })

  it('kullanıcı değişince öncekinin bildirimleri kapanır (ikisi de push istese bile)', async () => {
    const e = env()
    m.setPushUser(5)
    await m.resyncPush()
    await m.enablePush()
    m.setPushUser(6)
    await m.enablePush()
    expect(e.shown[0].close).not.toHaveBeenCalled()
    await m.resyncPush()
    expect(e.shown[0].close).toHaveBeenCalled()
    expect(e.posted().length).toBeGreaterThan(1)
  })
})

describe('kapatma', () => {
  it('disablePush: bu cihazın kaydı silinir, abonelik iptal, tercih kalkar', async () => {
    const e = env({ devices: [{ id: 3, current: false }, { id: 4, current: true }] })
    m.setPushUser(5)
    await m.enablePush()
    const sub = e.pm.sub!
    await m.disablePush()
    expect(e.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/api/push/devices/4'])
    expect(sub.unsubscribe).toHaveBeenCalled()
    e.pm.sub = null
    e.calls.length = 0
    await m.resyncPush()
    expect(e.posted()).toHaveLength(0) // kullanıcı kapattı: yeniden kaydolmaz
  })

  it('suspendPush: abonelik iptal, görünen bildirimler kapanır, sunucuya gidilmez', async () => {
    const e = env()
    m.setPushUser(5)
    await m.enablePush()
    const sub = e.pm.sub!
    e.calls.length = 0
    await m.suspendPush()
    expect(sub.unsubscribe).toHaveBeenCalled()
    expect(e.shown[0].close).toHaveBeenCalled()
    expect(e.calls).toEqual([])
  })

  it('suspendPush asılı push servisini beklemez: sayfa yenilenebilsin', async () => {
    vi.useFakeTimers()
    try {
      const e = env()
      m.setPushUser(5)
      e.pm.sub = fakeSub('https://fcm.googleapis.com/fcm/send/x')
      e.pm.sub.unsubscribe.mockImplementation(() => new Promise(() => {}))
      const done = m.suspendPush()
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(done).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('push desteklenmiyorsa suspendPush sorun çıkarmaz', async () => {
    env({ noSw: true })
    await expect(m.suspendPush()).resolves.toBeUndefined()
  })
})

describe('pushEnabled', () => {
  it('abonelik ve tercih varsa açık', async () => {
    const e = env()
    m.setPushUser(5)
    expect(await m.pushEnabled()).toBe(false)
    await m.enablePush()
    expect(await m.pushEnabled()).toBe(true)
    e.pm.sub = null
    expect(await m.pushEnabled()).toBe(false)
  })

  it('sunucudaki kayıt düşmüşse (410, başka cihazdan silme) kapalı görünür', async () => {
    const e = env()
    m.setPushUser(5)
    await m.enablePush()
    e.state.devices = [{ id: 9, current: false }]
    expect(await m.pushEnabled()).toBe(false)
  })

  it('sunucuya sorulamazsa yerel bilgi geçerli', async () => {
    const e = env()
    m.setPushUser(5)
    await m.enablePush()
    e.state.devicesDown = true
    expect(await m.pushEnabled()).toBe(true)
  })
})

describe('durum değişikliği olayı', () => {
  it('açma ve kapatma dinleyiciye bildirilir, abonelik bitince bildirilmez', async () => {
    env()
    m.setPushUser(5)
    const cb = vi.fn()
    const off = m.onPushChange(cb)
    await m.enablePush()
    expect(cb).toHaveBeenCalledTimes(1)
    await m.disablePush()
    expect(cb).toHaveBeenCalledTimes(2)
    off()
    await m.enablePush()
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('başarısız açma bildirilmez', async () => {
    env({ subscribeFails: true })
    m.setPushUser(5)
    const cb = vi.fn()
    m.onPushChange(cb)
    await m.enablePush()
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('derin bağlantı', () => {
  it('ileti ve yanıt', () => {
    expect(m.parseDeepLink('?m=42')).toEqual({ messageId: 42, accountId: null, reply: false })
    expect(m.parseDeepLink('?reply=42')).toEqual({ messageId: 42, accountId: null, reply: true })
  })

  it('bozuk değer yok sayılır', () => {
    for (const s of ['', '?m=', '?m=abc', '?m=-1', '?m=1e3', '?reply=99999999999999999999', '?mode=wallboard']) expect(m.parseDeepLink(s)).toBeNull()
  })

  it('service worker iletisi', () => {
    expect(m.parseSwMessage({ type: 'open-message', messageId: 9, accountId: 3 })).toEqual({ messageId: 9, accountId: 3, reply: false })
    expect(m.parseSwMessage({ type: 'open-reply', messageId: 9, accountId: 3 })).toEqual({ messageId: 9, accountId: 3, reply: true })
    expect(m.parseSwMessage({ type: 'open-message', messageId: null, accountId: 3 })).toEqual({ messageId: null, accountId: 3, reply: false })
    for (const v of ['gecko-shell-on', null, { type: 'x', messageId: 1 }, { type: 'open-message', messageId: 'a' }, { type: 'open-message', messageId: null, accountId: null }])
      expect(m.parseSwMessage(v)).toBeNull()
  })
})
