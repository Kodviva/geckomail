import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveStatic } from '../static'

const WEB_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

interface Res {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

describe('serveStatic', () => {
  let parent: string
  let root: string
  let server: http.Server
  let port: number

  beforeAll(async () => {
    parent = mkdtempSync(join(tmpdir(), 'gecko-static-'))
    root = join(parent, 'web')
    mkdirSync(join(root, 'assets'), { recursive: true })
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>GeckoMail</title>')
    writeFileSync(join(root, 'assets', 'index-Ab12Cd34.js'), 'console.log(1)')
    writeFileSync(join(root, 'assets', 'index-Ef56.css'), 'body{}')
    writeFileSync(join(root, 'manifest.webmanifest'), '{}')
    writeFileSync(join(root, 'sw.js'), '//')
    // kök dışındaki dosya: hiçbir yolla okunamamalı
    writeFileSync(join(parent, 'gizli.txt'), 'sir')
    // kök içinden kök dışına bağlantılar (dosya ve dizin) ve nokta dosyaları
    symlinkSync(join(parent, 'gizli.txt'), join(root, 'disari.txt'))
    mkdirSync(join(parent, 'dis'))
    writeFileSync(join(parent, 'dis', 'x.js'), 'dis')
    symlinkSync(join(parent, 'dis'), join(root, 'disdizin'))
    // kök içinde kalan bağlantı sorun değil
    symlinkSync(join(root, 'sw.js'), join(root, 'ic.js'))
    writeFileSync(join(root, '.env'), 'SIR=1')
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'config'), 'x')
    server = http.createServer((req, res) => {
      if (!serveStatic(req, res, root)) res.writeHead(418).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(parent, { recursive: true, force: true })
  })

  const get = (path: string, method = 'GET'): Promise<Res> =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method, path }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }))
      })
      r.on('error', reject)
      r.end()
    })

  it('hashed asset: immutable cache, JS content type', async () => {
    const r = await get('/assets/index-Ab12Cd34.js')
    expect(r.status).toBe(200)
    expect(r.body).toBe('console.log(1)')
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(r.headers['content-type']).toMatch(/^text\/javascript/)
    expect(r.headers['content-length']).toBe(String('console.log(1)'.length))
    expect((await get('/assets/index-Ef56.css')).headers['content-type']).toMatch(/^text\/css/)
  })

  it('index.html, manifest and sw.js are no-cache', async () => {
    const i = await get('/')
    expect(i.status).toBe(200)
    expect(i.body).toContain('GeckoMail')
    expect(i.headers['content-type']).toMatch(/^text\/html/)
    expect(i.headers['cache-control']).toBe('no-cache, no-transform')
    expect((await get('/index.html')).headers['cache-control']).toBe('no-cache, no-transform')
    const m = await get('/manifest.webmanifest')
    expect(m.headers['cache-control']).toBe('no-cache')
    expect(m.headers['content-type']).toMatch(/^application\/manifest\+json/)
    expect((await get('/sw.js')).headers['cache-control']).toBe('no-cache')
  })

  it('unknown extensionless path falls back to index.html (SPA)', async () => {
    const r = await get('/mail/123')
    expect(r.status).toBe(200)
    expect(r.body).toContain('GeckoMail')
    expect(r.headers['cache-control']).toBe('no-cache, no-transform')
    expect((await get('/mail/123?x=1')).status).toBe(200)
  })

  it('missing file with extension is 404', async () => {
    expect((await get('/assets/yok-123.js')).status).toBe(404)
    expect((await get('/yok.png')).status).toBe(404)
  })

  it('path traversal is 404', async () => {
    for (const p of ['/../gizli.txt', '/../etc/passwd', '/%2e%2e/gizli.txt', '/assets/%2e%2e/%2e%2e/gizli.txt', '/%2E%2E%2Fgizli.txt', '/assets/..%2f..%2fgizli.txt', '/a%00.js', '/%zz']) {
      const r = await get(p)
      expect(r.status, p).toBe(404)
      expect(r.body, p).not.toContain('sir')
    }
  })

  it('symlink resolving outside root is 404', async () => {
    expect((await get('/disari.txt')).status).toBe(404)
    expect((await get('/disdizin/x.js')).status).toBe(404)
    const r = await get('/ic.js')
    expect(r.status).toBe(200)
    expect(r.body).toBe('//')
  })

  it('dotfile segments are 404', async () => {
    for (const p of ['/.env', '/.git/config', '/%2eenv', '/.git', '/.yok']) {
      const r = await get(p)
      expect(r.status, p).toBe(404)
      expect(r.body).not.toContain('GeckoMail')
    }
  })

  it('web CSP and security headers on every static response', async () => {
    for (const p of ['/', '/assets/index-Ab12Cd34.js', '/mail/1', '/yok.png', '/../etc/passwd']) {
      const r = await get(p)
      expect(r.headers['content-security-policy'], p).toBe(WEB_CSP)
      expect(r.headers['x-content-type-options'], p).toBe('nosniff')
      expect(r.headers['referrer-policy'], p).toBe('no-referrer')
    }
  })

  it('HEAD has headers but no body; other methods not handled', async () => {
    const h = await get('/assets/index-Ab12Cd34.js', 'HEAD')
    expect(h.status).toBe(200)
    expect(h.body).toBe('')
    expect(h.headers['content-length']).toBe(String('console.log(1)'.length))
    expect((await get('/', 'POST')).status).toBe(418)
  })
})
