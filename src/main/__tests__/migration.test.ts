import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MigrationEvent, PlanItem, Sealed, SealRequest } from '../../shared/importTypes'
import { readMode, updateMode, writeMode } from '../desktopMode'
import { MigrationRunner, recordImport } from '../migration'

const ORIGIN = 'https://posta.example.com'
const item = (key: string, kind: PlanItem['kind'] = 'rule', blocked: PlanItem['blocked'] = null): PlanItem => ({ key, kind, label: key, blocked })
const sealedOf = (key: string): Sealed => ({ key, pub: 'p', iv: 'i', ct: 'zarf' })

function setup(plan: PlanItem[], o: { failAt?: string; replies?: Record<string, { status: string; detail?: string; notice?: string }>; confirm?: boolean; missing?: string[] } = {}) {
  const sent: string[] = []
  let done: string[] = []
  let failAt = o.failAt
  const calls: string[] = []
  const call = vi.fn(async (method: string, params: unknown) => {
    calls.push(method)
    if (method === 'importBegin') return { importId: 'imp', serverKey: 'anahtar', done: [...done] }
    if (method === 'importFinish') return { accounts: 1 }
    const { item: it } = params as { item: Sealed }
    if (it.key === failAt) {
      failAt = undefined
      throw new Error('sunucu bağlantısı koptu')
    }
    sent.push(it.key)
    const r = o.replies?.[it.key] ?? { status: 'added' }
    if (r.status !== 'blocked') done.push(it.key)
    return r
  })
  const seal = vi.fn(async (r: SealRequest) => r.keys.filter((k) => !o.missing?.includes(k)).map(sealedOf))
  const confirm = vi.fn(async () => o.confirm ?? true)
  const events: MigrationEvent[] = []
  const runner = new MigrationRunner({
    link: { call } as never, engine: { plan: async () => plan, seal }, confirm, onEvent: (e) => events.push(e), batch: 2
  })
  return { runner, sent, call, seal, confirm, events, calls, last: () => events[events.length - 1], reset: () => { done = [] } }
}

