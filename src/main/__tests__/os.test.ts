import { describe, expect, it } from 'vitest'
import { appUserModelId, autoUpdateAllowed, devRendererUrl, encryptionPolicy, TOAST_CLSID, windowChrome } from '../os'

describe('windowChrome', () => {
  it('darwin yerel: hiddenInset', () => {
    expect(windowChrome('darwin', 'local')).toEqual({ titleBarStyle: 'hiddenInset' })
  })
  it('win32 yerel: hidden ve pencere düğmeleri katmanı', () => {
    const c = windowChrome('win32', 'local')
    expect(c.titleBarStyle).toBe('hidden')
    expect(c.titleBarOverlay).toEqual({ color: expect.any(String), symbolColor: expect.any(String), height: 38 })
  })
  it('darwin sunucu: yerel çerçeve', () => {
    expect(windowChrome('darwin', 'server').titleBarStyle).toBeUndefined()
    expect(windowChrome('darwin', 'server').titleBarOverlay).toBeUndefined()
  })
  it('win32 sunucu: yerel çerçeve', () => {
    expect(windowChrome('win32', 'server').titleBarStyle).toBeUndefined()
    expect(windowChrome('win32', 'server').titleBarOverlay).toBeUndefined()
  })
})

describe('appUserModelId', () => {
  const appId = 'com.kodviva.geckomail'
  it('win32 NSIS: appId', () => {
    expect(appUserModelId({ os: 'win32', windowsStore: false, appId })).toBe(appId)
  })
  it('Store: null (paket kimliği kullanılır)', () => {
    expect(appUserModelId({ os: 'win32', windowsStore: true, appId })).toBeNull()
  })
  it('diğer işletim sistemleri: null', () => {
    expect(appUserModelId({ os: 'darwin', windowsStore: false, appId })).toBeNull()
    expect(appUserModelId({ os: 'linux', windowsStore: false, appId })).toBeNull()
  })
})

describe('autoUpdateAllowed', () => {
  it('Store ve paketsizde false', () => {
    expect(autoUpdateAllowed({ os: 'win32', packaged: true, windowsStore: true })).toBe(false)
    expect(autoUpdateAllowed({ os: 'darwin', packaged: false, windowsStore: false })).toBe(false)
    expect(autoUpdateAllowed({ os: 'win32', packaged: false, windowsStore: false })).toBe(false)
  })
  it('paketli mac ve NSIS: true', () => {
    expect(autoUpdateAllowed({ os: 'darwin', packaged: true, windowsStore: false })).toBe(true)
    expect(autoUpdateAllowed({ os: 'win32', packaged: true, windowsStore: false })).toBe(true)
  })
})

describe('encryptionPolicy', () => {
  it('kullanılabilirse şifreler', () => {
    expect(encryptionPolicy('darwin', true)).toBe('encrypt')
    expect(encryptionPolicy('win32', true)).toBe('encrypt')
  })
  it('refuse only on win32', () => {
    expect(encryptionPolicy('win32', false)).toBe('refuse')
    expect(encryptionPolicy('darwin', false)).toBe('plain')
    expect(encryptionPolicy('linux', false)).toBe('plain')
  })
})

describe('TOAST_CLSID', () => {
  it('küme parantezsiz GUID', () => {
    expect(TOAST_CLSID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

describe('devRendererUrl', () => {
  it('paketli uygulama ortam değişkenine uymaz', () => {
    expect(devRendererUrl({ packaged: true, url: 'http://kotu.example' })).toBeUndefined()
    expect(devRendererUrl({ packaged: false, url: 'http://localhost:5173' })).toBe('http://localhost:5173')
    expect(devRendererUrl({ packaged: false, url: undefined })).toBeUndefined()
  })
})
