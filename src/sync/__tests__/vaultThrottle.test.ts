import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '../../shared/rpc'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import type { OpQueue } from '../opQueue'
import { RpcHub } from '../rpcHub'
import type { Scheduler } from '../scheduler'
import { fxBytes } from '../smime/__tests__/fx'
import { createVault } from '../vault/manager'
import { setVaultKey } from '../vault/state'
import { checkVaultPassphrase, clearVaultPassphraseFails, hubDelayMs, VAULT_CLEAR_COOLDOWN_MS, VAULT_DAY_MAX_FAILS, VAULT_DAY_MS, VAULT_HARD_MAX_FAILS, VAULT_HUB_BASE_DELAY_MS, VAULT_HUB_MAX_DELAY_MS, VAULT_HUB_MAX_FAILS, VAULT_USER_MAX_FAILS, VAULT_WINDOW_MS } from '../vault/throttle'

type Session = { handle(method: string, params: unknown): Promise<unknown>; currentUser: SessionUser | null }

const VAULT = 'kasa-parolasi'
const WRONG = 'yanlis-parola'
const LOCKED = 'Çok fazla hatalı deneme'
const NOW = Date.UTC(2030, 0, 1)

describe('kasa parolası sınırı', { timeout: 30_000 }, () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let srv: Session
  let u1: number
  let u2: number
  let now: number

  const user = (id: number, role: 'admin' | 'member' = 'admin'): SessionUser => ({ id, username: `u${id}`, role, totpEnabled: false, totpRequired: false } as unknown as SessionUser)
  const makeHub = (): RpcHub => {
    const stub = new Proxy({}, { get: () => () => undefined })
    const h = new RpcHub({
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: async (v) => v.map((s) => new TextEncoder().encode(s)), decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)),
      userData: dir, dbSchemaVersion: () => 0
    }, 'desktop')
    h.now = () => now
    return h
  }
  const session = (h: RpcHub, id: number, role: 'admin' | 'member' = 'admin'): Session => {
    const s = h.openSession({ send() {}, onMessage() {}, onClose() {}, close() {} }) as unknown as Session
    s.currentUser = user(id, role)
    return s
  }
  const lock = (): Promise<unknown> => srv.handle('lockVault', {})
  const failUnlock = async (s: Session = srv): Promise<void> => expect(s.handle('unlockVault', { password: WRONG })).resolves.toMatchObject({ ok: false })
  const failBio = async (s: Session = srv): Promise<void> => expect(s.handle('enableVaultBiometric', { passphrase: WRONG })).rejects.toThrow('Kasa parolası hatalı')
  const importIdentity = async (s: Session): Promise<number> => {
    const acc = q.insertAccount({ email: 'alice@example.test', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    const p12Base64 = fxBytes('alice-modern.p12').toString('base64')
    const password = fxBytes('p12-password.txt').toString().trim()
    return ((await s.handle('smimeImportIdentity', { accountId: acc, p12Base64, password })) as { id: number }).id
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-vaultthrottle-'))
    db = openDb(dir)
    q = makeQueries(db)
    u1 = q.insertUser({ username: 'u1', passwordHash: 'h', role: 'admin' })
    u2 = q.insertUser({ username: 'u2', passwordHash: 'h', role: 'member' })
    now = NOW
    hub = makeHub()
    srv = session(hub, u1)
    createVault(q, VAULT)
  })
  afterEach(() => {
    setVaultKey(null)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('yardımcı', () => {
    const member = (id: number) => ({ id, role: 'member' as const })
    const admin = (id: number) => ({ id, role: 'admin' as const })
    const fail = (id: number, at = now): Promise<boolean> => checkVaultPassphrase(q, member(id), at, () => false)
    /** eşiğe kadar farklı üyelerden yanlış: kullanıcı sınırına takılmadan */
    const fillHub = async (): Promise<void> => {
      for (let i = 0; i < VAULT_HUB_MAX_FAILS; i++) await fail(100 + Math.floor(i / (VAULT_USER_MAX_FAILS - 1)))
    }

    it('kilitliyken parola türetilmez', async () => {
      for (let i = 0; i < VAULT_USER_MAX_FAILS; i++) await fail(1)
      const verify = vi.fn(() => true)
      await expect(checkVaultPassphrase(q, member(1), now, verify)).rejects.toThrow(LOCKED)
      expect(verify).not.toHaveBeenCalled()
    })

    it('eşzamanlı denemeler sınırı aşamaz', async () => {
      const verify = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5))
        return false
      })
      const all = await Promise.allSettled(Array.from({ length: 9 }, () => checkVaultPassphrase(q, member(1), now, verify)))
      expect(verify).toHaveBeenCalledTimes(VAULT_USER_MAX_FAILS)
      expect(all.filter((r) => r.status === 'rejected')).toHaveLength(9 - VAULT_USER_MAX_FAILS)
    })

    it('kullanıcı sınırı kişiye özeldir, pencere dolunca açılır', async () => {
      for (let i = 0; i < VAULT_USER_MAX_FAILS; i++) await fail(1)
      await expect(checkVaultPassphrase(q, member(2), now, () => true)).resolves.toBe(true)
      await expect(checkVaultPassphrase(q, member(1), now + VAULT_WINDOW_MS, () => true)).resolves.toBe(true)
    })

    it('üye eşiği sert kilit değildir: artan bekleme, pencere beklenmez', async () => {
      await fillHub()
      const verify = vi.fn(() => true)
      await expect(checkVaultPassphrase(q, member(99), now, verify)).rejects.toThrow(LOCKED)
      expect(verify).not.toHaveBeenCalled()
      expect(hubDelayMs(VAULT_HUB_MAX_FAILS)).toBe(VAULT_HUB_BASE_DELAY_MS)
      now += hubDelayMs(VAULT_HUB_MAX_FAILS)
      await expect(fail(99)).resolves.toBe(false) // bekleme bitti, yeni deneme hakkı; yanlış bekleme süresini uzatır
      await expect(checkVaultPassphrase(q, member(98), now + VAULT_HUB_BASE_DELAY_MS, () => true)).rejects.toThrow(LOCKED)
      await expect(checkVaultPassphrase(q, member(98), now + hubDelayMs(VAULT_HUB_MAX_FAILS + 1), () => true)).resolves.toBe(true)
    })

    it('bekleme üst sınırı aşmaz', () => {
      expect(hubDelayMs(VAULT_HUB_MAX_FAILS - 1)).toBe(0)
      expect(hubDelayMs(VAULT_HUB_MAX_FAILS + 500)).toBe(VAULT_HUB_MAX_DELAY_MS)
      expect(VAULT_HUB_MAX_DELAY_MS).toBeLessThan(VAULT_WINDOW_MS)
    })

    it('üye yanlışları yöneticiyi durdurmaz; yönetici yanlışları üyeyi durdurmaz', async () => {
      await fillHub()
      const verify = vi.fn(() => true)
      await expect(checkVaultPassphrase(q, admin(1), now, verify)).resolves.toBe(true)
      expect(verify).toHaveBeenCalledOnce()
      q.prefSet('vault_pass_fails', '{}')
      for (let i = 0; i < VAULT_HUB_MAX_FAILS; i++) await checkVaultPassphrase(q, admin(200 + Math.floor(i / (VAULT_USER_MAX_FAILS - 1))), now, () => false)
      await expect(checkVaultPassphrase(q, member(1), now, () => true)).resolves.toBe(true)
      await expect(checkVaultPassphrase(q, admin(1), now, () => true)).rejects.toThrow(LOCKED)
    })

    it('bekleme bittikten sonra pencere başına sert üst sınır kalır; her kova kendi sınırına takılır', async () => {
      expect(VAULT_HARD_MAX_FAILS).toBe(3 * VAULT_HUB_MAX_FAILS)
      const full = Array.from({ length: VAULT_HARD_MAX_FAILS }, () => now - 1000)
      q.prefSet('vault_pass_fails', JSON.stringify({ hub: full, admins: [], users: {} }))
      const verify = vi.fn(() => true)
      const later = now + VAULT_HUB_MAX_DELAY_MS + 1000
      await expect(checkVaultPassphrase(q, member(1), later, verify)).rejects.toThrow(LOCKED)
      expect(verify).not.toHaveBeenCalled()
      await expect(checkVaultPassphrase(q, admin(1), now, () => true)).resolves.toBe(true) // üye kovası yöneticiyi durdurmaz
      await expect(checkVaultPassphrase(q, member(1), now + VAULT_WINDOW_MS, () => true)).resolves.toBe(true)
      q.prefSet('vault_pass_fails', JSON.stringify({ hub: [], admins: full, users: {} }))
      await expect(checkVaultPassphrase(q, admin(1), later, () => true)).rejects.toThrow(LOCKED)
      await expect(checkVaultPassphrase(q, member(1), later, () => true)).resolves.toBe(true)
    })

    it('üyelerin 24 saatlik bütçesi dolunca yalnız üyeler kilitlenir, yönetici açabilir; temizleme sıfırlamaz', async () => {
      const day = Array.from({ length: VAULT_DAY_MAX_FAILS }, (_, i) => now - VAULT_DAY_MS + 60_000 + i)
      q.prefSet('vault_pass_fails', JSON.stringify({ hub: [], admins: [], users: {}, day }))
      const verify = vi.fn(() => true)
      await expect(checkVaultPassphrase(q, member(1), now, verify)).rejects.toThrow(LOCKED)
      expect(verify).not.toHaveBeenCalled()
      await expect(checkVaultPassphrase(q, admin(2), now, verify)).resolves.toBe(true)
      clearVaultPassphraseFails(q, admin(2), now)
      await expect(checkVaultPassphrase(q, member(1), now, verify)).rejects.toThrow(LOCKED)
      await expect(checkVaultPassphrase(q, member(1), now + 60_000, verify)).resolves.toBe(true) // en eski deneme pencereden çıktı
    })

    it('yöneticilerin kendi 24 saatlik bütçesi vardır: dolunca yönetici kilitlenir, üye etkilenmez', async () => {
      const adminDay = Array.from({ length: VAULT_DAY_MAX_FAILS }, (_, i) => now - VAULT_DAY_MS + 60_000 + i)
      q.prefSet('vault_pass_fails', JSON.stringify({ hub: [], admins: [], users: {}, day: [], adminDay }))
      const verify = vi.fn(() => true)
      await expect(checkVaultPassphrase(q, admin(1), now, verify)).rejects.toThrow(LOCKED)
      expect(verify).not.toHaveBeenCalled()
      await expect(checkVaultPassphrase(q, member(2), now, verify)).resolves.toBe(true)
      clearVaultPassphraseFails(q, admin(1), now)
      await expect(checkVaultPassphrase(q, admin(1), now, verify)).rejects.toThrow(LOCKED)
    })

    it('üye yanlışları yöneticinin gün bütçesini tüketemez; başarı rezervasyonu geri alınır', async () => {
      await fail(1)
      await fail(2)
      await checkVaultPassphrase(q, admin(2), now, () => false)
      await checkVaultPassphrase(q, admin(3), now, () => true)
      const f = JSON.parse(q.prefGet('vault_pass_fails')!) as { day: number[]; adminDay: number[] }
      expect(f.day).toHaveLength(2)
      expect(f.adminDay).toHaveLength(1)
    })

    it('başarı yalnız o kullanıcının sayacını sıfırlar', async () => {
      for (let i = 0; i < VAULT_USER_MAX_FAILS - 1; i++) await fail(1)
      await checkVaultPassphrase(q, member(1), now, () => true)
      await fail(1)
      await expect(checkVaultPassphrase(q, member(1), now, () => true)).resolves.toBe(true)
    })

    it('bozuk kayıt kilitlemez ve doğrulamayı atlatmaz', async () => {
      q.prefSet('vault_pass_fails', '{bozuk')
      await expect(checkVaultPassphrase(q, member(1), now, () => false)).resolves.toBe(false)
      q.prefSet('vault_pass_fails', '{"hub":5,"users":[1]}')
      await expect(checkVaultPassphrase(q, member(1), now, () => true)).resolves.toBe(true)
    })

    it('doğrulama hatası (kasa kurulu değil) deneme sayılmaz', async () => {
      for (let i = 0; i < VAULT_USER_MAX_FAILS + 1; i++) {
        await expect(checkVaultPassphrase(q, member(1), now, () => { throw new Error('kurulu değil') })).rejects.toThrow('kurulu değil')
      }
      await expect(checkVaultPassphrase(q, member(1), now, () => true)).resolves.toBe(true)
    })
  })

  it('unlockVault sınırlıdır: kilitliyken doğru parola da açmaz', async () => {
    await lock()
    for (let i = 0; i < VAULT_USER_MAX_FAILS; i++) await failUnlock()
    await expect(srv.handle('unlockVault', { password: VAULT })).rejects.toThrow(LOCKED)
    now += VAULT_WINDOW_MS
    await expect(srv.handle('unlockVault', { password: VAULT })).resolves.toMatchObject({ ok: true })
  })

  it('enableVaultBiometric sınırlıdır', async () => {
    for (let i = 0; i < VAULT_USER_MAX_FAILS; i++) await failBio()
    await expect(srv.handle('enableVaultBiometric', { passphrase: VAULT })).rejects.toThrow(LOCKED)
  })

  it('smimeExportIdentity sınırlıdır', async () => {
    const id = await importIdentity(srv)
    const call = (vaultPassphrase: string) => srv.handle('smimeExportIdentity', { id, vaultPassphrase, exportPassword: 'yeni-parola-12' })
    for (let i = 0; i < VAULT_USER_MAX_FAILS; i++) await expect(call(WRONG)).rejects.toThrow('Kasa parolası hatalı')
    await expect(call(VAULT)).rejects.toThrow(LOCKED)
  })

  it('üç yol tek kovayı paylaşır', async () => {
    const id = await importIdentity(srv)
    await failBio()
    await failBio()
    await expect(srv.handle('smimeExportIdentity', { id, vaultPassphrase: WRONG, exportPassword: 'yeni-parola-12' })).rejects.toThrow('Kasa parolası hatalı')
    await expect(srv.handle('smimeExportIdentity', { id, vaultPassphrase: WRONG, exportPassword: 'yeni-parola-12' })).rejects.toThrow('Kasa parolası hatalı')
    await lock()
    await failUnlock()
    await expect(srv.handle('unlockVault', { password: VAULT })).rejects.toThrow(LOCKED)
    await expect(srv.handle('enableVaultBiometric', { passphrase: VAULT })).rejects.toThrow(LOCKED)
  })

  it('sayaç yeniden başlatmada silinmez', async () => {
    await lock()
    for (let i = 0; i < VAULT_USER_MAX_FAILS; i++) await failUnlock()
    const restarted = session(makeHub(), u1)
    await expect(restarted.handle('unlockVault', { password: VAULT })).rejects.toThrow(LOCKED)
    expect(Object.keys(q.getAllPrefs())).toContain('vault_pass_fails')
  })

  it('üye yanlışları doğru parolalı yöneticiyi engellemez, kurulum sayacına yazılır', async () => {
    await lock()
    const m = session(hub, u2, 'member')
    for (let i = 0; i < VAULT_USER_MAX_FAILS; i++) await failUnlock(m)
    await expect(m.handle('unlockVault', { password: VAULT })).rejects.toThrow(LOCKED)
    await expect(srv.handle('unlockVault', { password: VAULT })).resolves.toMatchObject({ ok: true })
    const fails = JSON.parse(q.prefGet('vault_pass_fails')!) as { hub: number[]; admins: number[] }
    expect(fails.hub).toHaveLength(VAULT_USER_MAX_FAILS)
    expect(fails.admins).toHaveLength(0)
  })

  it('sayaç temizleme yalnız yöneticinin; kilit yeniden başlatmasız kalkar', async () => {
    await lock()
    const m = session(hub, u2, 'member')
    for (let i = 0; i < VAULT_USER_MAX_FAILS; i++) await failUnlock(m)
    await expect(m.handle('clearVaultPassphraseFails', {})).rejects.toThrow()
    await expect(m.handle('unlockVault', { password: VAULT })).rejects.toThrow(LOCKED)
    await expect(srv.handle('clearVaultPassphraseFails', {})).resolves.toEqual({ ok: true })
    await expect(m.handle('unlockVault', { password: VAULT })).resolves.toMatchObject({ ok: true })
  })

  it('temizleme yöneticinin kendi sınırını ve yönetici kovasını açmaz', async () => {
    const u3 = q.insertUser({ username: 'u3', passwordHash: 'h', role: 'admin' })
    await lock()
    const m = session(hub, u2, 'member')
    const otherAdmin = session(hub, u3)
    for (let i = 0; i < VAULT_USER_MAX_FAILS; i++) {
      await failUnlock()
      await failUnlock(m)
      await failUnlock(otherAdmin)
    }
    await srv.handle('clearVaultPassphraseFails', {})
    await expect(srv.handle('unlockVault', { password: VAULT })).rejects.toThrow(LOCKED)
    await expect(otherAdmin.handle('unlockVault', { password: VAULT })).rejects.toThrow(LOCKED)
    const f = JSON.parse(q.prefGet('vault_pass_fails')!) as { hub: number[]; admins: number[]; users: Record<string, number[]> }
    expect(f.hub).toEqual([])
    expect(f.admins).toHaveLength(2 * VAULT_USER_MAX_FAILS)
    expect(Object.keys(f.users).sort()).toEqual([String(u1), String(u3)].sort())
  })

  it('temizleme bekleme süresine tabidir ve her biri denetim kaydı bırakır', async () => {
    await srv.handle('clearVaultPassphraseFails', {})
    await expect(srv.handle('clearVaultPassphraseFails', {})).rejects.toThrow('sn sonra')
    now += VAULT_CLEAR_COOLDOWN_MS
    await srv.handle('clearVaultPassphraseFails', {})
    const log = q.getRuleLog(10).filter((r) => r.kind === 'vault')
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ ref_id: u1, ok: 1 })
    const entries = (await srv.handle('getRuleLog', { limit: 10 })) as { kind: string; actor?: string | null }[]
    expect(entries.find((e) => e.kind === 'vault')?.actor).toBe('u1')
  })

  it('biyometrik açma sayılmaz ve kilitliyken çalışır', async () => {
    await srv.handle('enableVaultBiometric', { passphrase: VAULT })
    await lock()
    for (let i = 0; i < VAULT_USER_MAX_FAILS; i++) await failUnlock()
    const before = q.prefGet('vault_pass_fails')
    await expect(srv.handle('unlockVaultBiometric', {})).resolves.toMatchObject({ ok: true })
    expect(q.prefGet('vault_pass_fails')).toBe(before)
  })

  it('sayaç tanı paketine ve getPrefs yanıtına çıkmaz', async () => {
    await lock()
    await failUnlock()
    expect(await srv.handle('getPrefs', {})).not.toHaveProperty('vault_pass_fails')
  })
})
