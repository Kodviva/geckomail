import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, Notification: class {}, BrowserWindow: class {} }))
vi.mock('../windows', () => ({ openLink: vi.fn() }))

import { EventEmitter } from 'events'
import { deepLinkPath, OpenQueue, trackNavigation, type OpenLink } from '../openQueue'
import { keepBounded, macActions, routeActivation, routeToast } from '../notifications'

const labels = { read: 'Okundu', archive: 'Arşivle', reply: 'Yanıtla' }
const link = (messageId: number, reply = false): OpenLink => ({ messageId, accountId: 3, reply })

describe('macActions', () => {
  it('sıra korunur: actionIndex aynı diziye eşlenir', () => {
    expect(macActions(['read', 'reply'], labels)).toEqual([{ type: 'button', text: 'Okundu' }, { type: 'button', text: 'Yanıtla' }])
    expect(macActions([], labels)).toEqual([])
  })
})

describe('routeActivation', () => {
  const deps = (ok: boolean | Error = true) => ({
    exec: vi.fn(async () => { if (ok instanceof Error) throw ok; return ok }),
    open: vi.fn()
  })
  it('okundu ve arşiv pencere açmaz', async () => {
    const d = deps()
    await routeActivation({ action: 'read', messageId: 7, accountId: 3 }, d)
    await routeActivation({ action: 'archive', messageId: 7, accountId: 3 }, d)
    expect(d.exec.mock.calls).toEqual([[{ action: 'read', messageId: 7 }], [{ action: 'archive', messageId: 7 }]])
    expect(d.open).not.toHaveBeenCalled()
  })
  it('eylem yapılamazsa ileti açılır: kilitli kasa, yetki yok, bağlantı yok', async () => {
    for (const r of [false, new Error('bağlantı yok')]) {
      const d = deps(r)
      await routeActivation({ action: 'archive', messageId: 7, accountId: 3 }, d)
      expect(d.open).toHaveBeenCalledWith({ messageId: 7, accountId: 3, reply: false })
    }
  })
  it('yanıtla yazma penceresini açar, eylem yapmaz', async () => {
    const d = deps()
    await routeActivation({ action: 'reply', messageId: 7, accountId: 3 }, d)
    expect(d.open).toHaveBeenCalledWith({ messageId: 7, accountId: 3, reply: true })
    expect(d.exec).not.toHaveBeenCalled()
  })
  it('iletisiz özet hesabı açar', async () => {
    const d = deps()
    await routeActivation({ action: 'read', messageId: null, accountId: 3 }, d)
    expect(d.exec).not.toHaveBeenCalled()
    expect(d.open).toHaveBeenCalledWith({ messageId: null, accountId: 3, reply: false })
  })
})

describe('routeToast', () => {
  const deps = () => ({ exec: vi.fn(async () => true), open: vi.fn() })
  it('cold start never writes', async () => {
    const d = deps()
    await routeToast('gecko:archive:7:3', true, d)
    await routeToast('gecko:read:7:3', true, d)
    expect(d.exec).not.toHaveBeenCalled()
    expect(d.open).toHaveBeenCalledTimes(2)
    expect(d.open).toHaveBeenCalledWith({ messageId: 7, accountId: 3, reply: false })
  })
  it('soğuk başlangıçta yanıtla yine oluşturucuyu açar', async () => {
    const d = deps()
    await routeToast('gecko:reply:7:3', true, d)
    expect(d.open).toHaveBeenCalledWith({ messageId: 7, accountId: 3, reply: true })
  })
  it('sıcakta eylem yapılır, bozuk argüman yok sayılır', async () => {
    const d = deps()
    await routeToast('gecko:archive:7:3', false, d)
    expect(d.exec).toHaveBeenCalledWith({ action: 'archive', messageId: 7 })
    await routeToast('gecko:archive:<x>:3', false, d)
    await routeToast('dismiss', false, d)
    expect(d.exec).toHaveBeenCalledTimes(1)
    expect(d.open).not.toHaveBeenCalled()
  })
})

