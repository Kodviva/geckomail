import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..', '..')
const entry = join(root, 'out', 'server', 'index.mjs')

describe('sunucu süreci', () => {
  let dir: string
  beforeAll(() => {
    // paketlenmiş çıktı gerekli (göç dosyaları ?raw ile gömülü)
    const r = spawnSync('npm', ['run', 'build:server'], { cwd: root, encoding: 'utf-8' })
    if (r.status !== 0 || !existsSync(entry)) throw new Error(`build:server başarısız\n${r.stdout}\n${r.stderr}`)
    dir = mkdtempSync(join(tmpdir(), 'gecko-boot-'))
  }, 120_000)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('serves /healthz and exits 0 on SIGTERM within 10s', async () => {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const child = spawn(process.execPath, [entry, 'serve'], {
      env: { ...process.env, GECKO_DATA_DIR: dir, GECKO_LISTEN: `127.0.0.1:${port}`, GECKO_PUBLIC_ORIGIN: `http://127.0.0.1:${port}` },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let log = ''
    child.stdout.on('data', (d) => (log += d))
    child.stderr.on('data', (d) => (log += d))
    const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)))
    try {
      let ok = false
      for (let i = 0; i < 100 && !ok; i++) {
        try {
          ok = (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200
        } catch {
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      expect(ok, log).toBe(true)
      expect(log).toContain('create-admin')
      const t0 = Date.now()
      child.kill('SIGTERM')
      expect(await exited).toBe(0)
      expect(Date.now() - t0).toBeLessThan(10_000)
    } finally {
      child.kill('SIGKILL')
    }
  }, 60_000)

  it('exits 2 with a clear error when GECKO_PUBLIC_ORIGIN is missing', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, GECKO_DATA_DIR: dir }
    delete env.GECKO_PUBLIC_ORIGIN
    const r = spawnSync(process.execPath, [entry, 'serve'], { env, encoding: 'utf-8', timeout: 20_000 })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('GECKO_PUBLIC_ORIGIN')
  })

  it('config error for another variable does not mention GECKO_PUBLIC_ORIGIN', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, GECKO_DATA_DIR: dir, GECKO_PUBLIC_ORIGIN: 'https://posta.example.com', GECKO_LISTEN: 'yok' }
    const r = spawnSync(process.execPath, [entry, 'serve'], { env, encoding: 'utf-8', timeout: 20_000 })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('GECKO_LISTEN')
    expect(r.stderr).not.toContain('GECKO_PUBLIC_ORIGIN')
  })

  it('exits 3 when the database is newer than the server', () => {
    const d = mkdtempSync(join(tmpdir(), 'gecko-boot-new-'))
    try {
      const db = new Database(join(d, 'geckomail.db'))
      db.pragma('user_version = 9999')
      db.close()
      const env: NodeJS.ProcessEnv = { ...process.env, GECKO_DATA_DIR: d, GECKO_PUBLIC_ORIGIN: 'https://posta.example.com', GECKO_LISTEN: `127.0.0.1:${20000 + Math.floor(Math.random() * 20000)}` }
      const r = spawnSync(process.execPath, [entry, 'serve'], { env, encoding: 'utf-8', timeout: 20_000 })
      expect(r.status, r.stderr).toBe(3)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})
