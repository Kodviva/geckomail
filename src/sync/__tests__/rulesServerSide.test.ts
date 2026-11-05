import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ImapFlow } from 'imapflow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageRow, RuleAction, RuleCondition } from '../../shared/rpc'
import { openDb } from '../db'
import { makeQueries, type HeaderInput } from '../db/queries'
import { pollAccount, pollFolder } from '../imapPoll'
import { movedArrivals } from '../movedArrivals'
import { notifyNewMail } from '../newMailNotify'
import type { OpQueue } from '../opQueue'
import type { RpcHub } from '../rpcHub'
import { clientPartAfterServerMove, effectAlreadyApplied, matchesServerMove, type MatchedAction } from '../rulesEngine'
import { RULES_BATCH, runRulesForAccount } from '../rulesRunner'
import { AUTOMATION_HOLD_PREF } from '../../shared/importTypes'

const WEBHOOK: RuleAction = { type: 'webhook', webhookId: 1 }
const MOVE: RuleAction = { type: 'move', folderName: 'Raporlar' }
const matched = (...actions: RuleAction[]): MatchedAction[] => actions.map((action, i) => ({ ruleId: i + 1, ruleName: `k${i}`, action }))

describe('effectAlreadyApplied', () => {
  it('etki satırda varsa true', () => {
    expect(effectAlreadyApplied({ seen: true, flagged: false }, { type: 'markRead' })).toBe(true)
    expect(effectAlreadyApplied({ seen: false, flagged: false }, { type: 'markRead' })).toBe(false)
    expect(effectAlreadyApplied({ seen: false, flagged: false }, { type: 'markUnread' })).toBe(true)
    expect(effectAlreadyApplied({ seen: true, flagged: false }, { type: 'markUnread' })).toBe(false)
    expect(effectAlreadyApplied({ seen: false, flagged: true }, { type: 'flag' })).toBe(true)
    expect(effectAlreadyApplied({ seen: false, flagged: false }, { type: 'flag' })).toBe(false)
  })

  it('bayrak dışı eylem hiç sayılmaz', () => {
    for (const a of [MOVE, WEBHOOK, { type: 'archive' }, { type: 'spam' }] as RuleAction[]) {
      expect(effectAlreadyApplied({ seen: true, flagged: true }, a)).toBe(false)
    }
  })
})

describe('sunucu taşıması yardımcıları', () => {
  it('clientPartAfterServerMove taşımaları atar', () => {
    const out = clientPartAfterServerMove(matched(MOVE, { type: 'archive' }, { type: 'spam' }, WEBHOOK, { type: 'flag' }))
    expect(out.map((m) => m.action.type)).toEqual(['webhook', 'flag'])
  })

  it('matchesServerMove klasörü adla ve türle eşler', () => {
    expect(matchesServerMove(matched(MOVE), { path: 'Raporlar', kind: 'other' })).toBe(true)
    expect(matchesServerMove(matched(MOVE), { path: 'INBOX.raporlar', kind: 'other' })).toBe(true)
    expect(matchesServerMove(matched(MOVE), { path: 'Baska', kind: 'other' })).toBe(false)
    expect(matchesServerMove(matched({ type: 'archive' }), { path: 'Eski', kind: 'archive' })).toBe(true)
    expect(matchesServerMove(matched({ type: 'archive' }), { path: 'Eski', kind: 'other' })).toBe(false)
    expect(matchesServerMove(matched(WEBHOOK), { path: 'Raporlar', kind: 'other' })).toBe(false)
  })
})

