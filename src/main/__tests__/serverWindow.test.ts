import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, dialog: {}, ipcMain: {}, session: {}, shell: {} }))

import { downloadAllowed, handleDownload, KEYCHAIN_GROUP, macWebAuthnOptions, navigationAllowed, permissionAllowed, pickWebauthnAccount, safeServerPath, singleFlight, subframeAllowed, wallboardAllowed } from '../serverWindow'

const ORIGIN = 'https://posta.example.com'

describe('navigationAllowed', () => {
  it('navigation locked to origin', () => {
    expect(navigationAllowed(`${ORIGIN}/`, ORIGIN)).toBe(true)
    expect(navigationAllowed(`${ORIGIN}/?m=5`, ORIGIN)).toBe(true)
    for (const bad of [
      'https://evil.com/', 'file:///etc/passwd', 'https://x.posta.example.com/', 'http://posta.example.com/',
      'https://posta.example.com.evil.com/', 'https://posta.example.com:8443/', `https://u:p@posta.example.com/`,
      'javascript:alert(1)', 'data:text/html,x', 'about:blank', 'çöp'
    ]) expect(navigationAllowed(bad, ORIGIN), bad).toBe(false)
  })
})

describe('wallboardAllowed', () => {
  it('yerel modda giriş penceresi duvar panosuna ulaşamaz', () => {
    expect(wallboardAllowed('server', true)).toBe(true)
    expect(wallboardAllowed('local', true)).toBe(false)
    expect(wallboardAllowed('server', false)).toBe(false)
  })
})

describe('permissionAllowed', () => {
  it('permission denied by default', () => {
    expect(permissionAllowed('clipboard-sanitized-write')).toBe(true)
    expect(permissionAllowed('fullscreen')).toBe(true)
    for (const p of ['notifications', 'media', 'geolocation', 'openExternal', 'clipboard-read', 'pointerLock', 'unknown', ''])
      expect(permissionAllowed(p), p).toBe(false)
  })
})

describe('safeServerPath', () => {
  it('yalnız aynı kökende göreli yol', () => {
    expect(safeServerPath('/', ORIGIN)).toBe(`${ORIGIN}/`)
    expect(safeServerPath('/?m=5', ORIGIN)).toBe(`${ORIGIN}/?m=5`)
    for (const bad of ['//evil.com/', 'https://evil.com/', '\\\\evil.com', '/\\evil.com', 'yol', 5, null, undefined])
      expect(safeServerPath(bad, ORIGIN), String(bad)).toBeNull()
  })
})

describe('pickWebauthnAccount', () => {
  const a = { credentialId: 'bir', name: 'ali' }
  const b = { credentialId: 'iki', name: 'ayse' }

  it('single account picked without prompt', async () => {
    const choose = vi.fn(async () => 0)
    expect(await pickWebauthnAccount([a], choose)).toBe('bir')
    expect(choose).not.toHaveBeenCalled()
  })
  it('birden çoksa sorulur, iptal seçim yapmaz', async () => {
    expect(await pickWebauthnAccount([a, b], async () => 1)).toBe('iki')
    expect(await pickWebauthnAccount([a, b], async () => 2)).toBeUndefined()
    expect(await pickWebauthnAccount([a, b], async () => -1)).toBeUndefined()
    expect(await pickWebauthnAccount([], async () => 0)).toBeUndefined()
  })
})

describe('macOS passkey', () => {
  it('sağlama profili gelene dek kapalı: yetkisiz çağrı uygulamayı düşürebilir', () => {
    expect(KEYCHAIN_GROUP).toBe('')
    expect(macWebAuthnOptions('darwin', KEYCHAIN_GROUP)).toBeNull()
  })
  it('grup tanımlıysa yalnız macOS', () => {
    expect(macWebAuthnOptions('darwin', 'TAKIM.grup')).toEqual({ touchID: { keychainAccessGroup: 'TAKIM.grup' } })
    expect(macWebAuthnOptions('win32', 'TAKIM.grup')).toBeNull()
  })
})

