import { describe, expect, it, vi } from 'vitest'
import { applyLoginItem, loginItemQuery, loginItemSettings, loginItemSupport, startedHidden } from '../loginItem'

describe('oturum açılışı', () => {
  it('loginItemSupport üç dal', () => {
    expect(loginItemSupport({ os: 'darwin', windowsStore: false, packaged: true })).toBe('native')
    expect(loginItemSupport({ os: 'win32', windowsStore: false, packaged: true })).toBe('native')
    expect(loginItemSupport({ os: 'win32', windowsStore: true, packaged: true })).toBe('storeSettings')
    expect(loginItemSupport({ os: 'darwin', windowsStore: false, packaged: false })).toBe('none')
    expect(loginItemSupport({ os: 'linux', windowsStore: false, packaged: true })).toBe('none')
  })

  it('Windows gizli argümanla kaydolur, mac argümansız', () => {
    expect(loginItemSettings(true, 'win32')).toEqual({ openAtLogin: true, args: ['--hidden'] })
    expect(loginItemSettings(false, 'win32')).toEqual({ openAtLogin: false, args: ['--hidden'] })
    expect(loginItemSettings(true, 'darwin')).toEqual({ openAtLogin: true })
    expect(loginItemQuery('win32')).toEqual({ args: ['--hidden'] }) // Windows aynı argümanla sorulmazsa kapalı görünür
    expect(loginItemQuery('darwin')).toBeUndefined()
  })

  it('off by default', () => {
    const set = vi.fn()
    expect(applyLoginItem(set, 'native', true, 'darwin')).toBe(true)
    expect(set).toHaveBeenCalledTimes(1)
    set.mockClear()
    for (const support of ['storeSettings', 'none'] as const) expect(applyLoginItem(set, support, true, 'win32')).toBe(false)
    expect(set).not.toHaveBeenCalled()
  })

  it('startedHidden argüman ve mac bayrağı', () => {
    expect(startedHidden({ os: 'win32', argv: ['x.exe', '--hidden'], wasOpenedAtLogin: false })).toBe(true)
    expect(startedHidden({ os: 'win32', argv: ['x.exe'], wasOpenedAtLogin: true })).toBe(false)
    expect(startedHidden({ os: 'darwin', argv: ['x', '--hidden'], wasOpenedAtLogin: false })).toBe(false)
    expect(startedHidden({ os: 'darwin', argv: ['x'], wasOpenedAtLogin: true })).toBe(true)
  })
})
