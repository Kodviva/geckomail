import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, HostGovernor } from '../net/hostGovernor'

function mk(limits = DEFAULT_LIMITS) {
  let t = 1_000_000
  const g = new HostGovernor('mail.test', limits, () => t)
  return { g, advance: (ms: number) => (t += ms), now: () => t }
}

describe('HostGovernor login jetonları', () => {
  it('patlama kadar login verir, sonra bekletir', () => {
    const { g, advance } = mk({ ...DEFAULT_LIMITS, loginBurst: 3, loginsPerMin: 6 })
    // arka plan son jetonu (interaktif rezervi) alamaz
    expect(g.tryTakeLogin('background', true).ok).toBe(true)
    advance(400)
    expect(g.tryTakeLogin('background', true).ok).toBe(true)
    advance(400)
    const denied = g.tryTakeLogin('background', true)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('rate')
    // interaktif rezervi kullanabilir
    expect(g.tryTakeLogin('interactive', true).ok).toBe(true)
    advance(400)
    expect(g.tryTakeLogin('interactive', true).ok).toBe(false)
    // 10 sn'de 1 jeton dolar (6/dk)
    advance(10_000)
    expect(g.tryTakeLogin('interactive', true).ok).toBe(true)
  })

  it('ardışık loginler arası min boşluk uygular', () => {
    const { g, advance } = mk()
    expect(g.tryTakeLogin('interactive', true).ok).toBe(true)
    const r = g.tryTakeLogin('interactive', true)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.waitMs).toBeGreaterThan(0)
    advance(DEFAULT_LIMITS.minGapMs)
    expect(g.tryTakeLogin('interactive', true).ok).toBe(true)
  })
})

describe('HostGovernor ban imzası', () => {
  it('3 login-öncesi hata → soğuma, soğumada login yok', () => {
    const { g, advance } = mk()
    g.onLoginFailure('preauth')
    g.onLoginFailure('preauth')
    expect(g.snapshot().state).toBe('ok')
    const ev = g.onLoginFailure('preauth')
    expect(ev?.kind).toBe('cooldown')
    expect(g.snapshot().state).toBe('cooldown')
    advance(60_000)
    const r = g.tryTakeLogin('interactive', true)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('cooldown')
  })

  it('soğuma sonrası tek sonda; başarısızsa kademe ikiye katlanır', () => {
    const { g, advance } = mk()
    for (let i = 0; i < 3; i++) g.onLoginFailure('preauth')
    const first = g.snapshot().cooldownUntil - g.snapshot().now
    advance(first + 1)
    expect(g.tryTakeLogin('background', true).ok).toBe(true) // sonda
    advance(1000)
    const second = g.tryTakeLogin('interactive', true)
    expect(second.ok).toBe(false) // sonda sürerken ikinci login yok
    if (!second.ok) expect(second.reason).toBe('probe')
    g.onLoginFailure('preauth')
    const next = g.snapshot().cooldownUntil - g.snapshot().now
    expect(next).toBe(first * 2)
  })

  it('başarılı sonda sağlığı geri getirir', () => {
    const { g, advance } = mk()
    for (let i = 0; i < 3; i++) g.onLoginFailure('preauth')
    advance(DEFAULT_LIMITS.cooldownBaseMs + 1)
    expect(g.tryTakeLogin('background', true).ok).toBe(true)
    g.onLoginSuccess()
    expect(g.snapshot().state).toBe('ok')
    advance(DEFAULT_LIMITS.minGapMs)
    expect(g.tryTakeLogin('interactive', true).ok).toBe(true)
  })

  it('soğuma tavanı 60 dk', () => {
    const { g, advance } = mk()
    for (let i = 0; i < 3; i++) g.onLoginFailure('preauth')
    for (let k = 0; k < 10; k++) {
      advance(g.snapshot().cooldownUntil - g.snapshot().now + 1)
      g.tryTakeLogin('background', true)
      g.onLoginFailure('preauth')
    }
    expect(g.snapshot().cooldownUntil - g.snapshot().now).toBe(DEFAULT_LIMITS.cooldownMaxMs)
  })

  it('eski hatalar pencereden düşer', () => {
    const { g, advance } = mk()
    g.onLoginFailure('preauth')
    g.onLoginFailure('preauth')
    advance(DEFAULT_LIMITS.preauthWindowMs + 1)
    g.onLoginFailure('preauth')
    expect(g.snapshot().state).toBe('ok')
  })
})

describe('HostGovernor limit ve auth bütçesi', () => {
  it('limit hatası soğuma + oturum tavanını yarıya indirir', () => {
    const { g } = mk()
    const ev = g.onLoginFailure('limit')
    expect(ev?.kind).toBe('cooldown')
    expect(g.maxSessions()).toBe(Math.floor(DEFAULT_LIMITS.maxSessions / 2))
  })

  it('auth bütçesi aşılınca yalnızca bilinen-iyi hesaplar login olur', () => {
    const { g, advance } = mk()
    for (let i = 0; i < DEFAULT_LIMITS.authFailPerHour; i++) g.onLoginFailure('auth')
    advance(DEFAULT_LIMITS.minGapMs)
    const unknown = g.tryTakeLogin('interactive', false)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.reason).toBe('auth-budget')
    expect(g.tryTakeLogin('interactive', true).ok).toBe(true)
    advance(60 * 60_000 + 1)
    expect(g.tryTakeLogin('interactive', false).ok).toBe(true)
  })

  it('auth hatası ban soğumasını tetiklemez', () => {
    const { g } = mk()
    for (let i = 0; i < 5; i++) g.onLoginFailure('auth')
    expect(g.snapshot().state).toBe('ok')
  })
})
