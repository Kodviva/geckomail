import type Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../sync/auth/password'
import { openDb } from '../../sync/db'
import { makeQueries } from '../../sync/db/queries'
import type { OpQueue } from '../../sync/opQueue'
import { RpcHub, type RpcServerDeps } from '../../sync/rpcHub'
import type { Scheduler } from '../../sync/scheduler'
import { WebAuth } from '../auth'
import type { ServerConfig } from '../config'
import { createServerHost } from '../hosts/serverHost'
import { createHttpServer } from '../http'

const ORIGIN = 'https://posta.example.com'
const PW = 'dogru-parola-1'
const CONTENT = Buffer.from('cozulmus ek icerigi')

describe('çözülmüş ek uçları (HTTP)', () => {
  let dir: string
  let db: Database.Database
  let q: ReturnType<typeof makeQueries>
  let hub: RpcHub
  let auth: WebAuth
  let server: http.Server
  let port: number
  let msg: number
  let alice: number
  let bob: number
  let stranger: number

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-smimeatt-'))
    db = openDb(dir)
    q = makeQueries(db)
    const host = createServerHost(randomBytes(32), () => hub)
    const stub = new Proxy({}, { get: () => () => undefined })
    const deps: RpcServerDeps = {
      q, scheduler: stub as Scheduler, opq: stub as OpQueue, creds: new Map(), attachDir: join(dir, 'attachments'),
      encrypt: (v) => host.encrypt(v), decrypt: async (b) => (await host.decrypt(b)).map((u) => Buffer.from(u).toString('utf-8')), userData: dir, dbSchemaVersion: () => 0
    }
    hub = new RpcHub(deps, 'server')
    auth = new WebAuth(q, host)
    const acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    const g = q.insertGroup('G', '#111111')
    q.setAccountGroup(acc, g)
    const f = q.upsertFolder(acc, 'INBOX', 'inbox')
    msg = q.upsertHeader({
      folderId: f, accountId: acc, folderKind: 'inbox', uid: 7, messageId: '<m7@t>', inReplyTo: null, subject: 's', fromName: null, fromAddr: 'x@y.co', toJson: null,
      date: 1, size: 1, seen: false, flagged: false, answered: false, hasAttachments: false, listUnsubscribe: null, listUnsubscribePost: null, smimeKind: 'encrypted'
    }).id
    const mk = (u: string, role: 'admin' | 'member' = 'member'): number => q.insertUser({ username: u, passwordHash: hashPassword(PW), role })
    alice = mk('alice', 'admin')
    bob = mk('bob', 'admin')
    stranger = mk('el')
    expect(stranger).toBeGreaterThan(0)
    const cfg: ServerConfig = {
      dataDir: dir, listenHost: '127.0.0.1', listenPort: 0, keyFile: join(dir, 'master.key'), publicOrigin: ORIGIN, trustedProxyDepth: 0, webDir: join(dir, 'web')
    }
    server = createHttpServer({ cfg, hub, auth })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
    hub.smimeCache.set(alice, msg, {
      textPlain: 'x', html: null, signers: [], info: { sig: 'none', enc: 'decrypted', notes: [], signer: null, canSaveCert: false },
      attachments: [{ index: 0, filename: 'gizli rapor.pdf', mime: 'application/pdf', contentId: null, content: CONTENT }]
    })
  })
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const tokenOf = async (username: string): Promise<string> => {
    const r = await auth.login({ username, password: PW, ip: '127.0.0.1', userAgent: 't' } as never) as { token?: string }
    return r.token!
  }
  const get = (path: string, method: string, token?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> =>
    new Promise((resolve, reject) => {
      const headers = token ? { cookie: `gm_session=${token}` } : undefined
      const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      r.on('error', reject)
      r.end()
    })

  it('girişsiz 401', async () => {
    expect((await get(`/api/smime-attachment/${msg}/0`, 'GET')).status).toBe(401)
  })
  it('headers no-store', async () => {
    const r = await get(`/api/smime-attachment/${msg}/0`, 'GET', await tokenOf('alice'))
    expect(r.status).toBe(200)
    expect(r.body.equals(CONTENT)).toBe(true)
    expect(r.headers['content-type']).toBe('application/octet-stream')
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.headers['content-disposition']).toContain('attachment')
    const head = await get(`/api/smime-attachment/${msg}/0`, 'HEAD', await tokenOf('alice'))
    expect(head.status).toBe(200)
    expect(head.body.length).toBe(0)
  })
  it('other user gets 410', async () => {
    expect(bob).toBeGreaterThan(0)
    expect((await get(`/api/smime-attachment/${msg}/0`, 'GET', await tokenOf('bob'))).status).toBe(410)
  })
  it('görme yetkisi olmayan 403', async () => {
    expect((await get(`/api/smime-attachment/${msg}/0`, 'GET', await tokenOf('el'))).status).toBe(403)
  })
  it('olmayan dizin 410', async () => {
    expect((await get(`/api/smime-attachment/${msg}/9`, 'GET', await tokenOf('alice'))).status).toBe(410)
  })
  it('web çıkışı yalnız o kullanıcının çözülmüş içeriğini siler', async () => {
    const token = await tokenOf('alice')
    await new Promise<void>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/logout', headers: { cookie: `gm_session=${token}`, origin: ORIGIN, 'content-type': 'application/json', 'content-length': '2' } }, (res) => {
        res.resume()
        res.on('end', () => resolve())
      })
      r.on('error', reject)
      r.end('{}')
    })
    expect(hub.smimeCache.get(alice, msg)).toBeNull()
  })
  it('no disk write', async () => {
    await get(`/api/smime-attachment/${msg}/0`, 'GET', await tokenOf('alice'))
    expect(existsSync(join(dir, 'attachments')) ? readdirSync(join(dir, 'attachments')) : []).toEqual([])
    expect(existsSync(join(dir, 'uploads')) ? readdirSync(join(dir, 'uploads')) : []).toEqual([])
  })
})
