import { createHmac } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { OpQueue } from '../opQueue'
import { automationHandlers } from '../rpc/automation'
import type { RpcSession } from '../rpcSession'
import type { Scheduler } from '../scheduler'

describe('webhook ağ politikası', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let q: ReturnType<typeof makeQueries>
  let srv: Server
  let hits: { headers: IncomingHttpHeaders; body: string }[]
  let reply: { status: number; headers?: Record<string, string> }
  let url: string
  const events = { emitOpFailed: vi.fn(), emitChanged: vi.fn(), emitAutomationLogged: vi.fn() }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-wh-'))
    db = openDb(dir)
    q = makeQueries(db)
    hits = []
    reply = { status: 200 }
    srv = createServer((r, w) => {
      let body = ''
      r.on('data', (c) => (body += c))
      r.on('end', () => {
        hits.push({ headers: r.headers, body })
        w.writeHead(reply.status, reply.headers)
        w.end()
      })
    })
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()))
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/kanca`
  })
  afterEach(async () => {
    srv.closeAllConnections()
    await new Promise((r) => srv.close(r))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const queue = (mode: 'desktop' | 'server'): OpQueue => new OpQueue(q, {} as Scheduler, new Map(), dir, events, mode)
  const run = (o: OpQueue): Promise<void> => (o as unknown as { drain(): Promise<void> }).drain()
  const op = (id: number) => db.prepare(`SELECT state, not_before, last_error FROM op_queue WHERE id = ?`).get(id) as { state: string; not_before: number; last_error: string } | undefined
  const fire = (secret: string | null = null): number => q.enqueueOp(0, 'call_webhook', { webhookId: q.insertWebhook({ name: 'k', url, secret }), body: { a: 1 } })
  const settle = async (o: OpQueue, id: number): Promise<void> => {
    await run(o)
    await vi.waitFor(() => expect(op(id)?.state).not.toBe('running'))
  }
  const session = (mode: 'desktop' | 'server'): RpcSession => ({ deps: { q }, hub: { mode } }) as unknown as RpcSession

  it('server: private network closed, request never sent', async () => {
    const id = fire()
    await settle(queue('server'), id)
    expect(hits).toEqual([])
    expect(op(id)?.last_error).toBeTruthy()
  })

  it('desktop: user-chosen local url delivered and signed', async () => {
    const id = fire('sir')
    await settle(queue('desktop'), id)
    expect(hits).toHaveLength(1)
    expect(hits[0].headers['x-geckomail-signature']).toBe(`sha256=${createHmac('sha256', 'sir').update('{"a":1}').digest('hex')}`)
    expect(hits[0].headers['user-agent']).toBe('GeckoMail-Webhook/1.0')
    expect(op(id)).toBeUndefined()
  })

  it('retry-after honoured', async () => {
    reply = { status: 429, headers: { 'retry-after': '600' } }
    const id = fire()
    const before = Date.now()
    await settle(queue('desktop'), id)
    expect(op(id)!.not_before).toBeGreaterThan(before + 500_000)
  })

  it('cloud metadata address refused on server', async () => {
    const webhook = q.insertWebhook({ name: 'k', url: 'http://169.254.169.254/latest', secret: null })
    const r = await automationHandlers.testWebhook(session('server'), { id: webhook })
    expect(r).toMatchObject({ ok: false, error: expect.any(String) })
  })

  it('testWebhook: server blocked, desktop allowed', async () => {
    const id = q.insertWebhook({ name: 'k', url, secret: null })
    expect(await automationHandlers.testWebhook(session('server'), { id })).toMatchObject({ ok: false })
    expect(hits).toEqual([])
    expect(await automationHandlers.testWebhook(session('desktop'), { id })).toEqual({ ok: true, status: 200 })
    expect(hits).toHaveLength(1)
  })
})
