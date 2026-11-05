import { describe, expect, it, vi } from 'vitest'
import type { PushPayload } from '../../../shared/pushTypes'
import { actionsFor, alwaysShows, clickPlan, deviceLabel, handlePush, notificationOptions, parsePush, renewSubscription, runClick, shouldShow } from '../swPush'

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0'
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'

const ACTIONS: PushPayload['actions'] = [
  { action: 'read', title: 'Okundu' }, { action: 'archive', title: 'Arşivle' }, { action: 'reply', title: 'Yanıtla' }
]
const one: PushPayload = { title: 'Ali', body: 'Konu', accountId: 3, messageId: 9, level: 'normal', tag: 'abc123', count: 1, actions: ACTIONS }
const summary: PushPayload = { ...one, messageId: null, count: 12, actions: [] }

describe('gösterim kararı', () => {
  const focused = [{ focused: true, visibilityState: 'visible' }]

  it('focused client suppresses', () => {
    expect(shouldShow(focused, CHROME)).toBe(false)
    expect(shouldShow(focused, FIREFOX)).toBe(false)
    expect(shouldShow(focused, ANDROID)).toBe(false)
  })

  it('ios shows anyway: sessiz push Apple tarafında aboneliği düşürür', () => {
    expect(shouldShow(focused, IPHONE)).toBe(true)
    expect(shouldShow(focused, SAFARI)).toBe(true)
    expect(alwaysShows(IPHONE)).toBe(true)
    expect(alwaysShows(CHROME)).toBe(false)
  })

  it('odaksız ya da görünmez pencere bastırmaz, pencere yoksa gösterilir', () => {
    expect(shouldShow([], CHROME)).toBe(true)
    expect(shouldShow([{ focused: false, visibilityState: 'visible' }], CHROME)).toBe(true)
    expect(shouldShow([{ focused: true, visibilityState: 'hidden' }], CHROME)).toBe(true)
  })
})

describe('bildirim seçenekleri', () => {
  it('etiket, gövde, veri ve eylemler yükten', () => {
    const o = notificationOptions(one)
    expect(o).toMatchObject({ body: 'Konu', tag: 'abc123', renotify: true, requireInteraction: false, data: { messageId: 9, accountId: 3 } })
    expect(o.actions.map((a) => a.action)).toEqual(['read', 'archive', 'reply'])
    expect(o.actions[0].title).toBe('Okundu')
  })

  it('aynı olay zaten görünüyorsa ikinci kez ses çıkmaz', () => {
    expect(notificationOptions(one, true).renotify).toBe(false)
  })

  it('acil seviye kapanmaz', () => {
    expect(notificationOptions({ ...one, level: 'urgent' }).requireInteraction).toBe(true)
  })

  it('özet bildirimde eylem yok', () => {
    expect(actionsFor(summary)).toEqual([])
    // ileti kimliği yoksa yük eylem taşısa da gösterilmez
    expect(actionsFor({ ...summary, actions: ACTIONS })).toEqual([])
  })

  it('tanınmayan eylem düşer', () => {
    const odd = [...ACTIONS, { action: 'sil', title: 'Sil' }] as unknown as PushPayload['actions']
    expect(actionsFor({ ...one, actions: odd })).toHaveLength(3)
  })
})

describe('yük ayrıştırma', () => {
  const data = (v: unknown): { json(): unknown } => ({ json: () => v })

  it('geçerli yük', () => {
    expect(parsePush(data(one))).toEqual(one)
  })

  it('eylem listesi yoksa boş sayılır', () => {
    const { actions: _a, ...rest } = one
    expect(parsePush(data(rest))?.actions).toEqual([])
  })

  it('boş, bozuk ya da eksik yük: null', () => {
    expect(parsePush(null)).toBeNull()
    expect(parsePush({ json: () => { throw new SyntaxError('x') } })).toBeNull()
    expect(parsePush(data({ title: 1 }))).toBeNull()
    expect(parsePush(data({ title: 'a', body: 'b' }))).toBeNull()
  })

  it('eylem öğeleri doğrulanır: bozuk öğe düşer', () => {
    const actions = [{ action: 'read', title: 'Okundu' }, { action: 'sil', title: 'Sil' }, { action: 'archive', title: 1 }, null, 'reply']
    expect(parsePush(data({ ...one, actions }))?.actions).toEqual([{ action: 'read', title: 'Okundu' }])
  })

  it('kimlik ya da seviye türü bozuksa: null', () => {
    expect(parsePush(data({ ...one, messageId: '9' }))).toBeNull()
    expect(parsePush(data({ ...one, accountId: {} }))).toBeNull()
    expect(parsePush(data({ ...one, messageId: 1.5 }))).toBeNull()
    expect(parsePush(data({ ...one, level: 'cok-acil' }))).toBeNull()
  })

  it('özet yükte kimlikler null', () => {
    expect(parsePush(data({ ...summary, accountId: null }))).toMatchObject({ messageId: null, accountId: null })
  })
})

