import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WS_CLOSE_RENEW } from '../../../shared/mobileProtocol'
import { webSocketTransport } from '../transport/webSocket'

// Sahte tarayıcı WebSocket'i: açılış/kapanış testten tetiklenir, gönderilenler dizide
class FakeWs {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static all: FakeWs[] = []
  readyState = FakeWs.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  closedByClient = false
  constructor(readonly url: string, readonly protocols?: string[]) {
    FakeWs.all.push(this)
  }
  send(s: string): void {
    if (this.readyState !== FakeWs.OPEN) throw new Error('InvalidStateError')
    this.sent.push(s)
  }
  close(): void {
    this.closedByClient = true
    this.readyState = FakeWs.CLOSED
  }
  open(): void {
    this.readyState = FakeWs.OPEN
    this.onopen?.()
  }
  drop(code = 1006): void {
    this.readyState = FakeWs.CLOSED
    this.onclose?.({ code })
  }
}

const g = globalThis as unknown as { WebSocket?: unknown }

describe('webSocketTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWs.all = []
    g.WebSocket = FakeWs
  })
  afterEach(() => {
    vi.useRealTimers()
    delete g.WebSocket
  })

  it('yenileme kapanışı sessiz: closed yok, yeni bilet hemen alınır', async () => {
    const states: string[] = []
    const endpoint = vi.fn(async () => ({ url: 'ws://h/rpc', protocols: ['gecko.v1'] }))
    const tr = webSocketTransport(endpoint)
    tr.start(() => {}, (s) => states.push(s))
    await vi.advanceTimersByTimeAsync(0)
    FakeWs.all[0].open()
    FakeWs.all[0].drop(WS_CLOSE_RENEW)
    await vi.advanceTimersByTimeAsync(0)
    expect(endpoint).toHaveBeenCalledTimes(2)
    expect(FakeWs.all).toHaveLength(2)
    FakeWs.all[1].open()
    expect(states).toEqual(['open', 'renewing', 'open'])
    tr.close()
  })

  it('yenileme başarısızsa kopuş bildirilir', async () => {
    const states: string[] = []
    let ok = true
    const tr = webSocketTransport(async () => {
      if (!ok) throw new Error('ağ')
      return { url: 'ws://h/rpc' }
    }, { backoffMs: [100] })
    tr.start(() => {}, (s) => states.push(s))
    await vi.advanceTimersByTimeAsync(0)
    FakeWs.all[0].open()
    ok = false
    FakeWs.all[0].drop(WS_CLOSE_RENEW)
    await vi.advanceTimersByTimeAsync(0)
    expect(states).toEqual(['open', 'renewing', 'closed'])
    tr.close()
  })

  it('kopunca backoff sırasıyla yeniden dener, açılınca sıra başa döner', () => {
    const states: string[] = []
    const tr = webSocketTransport('ws://h/rpc', { backoffMs: [100, 200, 400] })
    tr.start(() => {}, (s) => states.push(s))
    expect(FakeWs.all).toHaveLength(1)
    FakeWs.all[0].open()
    FakeWs.all[0].drop()
    expect(states).toEqual(['open', 'closed'])
    vi.advanceTimersByTime(99)
    expect(FakeWs.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWs.all).toHaveLength(2)
    FakeWs.all[1].drop() // açılmadan düştü: ikinci bekleme
    vi.advanceTimersByTime(199)
    expect(FakeWs.all).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeWs.all).toHaveLength(3)
    FakeWs.all[2].drop()
    vi.advanceTimersByTime(400)
    expect(FakeWs.all).toHaveLength(4)
    FakeWs.all[3].drop() // dizi bitti: son değerde sabit
    vi.advanceTimersByTime(400)
    expect(FakeWs.all).toHaveLength(5)
    // ara denemeler 'closed'ı tekrarlamaz
    expect(states).toEqual(['open', 'closed'])
    FakeWs.all[4].open()
    expect(states).toEqual(['open', 'closed', 'open'])
    FakeWs.all[4].drop()
    vi.advanceTimersByTime(100) // başarılı açılış sırayı sıfırlar
    expect(FakeWs.all).toHaveLength(6)
  })

  it('varsayılan backoff 500,1000,2000,5000,10000 sonra 10000', () => {
    const tr = webSocketTransport('ws://h/rpc')
    tr.start(() => {}, () => {})
    const waits: number[] = []
    for (let i = 0; i < 7; i++) {
      const n = FakeWs.all.length
      FakeWs.all[n - 1].drop()
      let ms = 0
      while (FakeWs.all.length === n) {
        vi.advanceTimersByTime(100)
        ms += 100
      }
      waits.push(ms)
    }
    expect(waits).toEqual([500, 1000, 2000, 5000, 10000, 10000, 10000])
  })

  it('4401 → revoked ve yeniden denemez', () => {
    const states: string[] = []
    const tr = webSocketTransport('ws://h/rpc', { backoffMs: [10] })
    tr.start(() => {}, (s) => states.push(s))
    FakeWs.all[0].open()
    FakeWs.all[0].drop(4401)
    vi.advanceTimersByTime(60_000)
    expect(FakeWs.all).toHaveLength(1)
    expect(states).toEqual(['open', 'revoked'])
  })

  it('send kapalıyken atmaz; açıkken JSON çerçeve yollar; gelen çerçeve ayrıştırılır', () => {
    const got: unknown[] = []
    const tr = webSocketTransport('ws://h/rpc')
    expect(() => tr.send({ id: 1 })).not.toThrow() // başlamadan
    tr.start((m) => got.push(m), () => {})
    expect(() => tr.send({ id: 2 })).not.toThrow() // bağlanıyor
    FakeWs.all[0].open()
    tr.send({ id: 3, method: 'getAccounts', params: {} })
    expect(FakeWs.all[0].sent).toEqual([JSON.stringify({ id: 3, method: 'getAccounts', params: {} })])
    FakeWs.all[0].onmessage?.({ data: '{"event":"sync:hello","data":{}}' })
    FakeWs.all[0].onmessage?.({ data: 'bozuk{' }) // yok sayılır
    expect(got).toEqual([{ event: 'sync:hello', data: {} }])
    FakeWs.all[0].drop()
    expect(() => tr.send({ id: 4 })).not.toThrow()
  })

  it('close sonrası yeniden bağlanmaz ve durum bildirmez', () => {
    const states: string[] = []
    const tr = webSocketTransport('ws://h/rpc', { backoffMs: [10] })
    tr.start(() => {}, (s) => states.push(s))
    FakeWs.all[0].open()
    tr.close()
    expect(FakeWs.all[0].closedByClient).toBe(true)
    FakeWs.all[0].drop(1000) // tarayıcı close olayını sonradan verir
    vi.advanceTimersByTime(1000)
    expect(FakeWs.all).toHaveLength(1)
    expect(states).toEqual(['open'])
  })
  it('bağlanamayan deneme oturumu sorar: oturum yoksa revoked, yeniden denenmez', async () => {
    const states: string[] = []
    const check = vi.fn(async () => true)
    const tr = webSocketTransport('ws://h/rpc', { backoffMs: [10], isSessionGone: check })
    tr.start(() => {}, (s) => states.push(s))
    FakeWs.all[0].drop() // yükseltme 401: tarayıcı yalnız 1006 görür
    await vi.advanceTimersByTimeAsync(0)
    expect(check).toHaveBeenCalledTimes(1)
    expect(states).toEqual(['revoked'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWs.all).toHaveLength(1)
  })

  it('oturum sorgusu ağ hatası verirse denemeler sürer; her başarısız denemede sorulur', async () => {
    const states: string[] = []
    const check = vi.fn(async (): Promise<boolean> => {
      throw new Error('ağ')
    })
    const tr = webSocketTransport('ws://h/rpc', { backoffMs: [10], isSessionGone: check })
    tr.start(() => {}, (s) => states.push(s))
    FakeWs.all[0].drop()
    await vi.advanceTimersByTimeAsync(10)
    expect(FakeWs.all).toHaveLength(2)
    FakeWs.all[1].drop()
    await vi.advanceTimersByTimeAsync(10)
    expect(FakeWs.all).toHaveLength(3)
    expect(check).toHaveBeenCalledTimes(2)
    // oturum geçerli (false) da denemeyi sürdürür
    check.mockImplementation(async () => false)
    FakeWs.all[2].drop()
    await vi.advanceTimersByTimeAsync(10)
    expect(FakeWs.all).toHaveLength(4)
    expect(states).toEqual([])
  })

  it('açık bağlantının kopuşunda oturum sorulmaz (mağaza local:disconnected ile sorar)', async () => {
    const check = vi.fn(async () => true)
    const tr = webSocketTransport('ws://h/rpc', { backoffMs: [10], isSessionGone: check })
    tr.start(() => {}, () => {})
    FakeWs.all[0].open()
    FakeWs.all[0].drop()
    await vi.advanceTimersByTimeAsync(10)
    expect(check).not.toHaveBeenCalled()
    expect(FakeWs.all).toHaveLength(2)
  })

  it('oturum sorgusu sürerken close çağrılırsa sonuç yok sayılır', async () => {
    const states: string[] = []
    let answer: (v: boolean) => void = () => {}
    const tr = webSocketTransport('ws://h/rpc', { backoffMs: [10], isSessionGone: () => new Promise((r) => (answer = r)) })
    tr.start(() => {}, (s) => states.push(s))
    FakeWs.all[0].drop()
    tr.close()
    answer(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWs.all).toHaveLength(1)
    expect(states).toEqual([])
  })
  describe('bilet sağlayıcısı', () => {
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }

    it('reconnect takes fresh ticket', async () => {
      let n = 0
      const provider = vi.fn(async () => ({ url: 'wss://s/rpc', protocols: ['gecko.v1', `gecko.ticket.t${++n}`] }))
      const states: string[] = []
      const tr = webSocketTransport(provider, { backoffMs: [10] })
      tr.start(() => {}, (s) => states.push(s))
      await flush()
      expect(FakeWs.all).toHaveLength(1)
      expect(FakeWs.all[0].protocols).toEqual(['gecko.v1', 'gecko.ticket.t1'])
      FakeWs.all[0].open()
      FakeWs.all[0].drop()
      expect(states).toEqual(['open', 'closed'])
      await vi.advanceTimersByTimeAsync(10)
      await flush()
      expect(provider).toHaveBeenCalledTimes(2)
      expect(FakeWs.all[1].protocols).toEqual(['gecko.v1', 'gecko.ticket.t2'])
      FakeWs.all[1].open()
      expect(states).toEqual(['open', 'closed', 'open'])
      tr.close()
    })

    it('ticket fetch failure schedules retry', async () => {
      const provider = vi.fn().mockRejectedValueOnce(new Error('ağ')).mockResolvedValue({ url: 'wss://s/rpc', protocols: ['gecko.v1'] })
      const tr = webSocketTransport(provider, { backoffMs: [10] })
      tr.start(() => {}, () => {})
      await flush()
      expect(FakeWs.all).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(10)
      await flush()
      expect(provider).toHaveBeenCalledTimes(2)
      expect(FakeWs.all).toHaveLength(1)
      tr.close()
    })

    it('bilet alınamazsa oturum sorulur: yoksa revoked', async () => {
      const provider = vi.fn().mockRejectedValue(new Error('401'))
      const states: string[] = []
      const tr = webSocketTransport(provider, { backoffMs: [10], isSessionGone: async () => true })
      tr.start(() => {}, (s) => states.push(s))
      await flush()
      await flush()
      expect(states).toEqual(['revoked'])
      await vi.advanceTimersByTimeAsync(100)
      expect(provider).toHaveBeenCalledOnce()
    })

    it('bilet beklerken kapatılan taşıma soket açmaz', async () => {
      let release: (v: { url: string }) => void = () => {}
      const provider = vi.fn(() => new Promise<{ url: string }>((r) => (release = r)))
      const tr = webSocketTransport(provider, { backoffMs: [10] })
      tr.start(() => {}, () => {})
      tr.close()
      release({ url: 'wss://s/rpc' })
      await flush()
      expect(FakeWs.all).toHaveLength(0)
    })

    it('kapatılıp yeniden başlayan taşımada eski bilet yanıtı yok sayılır', async () => {
      const releases: ((v: { url: string }) => void)[] = []
      const provider = vi.fn(() => new Promise<{ url: string }>((r) => releases.push(r)))
      const tr = webSocketTransport(provider, { backoffMs: [10] })
      tr.start(() => {}, () => {})
      tr.close()
      tr.start(() => {}, () => {})
      releases[0]({ url: 'wss://s/eski' })
      releases[1]({ url: 'wss://s/yeni' })
      await flush()
      expect(FakeWs.all.map((w) => w.url)).toEqual(['wss://s/yeni'])
      tr.close()
    })
  })

  it('string endpoint unchanged', () => {
    const tr = webSocketTransport('wss://s/rpc')
    tr.start(() => {}, () => {})
    expect(FakeWs.all).toHaveLength(1) // aynı anda, eşzamanlı
    expect(FakeWs.all[0].url).toBe('wss://s/rpc')
    expect(FakeWs.all[0].protocols).toBeUndefined()
    tr.close()
  })
})
