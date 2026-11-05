import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

const electron = vi.hoisted(() => {
  const tray = { setContextMenu: vi.fn(), setToolTip: vi.fn(), on: vi.fn() }
  return {
    tray,
    Tray: vi.fn(function Tray() { return tray }),
    buildFromTemplate: vi.fn((t: unknown) => t),
    createFromPath: vi.fn(() => ({ setTemplateImage: vi.fn() }))
  }
})
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: electron.buildFromTemplate },
  Tray: electron.Tray,
  nativeImage: { createFromPath: electron.createFromPath }
}))

import { setAgentState, shouldHintOnClose, startTray, trayIconPath, trayMenuTemplate, type AgentState, type TrayHandlers } from '../tray'

const label = (k: string, v?: Record<string, unknown>): string => (v ? `${k}:${JSON.stringify(v)}` : k)
const on = (): TrayHandlers => ({ open: vi.fn(), installUpdate: vi.fn(), quit: vi.fn() })
const local: AgentState = { mode: 'local', link: null, unread: 0, updateReady: false }
const server: AgentState = { mode: 'server', link: 'online', unread: 0, updateReady: false }
const labels = (t: MenuItemConstructorOptions[]): (string | undefined)[] => t.filter((i) => i.type !== 'separator').map((i) => i.label)
const item = (t: MenuItemConstructorOptions[], l: string): MenuItemConstructorOptions => t.find((i) => i.label === l)!

describe('tepsi menüsü', () => {
  it('yerel mod: okunmamış sayısı varsa görünür', () => {
    expect(labels(trayMenuTemplate(local, label, on()))).toEqual(['open', 'quit'])
    const t = trayMenuTemplate({ ...local, unread: 3 }, label, on())
    expect(labels(t)).toEqual(['unread:{"count":3}', 'open', 'quit'])
    expect(t[0].enabled).toBe(false)
  })

  it('sunucu modu bağlantı durumunu söyler', () => {
    expect(labels(trayMenuTemplate(server, label, on()))).toEqual(['online', 'open', 'quit'])
    expect(labels(trayMenuTemplate({ ...server, link: 'offline' }, label, on()))).toEqual(['offline', 'open', 'quit'])
  })

  it('signedOut: giriş öğesi pencereyi açar', () => {
    const h = on()
    const t = trayMenuTemplate({ ...server, link: 'signedOut' }, label, h)
    expect(labels(t)).toEqual(['signedOut', 'signIn', 'quit'])
    ;(item(t, 'signIn').click as () => void)()
    expect(h.open).toHaveBeenCalled()
  })

  it('Quit item sets quitting', () => {
    let quitting = false
    const h = { ...on(), quit: () => { quitting = true } }
    ;(item(trayMenuTemplate(local, label, h), 'quit').click as () => void)()
    expect(quitting).toBe(true)
  })

  it('update item only when ready', () => {
    expect(labels(trayMenuTemplate(local, label, on()))).not.toContain('update')
    const h = on()
    const t = trayMenuTemplate({ ...local, updateReady: true }, label, h)
    ;(item(t, 'update').click as () => void)()
    expect(h.installUpdate).toHaveBeenCalled()
  })
})

describe('simge ve ipucu', () => {
  it('mac template icon path', () => {
    expect(trayIconPath('darwin', '/kaynak')).toBe(join('/kaynak', 'trayTemplate.png'))
    expect(trayIconPath('win32', '/kaynak')).toBe(join('/kaynak', 'tray.ico'))
  })
  it('hint once on win32 only', () => {
    expect(shouldHintOnClose({ os: 'win32', shown: false })).toBe(true)
    expect(shouldHintOnClose({ os: 'win32', shown: true })).toBe(false)
    expect(shouldHintOnClose({ os: 'darwin', shown: false })).toBe(false)
  })
})

describe('tepsi yaşam döngüsü', () => {
  beforeEach(() => vi.clearAllMocks())
  it('durum değişince menü ve ipucu yenilenir', () => {
    startTray({ os: 'darwin', resources: '/r', state: local, label, on: on() })
    const before = electron.tray.setContextMenu.mock.calls.length
    setAgentState({ unread: 2 })
    expect(electron.tray.setContextMenu.mock.calls.length).toBe(before + 1)
    expect(electron.tray.setToolTip).toHaveBeenLastCalledWith('GeckoMail · unread:{"count":2}')
  })
})
