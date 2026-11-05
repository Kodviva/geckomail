import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_LIMITS, HostGovernor, type GovernorLimits } from '../net/hostGovernor'
import { PoolDeferred, SessionPool, type PoolClient, type PoolDeps } from '../net/sessionPool'

class FakeClient extends EventEmitter implements PoolClient {
  usable = true
  mailbox: false | { path: string } = false
  closed = false
  opened: string[] = []
  async mailboxOpen(path: string) {
    this.mailbox = { path }
    this.opened.push(path)
  }
  async logout() {
    this.usable = false
  }
  close() {
    this.closed = true
    this.usable = false
    this.emit('close')
  }
}

function setup(limits: Partial<GovernorLimits> = {}, over: Partial<PoolDeps<FakeClient>> = {}) {
  let t = 1_000_000
  const now = () => t
  const gov = new HostGovernor('mail.test', { ...DEFAULT_LIMITS, loginBurst: 50, loginsPerMin: 600, minGapMs: 0, ...limits }, now)
  const clients: FakeClient[] = []
  const deps: PoolDeps<FakeClient> = {
    now,
    hostOf: () => 'mail.test',
    governor: () => gov,
    knownGood: () => true,
    canLogin: () => null,
    connect: vi.fn(async () => {
      const c = new FakeClient()
      clients.push(c)
      return c
    }),
    onLoginSuccess: vi.fn(),
    onLoginFailure: vi.fn(),
    onCooldown: vi.fn(),
    onMailboxActivity: vi.fn(),
    onSessionLost: vi.fn(),
    sleep: async () => {},
    ...over
  }
  const pool = new SessionPool(deps, { idleTtlMs: 5 * 60_000, jobTimeoutMs: 5_000, interactiveWaitMs: 1_000 })
  return { pool, deps, gov, clients, advance: (ms: number) => (t += ms) }
}

