import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// modül durumu (kurucu reddi, canlı bildirimler) testler arasında taşınmasın
let m: typeof import('../webNotify')
beforeEach(async () => {
  vi.resetModules()
  m = await import('../webNotify')
})

type Fake = { title: string; opts: NotificationOptions; onclick: (() => void) | null; close: ReturnType<typeof vi.fn> }

function fakeNotification(permission: string, answer = 'granted') {
  const made: Fake[] = []
  class N {
    static permission = permission
    static requestPermission = vi.fn(async () => {
      N.permission = answer
      return answer
    })
    onclick: (() => void) | null = null
    onclose: (() => void) | null = null
    close = vi.fn()
    constructor(
      readonly title: string,
      readonly opts: NotificationOptions
    ) {
      made.push(this as unknown as Fake)
    }
  }
  vi.stubGlobal('Notification', N)
  return { N, made }
}

const msg = { title: 'Yeni posta', body: 'Ali: <b>merhaba</b>', accountId: 7, messageId: null, level: 'normal' as const, tag: 'new:7', count: 1, actions: [], seq: 1 }

describe('sekme içi bildirim', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k)
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('izin yoksa gösterilmez', () => {
    for (const p of ['default', 'denied']) {
      const { made } = fakeNotification(p)
      m.showServerNotification(msg, { focused: false })
      expect(made).toHaveLength(0)
    }
  })

  it('sekme odaktayken gösterilmez', () => {
    const { made } = fakeNotification('granted')
    m.showServerNotification(msg, { focused: true })
    expect(made).toHaveLength(0)
  })

  it('izin var, sekme arka planda: düz metin gösterilir', () => {
    const { made } = fakeNotification('granted')
    m.showServerNotification(msg, { focused: false })
    expect(made).toHaveLength(1)
    expect(made[0].title).toBe('Yeni posta')
    // içerik HTML olarak yorumlanmaz: olduğu gibi metin alanında gider
    expect(made[0].opts.body).toBe('Ali: <b>merhaba</b>')
  })

  describe("service worker'la gösterim", () => {
    const worker = (o: { reg?: boolean; shown?: { title: string; body: string }[]; showFails?: boolean } = {}) => {
      const reg = {
        showNotification: vi.fn(async () => {
          if (o.showFails) throw new TypeError('gösterilemedi')
        }),
        getNotifications: vi.fn(async () => o.shown ?? [])
      }
      vi.stubGlobal('navigator', { userAgent: 'x', serviceWorker: { getRegistration: vi.fn(async () => (o.reg === false ? undefined : reg)) } })
      return reg
    }
    const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

    it('kayıt ölü olsa da sekme odakta değilken gösterilir: etiket aynı, tıklama verisi SW için', async () => {
      const { made } = fakeNotification('granted')
      const reg = worker()
      m.showServerNotification({ ...msg, messageId: 9 }, { focused: false })
      await settled()
      expect(made).toHaveLength(0)
      expect(reg.getNotifications).toHaveBeenCalledWith({ tag: 'new:7' })
      expect(reg.showNotification).toHaveBeenCalledWith('Yeni posta', expect.objectContaining({
        body: msg.body, tag: 'new:7', renotify: false, data: { messageId: 9, accountId: 7 }
      }))
    })

    it('ana makine bildirimi (hesapsız) gösterilir, tıklama pencereyi öne alır', async () => {
      fakeNotification('granted')
      const reg = worker()
      m.showServerNotification({ ...msg, accountId: null, tag: 'host::x' }, { focused: false })
      await settled()
      expect(reg.showNotification).toHaveBeenCalledWith('Yeni posta', expect.objectContaining({ data: { messageId: null, accountId: null } }))
    })

    it('push aynı olayı göstermişse dokunulmaz: eylem düğmeleri kalır, ses tekrarlanmaz', async () => {
      fakeNotification('granted')
      const reg = worker({ shown: [{ title: 'Yeni posta', body: msg.body }] })
      m.showServerNotification(msg, { focused: false })
      await settled()
      expect(reg.showNotification).not.toHaveBeenCalled()
    })

    it('aynı etiketle yeni içerik: değiştirilir ve duyulur', async () => {
      fakeNotification('granted')
      const reg = worker({ shown: [{ title: 'Yeni posta', body: 'eski sayı' }] })
      m.showServerNotification(msg, { focused: false })
      await settled()
      expect(reg.showNotification).toHaveBeenCalledWith('Yeni posta', expect.objectContaining({ renotify: true }))
    })

    it('sorgu ve gösterim kilit içinde, etikete özel', async () => {
      fakeNotification('granted')
      const reg = worker()
      const order: string[] = []
      const request = vi.fn(async (name: string, _o: unknown, cb: () => Promise<void>) => {
        order.push(`al:${name}`)
        await cb()
        order.push('bırak')
      })
      reg.getNotifications.mockImplementation(async () => (order.push('sorgu'), []))
      reg.showNotification.mockImplementation(async () => void order.push('göster'))
      vi.stubGlobal('navigator', { userAgent: 'x', locks: { request }, serviceWorker: navigator.serviceWorker })
      m.showServerNotification(msg, { focused: false })
      await settled()
      expect(order).toEqual(['al:gecko-notify:new:7', 'sorgu', 'göster', 'bırak'])
    })

    it('kilit alınamazsa bildirim yine gösterilir, sekmeye düşmez', async () => {
      const { made } = fakeNotification('granted')
      const reg = worker()
      vi.stubGlobal('navigator', { userAgent: 'x', locks: { request: vi.fn(async () => { throw new DOMException('süre doldu', 'AbortError') }) }, serviceWorker: navigator.serviceWorker })
      m.showServerNotification(msg, { focused: false })
      await settled()
      expect(reg.showNotification).toHaveBeenCalledTimes(1)
      expect(made).toHaveLength(0)
    })

    it('çıkışta service worker bildirimleri de kapanır', async () => {
      fakeNotification('granted')
      const close = vi.fn()
      const reg = worker()
      reg.getNotifications.mockResolvedValue([{ title: 'a', body: 'b', close }] as never)
      m.closeServerNotifications()
      await settled()
      expect(close).toHaveBeenCalled()
    })

    it('odakta ya da izinsizken gösterilmez', async () => {
      fakeNotification('granted')
      const reg = worker()
      m.showServerNotification(msg, { focused: true })
      m.disableWebNotify()
      m.showServerNotification(msg, { focused: false })
      await settled()
      expect(reg.showNotification).not.toHaveBeenCalled()
    })

    it('kayıt yoksa ya da SW gösteremezse sekmeden gösterilir', async () => {
      const { made } = fakeNotification('granted')
      worker({ reg: false })
      m.showServerNotification(msg, { focused: false })
      await settled()
      expect(made).toHaveLength(1)
      worker({ showFails: true })
      m.showServerNotification(msg, { focused: false })
      await settled()
      expect(made).toHaveLength(2)
    })
  })

  it('etiket sunucudan: iki sekme ve push aynı bildirime düşer', () => {
    const { made } = fakeNotification('granted')
    m.showServerNotification(msg, { focused: false })
    expect(made[0].opts.tag).toBe('new:7')
  })

  it('tıklanınca pencereye odak, bildirim kapanır, hesap açılır', () => {
    const { made } = fakeNotification('granted')
    const focus = vi.fn()
    vi.stubGlobal('window', { focus })
    const onOpen = vi.fn()
    m.showServerNotification(msg, { focused: false, onOpen })
    made[0].onclick!()
    expect(focus).toHaveBeenCalled()
    expect(made[0].close).toHaveBeenCalled()
    expect(onOpen).toHaveBeenCalledWith(7, null)
  })

  it('hesapsız bildirimde tıklama yalnız odaklar', () => {
    const { made } = fakeNotification('granted')
    vi.stubGlobal('window', { focus: vi.fn() })
    const onOpen = vi.fn()
    m.showServerNotification({ ...msg, accountId: null }, { focused: false, onOpen })
    made[0].onclick!()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('Notification olmayan tarayıcıda ya da kurucu reddederse çökmez', () => {
    expect(() => m.showServerNotification(msg, { focused: false })).not.toThrow()
    expect(m.webNotifyState()).toBe('unsupported')
    // Android Chrome: new Notification TypeError atar
    class Illegal {
      static permission = 'granted'
      constructor() {
        throw new TypeError('Illegal constructor')
      }
    }
    vi.stubGlobal('Notification', Illegal)
    expect(() => m.showServerNotification(msg, { focused: false })).not.toThrow()
  })

  it('kurucu reddederse durum unsupported olur: anahtar "açık" göstermez, izin sorulmaz', async () => {
    const requestPermission = vi.fn(async () => 'granted')
    class Illegal {
      static permission = 'granted'
      static requestPermission = requestPermission
      constructor() {
        throw new TypeError('Illegal constructor')
      }
    }
    vi.stubGlobal('Notification', Illegal)
    expect(m.webNotifyState()).toBe('on')
    m.showServerNotification(msg, { focused: false })
    expect(m.webNotifyState()).toBe('unsupported')
    expect(await m.enableWebNotify()).toBe('unsupported')
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('Android Chrome baştan unsupported; Android Firefox ve masaüstü değil', () => {
    const { N } = fakeNotification('granted')
    expect(N.permission).toBe('granted')
    const ua = (userAgent: string) => vi.stubGlobal('navigator', { userAgent })
    ua('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36')
    expect(m.webNotifyState()).toBe('unsupported')
    ua('Mozilla/5.0 (Android 14; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0')
    expect(m.webNotifyState()).toBe('on')
    ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36')
    expect(m.webNotifyState()).toBe('on')
  })

  it('çıkışta görünen bildirimler kapanır; tıklanmış ya da kapanmış olan bir daha kapatılmaz', () => {
    const { made } = fakeNotification('granted')
    vi.stubGlobal('window', { focus: vi.fn() })
    m.showServerNotification({ ...msg, title: 'a' }, { focused: false })
    m.showServerNotification({ ...msg, title: 'b' }, { focused: false })
    m.showServerNotification({ ...msg, title: 'c' }, { focused: false })
    made[0].onclick!()
    ;(made[1] as unknown as { onclose: () => void }).onclose()
    made[0].close.mockClear()
    m.closeServerNotifications()
    expect(made[0].close).not.toHaveBeenCalled()
    expect(made[1].close).not.toHaveBeenCalled()
    expect(made[2].close).toHaveBeenCalledTimes(1)
    m.closeServerNotifications()
    expect(made[2].close).toHaveBeenCalledTimes(1)
  })

  it('izin yalnız enableWebNotify ile istenir; kapatılınca gösterilmez', async () => {
    const { N, made } = fakeNotification('default')
    expect(m.webNotifyState()).toBe('default')
    m.showServerNotification(msg, { focused: false })
    expect(N.requestPermission).not.toHaveBeenCalled()

    expect(await m.enableWebNotify()).toBe('on')
    expect(N.requestPermission).toHaveBeenCalledTimes(1)

    m.disableWebNotify()
    expect(m.webNotifyState()).toBe('off')
    m.showServerNotification(msg, { focused: false })
    expect(made).toHaveLength(0)

    expect(await m.enableWebNotify()).toBe('on')
    expect(N.requestPermission).toHaveBeenCalledTimes(1) // izin zaten var: yeniden sorulmaz
    m.showServerNotification(msg, { focused: false })
    expect(made).toHaveLength(1)
  })

  it('kullanıcı reddederse durum denied', async () => {
    fakeNotification('default', 'denied')
    expect(await m.enableWebNotify()).toBe('denied')
  })
})

describe('okunmamış rozeti', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('başlık (3) GeckoMail, sıfırda sade', () => {
    const doc = { title: '' }
    vi.stubGlobal('document', doc)
    vi.stubGlobal('navigator', {})
    m.updateUnreadBadge(3)
    expect(doc.title).toBe('(3) GeckoMail')
    m.updateUnreadBadge(0)
    expect(doc.title).toBe('GeckoMail')
  })

  it('setAppBadge varsa sayı verilir, sıfırda temizlenir', () => {
    vi.stubGlobal('document', { title: '' })
    const setAppBadge = vi.fn(async () => {})
    const clearAppBadge = vi.fn(async () => {})
    vi.stubGlobal('navigator', { setAppBadge, clearAppBadge })
    m.updateUnreadBadge(5)
    expect(setAppBadge).toHaveBeenCalledWith(5)
    m.updateUnreadBadge(0)
    expect(clearAppBadge).toHaveBeenCalled()
  })

  it('setAppBadge reddederse sessiz', async () => {
    vi.stubGlobal('document', { title: '' })
    vi.stubGlobal('navigator', { setAppBadge: vi.fn(async () => { throw new Error('izin yok') }) })
    expect(() => m.updateUnreadBadge(1)).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
  })
})
