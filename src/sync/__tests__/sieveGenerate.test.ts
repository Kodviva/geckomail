import { describe, expect, it } from 'vitest'
import type { RuleAction, RuleCondition } from '../../shared/rpc'
import type { SieveVacation } from '../../shared/sieve'
import type { RuleRow } from '../db/queries'
import { evaluateRules, orderActions } from '../rulesEngine'
import { generateEmptyRules, generateSieve, generateWrapper, parseManagedHeader, parseWrapperTarget, sieveQuote, type SieveGenInput } from '../sieve/generate'

function rule(id: number, conditions: RuleCondition, actions: RuleAction[], extra: Partial<RuleRow> = {}): RuleRow {
  return {
    id, name: `kural-${id}`, enabled: 1, account_id: null, group_id: null,
    conditions_json: JSON.stringify(conditions), actions_json: JSON.stringify(actions),
    created_at: 0, last_triggered_at: null, trigger_count: 0, run_on_server: 1, ...extra
  }
}

const ALL_EXT = ['fileinto', 'imap4flags', 'mailbox', 'special-use', 'vacation', 'date', 'relational', 'comparator-i;unicode-casemap']
const FOLDERS = [
  { path: 'INBOX', kind: 'inbox' as const }, { path: 'INBOX.Fatura', kind: 'other' as const }, { path: 'Raporlar', kind: 'other' as const },
  { path: 'Archive', kind: 'archive' as const }, { path: 'Junk', kind: 'junk' as const }
]
const gen = (over: Partial<SieveGenInput>) =>
  generateSieve({ rules: [], extensions: ALL_EXT, folders: FOLDERS, delimiters: ['.', '/'], vacation: null, accountEmail: 'a@t.test', ...over })
const moveTo = (folderName: string): RuleAction => ({ type: 'move', folderName })
const body = (text: string | null) => text!.slice(text!.indexOf('\n') + 1)
// dizgiler atılınca geriye yalnız sözdizimi kalır: komut olarak var mı sorusu için
const code = (text: string | null) => text!.replace(/"(?:\\.|[^"\\])*"/g, '""')
const VAC: SieveVacation = { enabled: true, subject: 'İzindeyim', body: 'Pazartesi\ndönerim', days: 3, startDate: null, endDate: null }

