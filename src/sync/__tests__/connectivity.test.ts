import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { Connectivity } from '../net/connectivity'
import { DEFAULT_LIMITS, HostGovernor } from '../net/hostGovernor'
import { OfflineError, SessionPool, type PoolClient, type PoolDeps } from '../net/sessionPool'

// 30 Eyl: internet kesintisi iki kez "olası IP engeli" soğumasına yol açtı; IP aslında engelsizdi.
describe('cihaz bağlantı durumu', () => {
  const make = (reachable: boolean) => {
    let t = 1_000_000
    const probes: string[] = []
    const c = new Connectivity({ now: () => t, tcpProbe: async (h) => (probes.push(h), reachable) })
    return { c, probes, advance: (ms: number) => (t += ms) }
  }

  it('işletim sistemi "yok" derse ağa çıkmadan offline', async () => {
    const { c, probes } = make(true)
    c.setOsOnline(false)
    expect(c.state).toBe('offline')
    expect(await c.verifyOnline()).toBe(false)
    expect(probes).toEqual([])
  })

  it('bağımsız hedeflerin biri açılırsa internet var; sonuç 15 sn önbellekli', async () => {
    const { c, probes, advance } = make(true)
    expect(await c.verifyOnline()).toBe(true)
    expect(probes).toHaveLength(3)
    await c.verifyOnline()
    expect(probes).toHaveLength(3)
    advance(16_000)
    await c.verifyOnline()
    expect(probes).toHaveLength(6)
  })

  it('hiçbirine ulaşılamazsa offline olur ve değişim bildirilir; OS "var" deyince döner', async () => {
    const { c } = make(false)
    const seen: string[] = []
    c.onChange((s) => seen.push(s))
    expect(await c.verifyOnline()).toBe(false)
    expect(c.state).toBe('offline')
    c.setOsOnline(true)
    expect(c.state).toBe('online')
    expect(seen).toEqual(['offline', 'online'])
  })

  it('uyanış sonrası kısa süre hatalar sunucuya yazılmaz', () => {
    const { c, advance } = make(true)
    c.onResume(20_000)
    expect(c.inWakeGrace()).toBe(true)
    advance(21_000)
    expect(c.inWakeGrace()).toBe(false)
  })
})

describe('kesinti yanlış alarmı', () => {
  class FakeClient extends EventEmitter implements PoolClient {
    usable = true
    mailbox: false | { path: string } = false
    async mailboxOpen(path: string) {
      this.mailbox = { path }
    }
    async logout() {}
    close() {
      this.usable = false
    }
  }
  const netError = () => Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET', phase: 'connect' })

  function setup(online: boolean) {
    const t = 1_000_000
    const gov = new HostGovernor('mail.test', { ...DEFAULT_LIMITS, loginBurst: 50, loginsPerMin: 600, minGapMs: 0 }, () => t)
    const deps: PoolDeps<FakeClient> = {
      now: () => t,
      hostOf: () => 'mail.test',
      governor: () => gov,
      knownGood: () => true,
      canLogin: () => null,
      connect: vi.fn(async () => {
        throw netError()
      }),
      onLoginSuccess: vi.fn(),
      onLoginFailure: vi.fn(),
      onCooldown: vi.fn(),
      onMailboxActivity: vi.fn(),
      onSessionLost: vi.fn(),
      sleep: async () => {},
      verifyOnline: async () => online
    }
    return { pool: new SessionPool(deps, { idleTtlMs: 60_000, jobTimeoutMs: 5_000, interactiveWaitMs: 0 }), deps, gov }
  }

  it('internet yokken bağlantı hataları soğuma ve giriş denemesi sayılmaz', async () => {
    const { pool, deps, gov } = setup(false)
    for (let i = 0; i < 5; i++) await expect(pool.run(i, 'background', async () => 1)).rejects.toBeInstanceOf(OfflineError)
    expect(deps.onCooldown).not.toHaveBeenCalled()
    expect(deps.onLoginFailure).not.toHaveBeenCalled()
    expect(gov.snapshot().state).toBe('ok')
  })

  it('internet varken aynı hatalar eşiğe ulaşınca soğuma (gerçek engel)', async () => {
    const { pool, deps } = setup(true)
    for (let i = 0; i < 3; i++) await expect(pool.run(i, 'background', async () => 1)).rejects.toThrow('ECONNRESET')
    expect(deps.onCooldown).toHaveBeenCalledTimes(1)
  })

  it('offline tahmini varsa bağlantı hiç denenmez', async () => {
    const { deps } = setup(true)
    const pool = new SessionPool({ ...deps, offline: () => true }, { idleTtlMs: 60_000, jobTimeoutMs: 5_000, interactiveWaitMs: 0 })
    await expect(pool.run(1, 'background', async () => 1)).rejects.toBeInstanceOf(OfflineError)
    expect(deps.connect).not.toHaveBeenCalled()
  })

  it('internet dönünce ilk kademe "IP engeli" soğuması affedilir; limit soğuması değil', () => {
    const gov = new HostGovernor('h', DEFAULT_LIMITS, () => 0)
    for (let i = 0; i < 3; i++) gov.onLoginFailure('preauth')
    expect(gov.snapshot().state).toBe('cooldown')
    expect(gov.forgiveNetwork()).toBe(true)
    expect(gov.snapshot().state).toBe('ok')
    gov.onLoginFailure('limit')
    expect(gov.forgiveNetwork()).toBe(false)
    expect(gov.snapshot().state).toBe('cooldown')
  })
})
