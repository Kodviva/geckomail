import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough, Readable, Writable } from 'stream'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPassword } from '../../sync/auth/password'
import { openDb } from '../../sync/db'
import { makeQueries } from '../../sync/db/queries'
import { loginKey } from '../auth'
import { EXIT_FATAL, readTtyLine, runCli } from '../cli'
import type { ServerConfig } from '../config'

class Sink extends Writable {
  text = ''
  override _write(c: Buffer, _e: string, cb: () => void): void {
    this.text += c.toString()
    cb()
  }
}

describe('CLI', () => {
  let dir: string
  let cfg: ServerConfig
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-cli-'))
    cfg = { dataDir: dir, listenHost: '127.0.0.1', listenPort: 0, keyFile: join(dir, 'master.key'), publicOrigin: 'http://localhost', trustedProxyDepth: 0, webDir: join(dir, 'web') }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const run = async (argv: string[], input = ''): Promise<{ code: number; out: string; err: string }> => {
    const stdout = new Sink()
    const stderr = new Sink()
    const code = await runCli(argv, { stdin: Readable.from([input]), stdout, stderr }, cfg)
    return { code, out: stdout.text, err: stderr.text }
  }
  it('smime-selftest başarıda 0 döner, DB açmaz', async () => {
    const r = await run(['smime-selftest'])
    expect(r).toMatchObject({ code: 0, err: '' })
    expect(r.out).toContain('smime')
    expect(existsSync(join(dir, 'geckomail.db'))).toBe(false)
  })

  const withDb = <T>(fn: (q: ReturnType<typeof makeQueries>) => T): T => {
    const db = openDb(dir)
    try {
      return fn(makeQueries(db))
    } finally {
      db.close()
    }
  }

  it('create-admin reads password from stdin and hashes it', async () => {
    const r = await run(['create-admin', 'ayse'], 'gizli-parola-123\n')
    expect(r.code).toBe(0)
    expect(r.out + r.err).not.toContain('gizli-parola-123')
    withDb((q) => {
      const u = q.getUserByUsername('ayse')!
      expect(u.password_hash.startsWith('scrypt$')).toBe(true)
      expect(u.role).toBe('admin')
      expect(u.enabled).toBe(1)
    })
  })

  it('create-admin rejects empty password', async () => {
    expect((await run(['create-admin', 'ayse'], '\n')).code).not.toBe(0)
    expect((await run(['create-admin', 'ayse'], 'kisa')).code).not.toBe(0)
    expect((await run(['create-admin', 'ayse'], '')).code).not.toBe(0)
    withDb((q) => expect(q.getUserByUsername('ayse')).toBeUndefined())
  })

  it('create-admin leaves an existing user unchanged', async () => {
    const hash = hashPassword('eski-parola-1')
    withDb((q) => q.insertUser({ username: 'ayse', passwordHash: hash, role: 'member' }))
    const r = await run(['create-admin', 'ayse'], 'yeni-parola-123\n')
    expect(r.code).toBe(1)
    withDb((q) => {
      const u = q.getUserByUsername('ayse')!
      expect(u.password_hash).toBe(hash)
      expect(u.role).toBe('member')
    })
  })

  it('reset-2fa clears totp and revokes sessions', async () => {
    const id = withDb((q) => {
      const uid = q.insertUser({ username: 'ayse', passwordHash: hashPassword('parola-123456'), role: 'admin' })
      q.setTotpPending(uid, Buffer.from('sir'))
      q.enableTotp(uid, 5)
      q.insertWebSession({ idHash: 'h1', userId: uid, now: Date.now(), expiresAt: Date.now() + 1e6, ip: null, userAgent: null })
      for (const k of ['k1', 'k2']) q.insertPasskey({ id: k, userId: uid, publicKey: Buffer.from('a'), counter: 0, transports: null, name: k, now: 1 })
      return uid
    })
    const r = await run(['reset-2fa', 'ayse'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('2 passkey silindi')
    withDb((q) => {
      const u = q.getUserById(id)!
      expect(u.totp_enabled).toBe(0)
      expect(u.totp_secret_enc).toBeNull()
      expect(u.totp_last_step).toBeNull()
      expect(q.getWebSession('h1')).toBeUndefined()
      expect(q.listPasskeys(id)).toEqual([])
    })
  })

  it('reset-2fa fails for missing user', async () => {
    expect((await run(['reset-2fa', 'yok'])).code).toBe(1)
  })

  it('create-admin rejects a password line over 1024 bytes', async () => {
    const r = await run(['create-admin', 'ayse'], 'x'.repeat(1025) + '\n')
    expect(r.code).toBe(1)
    expect(r.err).toContain('1024')
    // satır sonu hiç gelmese de okuma sınırda biter
    expect((await run(['create-admin', 'ayse'], 'y'.repeat(5000))).code).toBe(1)
    // tam sınır kabul edilir
    expect((await run(['create-admin', 'ayse'], 'z'.repeat(1024) + '\r\n')).code).toBe(0)
  })

  it('create-admin on a TTY reads without echo and restores the mode', async () => {
    const tty = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() })
    tty.setRawMode.mockImplementation((v: boolean) => (tty.isRaw = v))
    const stdout = new Sink()
    const stderr = new Sink()
    const p = runCli(['create-admin', 'ayse'], { stdin: tty, stdout, stderr }, cfg)
    await new Promise((r) => setTimeout(r, 20))
    expect(tty.isRaw).toBe(true)
    // geri silme son karakteri siler
    tty.write('gizli-parola-12X\u007f3')
    tty.write('\r')
    expect(await p).toBe(0)
    expect(tty.setRawMode.mock.calls).toEqual([[true], [false]])
    expect(stdout.text + stderr.text).not.toContain('gizli')
    expect(stderr.text.endsWith('\n')).toBe(true)
    withDb((q) => expect(q.getUserByUsername('ayse')).toBeDefined())
    // auth doğrulaması: parola geri silme sonrası haliyle kaydedildi
    const { verifyPassword } = await import('../../sync/auth/password')
    withDb((q) => expect(verifyPassword('gizli-parola-123', q.getUserByUsername('ayse')!.password_hash)).toBe(true))
  })

  it('readTtyLine: Ctrl-C cancels, overlong line rejected, mode restored', async () => {
    const mk = () => {
      const t = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() })
      t.setRawMode.mockImplementation((v: boolean) => (t.isRaw = v))
      return t
    }
    const a = mk()
    const pa = readTtyLine(a, new Sink())
    a.write('abc\u0003')
    expect(await pa).toEqual({ ok: false, reason: 'cancelled' })
    expect(a.isRaw).toBe(false)
    const b = mk()
    const pb = readTtyLine(b, new Sink())
    b.write('ş'.repeat(513)) // 1026 bayt
    expect(await pb).toEqual({ ok: false, reason: 'tooLong' })
    expect(b.isRaw).toBe(false)
  })

  it('unlock removes login attempts for the normalized username', async () => {
    withDb((q) => {
      q.insertUser({ username: 'Ayse', passwordHash: hashPassword('parola-123456'), role: 'member' })
      for (let i = 0; i < 5; i++) q.recordWebLoginAttempt(Date.now(), '10.0.0.1', loginKey(' Ayse '), 0)
      q.recordWebLoginAttempt(Date.now(), '10.0.0.1', 'baska', 0)
    })
    const r = await run(['unlock', 'Ayse'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('5')
    withDb((q) => {
      expect(q.webLoginFailuresSince(0, '10.0.0.9', 'ayse').byUser).toBe(0)
      expect(q.webLoginFailuresSince(0, '10.0.0.9', 'baska').byUser).toBe(1)
    })
  })

  it('unlock fails for missing user or no argument', async () => {
    expect((await run(['unlock', 'yok'])).code).toBe(1)
    expect((await run(['unlock'])).code).toBe(1)
  })

  it('reset-vault-throttle clears every bucket and prints one line without secrets', async () => {
    const now = Date.now()
    withDb((q) => {
      q.prefSet('vault_pass_fails', JSON.stringify({ hub: [now], admins: [now], users: { '1': [now] }, day: [now], adminDay: [now], clearedAt: now }))
    })
    const r = await run(['reset-vault-throttle'])
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(r.out.trim().split('\n')).toHaveLength(1)
    withDb((q) => {
      const f = JSON.parse(q.prefGet('vault_pass_fails') ?? '{}') as Record<string, unknown>
      expect(f.hub ?? []).toEqual([])
      expect(f.admins ?? []).toEqual([])
      expect(f.users ?? {}).toEqual({})
      expect(f.day ?? []).toEqual([])
      expect(f.adminDay ?? []).toEqual([])
      expect(f.clearedAt).toBeUndefined()
    })
  })

  it('serve exits with the fatal code when the database is too new', async () => {
    const db = new Database(join(dir, 'geckomail.db'))
    db.pragma('user_version = 9999')
    db.close()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const saved = process.exitCode
    try {
      const r = await run(['serve'])
      expect(r.code).toBe(EXIT_FATAL)
      expect(EXIT_FATAL).toBe(3)
    } finally {
      process.exitCode = saved // ev sahibi fatal'ı test sürecinin çıkış kodunu da ayarlar
      err.mockRestore()
    }
  })

  it('unknown command exits 1', async () => {
    expect((await run(['bilinmeyen'])).code).toBe(1)
  })
})