describe('generateSieve', () => {
  it('deterministic output', () => {
    const rules = [rule(2, { senderContains: 'b' }, [moveTo('Raporlar')]), rule(1, { subjectContains: 'a' }, [{ type: 'markRead' }])]
    const a = gen({ rules })
    const b = gen({ rules })
    const sorted = gen({ rules: [...rules].reverse() })
    expect(a.text).toBe(b.text)
    expect(sorted.text).toBe(a.text)
    expect(a.plans.map((p) => p.ruleId)).toEqual([1, 2])
  })

  it('flags precede fileinto', () => {
    const { text } = gen({ rules: [rule(1, { senderContains: 'a' }, [moveTo('Raporlar')]), rule(2, { senderContains: 'b' }, [{ type: 'markRead' }])] })
    expect(text!.indexOf('addflag')).toBeGreaterThan(-1)
    expect(text!.indexOf('addflag')).toBeLessThan(text!.indexOf('fileinto "Raporlar"'))
  })

  it('two movers single copy', () => {
    const { text } = gen({ rules: [rule(1, { senderContains: 'a' }, [moveTo('Raporlar')]), rule(2, { senderContains: 'b' }, [moveTo('INBOX.Fatura')])] })
    const c = code(text)
    expect(c.match(/\bif\b/g)).toHaveLength(1)
    expect(c.match(/\belsif\b/g)).toHaveLength(1)
    expect(text).toMatch(/fileinto "Raporlar";\s*\} elsif /)
    expect(c).not.toMatch(/\bstop\b/)
  })

  it('tek kuralın ikinci taşıması sunucuya gitmez', () => {
    const { text, plans } = gen({ rules: [rule(1, { senderContains: 'a' }, [moveTo('Raporlar'), { type: 'archive' }])] })
    expect(text!.match(/fileinto/g)!.filter(Boolean).length).toBe(2) // require + tek komut
    expect(plans[0]).toEqual({ ruleId: 1, placement: 'server', reason: null, server: [moveTo('Raporlar')], client: [], targetPath: 'Raporlar' })
  })

  it('require lists only used', () => {
    const { text, requires } = gen({ rules: [rule(1, { senderContains: 'a' }, [moveTo('Raporlar')])] })
    expect(requires).toEqual(['fileinto'])
    expect(text).toContain('require ["fileinto"];')
    expect(text).not.toContain('imap4flags')
  })

  it('require sıralı ve kullanılan eklentileri kapsar', () => {
    const { requires } = gen({ rules: [rule(1, { senderContains: 'a' }, [{ type: 'flag' }, moveTo('Yeni')]), rule(2, {}, [{ type: 'archive' }])] })
    expect(requires).toEqual(['fileinto', 'imap4flags', 'mailbox', 'special-use'])
  })

  it('koşul çevirisi: gönderen, alan adı, konu, boş koşul', () => {
    const multi = gen({ rules: [rule(1, { senderContains: 'dmarc', domainEquals: '@softvia.co', subjectContains: 'SLA' }, [{ type: 'flag' }])] })
    expect(multi.text).toContain('allof(address :contains "from" "dmarc", address :domain :is "from" "softvia.co", header :contains "subject" "SLA")')
    const empty = gen({ rules: [rule(1, {}, [{ type: 'flag' }])] })
    expect(empty.text).toContain('if true {')
    expect(empty.plans[0].placement).toBe('server')
  })

  it('eylem çevirisi: bayraklar ve özel klasörler', () => {
    const { text } = gen({ rules: [rule(1, { senderContains: 'a' }, [{ type: 'markRead' }, { type: 'flag' }, { type: 'markUnread' }]), rule(2, { senderContains: 'b' }, [{ type: 'archive' }]), rule(3, { senderContains: 'c' }, [{ type: 'spam' }])] })
    expect(text).toContain('addflag "\\\\Seen";')
    expect(text).toContain('addflag "\\\\Flagged";')
    expect(text).toContain('removeflag "\\\\Seen";')
    expect(text).toContain('fileinto :specialuse "\\\\Archive" "Archive";')
    expect(text).toContain('fileinto :specialuse "\\\\Junk" "Junk";')
  })

  it('special-use yoksa düz fileinto', () => {
    const { text, requires } = gen({ extensions: ['fileinto'], rules: [rule(1, {}, [{ type: 'archive' }])] })
    expect(text).toContain('fileinto "Archive";')
    expect(requires).toEqual(['fileinto'])
  })

  it('klasör yerel eşlemeyle bulunur (INBOX öneki, büyük/küçük harf)', () => {
    const { plans, text } = gen({ rules: [rule(1, {}, [moveTo(' fatura ')])] })
    expect(plans[0].targetPath).toBe('INBOX.Fatura')
    expect(text).toContain('fileinto "INBOX.Fatura";')
    expect(text).not.toContain(':create')
  })

  it('kural yorumu id taşır, ad taşımaz', () => {
    const { text } = gen({ rules: [rule(7, {}, [{ type: 'flag' }], { name: 'Gizli ad' })] })
    expect(text).toContain('# geckomail:rule:7')
    expect(text).not.toContain('Gizli ad')
  })

  it('attachment rule stays on client', () => {
    for (const hasAttachment of [true, false]) {
      const { plans, text } = gen({ rules: [rule(1, { hasAttachment, senderContains: 'a' }, [moveTo('Raporlar')])] })
      expect(plans[0]).toMatchObject({ placement: 'client', reason: 'attachment', server: [] })
      expect(text).toBeNull()
    }
  })

  it('forward stays on client', () => {
    const { plans, text } = gen({ rules: [rule(1, { senderContains: 'a' }, [{ type: 'forward', to: 'b@t.test' }])] })
    expect(plans[0]).toMatchObject({ placement: 'client', server: [], client: [{ type: 'forward', to: 'b@t.test' }], reason: null })
    expect(text).toBeNull()
  })

  it('webhook stays on client', () => {
    const { plans } = gen({ rules: [rule(1, { senderContains: 'a' }, [{ type: 'webhook', webhookId: 1 }, { type: 'notify' }])] })
    expect(plans[0]).toMatchObject({ placement: 'client', server: [] })
    expect(plans[0].client).toHaveLength(2)
  })

  it('run_on_server 0: user_choice', () => {
    const { plans, text } = gen({ rules: [rule(1, { senderContains: 'a' }, [moveTo('Raporlar')], { run_on_server: 0 })] })
    expect(plans[0]).toMatchObject({ placement: 'client', reason: 'user_choice' })
    expect(text).toBeNull()
  })

  it('split rule', () => {
    const { plans, watched } = gen({ rules: [rule(1, { subjectContains: 'FAILED' }, [moveTo('Raporlar'), { type: 'webhook', webhookId: 1 }])] })
    expect(plans[0]).toEqual({ ruleId: 1, placement: 'split', reason: null, server: [moveTo('Raporlar')], client: [{ type: 'webhook', webhookId: 1 }], targetPath: 'Raporlar' })
    expect(watched).toEqual(['Raporlar'])
  })

  it('spam with webhook stays client', () => {
    const { plans, text } = gen({ rules: [rule(1, { senderContains: 'a' }, [{ type: 'spam' }, { type: 'webhook', webhookId: 1 }])] })
    expect(plans[0]).toMatchObject({ placement: 'client', reason: 'spam_split', server: [] })
    expect(text).toBeNull()
  })

  it('ext_missing', () => {
    const noFileinto = gen({ extensions: ['imap4flags'], rules: [rule(1, {}, [moveTo('Raporlar')])] })
    expect(noFileinto.plans[0]).toMatchObject({ placement: 'client', reason: 'ext_missing' })
    const noFlags = gen({ extensions: ['fileinto'], rules: [rule(1, {}, [{ type: 'flag' }])] })
    expect(noFlags.plans[0]).toMatchObject({ placement: 'client', reason: 'ext_missing' })
    const partial = gen({ extensions: ['fileinto'], rules: [rule(1, {}, [{ type: 'markRead' }, moveTo('Raporlar')])] })
    expect(partial.plans[0]).toMatchObject({ placement: 'split', reason: 'ext_missing', server: [moveTo('Raporlar')], client: [{ type: 'markRead' }] })
  })

  it('imap4flags yokken bayrak taşıyan spam kuralı istemcide kalır', () => {
    const { plans } = gen({ extensions: ['fileinto'], rules: [rule(1, {}, [{ type: 'markRead' }, { type: 'spam' }])] })
    expect(plans[0]).toMatchObject({ placement: 'client', reason: 'spam_split' })
  })

  it('non_ascii', () => {
    const without = gen({ extensions: ['fileinto'], rules: [rule(1, { subjectContains: 'Şeker' }, [moveTo('Raporlar')])] })
    expect(without.plans[0]).toMatchObject({ placement: 'client', reason: 'non_ascii' })
    const withCmp = gen({ rules: [rule(1, { subjectContains: 'Şeker' }, [moveTo('Raporlar')])] })
    expect(withCmp.plans[0].placement).toBe('server')
    expect(withCmp.text).toContain('header :comparator "i;unicode-casemap" :contains "subject" "Şeker"')
    expect(withCmp.requires).toContain('comparator-i;unicode-casemap')
  })

  it('ASCII değerde karşılaştırıcı eklenmez', () => {
    const { text, requires } = gen({ rules: [rule(1, { subjectContains: 'abc' }, [moveTo('Raporlar')])] })
    expect(text).not.toContain(':comparator')
    expect(requires).not.toContain('comparator-i;unicode-casemap')
  })

  it('rejects control characters', () => {
    const { plans, text } = gen({ rules: [rule(1, { subjectContains: 'a\nb' }, [{ type: 'flag' }])] })
    expect(plans[0]).toMatchObject({ placement: 'client', reason: 'unsafe_string' })
    expect(text).toBeNull()
    const mixed = gen({ rules: [rule(1, { subjectContains: 'iz\u0001li' }, [{ type: 'flag' }]), rule(2, { senderContains: 'x' }, [{ type: 'flag' }])] })
    expect(mixed.text).not.toContain('iz')
    const folder = gen({ rules: [rule(1, {}, [moveTo('a\r\nb')])] })
    expect(folder.plans[0].placement).toBe('client')
    expect(folder.text).toBeNull()
  })

  it('quote injection', () => {
    const evil = 'a" { discard; } "'
    const { text } = gen({ rules: [rule(1, { subjectContains: evil }, [moveTo('Raporlar')])] })
    expect(text).toContain('"a\\" { discard; } \\""')
    const c = code(body(text))
    expect(c.match(/\bif\b/g)).toHaveLength(1)
    expect(c).not.toContain('discard')
    const slash = gen({ rules: [rule(1, { subjectContains: 'a\\' }, [moveTo('Raporlar')])] })
    expect(slash.text).toContain('"a\\\\"')
  })

  it('klasör adı ve hesap adresi de kaçırılır', () => {
    const { text } = gen({ folders: [{ path: 'a"b', kind: 'other' }], rules: [rule(1, {}, [moveTo('a"b')])], vacation: VAC, accountEmail: 'x"y@t.test' })
    expect(text).toContain('fileinto "a\\"b";')
    expect(text).toContain('"x\\"y@t.test"')
  })

  it('unknown folder', () => {
    const create = gen({ rules: [rule(1, {}, [moveTo('Yeni')])] })
    expect(create.text).toContain('fileinto :create "Yeni";')
    expect(create.requires).toContain('mailbox')
    expect(create.watched).toEqual(['Yeni'])
    const withClient = gen({ rules: [rule(1, {}, [moveTo('Yeni'), { type: 'webhook', webhookId: 1 }])] })
    expect(withClient.plans[0]).toMatchObject({ placement: 'client', reason: 'folder_unknown' })
    const nested = gen({ rules: [rule(1, {}, [moveTo('Yeni/Alt')])] })
    expect(nested.plans[0]).toMatchObject({ placement: 'client', reason: 'folder_unknown' })
    const noMailbox = gen({ extensions: ['fileinto'], rules: [rule(1, {}, [moveTo('Yeni')])] })
    expect(noMailbox.plans[0]).toMatchObject({ placement: 'client', reason: 'folder_unknown' })
  })

  it('archive/spam: yerel klasör yoksa istemcide', () => {
    for (const type of ['archive', 'spam'] as const) {
      expect(gen({ folders: [], rules: [rule(1, {}, [{ type }])] }).plans[0].reason).toBe('folder_unknown')
    }
  })

  it('watch cap', () => {
    const folders = Array.from({ length: 9 }, (_, i) => ({ path: `K${i + 1}`, kind: 'other' as const }))
    const rules = folders.map((f, i) => rule(i < 8 ? i + 1 : 30, { senderContains: `s${i}` }, [moveTo(f.path)]))
    const out = gen({ folders: [...folders, ...FOLDERS], rules: [...rules, rule(20, { senderContains: 'z' }, [{ type: 'spam' }]), rule(21, { senderContains: 'y' }, [moveTo('K1')])] })
    expect(out.watched).toHaveLength(8)
    expect(out.plans.find((p) => p.ruleId === 30)).toMatchObject({ placement: 'client', reason: 'watch_cap', server: [] })
    expect(out.watched).not.toContain('Junk')
    expect(out.plans.find((p) => p.ruleId === 20)).toMatchObject({ placement: 'server', targetPath: 'Junk' })
    // var olan hedefe giden kural sınıra takılmaz
    expect(out.plans.find((p) => p.ruleId === 21)?.placement).toBe('server')
    expect(gen({ folders, rules, maxWatched: 2 }).watched).toHaveLength(2)
  })

  describe('spam ve başka kuralın istemci eylemi', () => {
    const webhook: RuleAction = { type: 'webhook', webhookId: 1 }

    it('rule 1 spam, rule 2 webhook: ikisi de çalışır', () => {
      const rules = [rule(1, { subjectContains: 'kampanya' }, [{ type: 'spam' }]), rule(2, { senderContains: 'x@' }, [webhook])]
      const { plans, text } = gen({ rules })
      expect(plans[0]).toMatchObject({ placement: 'client', reason: 'spam_split', server: [], client: [{ type: 'spam' }] })
      expect(text).toBeNull()
      const matched = evaluateRules({ fromAddr: 'x@t.test', subject: 'kampanya', hasAttachments: false }, rules)
      expect(orderActions(matched).map((m) => m.action.type)).toEqual(['webhook', 'spam'])
    })

    it.each<RuleAction>([{ type: 'forward', to: 'b@t.test' }, { type: 'notify', urgent: false }])('$type de spam kuralını istemcide tutar', (action) => {
      expect(gen({ rules: [rule(1, { subjectContains: 'k' }, [{ type: 'spam' }]), rule(2, {}, [action])] }).plans[0].reason).toBe('spam_split')
    })

    it('devre dışı kural ya da istemci eylemsiz kural etkilemez', () => {
      const rules = [rule(1, { subjectContains: 'k' }, [{ type: 'spam' }]), rule(2, {}, [webhook], { enabled: 0 }), rule(3, {}, [{ type: 'flag' }])]
      expect(gen({ rules }).plans[0].placement).toBe('server')
    })

    it('spam dışı taşıma etkilenmez', () => {
      const { plans } = gen({ rules: [rule(1, { subjectContains: 'k' }, [moveTo('Raporlar')]), rule(2, {}, [webhook])] })
      expect(plans[0].placement).toBe('server')
    })
  })

  describe('bozuk kural', () => {
    const bad: [string, RuleRow][] = [
      ['sayısal koşul', rule(1, { senderContains: 5 } as unknown as RuleCondition, [{ type: 'flag' }])],
      ['boş eylem', rule(1, {}, [null] as unknown as RuleAction[])],
      ['adsız taşıma', rule(1, {}, [{ type: 'move' }] as unknown as RuleAction[])],
      ['bilinmeyen eylem', rule(1, {}, [{ type: 'sil' }] as unknown as RuleAction[])],
      ['nesne olmayan koşul', { ...rule(1, {}, []), conditions_json: '3' }],
      ['geçersiz JSON', { ...rule(1, {}, []), actions_json: '{' }]
    ]

    it.each(bad)('%s istemcide kalır, hesap düşmez', (_, broken) => {
      const out = gen({ rules: [broken, rule(2, { senderContains: 'a' }, [{ type: 'flag' }])] })
      expect(out.plans[0]).toMatchObject({ ruleId: 1, placement: 'client' })
      expect(out.plans[1]).toMatchObject({ ruleId: 2, placement: 'server' })
      expect(out.text).toContain('addflag')
    })

    it('bozuk taşıma sırayı korur', () => {
      const out = gen({ rules: [bad[2][1], rule(2, { senderContains: 'a' }, [moveTo('Raporlar')])] })
      expect(out.plans[1]).toMatchObject({ placement: 'client', reason: 'order' })
    })
  })

  it('tatilde tırnak ve ters bölü kaçırılır', () => {
    const { text } = gen({ vacation: { ...VAC, subject: 'a"b\\c', body: 'x"y\\z' } })
    expect(text).toContain(':subject "a\\"b\\\\c"')
    expect(text).toContain('"x\\"y\\\\z";')
    expect(code(text).match(/\bvacation\b/g)).toHaveLength(1)
    expect(code(text)).toMatch(/^vacation :days 3 :subject "" :addresses \[""\] "";/m)
  })

  describe('64 KiB sınırı', () => {
    const spammers = (n: number) => Array.from({ length: n }, (_, i) => rule(i + 1, { subjectContains: 'y'.repeat(100) + i }, [{ type: 'spam' }]))
    const size = (t: string | null) => Buffer.byteLength(t ?? '', 'utf8')

    it('spam dışlamaları sığmazsa tatil üretilmez, nedeni döner', () => {
      const out = gen({ rules: spammers(1000), vacation: VAC })
      expect(out.vacationDropped).toBe(true)
      expect(size(out.text)).toBeLessThanOrEqual(64 * 1024)
      expect(out.text).not.toContain('vacation')
      expect(parseManagedHeader(out.text!)?.valid).toBe(true)
    })

    it('istemcide kalan spam kuralları da dışlamada: yalnız tatilken de sınır aşılmaz', () => {
      const out = gen({ rules: [rule(0, {}, [{ type: 'webhook', webhookId: 1 }]), ...spammers(1000)], vacation: VAC })
      expect(out.vacationDropped).toBe(true)
      expect(out.text).toBeNull()
    })

    it('sığan tatil kalır, bayrak düşmez', () => {
      expect(gen({ rules: spammers(3), vacation: VAC })).toMatchObject({ vacationDropped: false })
      expect(gen({ vacation: VAC }).text).toContain('vacation')
    })
  })

  describe('taşıma sırası: ilk taşıyan kazanır', () => {
    const clientMove = rule(1, { hasAttachment: true }, [moveTo('Raporlar')])

    it('yalnız istemci taşımasından sonraki taşıma istemcide kalır', () => {
      const { plans, text } = gen({ rules: [clientMove, rule(2, { senderContains: 'a' }, [moveTo('INBOX.Fatura')])] })
      expect(plans[0]).toMatchObject({ placement: 'client', reason: 'attachment' })
      expect(plans[1]).toMatchObject({ placement: 'client', reason: 'order', server: [], client: [moveTo('INBOX.Fatura')] })
      expect(text).toBeNull()
    })

    it('kuralın bayrakları da istemcide kalır, zincir sürer', () => {
      const { plans } = gen({
        rules: [
          clientMove,
          rule(2, { senderContains: 'a' }, [{ type: 'markRead' }, { type: 'archive' }]),
          rule(3, { senderContains: 'b' }, [{ type: 'spam' }])
        ]
      })
      expect(plans[1]).toMatchObject({ placement: 'client', reason: 'order', client: [{ type: 'markRead' }, { type: 'archive' }] })
      expect(plans[2]).toMatchObject({ placement: 'client', reason: 'order' })
    })

    it('kullanıcının istemcide tuttuğu taşıma da sayılır', () => {
      const { plans } = gen({ rules: [rule(1, { senderContains: 'a' }, [moveTo('Raporlar')], { run_on_server: 0 }), rule(2, { senderContains: 'b' }, [moveTo('Raporlar')])] })
      expect(plans.map((p) => p.reason)).toEqual(['user_choice', 'order'])
    })

    it('taşımasız kural etkilenmez, önceki taşıma etkilenmez', () => {
      const { plans } = gen({
        rules: [
          rule(1, { senderContains: 'a' }, [moveTo('Raporlar')]),
          rule(2, { hasAttachment: true }, [moveTo('INBOX.Fatura')]),
          rule(3, { senderContains: 'b' }, [{ type: 'flag' }])
        ]
      })
      expect(plans.map((p) => p.placement)).toEqual(['server', 'client', 'server'])
    })

    it('istemcide kalan taşımasız kural ve devre dışı taşıma sırayı bozmaz', () => {
      const { plans } = gen({
        rules: [
          rule(1, { hasAttachment: true }, [{ type: 'markRead' }]),
          rule(2, { hasAttachment: true }, [moveTo('Raporlar')], { enabled: 0 }),
          rule(3, { senderContains: 'a' }, [{ type: 'webhook', webhookId: 1 }]),
          rule(4, { senderContains: 'b' }, [moveTo('Raporlar')])
        ]
      })
      expect(plans.at(-1)).toMatchObject({ ruleId: 4, placement: 'server', reason: null })
    })

    it('bölünmüş taşıma sırayı bozmaz: taşıması sunucuda', () => {
      const { plans } = gen({ rules: [rule(1, { senderContains: 'a' }, [moveTo('Raporlar'), { type: 'webhook', webhookId: 1 }]), rule(2, { senderContains: 'b' }, [moveTo('INBOX.Fatura')])] })
      expect(plans.map((p) => p.placement)).toEqual(['split', 'server'])
    })

    it('izleme sınırına takılan taşımadan sonrakiler de istemcide', () => {
      const { plans } = gen({ maxWatched: 1, rules: [rule(1, { senderContains: 'a' }, [moveTo('Raporlar')]), rule(2, { senderContains: 'b' }, [moveTo('INBOX.Fatura')]), rule(3, { senderContains: 'c' }, [moveTo('Raporlar')])] })
      expect(plans.map((p) => p.reason)).toEqual([null, 'watch_cap', 'order'])
    })
  })

  it('size_cap', () => {
    const rules = Array.from({ length: 60 }, (_, i) => rule(i + 1, { subjectContains: 'x'.repeat(1400) + i }, [{ type: 'flag' }]))
    const { text, plans } = gen({ rules })
    expect(Buffer.byteLength(text!)).toBeLessThanOrEqual(64 * 1024)
    expect(parseManagedHeader(text!)?.valid).toBe(true)
    const capped = plans.filter((p) => p.reason === 'size_cap')
    expect(capped.length).toBeGreaterThan(0)
    expect(capped.every((p) => p.placement === 'client' && p.server.length === 0)).toBe(true)
    // aşanlar sondakiler
    const firstCapped = plans.findIndex((p) => p.reason === 'size_cap')
    expect(plans.slice(firstCapped).every((p) => p.reason === 'size_cap')).toBe(true)
  })

  it('150 kural sınırı', () => {
    const { plans } = gen({ rules: Array.from({ length: 152 }, (_, i) => rule(i + 1, { senderContains: `s${i}` }, [{ type: 'flag' }])) })
    expect(plans.filter((p) => p.placement === 'server')).toHaveLength(150)
    expect(plans.slice(150).map((p) => p.reason)).toEqual(['size_cap', 'size_cap'])
  })

  it('3900 baytı aşan değer size_cap', () => {
    const { plans } = gen({ rules: [rule(1, { subjectContains: 'x'.repeat(3901) }, [{ type: 'flag' }])] })
    expect(plans[0]).toMatchObject({ placement: 'client', reason: 'size_cap' })
  })

  it('null when nothing to deploy', () => {
    const out = gen({ rules: [] })
    expect(out.text).toBeNull()
    expect(out.hash).toBeNull()
    expect(out.requires).toEqual([])
    expect(gen({ vacation: { ...VAC, enabled: false } }).text).toBeNull()
  })

  it('kapalı ve bozuk kural çıktıyı bozmaz', () => {
    const { text, plans } = gen({ rules: [rule(1, {}, [{ type: 'flag' }], { enabled: 0 }), rule(2, {}, [{ type: 'flag' }], { conditions_json: '{bozuk' })] })
    expect(text).toBeNull()
    expect(plans.find((p) => p.ruleId === 2)).toMatchObject({ placement: 'client', server: [] })
  })

  it('vacation block', () => {
    const plain = gen({ vacation: VAC })
    expect(plain.requires).toEqual(['vacation'])
    expect(plain.text).toContain('vacation :days 3 :subject "İzindeyim" :addresses ["a@t.test"] "Pazartesi\r\ndönerim";')
    expect(plain.text).not.toContain('currentdate')

    const ranged = gen({ vacation: { ...VAC, startDate: '2026-11-04', endDate: '2026-11-10' } })
    expect(ranged.requires).toEqual(['date', 'relational', 'vacation'])
    expect(ranged.text).toContain('currentdate :value "ge" "date" "2026-11-04"')
    expect(ranged.text).toContain('currentdate :value "le" "date" "2026-11-10"')

    expect(gen({ extensions: ['fileinto'], vacation: VAC }).text).toBeNull()
    // aralık istenmiş ama sunucu desteklemiyorsa aralık dışında yanıt gitmemeli
    expect(gen({ extensions: ['vacation'], vacation: { ...VAC, startDate: '2026-11-04' } }).text).toBeNull()
  })

  it('vacation geçersiz değerde üretilmez', () => {
    expect(gen({ vacation: { ...VAC, subject: 'a\r\nb' } }).text).toBeNull()
    expect(gen({ vacation: { ...VAC, days: 99 } }).text).toBeNull()
  })

  it('vacation skips spam', () => {
    const { text } = gen({ vacation: VAC, rules: [rule(1, { senderContains: 'kötü' }, [{ type: 'spam' }]), rule(2, { domainEquals: 'x.test' }, [{ type: 'spam' }])] })
    expect(text).toContain('if not anyof(address :comparator "i;unicode-casemap" :contains "from" "kötü", address :domain :is "from" "x.test") {')
    expect(text!.indexOf('fileinto')).toBeLessThan(text!.indexOf('vacation :days'))
  })

  it('istemcide kalan spam kuralına da tatil yanıtı gitmez', () => {
    const { text } = gen({ vacation: VAC, rules: [rule(1, { senderContains: 'k' }, [{ type: 'spam' }, { type: 'webhook', webhookId: 1 }])] })
    expect(text).toContain('if not anyof(address :contains "from" "k") {')
    expect(text).not.toContain('fileinto')
  })

  it('header self check', () => {
    const { text, hash } = gen({ rules: [rule(1, { senderContains: 'a' }, [moveTo('Raporlar')])] })
    expect(text!.split('\r\n')[0]).toBe(`# geckomail v1 sha256:${hash}`)
    expect(parseManagedHeader(text!)).toEqual({ kind: 'rules', valid: true })
    expect(parseManagedHeader(text!.replace('"Raporlar"', '"Raporlaz"'))).toEqual({ kind: 'rules', valid: false })
    expect(parseManagedHeader(text! + ' ')?.valid).toBe(false)
    expect(parseManagedHeader('require "fileinto";\r\n')).toBeNull()
    expect(parseManagedHeader('# başka yorum\r\n')).toBeNull()
    expect(parseManagedHeader('')).toBeNull()
  })

  it('sunucu satır sonunu değiştirse de başlık tutar', () => {
    const { text } = gen({ rules: [rule(1, { senderContains: 'a' }, [moveTo('Raporlar')])] })
    expect(parseManagedHeader(text!.replace(/\r\n/g, '\n'))).toEqual({ kind: 'rules', valid: true })
  })
})

