import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import * as fs from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_API } from '../../server/desktopRoutes'
import { normalizeServerUrl, probeServer, readMode, startForMode, updateMode, writeMode, type DesktopModeFile } from '../desktopMode'

const ORIGIN = 'https://posta.example.com'
const reply = (status: number, body: unknown): Response => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

describe('mod dosyası', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-mode-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const file = (): string => join(dir, 'desktop-mode.json')
  const server: DesktopModeFile = { version: 1, mode: 'server', serverOrigin: ORIGIN, sourceId: 'kaynak-1', closeHintShown: true, importedTo: null }

  it('missing file means local', () => {
    const log = vi.fn()
    expect(readMode(dir, fs, log)).toMatchObject({ version: 1, mode: 'local', serverOrigin: null, closeHintShown: false, importedTo: null })
    expect(log).not.toHaveBeenCalled()
    expect(existsSync(file())).toBe(false) // yükseltmede yerel kurulum hiçbir şey yazmaz
  })

  it('corrupt file means local', () => {
    for (const bad of ['{', '[]', 'null', '{"version":2,"mode":"server"}', '{"version":1,"mode":"uzay"}',
      JSON.stringify({ ...server, serverOrigin: null }), JSON.stringify({ ...server, serverOrigin: 'http://evil.example' }),
      JSON.stringify({ ...server, serverOrigin: `${ORIGIN}/yol` }), JSON.stringify({ ...server, sourceId: '../x' })]) {
      writeFileSync(file(), bad)
      const log = vi.fn()
      expect(readMode(dir, fs, log).mode, bad).toBe('local')
      expect(log, bad).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(log.mock.calls), bad).not.toContain('evil')
    }
  })

  it('kayıt okunur', () => {
    writeMode(dir, server)
    expect(readMode(dir)).toEqual(server)
  })

  it('write is atomic', () => {
    const seen: string[] = []
    const spy = { ...fs, writeFileSync: fs.writeFileSync, rmSync: fs.rmSync, renameSync: (a: string, b: string) => { seen.push(a); renameSync(a, b) } }
    writeMode(dir, server)
    writeMode(dir, { ...server, closeHintShown: false }, spy as unknown as typeof fs)
    expect(seen[0]).not.toBe(file())
    expect(readdirSync(dir)).toEqual(['desktop-mode.json'])

    // yazma yarıda kalırsa önceki dosya sağlam kalır, geçici dosya süpürülür
    const broken = { ...spy, renameSync: () => { throw new Error('disk') } }
    expect(() => writeMode(dir, { ...server, mode: 'local' }, broken as unknown as typeof fs)).toThrow('disk')
    expect(JSON.parse(readFileSync(file(), 'utf-8')).mode).toBe('server')
    expect(readdirSync(dir)).toEqual(['desktop-mode.json'])
  })

  it('updateMode kaynak kimliğini kalıcı yapar, öteki alanlara dokunmaz', () => {
    const first = updateMode(dir, { closeHintShown: true })
    expect(first.closeHintShown).toBe(true)
    expect(updateMode(dir, { mode: 'server', serverOrigin: ORIGIN }).sourceId).toBe(first.sourceId)
    expect(readMode(dir)).toMatchObject({ mode: 'server', serverOrigin: ORIGIN, closeHintShown: true, sourceId: first.sourceId })
  })

  it('dizin yoksa oluşturulur', () => {
    const sub = join(dir, 'a', 'b')
    mkdirSync(join(dir, 'a'))
    writeMode(sub, server)
    expect(readMode(sub).mode).toBe('server')
  })
})

describe('normalizeServerUrl', () => {
  it('yol, sorgu ve parça atılır; şema yoksa https', () => {
    expect(normalizeServerUrl('https://posta.example.com/giris?x=1#y')).toEqual({ ok: true, origin: ORIGIN })
    expect(normalizeServerUrl('  posta.example.com  ')).toEqual({ ok: true, origin: ORIGIN })
    expect(normalizeServerUrl('posta.example.com:8443')).toEqual({ ok: true, origin: `${ORIGIN}:8443` })
  })
  it('büyük harf ana makine küçülür', () => {
    expect(normalizeServerUrl('HTTPS://POSTA.Example.COM')).toEqual({ ok: true, origin: ORIGIN })
  })
  it('kullanıcı bilgisi reddedilir: gerçek ana makineyi gizler', () => {
    expect(normalizeServerUrl('https://posta.example.com@evil.example')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeServerUrl('https://a:b@posta.example.com')).toEqual({ ok: false, reason: 'invalid' })
  })
  it('düz http yalnız geri döngüde', () => {
    expect(normalizeServerUrl('http://example.com')).toEqual({ ok: false, reason: 'insecure' })
    expect(normalizeServerUrl('http://192.168.1.5:8080')).toEqual({ ok: false, reason: 'insecure' })
    expect(normalizeServerUrl('http://localhost.evil.example')).toEqual({ ok: false, reason: 'insecure' })
    expect(normalizeServerUrl('http://localhost:8080')).toEqual({ ok: true, origin: 'http://localhost:8080' })
    expect(normalizeServerUrl('http://127.0.0.1:8080')).toEqual({ ok: true, origin: 'http://127.0.0.1:8080' })
    expect(normalizeServerUrl('http://[::1]:8080')).toEqual({ ok: true, origin: 'http://[::1]:8080' })
  })
  it('başka şema ve bozuk girdi', () => {
    for (const bad of ['', '   ', 'file:///etc/passwd', 'ftp://x.example', 'javascript:alert(1)', 'https://', 'a b.example', 'data:text/html,x'])
      expect(normalizeServerUrl(bad), bad).toEqual({ ok: false, reason: 'invalid' })
  })
  it('IDN ad punycode gösterilir', () => {
    expect(normalizeServerUrl('https://pоsta.example.com')).toEqual({ ok: true, origin: 'https://xn--psta-55d.example.com' })
  })
})

