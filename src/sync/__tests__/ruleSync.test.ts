import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { ruleRowToInfo } from '../rpc/common'

describe('kural mezar taşları (R36)', () => {
  let dir: string
  let q: ReturnType<typeof makeQueries>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-rs-'))
    q = makeQueries(openDb(dir))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('silinen kural mezar taşı bırakır; aynı adla yeniden oluşturmak onu kaldırır', () => {
    const id = q.insertRule({ name: 'DMARC', accountId: null, groupId: null, conditions: {}, actions: [{ type: 'archive' }] })
    q.deleteRule(id)
    expect(q.deletedRuleTombstones().map((t) => t.name)).toEqual(['DMARC'])
    q.insertRule({ name: 'DMARC', accountId: null, groupId: null, conditions: {}, actions: [{ type: 'archive' }] })
    expect(q.deletedRuleTombstones()).toEqual([])
  })

  it('webhook adıyla upsert edilir ve aynı id korunur', () => {
    const a = q.upsertWebhookByName({ name: 'Slack', url: 'https://a', secret: null, enabled: true })
    const b = q.upsertWebhookByName({ name: 'Slack', url: 'https://b', secret: 's', enabled: false })
    expect(a).toBe(b)
    expect(q.getWebhookById(a)).toMatchObject({ url: 'https://b', secret: 's', enabled: 0 })
  })

  it('rule sync keeps runOnServer', () => {
    const base = { accountId: null, groupId: null, conditions: {}, actions: [] }
    q.upsertSyncRuleByName({ ...base, name: 'kapali', enabled: true, runOnServer: false })
    q.upsertSyncRuleByName({ ...base, name: 'eski-paket', enabled: true })
    const byName = (n: string) => q.getAllRules().find((r) => r.name === n)
    expect(byName('kapali')?.run_on_server).toBe(0)
    expect(byName('eski-paket')?.run_on_server).toBe(1)
    // var olan satır güncellenirken de taşınır
    q.upsertSyncRuleByName({ ...base, name: 'eski-paket', enabled: true, runOnServer: false })
    expect(byName('eski-paket')?.run_on_server).toBe(0)
    q.upsertSyncRuleByName({ ...base, name: 'kapali', enabled: true, runOnServer: true })
    expect(byName('kapali')?.run_on_server).toBe(1)
    // dışa aktarma alanı taşır
    q.upsertSyncRuleByName({ ...base, name: 'kapali', enabled: true, runOnServer: false })
    expect(q.getSyncExport().rules.find((r) => r.name === 'kapali')?.run_on_server).toBe(0)
  })

  it('eski paket alanı taşımıyorsa yerel run_on_server korunur', () => {
    const base = { accountId: null, groupId: null, conditions: {}, actions: [] }
    const byName = (n: string) => q.getAllRules().find((r) => r.name === n)
    q.upsertSyncRuleByName({ ...base, name: 'yerel-kapali', enabled: true, runOnServer: false })
    q.upsertSyncRuleByName({ ...base, name: 'yerel-kapali', enabled: false })
    expect(byName('yerel-kapali')).toMatchObject({ run_on_server: 0, enabled: 0 })
    q.upsertSyncRuleByName({ ...base, name: 'yerel-acik', enabled: true, runOnServer: true })
    q.upsertSyncRuleByName({ ...base, name: 'yerel-acik', enabled: true })
    expect(byName('yerel-acik')?.run_on_server).toBe(1)
  })

  it('RuleInfo ve updateRuleFields run_on_server taşır', () => {
    const id = q.insertRule({ name: 'R', accountId: null, groupId: null, conditions: {}, actions: [] })
    expect(ruleRowToInfo(q.getRuleById(id)!).runOnServer).toBe(true)
    q.updateRuleFields(id, { run_on_server: 0 })
    expect(ruleRowToInfo(q.getRuleById(id)!).runOnServer).toBe(false)
    const off = q.insertRule({ name: 'K', accountId: null, groupId: null, conditions: {}, actions: [], runOnServer: false })
    expect(ruleRowToInfo(q.getRuleById(off)!).runOnServer).toBe(false)
  })
})
