import { describe, expect, it } from 'vitest'
import { NOTIFY_BACKLOG_MAX, NOTIFY_BACKLOG_TTL_MS, NotifyBacklog } from '../notifyBacklog'

const item = (title: string) => ({
  title, body: '', accountId: null, messageId: null, level: 'normal' as const, tag: title, count: 1, actions: []
})

describe('NotifyBacklog', () => {
  it('backlog returns only after seq', () => {
    const b = new NotifyBacklog(() => 1000)
    const a = b.push(1, item('a'))
    const c = b.push(1, item('b'))
    expect(c.seq).toBeGreaterThan(a.seq)
    const r = b.since(1, a.seq)
    expect(r.items.map((i) => i.title)).toEqual(['b'])
    expect(r.lastSeq).toBe(c.seq)
    expect(b.since(1, c.seq)).toEqual({ items: [], lastSeq: c.seq, truncated: false })
  })

  it('backlog caps at 50', () => {
    const b = new NotifyBacklog(() => 1000)
    for (let i = 0; i < 60; i++) b.push(1, item(String(i)))
    const { items } = b.since(1, 0)
    expect(NOTIFY_BACKLOG_MAX).toBe(50)
    expect(items).toHaveLength(50)
    expect(items[0].title).toBe('10')
    expect(items.at(-1)!.title).toBe('59')
  })

  it('backlog drops after 24h', () => {
    let now = 1000
    const b = new NotifyBacklog(() => now)
    b.push(1, item('eski'))
    now += NOTIFY_BACKLOG_TTL_MS - 1
    b.push(1, item('yeni'))
    expect(b.since(1, 0).items).toHaveLength(2)
    now += 2
    const r = b.since(1, 0)
    expect(r.items.map((i) => i.title)).toEqual(['yeni'])
    expect(r.lastSeq).toBe(r.items[0].seq)
  })

  it('backlog is per user', () => {
    const b = new NotifyBacklog(() => 1000)
    b.push(1, item('bir'))
    expect(b.since(2, 0).items).toEqual([])
    expect(b.since(1, 0).items).toHaveLength(1)
  })

  it('öge eklemeden lastSeq sonraki ögeden küçüktür: ilk bağlantıdaki değer yeni postayı kaçırmaz', () => {
    const b = new NotifyBacklog(() => 1000)
    const { lastSeq } = b.since(1, 0)
    const pushed = b.push(1, item('yeni'))
    expect(b.since(1, lastSeq).items).toEqual([pushed])
  })

  it('sunucu yeniden başlayınca boşalır, sıra numarası geri gitmez', () => {
    let now = 1000
    const first = new NotifyBacklog(() => now)
    const old = first.push(1, item('a'))
    now += 5000
    const second = new NotifyBacklog(() => now)
    expect(second.since(1, 0).items).toEqual([])
    expect(second.push(1, item('b')).seq).toBeGreaterThan(old.seq)
  })

  it('forget kullanıcının ögelerini bırakır', () => {
    const b = new NotifyBacklog(() => 1000)
    b.push(1, item('a'))
    b.forget(1)
    expect(b.since(1, 0).items).toEqual([])
  })

  it('forget sıra numarasını korur: elinde yüksek lastSeq olan ajan sonraki ögeyi kaçırmaz', () => {
    const b = new NotifyBacklog(() => 1000)
    const old = b.push(1, item('a'))
    b.push(1, item('b'))
    const { lastSeq } = b.since(1, old.seq)
    b.forget(1)
    const next = b.push(1, item('c'))
    expect(next.seq).toBeGreaterThan(lastSeq)
    expect(b.since(1, lastSeq).items).toEqual([next])
  })

  it('truncated: üst sınır, süre ya da forget ajanın beklediği ögeyi düşürdüyse', () => {
    let now = 1000
    const b = new NotifyBacklog(() => now)
    const start = b.since(1, Number.MAX_SAFE_INTEGER).lastSeq
    expect(b.since(1, Number.MAX_SAFE_INTEGER).truncated).toBe(false) // ilk bağlantı: beklenen öge yok
    b.push(1, item('a'))
    expect(b.since(1, start).truncated).toBe(false)
    for (let i = 0; i < NOTIFY_BACKLOG_MAX; i++) b.push(1, item(String(i)))
    const over = b.since(1, start)
    expect(over.items).toHaveLength(NOTIFY_BACKLOG_MAX)
    expect(over.truncated).toBe(true)
    expect(b.since(1, over.lastSeq - 1).truncated).toBe(false)
    now += NOTIFY_BACKLOG_TTL_MS + 1
    expect(b.since(1, over.lastSeq - 1)).toMatchObject({ items: [], truncated: true })
    const u2 = b.since(2, Number.MAX_SAFE_INTEGER).lastSeq
    b.push(2, item('x'))
    b.forget(2)
    expect(b.since(2, u2).truncated).toBe(true)
  })

  it('maskeli öge çağırana içerikle döner, kuyrukta metin kalmaz', () => {
    const b = new NotifyBacklog(() => 1000)
    const live = b.push(1, { ...item('Gizli konu'), body: 'Gizli gövde', accountId: 3, messageId: 9, actions: ['read'] }, true)
    expect(live).toMatchObject({ title: 'Gizli konu', body: 'Gizli gövde', actions: ['read'] })
    const [stored] = b.since(1, live.seq - 1).items
    expect(stored).toMatchObject({ seq: live.seq, title: '', body: '', accountId: 3, messageId: 9, actions: [] })
    expect(JSON.stringify(stored)).not.toContain('Gizli')
  })
})