describe('sunucu tarafı kurallarda istemci', () => {
  let dir: string
  let q: ReturnType<typeof makeQueries>
  let acc: number
  let inbox: number
  let target: number
  let uid: number
  const opq = { kick: vi.fn() } as unknown as OpQueue

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-rss-'))
    q = makeQueries(openDb(dir))
    acc = q.insertAccount({ email: 'a@t.test', displayName: null, imapHost: 'm.t.test', imapPort: 993, smtpHost: 'm.t.test', smtpPort: 465, passwordEnc: Buffer.from('x') })
    inbox = q.upsertFolder(acc, 'INBOX', 'inbox')
    target = q.upsertFolder(acc, 'Raporlar', 'other')
    q.upsertSieveAccount(acc, { enabled: 1, state: 'active', watched_json: JSON.stringify(['Raporlar']) }, 1)
    uid = 0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const add = (folderId: number, o: Partial<HeaderInput> = {}): number => {
    uid++
    const folderKind = folderId === inbox ? 'inbox' : 'other'
    return q.upsertHeader({
      folderId, accountId: acc, folderKind, uid, messageId: `<m${uid}@t>`, inReplyTo: null, subject: 'rapor', fromName: null, fromAddr: 'x@y.test',
      toJson: null, date: 1_700_000_000_000 + uid, size: 10, seen: false, flagged: false, answered: false, hasAttachments: false,
      listUnsubscribe: null, listUnsubscribePost: null, rulesEligible: true, ...o
    }).id
  }
  const rule = (actions: RuleAction[], conditions: RuleCondition = { subjectContains: 'rapor' }) =>
    q.insertRule({ name: `r${Math.random()}`, accountId: acc, groupId: null, conditions, actions })
  const ops = () => [...q.dueOps(Date.now() + 1, 1000), ...q.dueWebhookOps(Date.now() + 1, 1000)].map((o) => o.kind)
  const run = async () => {
    const seen: { rows: MessageRow[]; reasons: ReadonlyMap<number, string>; scanned: number }[] = []
    await runRulesForAccount(q, opq, acc, () => {}, (rows, reasons, scanned) => seen.push({ rows, reasons, scanned }))
    return seen
  }
  const logs = () => q.getRuleLog(50).map((l) => l.summary)

  it('inbox row still moved', async () => {
    rule([MOVE])
    add(inbox)
    await run()
    expect(ops()).toEqual(['move_named'])
  })

  it('already seen no store op', async () => {
    rule([{ type: 'markRead' }])
    add(inbox, { seen: true })
    await run()
    expect(ops()).toEqual([])
    expect(logs()).toHaveLength(1)
  })

  it('flag ve markUnread eşdeğeri', async () => {
    rule([{ type: 'flag' }])
    rule([{ type: 'markUnread' }])
    add(inbox, { flagged: true })
    await run()
    expect(ops()).toEqual([])
    expect(logs()).toHaveLength(2)
  })

  it('etki yoksa bayrak işlemi kuyruğa girer', async () => {
    rule([{ type: 'markRead' }, { type: 'flag' }])
    add(inbox)
    await run()
    expect(ops()).toEqual(['store_flags', 'store_flags'])
  })

  it('aynı satırda ters bayrak sırası korunur', async () => {
    rule([{ type: 'markRead' }])
    rule([{ type: 'markUnread' }])
    const id = add(inbox)
    await run()
    expect(ops()).toEqual(['store_flags', 'store_flags'])
    expect(q.getMessage(id)?.seen).toBe(false)
  })

  it('split rule fires once', async () => {
    rule([MOVE, WEBHOOK])
    const id = add(target)
    await run()
    expect(ops()).toEqual(['call_webhook'])
    expect(q.messagesSince(acc, 0, 10, ['Raporlar']).map((r) => r.id)).toEqual([id]) // gizlenmedi: taşınmadı
    await run()
    expect(ops()).toEqual(['call_webhook'])
  })

  it('sunucuda taşındı günlüğü', async () => {
    rule([MOVE])
    add(target)
    await run()
    expect(logs()).toHaveLength(1)
    expect(logs()[0]).not.toContain('sync.rule')
  })

  it('izlenen klasörde bayrak çalışır, sunucu yaptıysa işlem yok', async () => {
    rule([MOVE, { type: 'markRead' }, { type: 'flag' }])
    add(target, { seen: true })
    await run()
    expect(ops()).toEqual(['store_flags'])
  })

  it('client-only rule still fires on server-moved mail', async () => {
    rule([MOVE])
    rule([WEBHOOK])
    add(target)
    await run()
    expect(ops()).toEqual(['call_webhook'])
  })

  it('unrelated row in watched folder ignored', async () => {
    rule([MOVE], { subjectContains: 'baska' })
    add(target)
    const seen = await run()
    expect(ops()).toEqual([])
    expect(seen[0]).toMatchObject({ rows: [], scanned: 1 })
    expect(logs()).toEqual([])
  })

  it('izlenen klasörde kurala eşleşen ama taşıması başka yere giden satır yok sayılır', async () => {
    rule([{ type: 'move', folderName: 'Baska' }, WEBHOOK])
    add(target)
    expect((await run())[0].rows).toEqual([])
    expect(ops()).toEqual([])
  })

  it('izlenmeyen klasör satırı sorguya girmez', async () => {
    const other = q.upsertFolder(acc, 'Diger', 'other')
    rule([{ type: 'move', folderName: 'Diger' }, WEBHOOK])
    add(other)
    expect(await run()).toEqual([])
  })

  it('user-moved row ignored', async () => {
    const f = q.getFolderById(target)!
    q.updateFolderSync(target, { uidvalidity: 1, last_seen_uidnext: 1, highest_modseq: null, last_seen_exists: 0 })
    q.prefSet(`sieve_watch_since:${acc}`, JSON.stringify({ Raporlar: 1 }))
    movedArrivals.expect(acc, 'Raporlar', [{ uid: 40, messageId: '<m1@t>' }])
    rule([MOVE, WEBHOOK])
    await pollFolder(q, q.getAccountRow(acc)!, { ...f, uidvalidity: 1, last_seen_uidnext: 1, last_seen_exists: 0 }, server(2), 1)
    expect(q.messagesSince(acc, 0, 100, ['Raporlar'])).toEqual([])
    expect(await run()).toEqual([])
  })

  it('notification parity', async () => {
    rule([MOVE, { type: 'notify', urgent: true }])
    const id = add(target)
    const [batch] = await run()
    expect(batch.rows.map((r) => r.id)).toEqual([id])
    expect(batch.reasons.get(id)).toBe('rule-urgent')
    const plain = add(target)
    rule([MOVE, { type: 'notify', urgent: false }], { subjectContains: 'yok' })
    rule([{ type: 'notify', urgent: false }])
    const [next] = await run()
    expect(next.reasons.get(plain)).toBe('rule-urgent')
  })

  it('otomasyon duraklatılmışken iki yolda da yalnız bildirim kararı sürer', async () => {
    q.prefSet(AUTOMATION_HOLD_PREF, '1')
    rule([MOVE, { type: 'markRead' }, WEBHOOK, { type: 'notify', urgent: true }])
    const ibx = add(inbox)
    const moved = add(target)
    const fired: number[] = []
    const seen: { rows: MessageRow[]; reasons: ReadonlyMap<number, string> }[] = []
    await runRulesForAccount(q, opq, acc, (ev) => fired.push(ev.messageId), (rows, reasons) => seen.push({ rows, reasons }))
    expect(ops()).toEqual([])
    expect(logs()).toEqual([])
    expect(fired).toEqual([])
    expect(q.getMessage(ibx)?.seen).toBe(false)
    expect(seen[0].rows.map((r) => r.id)).toEqual([ibx, moved])
    expect(seen[0].reasons.get(moved)).toBe('rule-urgent')
    expect(q.prefGet(`rules_watermark:${acc}`)).toBe(String(moved))
  })

  it('forward guard kept', async () => {
    rule([MOVE, { type: 'forward', to: 'b@t.test' }])
    add(target, { autoForwarded: true })
    await run()
    expect(ops()).toEqual([])
  })

  it('messagesSince klasör bilgisini taşır, izlenen liste yoksa yalnız inbox', () => {
    add(inbox)
    add(target)
    expect(q.messagesSince(acc, 0, 10).map((r) => r.folderPath)).toEqual(['INBOX'])
    expect(q.messagesSince(acc, 0, 10, ['Raporlar']).map((r) => [r.folderPath, r.folderKind])).toEqual([['INBOX', 'inbox'], ['Raporlar', 'other']])
  })

  it('full batch continues after filtering', async () => {
    rule([MOVE], { subjectContains: 'eslesen' })
    for (let i = 0; i < RULES_BATCH + 3; i++) add(target, { subject: i % 170 === 0 ? 'eslesen' : 'x' })
    const onNewMail = vi.fn(async () => {})
    const ctx = { q, opq, hub: { broadcast: vi.fn() } as unknown as RpcHub, pipeline: { onNewMail } }
    await notifyNewMail(ctx, acc)
    // ilk tur 500 tarar, 3 satırı hatta verir; döngü sürer ve kalan 3 satır da işlenir
    expect(Number(q.prefGet(`rules_watermark:${acc}`))).toBeGreaterThan(0)
    expect(q.messagesSince(acc, Number(q.prefGet(`rules_watermark:${acc}`)), 10, ['Raporlar'])).toEqual([])
    expect(onNewMail).toHaveBeenCalledTimes(1)
  })

  it('tam tur boş çıksa da sürer', async () => {
    rule([MOVE], { subjectContains: 'eslesen' })
    for (let i = 0; i < RULES_BATCH; i++) add(target, { subject: 'x' })
    const last = add(target, { subject: 'eslesen' })
    const onNewMail = vi.fn(async () => {})
    await notifyNewMail({ q, opq, hub: { broadcast: vi.fn() } as unknown as RpcHub, pipeline: { onNewMail } }, acc)
    expect(onNewMail).toHaveBeenCalledTimes(1)
    expect((onNewMail.mock.calls[0] as unknown as [number, MessageRow[]])[1].map((r) => r.id)).toEqual([last])
  })

  describe('izlenen klasör yoklaması', () => {
    const noList = (client: ImapFlow): ImapFlow => {
      Object.assign(client, { list: async () => [{ path: 'INBOX' }, { path: 'Raporlar' }] })
      return client
    }
    const settled = (id: number, next: number): void => q.updateFolderSync(id, { uidvalidity: 1, last_seen_uidnext: next, highest_modseq: null, last_seen_exists: next - 1 })

    it('watched folder arrival triggers run', async () => {
      settled(inbox, 1)
      settled(target, 1)
      q.prefSet(`sieve_watch_since:${acc}`, JSON.stringify({ Raporlar: 1 }))
      const client = noList(serverByPath({ INBOX: 1, Raporlar: 3 }))
      const r = await pollAccount(q, q.getAccountRow(acc)!, client, 1)
      expect(r).toMatchObject({ newInboxMessages: 0, watchedArrivals: 2 })
      expect(q.messagesSince(acc, 0, 10, ['Raporlar'])).toHaveLength(2)
    })

    it('activation window: mail delivered before the first poll runs the client part', async () => {
      settled(inbox, 1)
      settled(target, 2)
      q.prefSet(`sieve_watch_since:${acc}`, JSON.stringify({ Raporlar: 1_700_000_000_003 }))
      const r = await pollAccount(q, q.getAccountRow(acc)!, noList(serverByPath({ INBOX: 1, Raporlar: 6 })), 1)
      expect(r.watchedArrivals).toBe(3)
      expect(q.messagesSince(acc, 0, 10, ['Raporlar']).map((m) => m.uid)).toEqual([3, 4, 5])
    })

    it('activation window: a folder never polled before', async () => {
      settled(inbox, 1)
      q.prefSet(`sieve_watch_since:${acc}`, JSON.stringify({ Raporlar: 1_700_000_000_002 }))
      const r = await pollAccount(q, q.getAccountRow(acc)!, noList(serverByPath({ INBOX: 1, Raporlar: 4 })), 1)
      expect(r.watchedArrivals).toBe(2)
    })

    it('an old mail filed by another client does not fire: INTERNALDATE, not Date', async () => {
      settled(inbox, 1)
      settled(target, 1)
      q.prefSet(`sieve_watch_since:${acc}`, JSON.stringify({ Raporlar: 1_800_000_000_000 }))
      internal = () => 1_799_000_000_000
      const r = await pollAccount(q, q.getAccountRow(acc)!, noList(serverByPath({ INBOX: 1, Raporlar: 3 })), 1)
      internal = (u) => 1_700_000_000_000 + u
      expect(r.watchedArrivals).toBe(0)
      expect(q.messagesSince(acc, 0, 10, ['Raporlar'])).toEqual([])
    })

    it('a UIDVALIDITY reset does not refire rules', async () => {
      settled(inbox, 1)
      q.updateFolderSync(target, { uidvalidity: 9, last_seen_uidnext: 3, highest_modseq: null, last_seen_exists: 2 })
      const r = await pollAccount(q, q.getAccountRow(acc)!, noList(serverByPath({ INBOX: 1, Raporlar: 3 })), 1)
      expect(r.watchedArrivals).toBe(0)
      expect(q.messagesSince(acc, 0, 10, ['Raporlar'])).toEqual([])
    })

    it('izlenmeyen klasör yoklanmaz', async () => {
      q.upsertSieveAccount(acc, { watched_json: '[]' }, 2)
      settled(inbox, 1)
      const locks: string[] = []
      const client = noList(serverByPath({ INBOX: 1, Raporlar: 3 }, locks))
      await pollAccount(q, q.getAccountRow(acc)!, client, 1)
      expect(locks).toEqual(['INBOX'])
    })

    it('missing watched folder skipped', async () => {
      q.upsertSieveAccount(acc, { watched_json: JSON.stringify(['Yok', 'Raporlar']) }, 2)
      settled(inbox, 1)
      const base = serverByPath({ INBOX: 1, Raporlar: 1 })
      const client = noList({
        ...base,
        getMailboxLock: async (p: string) => {
          if (p === 'Raporlar') throw Object.assign(new Error('x'), { serverResponseCode: 'NONEXISTENT' })
          return base.getMailboxLock(p)
        }
      } as unknown as ImapFlow)
      await expect(pollAccount(q, q.getAccountRow(acc)!, client, 1)).resolves.toMatchObject({ watchedArrivals: 0 })
    })

    it('baseline no rules: hiç yoklanmamış klasör', async () => {
      settled(inbox, 1)
      const client = noList(serverByPath({ INBOX: 1, Raporlar: 5 }))
      const r = await pollAccount(q, q.getAccountRow(acc)!, client, 1)
      expect(r.watchedArrivals).toBe(0)
      expect(q.messagesSince(acc, 0, 10, ['Raporlar'])).toEqual([])
    })

    it('baseline no rules: daha önce eşitlenmiş klasörün birikmişi', async () => {
      settled(inbox, 1)
      settled(target, 2)
      q.prefSet(`sieve_watch_since:${acc}`, JSON.stringify({ Raporlar: 1_700_000_000_006 }))
      const first = await pollAccount(q, q.getAccountRow(acc)!, noList(serverByPath({ INBOX: 1, Raporlar: 6 })), 1)
      expect(first.watchedArrivals).toBe(0)
      expect(q.messagesSince(acc, 0, 10, ['Raporlar'])).toEqual([])
      const next = await pollAccount(q, q.getAccountRow(acc)!, noList(serverByPath({ INBOX: 1, Raporlar: 7 })), 2)
      expect(next.watchedArrivals).toBe(1)
    })

    it('izlemeden çıkan klasör yeniden girince taban yenilenir', async () => {
      settled(inbox, 1)
      settled(target, 2)
      const row = q.getAccountRow(acc)!
      await pollAccount(q, row, noList(serverByPath({ INBOX: 1, Raporlar: 3 })), 1)
      q.upsertSieveAccount(acc, { watched_json: '[]' }, 2)
      await pollAccount(q, row, noList(serverByPath({ INBOX: 1, Raporlar: 3 })), 2)
      q.upsertSieveAccount(acc, { watched_json: JSON.stringify(['Raporlar']) }, 3)
      const r = await pollAccount(q, row, noList(serverByPath({ INBOX: 1, Raporlar: 9 })), 3)
      expect(r.watchedArrivals).toBe(0)
    })
  })

  let internal: (uid: number) => number = (u) => 1_700_000_000_000 + u

  /** Tek klasörlü sahte sunucu: uidNext'e kadar uid'ler */
  function server(uidNext: number): ImapFlow {
    return serverByPath({ Raporlar: uidNext })
  }

  function serverByPath(next: Record<string, number>, locks: string[] = []): ImapFlow {
    const client = {
      mailbox: null as unknown,
      getMailboxLock: async (path: string) => {
        locks.push(path)
        client.mailbox = { uidValidity: 1n, uidNext: next[path], exists: next[path] - 1 }
        client.current = path
        return { release() {} }
      },
      current: '',
      search: async () => Array.from({ length: next[client.current] - 1 }, (_, i) => i + 1),
      fetch: async function* (range: string) {
        const from = Number(range.split(':')[0])
        for (let u = from; u < next[client.current]; u++) {
          yield { uid: u, envelope: { messageId: `<m${u}@t>`, subject: 'rapor', from: [{ address: 'x@y.test' }], date: new Date(1_700_000_000_000 + u) }, flags: new Set<string>(), size: 10, internalDate: new Date(internal(u)) }
        }
      }
    }
    return client as unknown as ImapFlow
  }
})