describe('OpenQueue', () => {
  it('open queued until ready', () => {
    const q = new OpenQueue()
    q.push(link(1))
    q.push(link(2))
    const sent: OpenLink[] = []
    q.ready((l) => sent.push(l))
    expect(sent.map((l) => l.messageId)).toEqual([1, 2])
    q.push(link(3))
    expect(sent.map((l) => l.messageId)).toEqual([1, 2, 3])
  })
  it('click with no window opens message', () => {
    // pencere yeni kuruluyor: yükleme başlangıcı bekleyeni silmez, renderer girişten sonra hazır der
    const q = new OpenQueue()
    q.push(link(9))
    q.pause()
    const sent: OpenLink[] = []
    q.ready((l) => sent.push(l))
    expect(sent).toEqual([link(9)])
  })
  it('pause sonrası hazır olmayan sayfaya gönderilmez', () => {
    const q = new OpenQueue()
    const sent: OpenLink[] = []
    q.ready((l) => sent.push(l))
    q.pause()
    q.push(link(4))
    expect(sent).toEqual([])
    q.ready((l) => sent.push(l))
    expect(sent).toEqual([link(4)])
  })
  it('reset on sign out', () => {
    const q = new OpenQueue()
    q.push(link(1))
    q.reset()
    const sent: OpenLink[] = []
    q.ready((l) => sent.push(l))
    expect(sent).toEqual([]) // sonraki kullanıcı öncekinin iletisini görmez
    q.reset()
    q.push(link(2))
    expect(sent).toEqual([])
  })
})

describe('deepLinkPath', () => {
  it('Parça 3 derin bağlantısı', () => {
    expect(deepLinkPath(link(9))).toBe('/?m=9')
    expect(deepLinkPath(link(9, true))).toBe('/?reply=9')
    expect(deepLinkPath({ messageId: null, accountId: 3, reply: false })).toBeNull()
  })
})

describe('sayfa geçişi ve bekleyen tıklama', () => {
  const setup = () => {
    const wc = new EventEmitter()
    const q = new OpenQueue()
    const sent: OpenLink[] = []
    trackNavigation(wc as never, q)
    q.ready((l) => sent.push(l))
    return { wc, q, sent }
  }
  it('alt çerçeve yüklemesi kuyruğu durdurmaz: posta iframe\'inden sonra tıklama ileti açar', () => {
    const { wc, q, sent } = setup()
    wc.emit('did-start-loading')
    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    wc.emit('did-stop-loading')
    q.push(link(1))
    expect(sent).toEqual([link(1)])
  })
  it('aynı belge gezinmesi durdurmaz', () => {
    const { wc, q, sent } = setup()
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    q.push(link(1))
    expect(sent).toEqual([link(1)])
  })
  it('ana çerçeve yeniden yüklenince bekler, hazır olunca gider', () => {
    const { wc, q, sent } = setup()
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    q.push(link(1))
    expect(sent).toEqual([])
    wc.emit('did-navigate')
    wc.emit('did-stop-loading')
    q.push(link(2))
    expect(sent).toEqual([])
    q.ready((l) => sent.push(l))
    expect(sent).toEqual([link(1), link(2)])
  })
  it('engellenen gezinme sayfayı değiştirmez: kuyruk geri açılır', () => {
    const { wc, q, sent } = setup()
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }) // will-navigate engeller, commit olmaz
    q.push(link(1))
    wc.emit('did-stop-loading')
    expect(sent).toEqual([link(1)])
    q.push(link(2))
    expect(sent).toEqual([link(1), link(2)])
  })
  it('çıkış sonrası engellenen gezinme eski göndericiyi canlandırmaz', () => {
    const { wc, q, sent } = setup()
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    q.reset()
    wc.emit('did-stop-loading')
    q.push(link(1))
    expect(sent).toEqual([])
  })
})

describe('keepBounded', () => {
  it('en eskiyi bırakır: kapanış olayı gelmeyen bildirim birikmez', () => {
    const live = new Set<number>()
    for (let i = 0; i < 60; i++) keepBounded(live, i, 50)
    expect(live.size).toBe(50)
    expect(live.has(9)).toBe(false)
    expect(live.has(59)).toBe(true)
  })
})