describe('sieveQuote', () => {
  it('ters bölü ve tırnağı kaçırır', () => {
    expect(sieveQuote('a"b\\c')).toBe('"a\\"b\\\\c"')
    expect(sieveQuote('Şeker')).toBe('"Şeker"')
    expect(sieveQuote('')).toBe('""')
  })
  it('denetim karakterinde null', () => {
    for (const s of ['a\nb', 'a\rb', 'a\u0000', 'a\tb', '\u007f']) expect(sieveQuote(s)).toBeNull()
  })
})

describe('generateWrapper', () => {
  it('wrapper', () => {
    const text = generateWrapper('rou"nd')
    const lines = text.split('\r\n')
    const rules = lines.findIndex((l) => l.includes('"geckomail-rules"'))
    const user = lines.findIndex((l) => l.includes('rou'))
    expect(rules).toBeGreaterThan(0)
    expect(user).toBeGreaterThan(rules)
    expect(lines[rules]).not.toContain(':optional')
    expect(lines[user]).not.toContain(':optional')
    expect(lines[user]).toContain('"rou\\"nd"')
    expect(text).toContain('require ["include"];')
    expect(parseManagedHeader(text)).toEqual({ kind: 'wrapper', valid: true })
    expect(parseManagedHeader(text.replace('rou', 'rau'))).toEqual({ kind: 'wrapper', valid: false })
  })
  it('denetim karakterli ad reddedilir', () => {
    expect(() => generateWrapper('a\r\nb')).toThrow()
  })
})

describe('generateEmptyRules', () => {
  it('yalnız geçerli başlık, gövdede komut yok', () => {
    const { text, hash } = generateEmptyRules()
    expect(parseManagedHeader(text)).toEqual({ kind: 'rules', valid: true })
    expect(text).toBe(`# geckomail v1 sha256:${hash}\r\n`)
    expect(generateEmptyRules()).toEqual({ text, hash })
  })

  it('özeti hiçbir üretilmiş betikle karışmaz', () => {
    expect(generateEmptyRules().hash).not.toBe(gen({ rules: [rule(1, {}, [{ type: 'flag' }])] }).hash)
  })
})

describe('parseWrapperTarget', () => {
  it('sarmalanan adı geri verir, kaçışlar çözülür', () => {
    expect(parseWrapperTarget(generateWrapper('kullanıcı'))).toBe('kullanıcı')
    expect(parseWrapperTarget(generateWrapper('a"b\\c'))).toBe('a"b\\c')
  })

  it('sarmalayıcı olmayan metin null', () => {
    expect(parseWrapperTarget('keep;')).toBeNull()
    expect(parseWrapperTarget(generateEmptyRules().text)).toBeNull()
  })
})
