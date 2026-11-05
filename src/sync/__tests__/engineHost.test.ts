import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../shared/i18n/locales/all'
import { sealWithKey } from '../../server/keyfile'
import { createServerHost } from '../../server/hosts/serverHost'
import { t } from '../../shared/i18n'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { startEngine, type Engine } from '../engine'
import type { EngineHost, HostSignal } from '../host'
import { createParentPortHost } from '../hosts/parentPortHost'

type Listener = (e: { data: unknown; ports?: unknown[] }) => void
function fakePort() {
  let listener: Listener = () => {}
  const postMessage = vi.fn()
  return { postMessage, on: (_: 'message', cb: Listener) => void (listener = cb), emit: (data: unknown, ports?: unknown[]) => listener({ data, ports }) }
}

describe('parentPortHost', () => {
  it('notify ve badge iletiye çevrilir', () => {
    const p = fakePort()
    const { host } = createParentPortHost(p as never)
    host.notify({ title: 'a', body: 'b', accountId: 3 })
    host.badge(4)
    expect(p.postMessage).toHaveBeenCalledWith({ type: 'notify', title: 'a', body: 'b', accountId: 3 })
    expect(p.postMessage).toHaveBeenCalledWith({ type: 'badge', count: 4 })
  })

  it('bildirim eylemi sinyale çevrilir, sonuç main\'e döner', () => {
    const p = fakePort()
    const { host, onSignal } = createParentPortHost(p as never)
    const signals: HostSignal[] = []
    onSignal((s) => signals.push(s))
    p.emit({ type: 'notify-action', id: 4, action: 'archive', messageId: 9 })
    p.emit({ type: 'notify-action', id: 5, action: 'sil', messageId: 9 })
    p.emit({ type: 'notify-action', id: 6, action: 'read', messageId: 'x' })
    expect(signals).toEqual([{ type: 'notify-action', id: 4, action: 'archive', messageId: 9 }])
    host.notifyActionResult!(4, true)
    expect(p.postMessage).toHaveBeenCalledWith({ type: 'notify-action:res', id: 4, ok: true })
  })

  it('fatal iletisi gönderilir', () => {
    const p = fakePort()
    createParentPortHost(p as never).host.fatal('x')
    expect(p.postMessage).toHaveBeenCalledWith({ type: 'fatal', message: 'x' })
  })

  it('encrypt yanıtla çözülür', async () => {
    const p = fakePort()
    const { host } = createParentPortHost(p as never)
    const pr = host.encrypt(['x'])
    const sent = p.postMessage.mock.calls[0][0] as { type: string; id: number; values: string[] }
    expect(sent).toMatchObject({ type: 'encrypt', values: ['x'] })
    const out = [new Uint8Array([1])]
    p.emit({ type: 'encrypt:res', id: sent.id, values: out })
    await expect(pr).resolves.toEqual(out)
  })

  it('crypto:err reddeder', async () => {
    const p = fakePort()
    const { host } = createParentPortHost(p as never)
    const pr = host.decrypt([new Uint8Array([1])])
    const sent = p.postMessage.mock.calls[0][0] as { id: number }
    p.emit({ type: 'crypto:err', id: sent.id })
    await expect(pr).rejects.toThrow()
  })

  it('15 sn yanıt yoksa zaman aşımıyla reddeder', async () => {
    vi.useFakeTimers()
    try {
      const p = fakePort()
      const { host } = createParentPortHost(p as never)
      const pr = host.encrypt(['x'])
      const assertion = expect(pr).rejects.toThrow(/./)
      await vi.advanceTimersByTimeAsync(15_001)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('network sinyali ve port iletilir', () => {
    const p = fakePort()
    const b = createParentPortHost(p as never)
    const signals: HostSignal[] = []
    const ports: unknown[] = []
    b.onSignal((s) => signals.push(s))
    b.onRpcPort((x) => ports.push(x))
    p.emit({ type: 'network', online: false })
    p.emit({ type: 'resume' })
    const mp = {}
    p.emit({ type: 'port' }, [mp])
    expect(signals).toEqual([{ type: 'network', online: false }, { type: 'resume' }])
    expect(ports).toEqual([mp])
  })
})

describe('startEngine', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-engine-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('DB açar, hub döner, stop DB kapatır', async () => {
    const host: EngineHost = { encrypt: async (v) => v.map((s) => Buffer.from(s)), decrypt: async (b) => b, notify: vi.fn(), badge: vi.fn(), fatal: vi.fn() }
    const engine = startEngine({ userData: dir, host, mode: 'desktop' })
    expect(engine.hub).toBeTruthy()
    await engine.stop()
    expect(() => openDb(dir).close()).not.toThrow()
  })

  function undecryptableAccount(): number {
    const db = openDb(dir)
    const id = makeQueries(db).insertAccount({
      email: 'a@example.test', displayName: null, imapHost: 'imap.example.test', imapPort: 993,
      smtpHost: 'smtp.example.test', smtpPort: 465, passwordEnc: Buffer.from('v10xxxx')
    })
    db.close()
    return id
  }
  const emptyDecrypt = (): EngineHost => ({ encrypt: async (v: string[]) => v.map((s) => Buffer.from(s)), decrypt: async (b: Uint8Array[]) => b.map(() => ''), notify: vi.fn(), badge: vi.fn(), fatal: vi.fn() }) as unknown as EngineHost

  it('no keychain wait on win32', async () => {
    const setTimer = vi.spyOn(globalThis, 'setTimeout')
    const accountId = undecryptableAccount()
    const host = emptyDecrypt()
    const engine = startEngine({ userData: dir, host, mode: 'desktop', os: 'win32' })
    await vi.waitFor(() => expect(host.notify).toHaveBeenCalledWith({ title: 'GeckoMail', body: t('sync.status.credentialStoreLost') }))
    expect(setTimer.mock.calls.some(([, ms]) => ms === 60_000)).toBe(false)
    await engine.stop()
    setTimer.mockRestore()
    expect(host.notify).toHaveBeenCalledTimes(1)
    const db = openDb(dir)
    expect(makeQueries(db).getAccountRow(accountId)?.status_detail).toBe(t('sync.status.credentialStoreLost'))
    db.close()
  })

  it('darwin wait unchanged', async () => {
    const setTimer = vi.spyOn(globalThis, 'setTimeout')
    const accountId = undecryptableAccount()
    const host = emptyDecrypt()
    const engine = startEngine({ userData: dir, host, mode: 'desktop', os: 'darwin' })
    await vi.waitFor(() => expect(host.notify).toHaveBeenCalledWith({ title: 'GeckoMail', body: t('sync.status.keychainWait') }))
    expect(setTimer.mock.calls.some(([, ms]) => ms === 60_000)).toBe(true)
    await engine.stop()
    setTimer.mockRestore()
    const db = openDb(dir)
    expect(makeQueries(db).getAccountRow(accountId)?.status_detail).toBe(t('sync.status.keychainWait'))
    db.close()
  })
})

describe('startEngine sunucu modu', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-engine-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('undecryptable password marks account auth-needed', async () => {
    const key = randomBytes(32)
    const db = openDb(dir)
    const accountId = makeQueries(db).insertAccount({
      email: 'a@example.test', displayName: null, imapHost: 'imap.example.test', imapPort: 993,
      smtpHost: 'smtp.example.test', smtpPort: 465, passwordEnc: Buffer.from('v10xxxx') // safeStorage biçimi
    })
    db.close()
    let engine: Engine | null = null
    const host = createServerHost(key, () => engine?.hub ?? null)
    engine = startEngine({ userData: dir, host, mode: 'server', notifySink: () => ({ deliver() {} }) })
    const spy = vi.spyOn(engine.hub, 'broadcast')
    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith('account:status', expect.objectContaining({ accountId, status: 'auth_failed', detail: t('sync.server.passwordNeeded') }))
    )
    await engine.stop()
    const db2 = openDb(dir)
    expect(makeQueries(db2).getAccountRow(accountId)?.status).toBe('auth_failed')
    db2.close()
  })

  it('bozuk tek blob yalnız kendi hesabını auth-needed yapar', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const key = randomBytes(32)
    const bad = Buffer.from(sealWithKey(key, Buffer.from('x')))
    bad[bad.length - 1] ^= 1
    const db = openDb(dir)
    const q = makeQueries(db)
    const mk = (email: string, passwordEnc: Buffer) =>
      q.insertAccount({ email, displayName: null, imapHost: 'imap.example.test', imapPort: 993, smtpHost: 'smtp.example.test', smtpPort: 465, passwordEnc })
    const goodId = mk('iyi@example.test', Buffer.from(sealWithKey(key, Buffer.from('parola'))))
    const badId = mk('bozuk@example.test', bad)
    db.close()
    let engine: Engine | null = null
    engine = startEngine({ userData: dir, host: createServerHost(key, () => engine?.hub ?? null), mode: 'server', notifySink: () => ({ deliver() {} }) })
    const spy = vi.spyOn(engine.hub, 'broadcast')
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith('account:status', expect.objectContaining({ accountId: badId, status: 'auth_failed' })))
    expect(spy).not.toHaveBeenCalledWith('account:status', expect.objectContaining({ accountId: goodId, status: 'auth_failed' }))
    await engine.stop()
    const db2 = openDb(dir)
    expect(makeQueries(db2).getAccountRow(goodId)?.status).not.toBe('auth_failed')
    db2.close()
  })
})