describe('push işleme', () => {
  const data = (v: unknown): { json(): unknown } => ({ json: () => v })
  const deps = (o: { ua?: string; focused?: boolean; shown?: { title: string; body: string }[]; showFails?: boolean } = {}) => {
    const show = vi.fn(async (_t: string, _o: NotificationOptions) => {
      if (o.showFails && show.mock.calls.length === 1) throw new TypeError('gösterilemedi')
    })
    return {
      ua: o.ua ?? CHROME, show, shown: vi.fn(async () => o.shown ?? []),
      windows: vi.fn(async () => (o.focused ? [{ focused: true, visibilityState: 'visible' }] : []))
    }
  }

  it('yük gösterilir', async () => {
    const d = deps()
    await handlePush(data(one), d)
    expect(d.shown).toHaveBeenCalledWith('abc123')
    expect(d.show.mock.calls[0][0]).toBe('Ali')
    expect(d.show.mock.calls[0][1]).toMatchObject({ tag: 'abc123', renotify: true })
  })

  it('sekme aynı iletiyi göstermişse ses tekrarlanmaz (kasada başlık farklı olabilir)', async () => {
    const d = deps({ shown: [{ title: 'Yeni posta', body: '' }] })
    await handlePush(data(one), d)
    expect(d.show.mock.calls[0][1]).toMatchObject({ renotify: false })
  })

  it('özet etiketi yeniden kullanılır: içerik değiştiyse yeni olaydır, ses çıkar', async () => {
    const d = deps({ shown: [{ title: 'Ali', body: '3 yeni posta' }] })
    await handlePush(data({ ...summary, body: '5 yeni posta' }), d)
    expect(d.show.mock.calls[0][1]).toMatchObject({ renotify: true })
    const same = deps({ shown: [{ title: 'Ali', body: '5 yeni posta' }] })
    await handlePush(data({ ...summary, body: '5 yeni posta' }), same)
    expect(same.show.mock.calls[0][1]).toMatchObject({ renotify: false })
  })

  describe('gösterim kilidi', () => {
    /** Tarayıcıdaki gibi: istekler sırayla, kilit iş bitince bırakılır */
    const fifo = (): LockManager => {
      let tail: Promise<unknown> = Promise.resolve()
      const names: string[] = []
      return {
        names,
        request: vi.fn((name: string, _o: unknown, cb: () => Promise<unknown>) => {
          names.push(name)
          const run = tail.then(cb, cb)
          tail = run.catch(() => {})
          return run
        })
      } as unknown as LockManager
    }
    /** Chromium yarışı: gösterim sürerken sorgu yeni bildirimi görmez */
    const center = (locks?: LockManager) => {
      const list: { title: string; body: string }[] = []
      const show = vi.fn(async (title: string, o: NotificationOptions) => {
        await new Promise((r) => setTimeout(r, 5))
        list.push({ title, body: o.body ?? '' })
      })
      return { ua: CHROME, locks, show, shown: vi.fn(async () => [...list]), windows: vi.fn(async () => []) }
    }

    it('iki gösterim sıraya girer: ikincisi birincinin bildirimini görür', async () => {
      const d = center(fifo())
      await Promise.all([handlePush(data(one), d), handlePush(data(one), d)])
      expect(d.show.mock.calls.map((c) => (c[1] as { renotify: boolean }).renotify)).toEqual([true, false])
    })

    it('kilit etikete özel', async () => {
      const locks = fifo()
      await handlePush(data(one), center(locks))
      expect((locks as unknown as { names: string[] }).names).toEqual(['gecko-notify:abc123'])
    })

    it('kilit alınamazsa ya da beklemesi dolarsa bildirim yine gösterilir', async () => {
      const locks = { request: vi.fn(async () => { throw new DOMException('süre doldu', 'AbortError') }) } as unknown as LockManager
      const d = center(locks)
      await handlePush(data(one), d)
      expect(d.show).toHaveBeenCalledTimes(1)
    })

    it('gösterim hatası kilit hatası sanılmaz: ikinci kez gösterilmez', async () => {
      const d = center(fifo())
      d.show.mockRejectedValueOnce(new TypeError('gösterilemedi'))
      await expect(handlePush(data(one), d)).rejects.toThrow(TypeError)
      expect(d.show).toHaveBeenCalledTimes(1)
    })
  })

  it('odaklı pencerede gösterilmez', async () => {
    const d = deps({ focused: true })
    await handlePush(data(one), d)
    expect(d.show).not.toHaveBeenCalled()
  })

  it('Apple: bozuk yükte genel bildirim, sessiz push yok', async () => {
    const d = deps({ ua: IPHONE })
    await handlePush(data({ title: 1 }), d)
    expect(d.show).toHaveBeenCalledTimes(1)
    expect(d.show.mock.calls[0][0]).toBe('GeckoMail')
    expect(d.show.mock.calls[0][1]).toMatchObject({ tag: 'fallback' })
    const empty = deps({ ua: SAFARI })
    await handlePush(null, empty)
    expect(empty.show).toHaveBeenCalledTimes(1)
  })

  it('Apple: gösterim reddedilirse ya da sorgu fırlatırsa genel bildirim', async () => {
    const d = deps({ ua: IPHONE, showFails: true })
    await handlePush(data(one), d)
    expect(d.show).toHaveBeenCalledTimes(2)
    expect(d.show.mock.calls[1][1]).toMatchObject({ tag: 'fallback' })
    const q = deps({ ua: IPHONE })
    q.windows.mockRejectedValue(new Error('x'))
    await handlePush(data(one), q)
    expect(q.show).toHaveBeenCalledWith('GeckoMail', expect.objectContaining({ tag: 'fallback' }))
  })

  it('Apple dışında bozuk yük gösterilmez, hata gizlenmez', async () => {
    const d = deps()
    await handlePush(data({ title: 1 }), d)
    expect(d.show).not.toHaveBeenCalled()
    await expect(handlePush(data(one), deps({ showFails: true }))).rejects.toThrow('gösterilemedi')
  })
})

