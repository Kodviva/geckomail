import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { TOAST_CLSID } from '../../src/main/os'
import { problems } from '../check-win-package.mjs'

const root = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')
const pkg = JSON.parse(read('package.json'))
const lock = JSON.parse(read('package-lock.json'))
const workflow = read('.github/workflows/windows.yml')
const uses = (y: string): string[] => [...y.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1])

describe('paket yapılandırması', () => {
  it('both arches on both targets', () => {
    expect(pkg.build.win.target).toEqual([
      { target: 'nsis', arch: ['x64', 'arm64'] },
      { target: 'appx', arch: ['x64', 'arm64'] }
    ])
  })

  it('mac block unchanged', () => {
    expect(pkg.build.mac).toEqual({
      category: 'public.app-category.productivity',
      icon: 'build/icon.icns',
      hardenedRuntime: true,
      notarize: true,
      target: [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }]
    })
  })

  it('fuses unchanged', () => {
    expect(pkg.build.electronFuses).toEqual({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      loadBrowserProcessSpecificV8Snapshot: false
    })
  })

  it('no server files in package', () => {
    expect(pkg.build.files).toEqual(expect.arrayContaining(['!out/server/**', '!out/web/**', '!out/e2e-server/**']))
    // yalnız dışlama yazılırsa electron-builder başına **/* ekler ve sunucu dosyaları pakete girer
    expect(pkg.build.win.files).toEqual([...pkg.build.files, '!**/better-sqlite3/prebuilds/{darwin,linux,linuxmusl}-*'])
  })

  it('electron-builder version pinned exactly', () => {
    const v = pkg.devDependencies['electron-builder']
    expect(v).toMatch(/^\d+\.\d+\.\d+$/)
    expect(lock.packages[''].devDependencies['electron-builder']).toBe(v)
    expect(lock.packages['node_modules/electron-builder'].version).toBe(v)
  })

  it('NSIS veriyi silmez, kullanıcı kurulumu', () => {
    expect(pkg.build.nsis).toEqual({ oneClick: true, perMachine: false, deleteAppDataOnUninstall: false })
  })

  it('appx: oturum açılışı varsayılan kapalı, toast etkinleştiricisi os.ts ile aynı', () => {
    // addAutoLaunchExtension şablonu Enabled="true" yazar: Windows ilk açılıştan sonra kendiliğinden başlatırdı
    expect(pkg.build.appx.addAutoLaunchExtension).toBe(false)
    const xml = read(pkg.build.appx.customExtensionsPath)
    expect(xml).toMatch(/windows\.startupTask/)
    expect(xml).toMatch(/Enabled="false"/)
    expect(xml).toContain(`ToastActivatorCLSID="${TOAST_CLSID}"`)
    expect(xml).toContain(`<com:Class Id="${TOAST_CLSID}"`)
  })
})

describe('windows.yml', () => {
  it('workflow publishes nothing', () => {
    expect(workflow).toContain('--publish never')
    expect(workflow).not.toMatch(/--publish\s+(always|onTag|onTagOrDraft)/)
    expect(workflow).not.toContain('secrets.')
    expect(workflow).not.toMatch(/contents:\s*write/)
    expect(pkg.scripts['dist:win']).toContain('--publish never')
  })

  it('artifacts gated on private repo', () => {
    const steps = workflow.split(/\n\s+- /).filter((s) => s.includes('upload-artifact'))
    expect(steps.length).toBeGreaterThan(0)
    for (const s of steps) {
      expect(s).toContain('if: github.event.repository.private')
      expect(s).toContain('retention-days: 14')
    }
  })

  it('action pins match ci.yml', () => {
    const ci = new Set(uses(read('.github/workflows/ci.yml')))
    const mine = uses(workflow)
    expect(mine.length).toBeGreaterThan(0)
    for (const u of mine) {
      expect(u).toMatch(/@[0-9a-f]{40}$/)
      expect(ci.has(u)).toBe(true)
    }
  })

  it('iki hedef, iki mimari, Windows koşucusu', () => {
    expect(workflow).toContain('electron-builder --win nsis appx --x64 --arm64 --publish never -c.npmRebuild=false')
    expect(workflow).toContain('node scripts/check-win-package.mjs')
    expect(workflow).toContain('runs-on: windows-latest')
  })
})

describe('check-win-package', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function make(files: string[]): string {
    dir = mkdtempSync(join(tmpdir(), 'gecko-winpkg-'))
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true })
      writeFileSync(join(dir, f), '')
    }
    return dir
  }
  const PRE = 'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds'
  const list = (entries: string[]) => () => entries

  it('doğru paket geçer', () => {
    const d = make([`${PRE}/win32-x64.node`, `${PRE}/win32-arm64.node`, 'resources/tray.ico', 'resources/app.asar'])
    expect(problems(d, 'x64', list(['/out/main/index.js']))).toEqual([])
  })
  it('eksik .node, yabancı ön derleme, eksik simge, sunucu dosyası yakalanır', () => {
    const d = make([`${PRE}/win32-arm64.node`, `${PRE}/darwin-arm64.node`, `${PRE}/linux-x64.node`, 'resources/app.asar'])
    const p = problems(d, 'x64', list(['/out/main/index.js', '/out/server/index.mjs', '/out/web/index.html'])).join('\n')
    expect(p).toContain('win32-x64.node')
    expect(p).toContain('darwin-arm64.node')
    expect(p).toContain('linux-x64.node')
    expect(p).toContain('tray.ico')
    expect(p).toContain('/out/server/index.mjs')
    expect(p).toContain('/out/web/index.html')
  })
})