describe('preload paketleri', () => {
  it('girişler yerel modül içe aktarmaz: sandbox parça yükleyemez', () => {
    for (const f of ['index.ts', 'server.ts']) {
      const s = readFileSync(join(__dirname, '../../preload', f), 'utf-8')
      expect(s.match(/from '\.[^']*'/g), f).toBeNull()
    }
  })
})

describe('sertifika ve oturum değeri', () => {
  const sources = readdirSync(join(__dirname, '..')).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(join(__dirname, '..', f), 'utf-8'))

  it('sertifika hatası hiçbir dalda atlanmaz', () => {
    for (const s of sources) {
      expect(s).not.toMatch(/['"]certificate-error['"]/)
      expect(s).not.toContain('setCertificateVerifyProc')
      expect(s).not.toMatch(/rejectUnauthorized:\s*false/)
      expect(s).not.toContain('ignore-certificate-errors')
    }
  })
  it('sunucu preload dar yüzey: ipcRenderer sayfaya verilmez', () => {
    const p = readFileSync(join(__dirname, '../../preload/server.ts'), 'utf-8')
    expect(p).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\s*\)/)
    expect(p.match(/exposeInMainWorld\('(\w+)'/g)).toEqual(["exposeInMainWorld('geckoDesktop'", "exposeInMainWorld('geckoDesktopConnect'"])
  })
})

describe('gezinme kilidi kenarları', () => {
  const o = 'https://posta.example.com'
  it('blob ana çerçeveye gezinemez', () => {
    expect(navigationAllowed(`blob:${o}/1234`, o)).toBe(false)
  })
  it('alt çerçeve yalnız srcdoc, kök ya da kökenin blob\'u', () => {
    expect(subframeAllowed('about:srcdoc', o)).toBe(true)
    expect(subframeAllowed('about:blank', o)).toBe(true)
    expect(subframeAllowed(`${o}/x`, o)).toBe(true)
    expect(subframeAllowed(`blob:${o}/1`, o)).toBe(true)
    expect(subframeAllowed('https://kotu.example/', o)).toBe(false)
    expect(subframeAllowed('blob:https://kotu.example/1', o)).toBe(false)
    expect(subframeAllowed('data:text/html,x', o)).toBe(false)
  })
})

describe('sunucu penceresi indirmesi', () => {
  const o = 'https://posta.example.com'
  const item = (name: string, url = `${o}/api/attachment/1`, chain = [url]) => {
    const done: ((e: unknown, state: string) => void)[] = []
    return {
      getURL: () => url, getURLChain: () => chain, getFilename: () => name, getSavePath: () => '/tmp/x', setSaveDialogOptions: vi.fn(), cancel: vi.fn(),
      once: (_: string, cb: (e: unknown, state: string) => void) => done.push(cb), finish: (s: string) => done.forEach((cb) => cb({}, s))
    }
  }
  const deps = (over = {}) => ({ origin: o, os: 'darwin' as const, warn: vi.fn(() => true), mark: vi.fn(async () => {}), now: () => 0, ...over })
  const run = (i: ReturnType<typeof item>, d: ReturnType<typeof deps>, gate = { lastWarn: -Infinity }) => {
    const e = { preventDefault: vi.fn() }
    handleDownload(e, i as never, d, gate)
    return e
  }

  it('kaynak köken ya da onun blob\'u', () => {
    expect(downloadAllowed([`${o}/a`], o)).toBe(true)
    expect(downloadAllowed([`blob:${o}/1`], o)).toBe(true)
    expect(downloadAllowed(['https://kotu.example/a'], o)).toBe(false)
    expect(downloadAllowed(['blob:https://kotu.example/1'], o)).toBe(false)
    expect(downloadAllowed(['data:text/plain,x'], o)).toBe(false)
    expect(downloadAllowed([`${o}/a`, 'https://kotu.example/b'], o)).toBe(false)
    expect(downloadAllowed([], o)).toBe(false)
  })
  it('kök dışı indirme durur, soru sorulmaz', () => {
    const d = deps()
    const e = run(item('a.pdf', 'https://kotu.example/a'), d)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(d.warn).not.toHaveBeenCalled()
  })
  it('tehlikeli tür uyarır, reddedilirse iner', () => {
    const d = deps({ warn: vi.fn(() => false) })
    const e = run(item('fatura.pdf.command'), d)
    expect(d.warn).toHaveBeenCalledWith('fatura.pdf.command')
    expect(e.preventDefault).toHaveBeenCalled()
  })
  it('tehlikeli tür onaylanırsa iner ve işaretlenir', () => {
    const d = deps()
    const i = item('fatura.pdf.command')
    expect(run(i, d).preventDefault).not.toHaveBeenCalled()
    i.finish('completed')
    expect(d.mark).toHaveBeenCalledWith('/tmp/x')
  })
  it('olağan dosya sorulmaz, işaret tamamlanınca konur', () => {
    const d = deps()
    const i = item('rapor.pdf')
    run(i, d)
    expect(d.warn).not.toHaveBeenCalled()
    expect(d.mark).not.toHaveBeenCalled()
    i.finish('cancelled')
    expect(d.mark).not.toHaveBeenCalled()
    i.finish('completed')
    expect(d.mark).toHaveBeenCalledTimes(1)
  })
  it('uyarı seli: sayfa pencereyi modal döngüye sokamaz', () => {
    const d = deps()
    const gate = { lastWarn: -Infinity }
    expect(run(item('a.exe'), d, gate).preventDefault).not.toHaveBeenCalled()
    expect(run(item('b.exe'), d, gate).preventDefault).toHaveBeenCalled()
    expect(d.warn).toHaveBeenCalledTimes(1)
  })
  it('Windows adı temizlenir', () => {
    const i = item('a:b.pdf')
    run(i, deps({ os: 'win32' }))
    expect(i.setSaveDialogOptions).toHaveBeenCalledWith({ defaultPath: 'a_b.pdf' })
  })
})

describe('singleFlight', () => {
  it('sürerken ikinci çağrı yedek değeri alır, bitince açılır', async () => {
    let release = () => {}
    const fn = vi.fn(() => new Promise<string>((r) => { release = () => r('bitti') }))
    const once = singleFlight(fn, 'meşgul')
    const a = once()
    expect(await once()).toBe('meşgul')
    release()
    expect(await a).toBe('bitti')
    expect(fn).toHaveBeenCalledTimes(1)
    void once()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