describe('SessionPool', () => {
  it('aynı hesabın oturumunu yeniden kullanır (tek login)', async () => {
    const { pool, deps } = setup()
    await pool.run(1, 'background', async () => 'a')
    await pool.run(1, 'interactive', async () => 'b')
    await pool.run(1, 'interactive', async () => 'c')
    expect(deps.connect).toHaveBeenCalledTimes(1)
  })

  it('kopmuş oturumu atar, yeniden bağlanır', async () => {
    const { pool, deps, clients } = setup()
    await pool.run(1, 'background', async () => {})
    clients[0].usable = false
    await pool.run(1, 'background', async () => {})
    expect(deps.connect).toHaveBeenCalledTimes(2)
  })

  it('iş sırasında soket ölürse oturum atılır, hata iletilir', async () => {
    const { pool, deps } = setup()
    await expect(
      pool.run(1, 'interactive', async (c) => {
        c.usable = false
        throw new Error('read ECONNRESET')
      })
    ).rejects.toThrow('ECONNRESET')
    await pool.run(1, 'interactive', async () => {})
    expect(deps.connect).toHaveBeenCalledTimes(2)
  })

  it('governor reddederse bağlanmadan PoolDeferred atar', async () => {
    const { pool, deps, gov } = setup()
    for (let i = 0; i < 3; i++) gov.onLoginFailure('preauth')
    const err = await pool.run(1, 'background', async () => {}).catch((e) => e)
    expect(err).toBeInstanceOf(PoolDeferred)
    expect((err as PoolDeferred).reason).toBe('cooldown')
    expect((err as Error).message).toMatch(/IP engeli/)
    expect(deps.connect).not.toHaveBeenCalled()
  })

  it('soğumada açık oturum çalışmaya devam eder', async () => {
    const { pool, deps, gov } = setup()
    await pool.run(1, 'background', async () => {})
    for (let i = 0; i < 3; i++) gov.onLoginFailure('preauth')
    await expect(pool.run(1, 'interactive', async () => 'ok')).resolves.toBe('ok')
    expect(deps.connect).toHaveBeenCalledTimes(1)
  })

  it('login-öncesi hatalar soğuma başlatır ve bir kez bildirir', async () => {
    const reset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', phase: 'connect' })
    const { pool, deps } = setup({}, { connect: vi.fn(async () => Promise.reject(reset())) })
    for (const id of [1, 2, 3]) await pool.run(id, 'background', async () => {}).catch(() => {})
    expect(deps.onCooldown).toHaveBeenCalledTimes(1)
    const err = await pool.run(4, 'interactive', async () => {}).catch((e) => e)
    expect(err).toBeInstanceOf(PoolDeferred)
    expect(deps.connect).toHaveBeenCalledTimes(3)
    expect(deps.onLoginFailure).toHaveBeenCalledWith(1, 'preauth', expect.anything())
  })

  it('canLogin engeli varsa hiç bağlanmaz', async () => {
    const { pool, deps } = setup({}, { canLogin: () => 'Şifre hatalı' })
    await expect(pool.run(1, 'interactive', async () => {})).rejects.toThrow('Şifre hatalı')
    expect(deps.connect).not.toHaveBeenCalled()
  })

  it('tavan dolunca en eski boştaki oturumu kapatır', async () => {
    const { pool, clients, advance } = setup({ maxSessions: 2 })
    await pool.run(1, 'background', async () => {})
    advance(1000)
    await pool.run(2, 'background', async () => {})
    advance(1000)
    await pool.run(3, 'background', async () => {})
    expect(clients[0].closed).toBe(true)
    expect(clients[1].closed).toBe(false)
    expect(pool.openCount('mail.test')).toBe(2)
  })

  it('sabitlenmiş oturum tahliye edilmez; iş sonrası INBOX seçilir', async () => {
    const { pool, clients, advance } = setup({ maxSessions: 2 })
    pool.pin(new Set([1]))
    await pool.run(1, 'background', async (c) => {
      await c.mailboxOpen('INBOX.Sent')
    })
    expect(clients[0].mailbox).toEqual({ path: 'INBOX' })
    advance(1000)
    await pool.run(2, 'background', async () => {})
    advance(1000)
    await pool.run(3, 'background', async () => {})
    expect(clients[0].closed).toBe(false)
    expect(clients[1].closed).toBe(true)
  })

  it('tavan dolu ve boşta yoksa arka plan ertelenir', async () => {
    const { pool } = setup({ maxSessions: 1 })
    pool.pin(new Set([1]))
    await pool.run(1, 'background', async () => {})
    const err = await pool.run(2, 'background', async () => {}).catch((e) => e)
    expect(err).toBeInstanceOf(PoolDeferred)
    expect((err as PoolDeferred).reason).toBe('capacity')
  })

  it('sweep boşta kalan süresi dolmuş oturumları kapatır', async () => {
    const { pool, clients, advance } = setup()
    pool.pin(new Set([2]))
    await pool.run(1, 'background', async () => {})
    await pool.run(2, 'background', async () => {})
    advance(6 * 60_000)
    pool.sweep()
    await new Promise((r) => setTimeout(r, 0)) // logout → close zinciri
    expect(clients[0].closed).toBe(true)
    expect(clients[1].closed).toBe(false)
  })

  it('kapanan oturum bildirilir, mailbox olayları iletilir', async () => {
    const { pool, deps, clients } = setup()
    await pool.run(1, 'background', async () => {})
    clients[0].emit('exists', { path: 'INBOX', count: 5, prevCount: 4 })
    expect(deps.onMailboxActivity).toHaveBeenCalledWith(1)
    clients[0].usable = false
    clients[0].emit('close')
    expect(deps.onSessionLost).toHaveBeenCalledWith(1)
    expect(pool.openCount('mail.test')).toBe(0)
  })

  it('aynı hesaptaki işler seri çalışır', async () => {
    const { pool } = setup()
    const order: string[] = []
    const a = pool.run(1, 'background', async () => {
      order.push('a1')
      await new Promise((r) => setTimeout(r, 10))
      order.push('a2')
    })
    const b = pool.run(1, 'interactive', async () => {
      order.push('b')
    })
    await Promise.all([a, b])
    expect(order).toEqual(['a1', 'a2', 'b'])
  })
})