describe('probeServer', () => {
  const good = { app: 'geckomail', desktopApi: DESKTOP_API, origin: ORIGIN }

  it('geçerli sunucu', async () => {
    const f = vi.fn(async () => reply(200, good))
    expect(await probeServer(ORIGIN, f as unknown as typeof fetch)).toEqual({ ok: true })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${ORIGIN}/api/server-info`)
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' }) // yönlendirme başka kökene taşımaz, çerez gitmez
  })
  it('unreachable', async () => {
    expect(await probeServer(ORIGIN, (async () => { throw new TypeError('ERR_CERT_AUTHORITY_INVALID') }) as typeof fetch)).toEqual({ ok: false, reason: 'unreachable' })
  })
  it('notGecko', async () => {
    for (const r of [reply(404, 'yok'), reply(200, '<html>'), reply(200, { app: 'baska' }), reply(200, 'null')])
      expect(await probeServer(ORIGIN, (async () => r.clone()) as typeof fetch)).toEqual({ ok: false, reason: 'notGecko' })
  })
  it('originMismatch', async () => {
    expect(await probeServer(ORIGIN, (async () => reply(200, { ...good, origin: 'https://baska.example' })) as typeof fetch)).toEqual({ ok: false, reason: 'originMismatch' })
  })
  it('apiMismatch', async () => {
    expect(await probeServer(ORIGIN, (async () => reply(200, { ...good, desktopApi: DESKTOP_API + 1 })) as typeof fetch)).toEqual({ ok: false, reason: 'apiMismatch' })
  })
})

describe('startForMode', () => {
  const deps = () => ({ restore: vi.fn(), spawnSync: vi.fn(), bridge: vi.fn(), localWindow: vi.fn(), serverWindow: vi.fn(), serverAgent: vi.fn() })
  const mode = (m: Partial<DesktopModeFile>): DesktopModeFile => ({ version: 1, mode: 'local', serverOrigin: null, sourceId: 'k', closeHintShown: false, importedTo: null, ...m })

  it('server mode never spawns sync', () => {
    const d = deps()
    startForMode(mode({ mode: 'server', serverOrigin: ORIGIN }), { hidden: false }, d)
    expect(d.spawnSync).not.toHaveBeenCalled()
    expect(d.restore).not.toHaveBeenCalled()
    expect(d.bridge).not.toHaveBeenCalled()
    expect(d.localWindow).not.toHaveBeenCalled()
    expect(d.serverWindow).toHaveBeenCalledWith(ORIGIN)
    expect(d.serverAgent).toHaveBeenCalledWith(ORIGIN)
  })
  it('gizli açılışta pencere kurulmaz, motor çalışır', () => {
    const d = deps()
    startForMode(mode({}), { hidden: true }, d)
    expect(d.spawnSync).toHaveBeenCalled()
    expect(d.bridge).toHaveBeenCalled()
    expect(d.localWindow).not.toHaveBeenCalled()
    const s = deps()
    startForMode(mode({ mode: 'server', serverOrigin: ORIGIN }), { hidden: true }, s)
    expect(s.serverWindow).not.toHaveBeenCalled()
    expect(s.serverAgent).toHaveBeenCalledWith(ORIGIN) // pencere yokken de bildirim gelir
  })

  it('yerel mod bugünkü sırayla başlar', () => {
    const d = deps()
    const order: string[] = []
    for (const k of ['restore', 'spawnSync', 'localWindow', 'bridge'] as const) d[k].mockImplementation(() => void order.push(k))
    startForMode(mode({}), { hidden: false }, d)
    expect(order).toEqual(['restore', 'spawnSync', 'localWindow', 'bridge'])
    expect(d.serverAgent).not.toHaveBeenCalled() // yerel modda ServerLink hiç başlamaz
  })
})