describe('bildirim tıklaması', () => {
  const open = () => vi.fn(async () => {})
  const res = (status: number): { ok: boolean } => ({ ok: status >= 200 && status < 300 })

  it('eylem başarılıysa pencere açılmaz', async () => {
    const d = { post: vi.fn(async () => res(204)), open: open() }
    await runClick('read', { messageId: 9, accountId: 3 }, d)
    expect(d.post).toHaveBeenCalledWith(9, 'read')
    expect(d.open).not.toHaveBeenCalled()
  })

  it('401, 403, 429, 5xx: eylem kaybolmaz, ileti açılır', async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      const d = { post: vi.fn(async () => res(status)), open: open() }
      await runClick('archive', { messageId: 9, accountId: 3 }, d)
      expect(d.open).toHaveBeenCalledWith({ kind: 'open', url: '/?m=9', message: { type: 'open-message', messageId: 9, accountId: 3 } })
    }
  })

  it('ağ hatası: ileti açılır', async () => {
    const d = { post: vi.fn(async () => { throw new TypeError('ağ') }), open: open() }
    await runClick('read', { messageId: 9, accountId: 3 }, d)
    expect(d.open).toHaveBeenCalledTimes(1)
  })

  it('eylemsiz tıklama sunucuya gitmez', async () => {
    const d = { post: vi.fn(async () => res(204)), open: open() }
    await runClick('', { messageId: 9, accountId: 3 }, d)
    expect(d.post).not.toHaveBeenCalled()
    expect(d.open).toHaveBeenCalledTimes(1)
  })
})

describe('cihaz adı', () => {
  it('tarayıcı ve işletim sistemi', () => {
    expect(deviceLabel(FIREFOX)).toBe('Firefox · macOS')
    expect(deviceLabel(ANDROID)).toBe('Chrome · Android')
    expect(deviceLabel(IPHONE)).toBe('Safari · iOS')
    expect(deviceLabel('')).toBe('Web')
  })
})

