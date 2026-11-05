import { createServer } from 'http'
import type { AddressInfo } from 'net'
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '../../shared/rpc'
import { getLocale, setLocale, t, tFor } from '../../shared/i18n'
import '../../shared/i18n/locales/all'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { AUTH_PAUSED_KEY } from '../../shared/accountStatus'
import { OpQueue } from '../opQueue'
import type { RpcPort } from '../rpc/transport'
import { RpcHub, type RpcServerDeps } from '../rpcHub'
import { Scheduler } from '../scheduler'
import { runWithLocale, tProcess } from '../sessionLocale'

class FakePort implements RpcPort {
  sent: { id?: number; ok?: boolean; error?: string; event?: string }[] = []
  private msgCb: ((m: unknown) => void) | null = null
  send(msg: unknown): void {
    this.sent.push(msg as FakePort['sent'][number])
  }
  onMessage(cb: (msg: unknown) => void): void {
    this.msgCb = cb
  }
  onClose(): void {}
  close(): void {}
  /** İstek gönderir, yanıtını bekler */
  async call(id: number, method: string, params: unknown = {}): Promise<FakePort['sent'][number]> {
    this.msgCb?.({ id, method, params })
    for (let i = 0; i < 200; i++) {
      const r = this.sent.find((m) => m.id === id)
      if (r) return r
      await new Promise((res) => setTimeout(res, 1))
    }
    throw new Error('yanıt gelmedi')
  }
}

const user = (id: number): SessionUser => ({ id, username: `u${id}`, role: 'admin', viewAccountIds: null } as unknown as SessionUser)

