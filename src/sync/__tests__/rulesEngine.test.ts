import { describe, expect, it } from 'vitest'
import { evaluateRules, orderActions } from '../rulesEngine'
import type { RuleRow } from '../db/queries'

function rule(id: number, conditions: object, actions: object[]): RuleRow {
  return {
    id, name: `kural-${id}`, enabled: 1, account_id: null, group_id: null,
    conditions_json: JSON.stringify(conditions), actions_json: JSON.stringify(actions),
    created_at: 0, last_triggered_at: null, trigger_count: 0, run_on_server: 1
  }
}

describe('evaluateRules', () => {
  it('senderContains eşleşirse aksiyonu döndürür', () => {
    const rules = [rule(1, { senderContains: 'dmarc' }, [{ type: 'archive' }])]
    const out = evaluateRules({ fromAddr: 'noreply-dmarc-support@google.com', subject: 'x', hasAttachments: false }, rules)
    expect(out).toHaveLength(1)
    expect(out[0].action).toEqual({ type: 'archive' })
  })

  it('birden fazla koşul AND ile birleşir', () => {
    const rules = [rule(1, { senderContains: 'musteri', subjectContains: 'SLA' }, [{ type: 'markRead' }])]
    expect(evaluateRules({ fromAddr: 'a@musteri.example.test', subject: 'SLA gecikmesi', hasAttachments: false }, rules)).toHaveLength(1)
    expect(evaluateRules({ fromAddr: 'a@musteri.example.test', subject: 'başka konu', hasAttachments: false }, rules)).toHaveLength(0)
  })

  it('domainEquals @ önekini tolere eder', () => {
    const rules = [rule(1, { domainEquals: '@softvia.co' }, [{ type: 'spam' }])]
    expect(evaluateRules({ fromAddr: 'x@softvia.co', subject: '', hasAttachments: false }, rules)).toHaveLength(1)
    expect(evaluateRules({ fromAddr: 'x@other.com', subject: '', hasAttachments: false }, rules)).toHaveLength(0)
  })

  it('devre dışı kural asla eşleşmez', () => {
    const r = rule(1, {}, [{ type: 'archive' }])
    r.enabled = 0
    expect(evaluateRules({ fromAddr: 'a@b.com', subject: 's', hasAttachments: false }, [r])).toHaveLength(0)
  })

  it('bozuk JSON kuralı sessizce atlar, diğerlerini etkilemez', () => {
    const bad = rule(1, {}, [])
    bad.conditions_json = '{not json'
    const good = rule(2, {}, [{ type: 'archive' }])
    expect(evaluateRules({ fromAddr: 'a@b.com', subject: '', hasAttachments: false }, [bad, good])).toHaveLength(1)
  })

  it('hasAttachment true/false doğru ayrımı yapar', () => {
    const rules = [rule(1, { hasAttachment: true }, [{ type: 'archive' }])]
    expect(evaluateRules({ fromAddr: 'a@b.com', subject: '', hasAttachments: true }, rules)).toHaveLength(1)
    expect(evaluateRules({ fromAddr: 'a@b.com', subject: '', hasAttachments: false }, rules)).toHaveLength(0)
  })
})

describe('orderActions', () => {
  it('taşıyıcı aksiyonları (move/archive/spam) her zaman sona alır', () => {
    const matched = [
      { ruleId: 1, ruleName: 'a', action: { type: 'archive' as const } },
      { ruleId: 1, ruleName: 'a', action: { type: 'markRead' as const } }
    ]
    const ordered = orderActions(matched)
    expect(ordered[0].action.type).toBe('markRead')
    expect(ordered[1].action.type).toBe('archive')
  })

  it('taşıyıcı aksiyon yoksa sırayı korur', () => {
    const matched = [
      { ruleId: 1, ruleName: 'a', action: { type: 'markRead' as const } },
      { ruleId: 1, ruleName: 'a', action: { type: 'markUnread' as const } }
    ]
    expect(orderActions(matched).map((m) => m.action.type)).toEqual(['markRead', 'markUnread'])
  })
})
