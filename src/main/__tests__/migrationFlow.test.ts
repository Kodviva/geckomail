import { describe, expect, it, vi } from 'vitest'

const windows: { closed: boolean }[] = []
vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, dialog: {}, ipcMain: {}, session: {} }))
vi.mock('../serverWindow', () => ({
  SERVER_PARTITION: 'persist:gecko-server', probe: vi.fn(), singleFlight: (f: unknown) => f,
  createServerWindow: () => {
    const w = { closed: false, isDestroyed: () => false, close: () => void (w.closed = true), once: () => {} }
    windows.push(w)
    return w
  }
}))
vi.mock('../syncProcess', () => ({ importPlan: vi.fn(), importSeal: vi.fn() }))

import { helloUser, signIn } from '../migrationFlow'

const ses = { cookies: { on() {}, removeListener() {} } } as never

function start() {
  const cb: { ready?: (r: 'ready') => void; out?: () => void; off?: () => void } = {}
  const done = signIn({ start() {}, stop() {} } as never, ses, 'https://posta.example.com', {
    onReady: (f) => { cb.ready = f },
    onSignedOut: (f) => { cb.out = f },
    onOffline: (f) => { cb.off = f }
  })
  return { cb, done }
}

describe('signIn', () => {
  it('giriş bittikten sonra 4401 kimsenin kapatmayacağı pencere açmaz', async () => {
    windows.length = 0
    const { cb, done } = start()
    cb.ready!('ready')
    await done
    cb.out!()
    expect(windows).toHaveLength(0)
  })

  it('giriş sürerken oturum yoksa pencere açılır, hazır olunca kapanır', async () => {
    windows.length = 0
    const { cb, done } = start()
    cb.out!()
    expect(windows).toHaveLength(1)
    cb.ready!('ready')
    await done
    expect(windows[0].closed).toBe(true)
  })
})

describe('helloUser', () => {
  it('rol ve kullanıcı adı yalnız beklenen biçimde okunur', () => {
    expect(helloUser({ user: { role: 'admin', username: 'ayse' } })).toEqual({ admin: true, username: 'ayse' })
    expect(helloUser({ user: { role: 'member', username: 'ali' } })).toEqual({ admin: false, username: 'ali' })
    expect(helloUser({ user: { role: 'admin', username: 5 } })).toEqual({ admin: true, username: '' })
    expect(helloUser(null)).toEqual({ admin: false, username: '' })
  })
})