describe('oturum dili', () => {
  let dir: string
  let db: Database.Database
  let deps: RpcServerDeps

  beforeEach(() => {
    setLocale('tr')
    dir = mkdtempSync(join(tmpdir(), 'gecko-locale-'))
    db = openDb(dir)
    deps = {
      q: makeQueries(db), scheduler: {} as Scheduler, opq: {} as OpQueue, creds: new Map(), attachDir: dir,
      encrypt: async (v) => v.map((s) => new TextEncoder().encode(s)),
      decrypt: async (b) => b.map((x) => new TextDecoder().decode(x)),
      userData: dir, dbSchemaVersion: () => 1
    }
    for (const name of ['u1', 'u2']) deps.q.insertUser({ username: name, passwordHash: 'x', role: 'admin' }) // setSessionLocale kullanıcıya yazar
  })
  afterEach(() => {
    setLocale('tr')
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const unknown = (l: 'tr' | 'en') => tFor(l, 'sync.err.unknownMethod', { method: 'yokYontem' })

  it('iki oturum, aynı hatalı çağrı: her biri kendi dilinde', async () => {
    const hub = new RpcHub(deps, 'server')
    const a = new FakePort()
    const b = new FakePort()
    hub.openSession(a, { user: user(1) })
    hub.openSession(b, { user: user(2) })
    expect((await a.call(1, 'setSessionLocale', { locale: 'en' })).ok).toBe(true)
    expect((await b.call(1, 'setSessionLocale', { locale: 'tr' })).ok).toBe(true)

    const [ra, rb] = await Promise.all([a.call(2, 'yokYontem'), b.call(2, 'yokYontem')])
    expect(ra.error).toBe(unknown('en'))
    expect(rb.error).toBe(unknown('tr'))
    expect(unknown('en')).not.toBe(unknown('tr'))
  })

  it('geçersiz dil reddedilir; hata oturumun dilinde', async () => {
    const hub = new RpcHub(deps, 'server')
    const a = new FakePort()
    hub.openSession(a, { user: user(1) })
    await a.call(1, 'setSessionLocale', { locale: 'en' })
    // setSessionLocale'in kendi geçersiz değer hatası: oturum dilinde
    const r = await a.call(2, 'setSessionLocale', { locale: 'klingon' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe(tFor('en', 'sync.pref.invalidValue', { key: 'locale' }))
  })

  it('dil verilmemiş oturum süreç dilinde; süreç dili değişmez', async () => {
    const hub = new RpcHub(deps, 'server')
    const a = new FakePort()
    const b = new FakePort()
    hub.openSession(a, { user: user(1) })
    hub.openSession(b, { user: user(2) })
    await a.call(1, 'setSessionLocale', { locale: 'en' })
    expect((await b.call(1, 'yokYontem')).error).toBe(unknown('tr'))
    expect(getLocale()).toBe('tr')
    expect(t('sync.err.unknownMethod', { method: 'yokYontem' })).toBe(unknown('tr'))
  })

  it('girişsiz çağrı reddedilir', async () => {
    const hub = new RpcHub(deps, 'server')
    const a = new FakePort()
    hub.openSession(a)
    expect((await a.call(1, 'setSessionLocale', { locale: 'en' })).ok).toBe(false)
  })

  it('masaüstünde süreç dili: oturum dili yok sayılır', async () => {
    const hub = new RpcHub(deps, 'desktop')
    const a = new FakePort()
    const s = hub.openSession(a)
    s.currentUser = user(1)
    expect((await a.call(1, 'setSessionLocale', { locale: 'en' })).ok).toBe(true)
    expect((await a.call(2, 'yokYontem')).error).toBe(unknown('tr'))
    setLocale('de')
    expect((await a.call(3, 'yokYontem')).error).toBe(tFor('de', 'sync.err.unknownMethod', { method: 'yokYontem' }))
  })

  it('handler bitince bağlam kapanır: arka planda kalan iş süreç diline döner', async () => {
    let late = ''
    let release!: () => void
    const done = new Promise<void>((r) => (release = r))
    await runWithLocale('en', async () => {
      expect(getLocale()).toBe('en')
      await new Promise((r) => setTimeout(r, 1))
      expect(getLocale()).toBe('en') // await sonrası da
      // handler'ın başlatıp beklemediği iş (zamanlayıcı döngüsü, gecikmeli yayın)
      setTimeout(() => {
        late = getLocale()
        release()
      }, 5)
    })
    await done
    expect(late).toBe('tr')
    expect(getLocale()).toBe('tr')
  })

  it('iç içe geçen iki bağlam gerçek await boyunca kendi dilini korur', async () => {
    // sıra elle zorlanır: a başlar, b başlar, a sürer, b sürer
    const gate = () => {
      let open!: () => void
      const wait = new Promise<void>((r) => (open = r))
      return { wait, open }
    }
    const aMid = gate()
    const bMid = gate()
    const seen: string[] = []
    const a = runWithLocale('en', async () => {
      seen.push(`a1:${getLocale()}`)
      bMid.open()
      await aMid.wait
      seen.push(`a2:${getLocale()}:${t('sync.err.unknownMethod', { method: 'x' })}`)
      await new Promise((r) => setTimeout(r, 2))
      seen.push(`a3:${getLocale()}`)
    })
    const b = runWithLocale('de', async () => {
      await bMid.wait
      seen.push(`b1:${getLocale()}`)
      aMid.open()
      await new Promise((r) => setTimeout(r, 1))
      seen.push(`b2:${getLocale()}`)
    })
    await Promise.all([a, b])
    expect(seen.slice().sort()).toEqual(
      ['a1:en', `a2:en:${tFor('en', 'sync.err.unknownMethod', { method: 'x' })}`, 'a3:en', 'b1:de', 'b2:de'].sort()
    )
    // gerçekten iç içe: a'nın ikinci adımı b'nin ilkinden sonra
    expect(seen.indexOf('b1:de')).toBeLessThan(seen.findIndex((x) => x.startsWith('a2')))
    expect(getLocale()).toBe('tr')
  })

  it('ortak durum metni oturum içinde tetiklense de süreç dilinde saklanır', async () => {
    const id = deps.q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    const events = new Proxy({}, { get: () => () => undefined }) as ConstructorParameters<typeof Scheduler>[2]
    const sched = new Scheduler(deps.q, new Map([[id, 'p']]), events)
    sched.reloadAccounts()
    const fail = (sched as unknown as { onAuthFailure(id: number): void }).onAuthFailure.bind(sched)
    const detail = (): string | null => deps.q.getAccountRow(id)?.status_detail ?? null

    await runWithLocale('en', async () => fail(id)) // 1. ret: süreli duraklama
    const paused = detail()
    expect(paused).not.toBeNull()
    expect(paused).toContain(tFor('tr', AUTH_PAUSED_KEY, { time: '' }).trim().slice(0, 8))

    await runWithLocale('en', async () => fail(id)) // 2. ret: kalıcı durur
    expect(detail()).toBe(tFor('tr', 'sync.status.authRejected'))
    expect(detail()).not.toBe(tFor('en', 'sync.status.authRejected'))
    sched.stop()
  })

  it('webhook günlüğü oturum içinde çalışsa da süreç dilinde', async () => {
    const hook = createServer((_q, r) => r.end('ok'))
    await new Promise<void>((res) => hook.listen(0, '127.0.0.1', () => res()))
    const webhookId = deps.q.insertWebhook({ name: 'kanca', url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/k`, secret: null })
    const noEvents = new Proxy({}, { get: () => () => undefined }) as ConstructorParameters<typeof OpQueue>[4]
    const opq = new OpQueue(deps.q, deps.scheduler, deps.creds, dir, noEvents, 'desktop')
    const run = (opq as unknown as { runWebhookOp(op: unknown): Promise<void> }).runWebhookOp.bind(opq)
    await runWithLocale('en', () => run({ id: 1, account_id: 0, kind: 'call_webhook', attempts: 0, payload_json: JSON.stringify({ webhookId, body: {} }) }))
    hook.closeAllConnections()
    await new Promise((res) => hook.close(res))
    expect(deps.q.getRuleLog(1)[0].summary).toBe(tFor('tr', 'sync.webhook.sent', { name: 'kanca' }))
  })

  it('tProcess bağlamı açıkken de süreç dilinde, bağlam sonra sürer', async () => {
    await runWithLocale('en', async () => {
      expect(tProcess('sync.err.unknownMethod', { method: 'x' })).toBe(tFor('tr', 'sync.err.unknownMethod', { method: 'x' }))
      expect(getLocale()).toBe('en')
    })
  })

  it('handler hata atsa da bağlam kapanır', async () => {
    let check: () => string = () => ''
    await expect(
      runWithLocale('en', async () => {
        check = () => getLocale()
        throw new Error('x')
      })
    ).rejects.toThrow('x')
    expect(check()).toBe('tr')
  })

  it('dil yoksa fn doğrudan çalışır', async () => {
    expect(await runWithLocale(null, async () => getLocale())).toBe('tr')
  })
})
