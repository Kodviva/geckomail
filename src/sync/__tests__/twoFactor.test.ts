import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '../../shared/rpc'
import { t } from '../../shared/i18n'
import { base32Decode, totpCode } from '../auth/totp'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import type { OpQueue } from '../opQueue'
import type { RpcPort } from '../rpc/transport'
import { RpcHub, type RpcServerDeps } from '../rpcHub'
import type { RpcSession } from '../rpcSession'
import type { Scheduler } from '../scheduler'

const fakePort = (): RpcPort => ({ send() {}, onMessage() {}, onClose() {}, close() {} })

describe('iki aşamalı doğrulama (TOTP) RPC', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  const stub = new Proxy({}, { get: () => () => undefined })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-2fa-'))
    db = openDb(dir)
    q = makeQueries(db)
    // sır DB'ye düz yazılmasın diye sahte şifreleme ters çevirir
    const deps: RpcServerDeps = {
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'att'),
      encrypt: async (v) => v.map((s) => new TextEncoder().encode([...s].reverse().join(''))),
      decrypt: async (b) => b.map((x) => [...new TextDecoder().decode(x)].reverse().join('')),
      userData: dir, dbSchemaVersion: () => 0
    }
    hub = new RpcHub(deps, 'server')
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const session = (role: 'admin' | 'member', name: string): RpcSession => {
    const id = q.insertUser({ username: name, passwordHash: 'x', role })
    const user: SessionUser = { id, username: name, role, permittedGroupIds: [], manageableGroupIds: [] }
    return hub.openSession(fakePort(), { user })
  }
  const nowSec = () => Date.now() / 1000

  /** begin + confirm; onaylamada kullanılan adımın bir sonrakini üretmek için sırrı döndürür */
  const setup = async (s: RpcSession): Promise<Buffer> => {
    const r = (await s.handle('twoFactorBegin', {})) as { otpauthUri: string; secretBase32: string }
    const secret = base32Decode(r.secretBase32)
    await s.handle('twoFactorConfirm', { code: totpCode(secret, nowSec()) })
    return secret
  }

  it('begin → confirm → status enabled', async () => {
    const s = session('member', 'uye')
    expect(await s.handle('twoFactorStatus', {})).toEqual({ enabled: false, required: false })
    const r = (await s.handle('twoFactorBegin', {})) as { otpauthUri: string; secretBase32: string }
    expect(r.otpauthUri).toMatch(/^otpauth:\/\/totp\/GeckoMail:uye\?secret=/)
    expect(r.otpauthUri).toContain(r.secretBase32)
    // sır DB'de düz durmaz; onaylanana dek etkin değil
    const row = q.getUserById(s.currentUser!.id)!
    expect(row.totp_enabled).toBe(0)
    expect(Buffer.from(row.totp_secret_enc!).toString()).not.toContain(r.secretBase32)
    expect(await s.handle('twoFactorStatus', {})).toEqual({ enabled: false, required: false })
    const secret = base32Decode(r.secretBase32)
    await expect(s.handle('twoFactorConfirm', { code: '000000' === totpCode(secret, nowSec()) ? '111111' : '000000' })).rejects.toThrow(t('sync.2fa.badCode'))
    await expect(s.handle('twoFactorConfirm', { code: totpCode(secret, nowSec()) })).resolves.toBeNull()
    expect(await s.handle('twoFactorStatus', {})).toEqual({ enabled: true, required: false })
    // etkinken yeniden begin, etkin sırrı kodsuz ezemez
    await expect(s.handle('twoFactorBegin', {})).rejects.toThrow(t('sync.2fa.alreadyEnabled'))
  })

  it('code guessing is limited per user', async () => {
    const s = session('member', 'uye')
    const secret = await setup(s)
    const next = totpCode(secret, nowSec() + 30)
    const wrong = next === '000000' ? '111111' : '000000'
    for (let i = 0; i < 5; i++) await expect(s.handle('twoFactorDisable', { code: wrong })).rejects.toThrow(t('sync.2fa.badCode'))
    // doğru kod da artık denetlenmez; yeni bağlantı sayacı sıfırlamaz
    const s2 = hub.openSession(fakePort(), { user: s.currentUser! })
    await expect(s2.handle('twoFactorDisable', { code: next })).rejects.toThrow(/sn sonra/)
    expect(await s.handle('twoFactorStatus', {})).toMatchObject({ enabled: true })
  })

  it('concurrent bad codes cannot exceed the limiter', async () => {
    const s = session('member', 'uye')
    const secret = await setup(s)
    const wrong = totpCode(secret, nowSec() + 30) === '000000' ? '111111' : '000000'
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () => s.handle('twoFactorDisable', { code: wrong })))
    expect(rs.every((r) => r.status === 'rejected')).toBe(true)
    expect(String((rs[5] as PromiseRejectedResult).reason)).toMatch(/sn sonra/)
    expect(hub.totpFailures.get(s.currentUser!.id)).toHaveLength(5)
  })

  it('limiter window uses the hub clock', async () => {
    const s = session('member', 'uye')
    const secret = await setup(s)
    const base = Date.now()
    hub.now = () => base
    const wrong = totpCode(secret, nowSec() + 30) === '000000' ? '111111' : '000000'
    for (let i = 0; i < 5; i++) await expect(s.handle('twoFactorDisable', { code: wrong })).rejects.toThrow(t('sync.2fa.badCode'))
    await expect(s.handle('twoFactorDisable', { code: wrong })).rejects.toThrow(/sn sonra/)
    hub.now = () => base + 15 * 60_000 + 1
    await expect(s.handle('twoFactorDisable', { code: wrong })).rejects.toThrow(t('sync.2fa.badCode'))
  })

  it('same code in two concurrent confirms → exactly one succeeds', async () => {
    const s = session('member', 'uye')
    const r = (await s.handle('twoFactorBegin', {})) as { secretBase32: string }
    const code = totpCode(base32Decode(r.secretBase32), nowSec())
    const rs = await Promise.allSettled([s.handle('twoFactorConfirm', { code }), s.handle('twoFactorConfirm', { code })])
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
  })

  it('same code in two concurrent disables → exactly one succeeds', async () => {
    const s = session('member', 'uye')
    const secret = await setup(s)
    const code = totpCode(secret, nowSec() + 30)
    const rs = await Promise.allSettled([s.handle('twoFactorDisable', { code }), s.handle('twoFactorDisable', { code })])
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
  })

  it('resetUserPassword ve resetUserTwoFactor passkeyleri siler ve sayısını bildirir', async () => {
    const admin = session('admin', 'yonetici')
    const s = session('member', 'uye')
    const other = session('member', 'diger')
    const id = s.currentUser!.id
    const key = (k: string, userId = id) => q.insertPasskey({ id: k, userId, publicKey: Buffer.from('a'), counter: 0, transports: null, name: k, now: 1 })
    key('b', other.currentUser!.id)
    key('k1')
    key('k2')
    expect(await admin.handle('resetUserPassword', { userId: id, newPassword: 'yeni-parola-123' })).toEqual({ passkeysRemoved: 2 })
    expect(q.listPasskeys(id)).toEqual([])
    key('k3')
    expect(await admin.handle('resetUserTwoFactor', { userId: id })).toEqual({ passkeysRemoved: 1 })
    expect(q.listPasskeys(id)).toEqual([])
    expect(await admin.handle('resetUserTwoFactor', { userId: id })).toEqual({ passkeysRemoved: 0 })
    // başkasınınki durur
    expect(q.listPasskeys(other.currentUser!.id)).toHaveLength(1)
  })

  it('resetUserPassword for a missing user does not revoke', async () => {
    const admin = session('admin', 'yonetici')
    const revoked = vi.fn()
    hub.onUserRevoked = revoked
    await expect(admin.handle('resetUserPassword', { userId: 9999, newPassword: 'yeni-parola-123' })).rejects.toThrow(t('sync.auth.userNotFound'))
    expect(revoked).not.toHaveBeenCalled()
  })

  it('2fa reset also clears decrypted S/MIME content', async () => {
    const admin = session('admin', 'yonetici')
    const clear = vi.spyOn(hub.smimeCache, 'clearUser')
    const id = q.insertUser({ username: 'kayip', passwordHash: 'x', role: 'member' })
    await admin.handle('resetUserTwoFactor', { userId: id })
    expect(clear).toHaveBeenCalledWith(id)
  })

  it('confirm without begin is rejected', async () => {
    const s = session('member', 'uye')
    await expect(s.handle('twoFactorConfirm', { code: '123456' })).rejects.toThrow(t('sync.2fa.notStarted'))
  })

  it('disable rejects wrong code', async () => {
    const s = session('member', 'uye')
    const secret = await setup(s)
    const next = totpCode(secret, nowSec() + 30)
    await expect(s.handle('twoFactorDisable', { code: next === '000000' ? '111111' : '000000' })).rejects.toThrow(t('sync.2fa.badCode'))
    expect(await s.handle('twoFactorStatus', {})).toMatchObject({ enabled: true })
    // onaylamada kullanılan kod tekrar kullanılamaz
    await expect(s.handle('twoFactorDisable', { code: totpCode(secret, nowSec()) })).rejects.toThrow(t('sync.2fa.badCode'))
    await expect(s.handle('twoFactorDisable', { code: next })).resolves.toBeNull()
    expect(await s.handle('twoFactorStatus', {})).toEqual({ enabled: false, required: false })
    expect(q.getUserById(s.currentUser!.id)!.totp_secret_enc).toBeNull()
  })

  it('disable rejected while require2fa', async () => {
    const admin = session('admin', 'yonetici')
    const s = session('member', 'uye')
    const secret = await setup(s)
    await admin.handle('setPrefs', { values: { require2fa: '1' } })
    expect(await s.handle('twoFactorStatus', {})).toEqual({ enabled: true, required: true })
    await expect(s.handle('twoFactorDisable', { code: totpCode(secret, nowSec() + 30) })).rejects.toThrow(t('sync.2fa.requiredByAdmin'))
    expect(await s.handle('twoFactorStatus', {})).toMatchObject({ enabled: true })
    // require2fa genel bir ayar: yalnız yönetici yazar, herkes okur
    await expect(s.handle('setPrefs', { values: { require2fa: '0' } })).rejects.toThrow(t('sync.perm.adminRequired'))
    await expect(s.handle('setPrefs', { values: { smimeRevocation: 'off' } })).rejects.toThrow(t('sync.perm.adminRequired'))
    await expect(admin.handle('setPrefs', { values: { smimeRevocation: 'ocsp' } })).rejects.toThrow()
    await admin.handle('setPrefs', { values: { smimeRevocation: 'off' } })
    expect(((await s.handle('getPrefs', {})) as Record<string, string>).smimeRevocation).toBe('off')
    expect(((await s.handle('getPrefs', {})) as Record<string, string>).require2fa).toBe('1')
  })

  it('getUsers has no totp_secret_enc', async () => {
    const admin = session('admin', 'yonetici')
    const s = session('member', 'uye')
    await setup(s)
    const users = (await admin.handle('getUsers', {})) as Record<string, unknown>[]
    expect(JSON.stringify(users)).not.toMatch(/totp_secret|secret|password/i)
    expect(users.find((u) => u.username === 'uye')).toMatchObject({ twoFactorEnabled: true })
    expect(users.find((u) => u.username === 'yonetici')).toMatchObject({ twoFactorEnabled: false })
  })

  it('admin resets a member 2fa', async () => {
    const admin = session('admin', 'yonetici')
    const s = session('member', 'uye')
    await setup(s)
    await expect(s.handle('resetUserTwoFactor', { userId: s.currentUser!.id })).rejects.toThrow(t('sync.perm.adminRequired'))
    await admin.handle('resetUserTwoFactor', { userId: s.currentUser!.id })
    const row = q.getUserById(s.currentUser!.id)!
    expect([row.totp_enabled, row.totp_secret_enc, row.totp_last_step]).toEqual([0, null, null])
  })

  it('twoFactor methods work in desktop mode too', async () => {
    const desk = new RpcHub(hub.deps, 'desktop')
    const id = q.insertUser({ username: 'masa', passwordHash: 'x', role: 'admin' })
    const s = desk.openSession(fakePort())
    s.currentUser = { id, username: 'masa', role: 'admin', permittedGroupIds: [], manageableGroupIds: [] }
    await setup(s)
    expect(await s.handle('twoFactorStatus', {})).toMatchObject({ enabled: true })
  })

  // R2: kullanıcının yetkisi değişince web katmanı (Görev 7/8) açık oturumlarını kapatır
  it('onUserRevoked fires on disable, delete, password reset, role change and 2fa reset/disable', async () => {
    const admin = session('admin', 'yonetici')
    const revoked = vi.fn()
    hub.onUserRevoked = revoked
    const mk = (name: string) => q.insertUser({ username: name, passwordHash: 'x', role: 'member' })

    const a = mk('a')
    await admin.handle('updateUser', { userId: a, patch: { enabled: true } })
    expect(revoked).not.toHaveBeenCalled() // etkinleştirmek iptal değil
    await admin.handle('updateUser', { userId: a, patch: { enabled: false } })
    expect(revoked).toHaveBeenLastCalledWith(a)

    const b = mk('b')
    await admin.handle('updateUser', { userId: b, patch: { role: 'admin' } })
    expect(revoked).toHaveBeenLastCalledWith(b)

    const c = mk('c')
    await admin.handle('resetUserPassword', { userId: c, newPassword: 'yeni-parola-123' })
    expect(revoked).toHaveBeenLastCalledWith(c)

    const d = mk('d')
    await admin.handle('deleteUser', { userId: d })
    expect(revoked).toHaveBeenLastCalledWith(d)

    const e = session('member', 'e')
    const secret = await setup(e)
    revoked.mockClear()
    await e.handle('twoFactorDisable', { code: totpCode(secret, nowSec() + 30) })
    expect(revoked).toHaveBeenCalledWith(e.currentUser!.id)

    const f = session('member', 'f')
    await setup(f)
    revoked.mockClear()
    await admin.handle('resetUserTwoFactor', { userId: f.currentUser!.id })
    expect(revoked).toHaveBeenCalledWith(f.currentUser!.id)
  })
})
