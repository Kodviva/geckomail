// Gerçek sunucu sınamasının güvenlik kapısı: bağlanmadan önce çalışır, kapatılamaz.
import { spawn } from 'child_process'
import { createServer, type AddressInfo, type Server } from 'net'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { authGuard, gateError } from '../../../scripts/sieve-it.mjs'
import { ManageSieveClient, ManageSieveError } from '../sieve/manageSieve'
import { makeTestCert, startFakeManageSieve } from './helpers/fakeManageSieve'

const SCRIPT = join(__dirname, '../../../scripts/sieve-it.mjs')
const GOOD = ['sieve-1@geckomail-sieve.test', 'sieve-2@geckomail-sieve.test']

/** Betiği çalıştırır: çıkış kodu ve stderr. Parola istemine kadar gelirse stdin kapalıdır, çıkar */
function runScript(env: Record<string, string>, args: string[] = ['--target', 'remote']): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GECKO_SIEVE_IT_')))
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: { ...clean, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => (err += String(d)))
    p.on('close', (code) => resolve({ code, err }))
  })
}

describe('gateError', () => {
  it('yerel ana makine ve iki .test kullanıcısını geçirir', () => {
    expect(gateError({ host: '127.0.0.1', users: GOOD })).toBeNull()
    expect(gateError({ host: 'localhost', users: GOOD })).toBeNull()
  })

  it('.test dışı kullanıcı her koşulda reddedilir, yerel görünen tünelde de', () => {
    expect(gateError({ host: '127.0.0.1', users: ['ali@gercek.com', GOOD[1]] })).toMatch(/\.test/)
    expect(gateError({ host: '127.0.0.1', users: [GOOD[0], 'ali@gercek.com'] })).toMatch(/\.test/)
    expect(gateError({ host: 'mail.gercek.com', users: ['ali@gercek.com', GOOD[1]] })).toMatch(/\.test/)
  })

  it('sonu .test gibi görünen ama alan adı olmayan değerler geçmez', () => {
    for (const u of ['sieve-1.test', '@x.test', 'a@b@x.test', 'a@x.test.com', 'a@x.test\n', ' a@x.test', 'a@.test', '']) {
      expect(gateError({ host: '127.0.0.1', users: [u, GOOD[1]] }), JSON.stringify(u)).not.toBeNull()
    }
  })

  it('tünel dışı ana makine reddedilir, kullanıcı .test olsa da', () => {
    expect(gateError({ host: 'mail.gercek.com', users: GOOD })).toMatch(/127\.0\.0\.1/)
    expect(gateError({ host: '', users: GOOD })).not.toBeNull()
  })

  it('iki kullanıcı ister', () => {
    expect(gateError({ host: '127.0.0.1', users: [GOOD[0]] })).not.toBeNull()
  })
})

describe('sieve-it.mjs', () => {
  const servers: Server[] = []
  afterEach(() => servers.splice(0).forEach((s) => s.close()))

  const listener = async (): Promise<{ port: number; connections: () => number }> => {
    let n = 0
    const s = createServer((c) => {
      n++
      c.destroy()
    })
    servers.push(s)
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
    return { port: (s.address() as AddressInfo).port, connections: () => n }
  }

  it('.test dışı kullanıcıda bağlanmadan çıkar', async () => {
    const l = await listener()
    const r = await runScript({
      GECKO_SIEVE_IT_HOST: '127.0.0.1', GECKO_SIEVE_IT_PORT: String(l.port), GECKO_SIEVE_IT_USER: 'ali@gercek.com',
      GECKO_SIEVE_IT_USER2: GOOD[1], GECKO_SIEVE_IT_SERVERNAME: 'mail.gercek.com'
    })
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/\.test/)
    expect(l.connections()).toBe(0)
  })

  it('sertifika denetimini kapatan bayrak dışarıdan verilemez', async () => {
    const l = await listener()
    const r = await runScript({
      GECKO_SIEVE_IT_HOST: '127.0.0.1', GECKO_SIEVE_IT_PORT: String(l.port), GECKO_SIEVE_IT_USER: GOOD[0],
      GECKO_SIEVE_IT_USER2: GOOD[1], GECKO_SIEVE_IT_SERVERNAME: 'mail.ornek.test', GECKO_SIEVE_IT_DOCKER: '1'
    })
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/GECKO_SIEVE_IT_DOCKER/)
    expect(l.connections()).toBe(0)
  })

  it('tünelde gerçek ad verilmezse bağlanmadan çıkar', async () => {
    const l = await listener()
    const r = await runScript({ GECKO_SIEVE_IT_HOST: '127.0.0.1', GECKO_SIEVE_IT_PORT: String(l.port), GECKO_SIEVE_IT_USER: GOOD[0], GECKO_SIEVE_IT_USER2: GOOD[1] })
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/SERVERNAME/)
    expect(l.connections()).toBe(0)
  })
})

describe('authGuard', () => {
  it('ilk kimlik reddinden sonra ikinci deneme yapılmaz', async () => {
    const server = await startFakeManageSieve({ tls: 'starttls', cert: makeTestCert(), sasl: ['PLAIN'], extensions: [], failAuth: true })
    const guard = authGuard()
    const attempt = (): Promise<void> => guard.run(async () => {
      const c = await ManageSieveClient.connect({ host: '127.0.0.1', port: server.port, tls: 'starttls', rejectUnauthorized: false })
      try {
        await c.authenticate({ kind: 'password', user: GOOD[0], password: 'yanlis' })
      } finally {
        c.close()
      }
    })
    try {
      await expect(attempt()).rejects.toBeInstanceOf(ManageSieveError)
      expect(guard.rejected).toBe(true)
      await expect(attempt()).rejects.toThrow(/kimlik reddi/)
      expect(server.connections).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('kimlik reddi olmayan hata durdurmaz', async () => {
    const guard = authGuard()
    await expect(guard.run(async () => Promise.reject(new Error('ağ')))).rejects.toThrow('ağ')
    expect(guard.rejected).toBe(false)
    await expect(guard.run(async () => 1)).resolves.toBe(1)
  })
})
