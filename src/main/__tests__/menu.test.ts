import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import { menuTemplate, type MenuHandlers } from '../menu'

const on: MenuHandlers = { settings: () => {}, accounts: () => {} }
const label = (key: string): string => `L:${key}`
const build = (os: 'darwin' | 'win32' | 'linux', packaged: boolean): MenuItemConstructorOptions[] =>
  menuTemplate({ os, packaged, appName: 'GeckoMail', label, on })

const roles = (items: MenuItemConstructorOptions[]): string[] =>
  items.flatMap((i) => [...(i.role ? [i.role] : []), ...(Array.isArray(i.submenu) ? roles(i.submenu) : [])])

const r = (role: MenuItemConstructorOptions['role'], key: string): MenuItemConstructorOptions => ({ role, label: `L:${key}` })
const sep: MenuItemConstructorOptions = { type: 'separator' }

describe('menuTemplate', () => {
  // Bölünmeden önceki index.ts'in buildMenu dizisi
  it('darwin template unchanged', () => {
    expect(build('darwin', true)).toEqual([
      {
        label: 'GeckoMail',
        submenu: [
          r('about', 'about'),
          sep,
          { label: 'L:settings', accelerator: 'CmdOrCtrl+,', click: expect.any(Function) },
          { label: 'L:accounts', accelerator: 'CmdOrCtrl+Shift+,', click: expect.any(Function) },
          sep,
          r('services', 'services'),
          sep,
          r('hide', 'hide'),
          r('hideOthers', 'hideOthers'),
          r('unhide', 'showAll'),
          sep,
          r('quit', 'quit')
        ]
      },
      {
        label: 'L:edit',
        submenu: [
          r('undo', 'undo'),
          r('redo', 'redo'),
          sep,
          r('cut', 'cut'),
          r('copy', 'copy'),
          r('paste', 'paste'),
          r('pasteAndMatchStyle', 'pasteMatch'),
          r('delete', 'delete'),
          r('selectAll', 'selectAll')
        ]
      },
      {
        label: 'L:view',
        submenu: [
          r('resetZoom', 'actualSize'),
          r('zoomIn', 'zoomIn'),
          r('zoomOut', 'zoomOut'),
          sep,
          r('togglefullscreen', 'fullScreen')
        ]
      },
      { label: 'L:window', role: 'window', submenu: [r('minimize', 'minimize'), r('zoom', 'zoom'), sep, r('front', 'front')] }
    ])
  })

  it('paketsizde geliştirici öğeleri Görünüm başında', () => {
    const view = build('darwin', false)[2].submenu as MenuItemConstructorOptions[]
    expect(view.slice(0, 4)).toEqual([r('reload', 'reload'), r('forceReload', 'forceReload'), r('toggleDevTools', 'devTools'), sep])
  })

  it('win32 has no mac roles', () => {
    const got = roles(build('win32', true))
    for (const role of ['services', 'hide', 'hideOthers', 'unhide', 'front', 'zoom', 'window']) expect(got, role).not.toContain(role)
    for (const role of ['about', 'quit', 'copy', 'paste', 'togglefullscreen', 'minimize']) expect(got, role).toContain(role)
  })

  it('win32 menüsünde art arda ya da sondaki ayraç yok', () => {
    for (const top of build('win32', true)) {
      const items = top.submenu as MenuItemConstructorOptions[]
      items.forEach((it, i) => {
        if (it.type !== 'separator') return
        expect(i, top.label).toBeGreaterThan(0)
        expect(i, top.label).toBeLessThan(items.length - 1)
        expect(items[i + 1].type, top.label).not.toBe('separator')
      })
    }
  })

  it('ayarlar ve hesaplar işleyicilere bağlı', () => {
    const calls: string[] = []
    const t = menuTemplate({ os: 'win32', packaged: true, appName: 'GeckoMail', label, on: { settings: () => calls.push('s'), accounts: () => calls.push('a') } })
    const items = t[0].submenu as MenuItemConstructorOptions[]
    const click = (l: string): void => (items.find((i) => i.label === l)!.click as () => void)()
    click('L:settings')
    click('L:accounts')
    expect(calls).toEqual(['s', 'a'])
  })

  it('sunucu öğeleri yalnız verilirse uygulama menüsüne girer', () => {
    const base = { os: 'darwin' as const, packaged: true, appName: 'GeckoMail', label: (k: string) => k, on: { settings() {}, accounts() {} } }
    const plain = menuTemplate(base)
    expect(JSON.stringify(menuTemplate({ ...base, extra: [] }))).toBe(JSON.stringify(plain))
    const sub = menuTemplate({ ...base, extra: [{ label: 'yerele dön' }] })[0].submenu as { label?: string }[]
    expect(sub.map((i) => i.label)).toContain('yerele dön')
  })
})
