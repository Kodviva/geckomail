// Uçtan uca bağlama: motorun yeni posta olayı → bildirim hattı → PushSink → yerel sahte push servisi / açık oturum.
import { createECDH, randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../shared/i18n/locales/all'
import type { PushPayload } from '../../shared/pushTypes'
import { hashPassword } from '../../sync/auth/password'
import { startEngine, type Engine } from '../../sync/engine'
import type { RpcPort } from '../../sync/rpc/transport'
import type { SchedulerEvents } from '../../sync/scheduler'
import { WebAuth } from '../auth'
import { createServerHost } from '../hosts/serverHost'
import { serverPushSink, type PushSink } from '../pushDevices'
import { decryptPush } from './pushTestUtil'

const PW = 'dogru-parola-1'
const ORIGIN = 'https://posta.example.com'

class FakePort implements RpcPort {
  sent: { event?: string; data?: unknown }[] = []
  send(msg: unknown): void {
    this.sent.push(msg as { event?: string; data?: unknown })
  }
  onMessage(): void {}
  onClose(): void {}
  close(): void {}
  notes(): { title: string; tag: string }[] {
    return this.sent.filter((m) => m.event === 'server:notify').map((m) => m.data as { title: string; tag: string })
  }
}

interface Hit { url: string; headers: http.IncomingHttpHeaders; body: Buffer }

describe('push bağlaması', () => {
  let dir: string
  let engine: Engine | null
  let host: ReturnType<typeof createServerHost>
  let push: PushSink | undefined
  let fake: http.Server
  let port: number
  let hits: Hit[]

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-wiring-'))
    hits = []
    fake = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        hits.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) })
        res.statusCode = 201
        res.end()
      })
    })
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
    port = (fake.address() as AddressInfo).port
    host = createServerHost(randomBytes(32), () => engine?.hub ?? null)
    engine = null
    engine = startEngine({
      userData: dir, host, mode: 'server',
      notifySink: (q, hub) => (push = serverPushSink({ q, host, hub, publicOrigin: ORIGIN, extraHosts: ['127.0.0.1'] }))
    })
  })
  afterEach(async () => {
    push?.close()
    await engine?.stop()
    await new Promise<void>((r) => fake.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  it('oturumu olmayan kullanıcı şifreli push alır, oturumu açık kullanıcı server:notify alır', async () => {
    const { hub } = engine!
    const { q } = hub.deps
    const acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    const group = q.insertGroup('A', '#111111')
    q.setAccountGroup(acc, group)
    const folder = q.upsertFolder(acc, 'INBOX', 'inbox')
    q.prefSet('notifyScope', 'all')
    const member = (username: string): number => {
      const id = q.insertUser({ username, passwordHash: hashPassword(PW), role: 'member' })
      q.setGroupPermission(id, group, true, false)
      return id
    }
    const ali = member('ali')
    const veli = member('veli')

    // ali: web oturumu canlı, soketi yok; tek cihaz
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const authKey = randomBytes(16)
    const login = await new WebAuth(q, host).login({ username: 'ali', password: PW, ip: '1.1.1.1', userAgent: '' })
    expect(login.ok).toBe(true)
    const ro = new Database(join(dir, 'geckomail.db'), { readonly: true })
    const { id_hash: sessionId } = ro.prepare(`SELECT id_hash FROM web_sessions WHERE user_id = ?`).get(ali) as { id_hash: string }
    ro.close()
    q.upsertPushDevice({
      userId: ali, sessionId, endpoint: `http://127.0.0.1:${port}/ali`, p256dh: ua.getPublicKey().toString('base64url'),
      auth: authKey.toString('base64url'), label: null, now: Date.now()
    })

    // veli: açık oturum, cihaz yok
    const pv = new FakePort()
    hub.openSession(pv, { user: { id: veli, username: 'veli', role: 'member', permittedGroupIds: [group], manageableGroupIds: [] } })

    q.upsertHeader({
      folderId: folder, accountId: acc, folderKind: 'inbox', uid: 1, messageId: '<a@t>', inReplyTo: null, subject: 'gizli konu', fromName: 'Ayşe', fromAddr: 'x@y.co', toJson: null,
      date: Date.now(), size: 1, seen: false, flagged: false, answered: false, hasAttachments: false, listUnsubscribe: null, listUnsubscribePost: null, rulesEligible: true
    })

    ;(hub.deps.scheduler as unknown as { ev: SchedulerEvents }).ev.onNewMail(acc)

    await vi.waitFor(() => expect(hits).toHaveLength(1), { timeout: 8000, interval: 50 })
    await vi.waitFor(() => expect(pv.notes()).toHaveLength(1), { timeout: 8000, interval: 50 })

    const hit = hits[0]
    expect(hit.url).toBe('/ali')
    expect(hit.headers['content-encoding']).toBe('aes128gcm')
    expect(hit.headers.authorization).toMatch(/^vapid t=/)
    expect(hit.body.includes('a@t.co')).toBe(false)
    const payload = JSON.parse(decryptPush(hit.body, ua, authKey).toString()) as PushPayload
    expect(payload.title).toContain('a@t.co')
    expect(payload.accountId).toBe(acc)

    // oturuma giden de aynı özet etiketi taşır
    const [note] = pv.notes()
    expect(note.tag).toBe(payload.tag)
    expect(note.tag).toMatch(/^[0-9a-f]{16}$/)
    await vi.waitFor(() => expect(q.listPushDevices(ali)[0].last_ok_at).not.toBeNull())
  }, 15_000)
})