describe('MigrationRunner', () => {
  it('confirm declined sends nothing', async () => {
    const t = setup([item('account:a', 'account')], { confirm: false })
    await t.runner.run('src', ORIGIN)
    expect(t.confirm).toHaveBeenCalledWith({ origin: ORIGIN, accounts: 1 })
    expect(t.call).not.toHaveBeenCalled()
    expect(t.seal).not.toHaveBeenCalled()
    expect(t.last().phase).toBe('paused')
  })

  it('yerel uyarı onaydan önce görünür, engelli hesapta yazılmaz', async () => {
    const t = setup([{ ...item('account:a', 'account'), notice: 'sieveLeft' }, { ...item('account:b', 'account', 'vaultLocked'), notice: 'sieveLeft' }], { confirm: false })
    await t.runner.run('src', ORIGIN)
    expect(t.events[0]).toMatchObject({ phase: 'plan', notices: [{ key: 'account:a', label: 'account:a', notice: 'sieveLeft' }] })
  })

  it('onay mühürlemeden ve sunucudan önce, köken ve hesap sayısıyla', async () => {
    const t = setup([item('account:a', 'account'), item('account:b', 'account', 'vaultLocked'), item('rule:r')])
    t.confirm.mockImplementation(async () => {
      expect(t.call).not.toHaveBeenCalled()
      expect(t.seal).not.toHaveBeenCalled()
      return true
    })
    await t.runner.run('src', ORIGIN)
    expect(t.confirm).toHaveBeenCalledWith({ origin: ORIGIN, accounts: 1 })
  })

  it('her çalıştırma yeniden sorar: onay saklanmaz', async () => {
    const t = setup([item('a')])
    await t.runner.run('src', ORIGIN)
    await t.runner.run('src', ORIGIN)
    expect(t.confirm).toHaveBeenCalledTimes(2)
  })

  it('anahtarı yalnız sunucu yanıtından alır, kaynak kimliğini iletir', async () => {
    const t = setup([item('a')])
    await t.runner.run('src', ORIGIN)
    expect(t.call).toHaveBeenCalledWith('importBegin', { sourceId: 'src' })
    expect(t.seal).toHaveBeenCalledWith({ importId: 'imp', serverKey: 'anahtar', keys: ['a'] })
  })

  it('pause on failure then resume sends only rest', async () => {
    const plan = ['a', 'b', 'c', 'd', 'e'].map((k) => item(k))
    const t = setup(plan, { failAt: 'c' })
    await t.runner.run('src', ORIGIN)
    expect(t.sent).toEqual(['a', 'b'])
    expect(t.last()).toMatchObject({ phase: 'paused', done: 2, total: 5, failed: [{ key: 'c', label: 'c' }], reason: 'connection' })
    expect(t.calls).not.toContain('importFinish')
    t.sent.length = 0
    await t.runner.run('src', ORIGIN)
    expect(t.sent).toEqual(['c', 'd', 'e'])
    expect(t.last()).toMatchObject({ phase: 'done', done: 5, total: 5, failed: [] })
  })

  it('importBegin başarısızsa mühürlemez, duraklar', async () => {
    const t = setup([item('a')])
    t.call.mockRejectedValueOnce(new Error('kopuk'))
    await t.runner.run('src', ORIGIN)
    expect(t.seal).not.toHaveBeenCalled()
    expect(t.last().phase).toBe('paused')
  })

  it('mühürleme başarısızsa duraklar: kilitlenen kasa ya da düşen motor', async () => {
    const t = setup([item('a'), item('b')])
    t.seal.mockRejectedValueOnce(new Error('motor'))
    await t.runner.run('src', ORIGIN)
    expect(t.sent).toEqual([])
    expect(t.last()).toMatchObject({ phase: 'paused', reason: 'localSession' })
  })

  it('motorun vermediği öge başarısız sayılır, kalanı sürer, tamamlanmış denmez', async () => {
    const t = setup([item('a'), item('b'), item('c')], { missing: ['b'] })
    await t.runner.run('src', ORIGIN)
    expect(t.sent).toEqual(['a', 'c'])
    expect(t.last()).toMatchObject({ phase: 'paused', failed: [{ key: 'b', label: 'b' }] })
    expect(t.calls).not.toContain('importFinish')
  })

  it('sunucu engeli özete girer, taşıma biter', async () => {
    const t = setup([item('account:a', 'account'), item('rule:r')], { replies: { 'account:a': { status: 'blocked', detail: 'vaultRequired' } } })
    await t.runner.run('src', ORIGIN)
    expect(t.last()).toMatchObject({ phase: 'done', blocked: [{ key: 'account:a', blocked: 'vaultRequired' }] })
    expect(t.calls).toContain('importFinish')
  })

  it('kapalı gelen öge özete yazılır, bilinmeyen uyarı kodu gitmez', async () => {
    const { runner, events } = setup([item('rule:A'), item('rule:B')], { replies: { 'rule:A': { status: 'added', notice: 'scopeDisabled' }, 'rule:B': { status: 'added', notice: '<b>x' } } })
    await runner.run('kaynak', ORIGIN)
    expect(events.at(-1)).toMatchObject({ phase: 'done', notices: [{ key: 'rule:A', label: 'rule:A', notice: 'scopeDisabled' }] })
  })

  it('yeni sunucu engel kodları özete olduğu gibi gider', async () => {
    const { runner, events } = setup([item('group:E', 'group'), item('rule:R')], { replies: { 'group:E': { status: 'blocked', detail: 'groupConflict' }, 'rule:R': { status: 'blocked', detail: 'webhookConflict' } } })
    await runner.run('kaynak', ORIGIN)
    expect(events.at(-1)!.blocked.map((b) => b.blocked)).toEqual(['groupConflict', 'webhookConflict'])
  })

  it('yerel engelli öge mühürlenmez, gönderilmez, özette görünür', async () => {
    const t = setup([item('account:a', 'account', 'oauthReconnect'), item('rule:r')])
    await t.runner.run('src', ORIGIN)
    expect(t.seal.mock.calls.flatMap(([r]) => r.keys)).toEqual(['rule:r'])
    expect(t.last().blocked.map((b) => b.key)).toEqual(['account:a'])
  })

  it('renderer olayı zarf ya da anahtar taşımaz', async () => {
    const t = setup([item('a'), item('b'), item('c')])
    await t.runner.run('src', ORIGIN)
    const text = JSON.stringify(t.events)
    expect(text).not.toContain('zarf')
    expect(text).not.toContain('anahtar')
    expect(t.events.map((e) => e.phase)).toEqual(['plan', 'sending', 'sending', 'sending', 'done'])
  })

  it('tek seferde batch kadar mühürlenir', async () => {
    const t = setup(['a', 'b', 'c'].map((k) => item(k)))
    await t.runner.run('src', ORIGIN)
    expect(t.seal.mock.calls.map(([r]) => r.keys)).toEqual([['a', 'b'], ['c']])
  })

  it('düşman sunucu yanıtı akışı bozamaz, arayüze bilinmeyen kod gitmez', async () => {
    const t = setup([item('a'), item('b')], { replies: { a: { status: 'blocked', detail: 'uydurma' } } })
    await t.runner.run('src', ORIGIN)
    expect(t.last().blocked).toMatchObject([{ key: 'a', blocked: 'invalid' }])
    const u = setup([item('a')])
    u.call.mockResolvedValueOnce({ importId: 'imp', serverKey: 'k', done: 'hepsi' } as never)
    await u.runner.run('src', ORIGIN)
    expect(u.sent).toEqual(['a'])
    const v = setup([item('a')])
    v.call.mockResolvedValueOnce(null as never)
    await v.runner.run('src', ORIGIN)
    expect(v.last()).toMatchObject({ phase: 'paused', reason: 'connection' })
    expect(v.seal).not.toHaveBeenCalled()
  })

  it('plan alınamazsa sunucuya gidilmez', async () => {
    const t = setup([])
    const runner = new MigrationRunner({ link: { call: t.call } as never, engine: { plan: async () => { throw new Error('yerel yönetici yok') }, seal: t.seal }, confirm: t.confirm, onEvent: (e) => t.events.push(e) })
    await runner.run('src', ORIGIN)
    expect(t.confirm).not.toHaveBeenCalled()
    expect(t.call).not.toHaveBeenCalled()
    expect(t.last()).toMatchObject({ phase: 'paused', reason: 'localSession' })
  })
})

describe('recordImport', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gecko-mig-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('mode unchanged after finish', () => {
    updateMode(dir, {})
    recordImport(dir, ORIGIN, 123)
    expect(readMode(dir)).toMatchObject({ mode: 'local', serverOrigin: null, importedTo: { origin: ORIGIN, at: 123 } })
  })

  it('kaynak kimliği kalıcı: sürdürme aynı kimlikle', () => {
    const first = updateMode(dir, {}).sourceId
    recordImport(dir, ORIGIN, 1)
    expect(readMode(dir).sourceId).toBe(first)
    expect(readdirSync(dir)).toEqual(['desktop-mode.json'])
    writeMode(dir, { ...readMode(dir), closeHintShown: true })
    expect(readMode(dir).importedTo?.origin).toBe(ORIGIN)
  })
})