describe('abonelik yenileme (pushsubscriptionchange)', () => {
  const KEY = new Uint8Array([1, 2, 3, 4]).buffer
  const fresh = { toJSON: () => ({ endpoint: 'https://updates.push.services.mozilla.com/yeni', keys: { p256dh: 'p', auth: 'a' } }) }
  const deps = (o: { postStatus?: number; keyStatus?: number } = {}) => {
    const calls: { path: string; body?: Record<string, unknown> }[] = []
    return {
      calls, label: 'Firefox · Linux', subscribe: vi.fn(async (_o: { userVisibleOnly: boolean; applicationServerKey: ArrayBuffer | Uint8Array }) => fresh),
      fetch: vi.fn(async (path: string, init?: RequestInit) => {
        calls.push({ path, body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined })
        if (path === '/api/push/key') return new Response(JSON.stringify({ publicKey: 'AQIDBA' }), { status: o.keyStatus ?? 200 })
        return new Response('{}', { status: o.postStatus ?? 200 })
      }) as unknown as typeof fetch
    }
  }

  it('anahtar eski abonelikten alınır, yeni abonelik çerezle kaydedilir', async () => {
    const d = deps()
    expect(await renewSubscription({ oldSubscription: { options: { applicationServerKey: KEY } } }, d)).toBe(true)
    expect(d.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: KEY })
    expect(d.calls.map((c) => c.path)).toEqual(['/api/push/subscribe'])
    expect(d.calls[0].body).toMatchObject({ endpoint: 'https://updates.push.services.mozilla.com/yeni', keys: { p256dh: 'p', auth: 'a' }, label: 'Firefox · Linux' })
    const [, init] = (d.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' })
  })

  it('eski abonelik yoksa anahtar sunucudan', async () => {
    const d = deps()
    expect(await renewSubscription({ oldSubscription: null }, d)).toBe(true)
    expect(d.calls[0].path).toBe('/api/push/key')
    const [opts] = d.subscribe.mock.calls[0]
    expect([...(opts.applicationServerKey as Uint8Array)]).toEqual([1, 2, 3, 4])
  })

  it('tarayıcı yeni aboneliği verdiyse yeniden abone olunmaz', async () => {
    const d = deps()
    expect(await renewSubscription({ newSubscription: fresh }, d)).toBe(true)
    expect(d.subscribe).not.toHaveBeenCalled()
    expect(d.calls.map((c) => c.path)).toEqual(['/api/push/subscribe'])
  })

  it('başarısızlık fırlatmaz: açılıştaki resync onarır', async () => {
    expect(await renewSubscription({ oldSubscription: null }, deps({ keyStatus: 401 }))).toBe(false)
    expect(await renewSubscription({ newSubscription: fresh }, deps({ postStatus: 401 }))).toBe(false)
    const d = deps()
    d.subscribe.mockRejectedValue(new Error('izin yok'))
    expect(await renewSubscription({ oldSubscription: { options: { applicationServerKey: KEY } } }, d)).toBe(false)
  })
})

describe('tıklama planı', () => {
  it('eylemsiz tıklama iletiyi açar', () => {
    expect(clickPlan('', { messageId: 9, accountId: 3 })).toEqual({ kind: 'open', url: '/?m=9', message: { type: 'open-message', messageId: 9, accountId: 3 } })
  })

  it('özet tıklaması yalnız pencereyi öne alır', () => {
    expect(clickPlan('', { messageId: null, accountId: null })).toEqual({ kind: 'open', url: '/', message: null })
  })

  it('toplu bildirim tıklaması hesabı açar', () => {
    expect(clickPlan('', { messageId: null, accountId: 3 })).toEqual({ kind: 'open', url: '/', message: { type: 'open-message', messageId: null, accountId: 3 } })
  })

  it('okundu ve arşiv sunucu ucuna gider', () => {
    expect(clickPlan('read', { messageId: 9, accountId: 3 })).toEqual({ kind: 'action', action: 'read', messageId: 9, accountId: 3 })
    expect(clickPlan('archive', { messageId: 9, accountId: 3 })).toEqual({ kind: 'action', action: 'archive', messageId: 9, accountId: 3 })
  })

  it('yanıtla oluşturucuyu açar', () => {
    expect(clickPlan('reply', { messageId: 9, accountId: 3 })).toEqual({ kind: 'open', url: '/?reply=9', message: { type: 'open-reply', messageId: 9, accountId: 3 } })
  })

  it('verisi bozuk bildirim ana sayfayı açar', () => {
    expect(clickPlan('read', undefined)).toEqual({ kind: 'open', url: '/', message: null })
  })
})
