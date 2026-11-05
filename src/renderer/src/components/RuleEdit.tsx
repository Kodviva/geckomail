import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import type { MessageRow, RuleAction } from '../../../shared/rpc'
import Modal from './Modal'
import { t, fmtNumber } from '../../../shared/i18n'

type ActionDraft =
  | { type: 'move'; folderName: string }
  | { type: 'archive' }
  | { type: 'spam' }
  | { type: 'markRead' }
  | { type: 'markUnread' }
  | { type: 'flag' }
  | { type: 'forward'; to: string }
  | { type: 'webhook'; webhookId: number | null }
  | { type: 'notify'; urgent?: boolean }

// t() render anında çağrılsın diye fonksiyon (modül seviyesinde dil henüz belli değil / değişebilir)
function actionLabels(): { value: RuleAction['type']; label: string }[] {
  return [
    { value: 'move', label: t('auto.action.move') },
    { value: 'archive', label: t('auto.action.archive') },
    { value: 'spam', label: t('auto.action.spam') },
    { value: 'markRead', label: t('auto.action.markRead') },
    { value: 'markUnread', label: t('auto.action.markUnread') },
    { value: 'flag', label: t('auto.action.flag') },
    { value: 'forward', label: t('auto.action.forward') },
    { value: 'webhook', label: t('auto.action.webhook') },
    { value: 'notify', label: t('auto.action.notify') }
  ]
}

function defaultForType(type: RuleAction['type']): ActionDraft {
  switch (type) {
    case 'move':
      return { type: 'move', folderName: '' }
    case 'forward':
      return { type: 'forward', to: '' }
    case 'webhook':
      return { type: 'webhook', webhookId: null }
    default:
      return { type } as ActionDraft
  }
}

interface RuleTemplate {
  key: string
  label: string
  hint: string
  name: string
  senderOn?: boolean
  domainOn?: boolean
  subjectOn?: boolean
  attachment?: 'any' | 'yes' | 'no'
  actions: ActionDraft[]
}

function ruleTemplates(): RuleTemplate[] {
  return [
    {
      key: 'mute-sender',
      label: t('auto.tpl.muteSender.label'),
      hint: t('auto.tpl.muteSender.hint'),
      name: t('auto.tpl.muteSender.name'),
      senderOn: true,
      actions: [{ type: 'markRead' }, { type: 'archive' }]
    },
    {
      key: 'archive-domain',
      label: t('auto.tpl.archiveDomain.label'),
      hint: t('auto.tpl.archiveDomain.hint'),
      name: t('auto.tpl.archiveDomain.name'),
      domainOn: true,
      actions: [{ type: 'archive' }]
    },
    {
      key: 'flag-important',
      label: t('auto.tpl.flagImportant.label'),
      hint: t('auto.tpl.flagImportant.hint'),
      name: t('auto.tpl.flagImportant.name'),
      senderOn: true,
      actions: [{ type: 'flag' }]
    },
    {
      key: 'attachment-move',
      label: t('auto.tpl.attachmentMove.label'),
      hint: t('auto.tpl.attachmentMove.hint'),
      name: t('auto.tpl.attachmentMove.name'),
      attachment: 'yes',
      actions: [{ type: 'move', folderName: '' }]
    },
    {
      key: 'spam-subject',
      label: t('auto.tpl.spamSubject.label'),
      hint: t('auto.tpl.spamSubject.hint'),
      name: t('auto.tpl.spamSubject.name'),
      subjectOn: true,
      actions: [{ type: 'spam' }]
    }
  ]
}

// "Son N mailden <b>M</b> tanesi eşleşiyor" — sayı kalın kalsın diye çeviri işaretçiden bölünür
const MARK = '\u0000'
function TestSummary({ total, matched }: { total: number; matched: number }) {
  const [before, after = ''] = t('auto.rule.testResult', { count: matched, total, matched: MARK }).split(MARK)
  return (
    <>
      {before}
      <b>{fmtNumber(matched)}</b>
      {after}
    </>
  )
}

export default function RuleEdit() {
  const editRuleId = useStore((s) => s.editRuleId)
  const setEditRule = useStore((s) => s.setEditRule)
  const rules = useStore((s) => s.rules)
  const accounts = useStore((s) => s.accounts)
  const groups = useStore((s) => s.groups)
  const webhooks = useStore((s) => s.webhooks)
  const refreshRules = useStore((s) => s.refreshRules)
  const refreshWebhooks = useStore((s) => s.refreshWebhooks)
  const refreshGroups = useStore((s) => s.refreshGroups)
  const ruleDraft = useStore((s) => s.ruleDraft)
  const toast = useStore((s) => s.toast)

  const isNew = editRuleId === 'new'
  const existing = !isNew ? rules.find((r) => r.id === editRuleId) : undefined

  const [name, setName] = useState(existing?.name ?? '')
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [scopeType, setScopeType] = useState<'all' | 'account' | 'group'>(
    existing?.accountId ? 'account' : existing?.groupId ? 'group' : 'all'
  )
  const [scopeAccountId, setScopeAccountId] = useState<number | null>(existing?.accountId ?? null)
  const [scopeGroupId, setScopeGroupId] = useState<number | null>(existing?.groupId ?? null)

  const [senderOn, setSenderOn] = useState(!!existing?.conditions.senderContains || !!ruleDraft?.senderAddr)
  const [sender, setSender] = useState(existing?.conditions.senderContains ?? ruleDraft?.senderAddr ?? '')
  const [domainOn, setDomainOn] = useState(!!existing?.conditions.domainEquals)
  const [domain, setDomain] = useState(existing?.conditions.domainEquals ?? ruleDraft?.domain ?? '')
  const [subjectOn, setSubjectOn] = useState(!!existing?.conditions.subjectContains)
  const [subject, setSubject] = useState(existing?.conditions.subjectContains ?? ruleDraft?.subject ?? '')
  const [attachment, setAttachment] = useState<'any' | 'yes' | 'no'>(
    existing?.conditions.hasAttachment === undefined ? 'any' : existing.conditions.hasAttachment ? 'yes' : 'no'
  )

  const [actions, setActions] = useState<ActionDraft[]>((existing?.actions as ActionDraft[]) ?? [])
  const [runOnServer, setRunOnServer] = useState(existing?.runOnServer ?? true)
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<{ matchedCount: number; samples: MessageRow[] } | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    void refreshWebhooks()
    void refreshGroups()
  }, [refreshWebhooks, refreshGroups])

  if (!isNew && !existing) return null

  const buildConditions = () => ({
    ...(senderOn && sender.trim() ? { senderContains: sender.trim() } : {}),
    ...(domainOn && domain.trim() ? { domainEquals: domain.trim() } : {}),
    ...(subjectOn && subject.trim() ? { subjectContains: subject.trim() } : {}),
    ...(attachment !== 'any' ? { hasAttachment: attachment === 'yes' } : {})
  })

  const applyTemplate = (tpl: RuleTemplate) => {
    setName(tpl.name)
    setSenderOn(!!tpl.senderOn)
    setDomainOn(!!tpl.domainOn)
    setSubjectOn(!!tpl.subjectOn)
    setAttachment(tpl.attachment ?? 'any')
    setActions(tpl.actions)
  }

  const buildActions = (): RuleAction[] =>
    actions
      .filter((a) => a.type !== 'webhook' || a.webhookId != null)
      .map((a) => (a.type === 'webhook' ? { type: 'webhook', webhookId: a.webhookId! } : a)) as RuleAction[]

  const save = async () => {
    if (!name.trim()) {
      toast(t('auto.rule.nameRequired'), 'error')
      return
    }
    setBusy(true)
    try {
      const accountId = scopeType === 'account' ? scopeAccountId : null
      const groupId = scopeType === 'group' ? scopeGroupId : null
      if (isNew) {
        await rpc.call('createRule', { name: name.trim(), accountId, groupId, conditions: buildConditions(), actions: buildActions(), runOnServer })
      } else if (existing) {
        await rpc.call('updateRule', {
          id: existing.id,
          patch: { name: name.trim(), enabled, accountId, groupId, conditions: buildConditions(), actions: buildActions(), runOnServer }
        })
      }
      await refreshRules()
      toast(t(isNew ? 'auto.rule.created' : 'auto.rule.updated'), 'info')
      useStore.setState({ ruleDraft: null })
      setEditRule(null)
    } catch (e) {
      toast(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const runTest = async () => {
    setTesting(true)
    try {
      const res = await rpc.call('testRule', { conditions: buildConditions(), accountId: scopeType === 'account' ? scopeAccountId : null })
      setTestResult(res)
    } catch (e) {
      toast(String((e as Error).message))
    } finally {
      setTesting(false)
    }
  }

  return (
    <Modal onClose={() => setEditRule(null)} className="rule-edit" confirmOnDirty>
        <div className="modal-title">{isNew ? t('auto.rules.new') : name || t('auto.rule.title')}</div>
        {isNew && (
          <div className="rule-templates">
            {ruleTemplates().map((tpl) => (
              <button key={tpl.key} type="button" className="rule-template-chip" onClick={() => applyTemplate(tpl)} title={tpl.hint}>
                {tpl.label}
              </button>
            ))}
          </div>
        )}
        <div className="cc-row">
          <label>
            {t('auto.rule.name')}
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          {!isNew && (
            <label className="check-row" style={{ flex: '0 0 auto' }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span>{t('auto.common.enabled')}</span>
            </label>
          )}
        </div>
        <label>
          {t('auto.rule.scope')}
          <select value={scopeType} onChange={(e) => setScopeType(e.target.value as typeof scopeType)}>
            <option value="all">{t('auto.rule.scopeAll')}</option>
            <option value="account">{t('auto.rule.scopeAccount')}</option>
            <option value="group">{t('auto.rule.scopeGroup')}</option>
          </select>
        </label>
        {scopeType === 'account' && (
          <select value={scopeAccountId ?? ''} onChange={(e) => setScopeAccountId(Number(e.target.value) || null)}>
            <option value="">{t('auto.rule.pickAccount')}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </select>
        )}
        {scopeType === 'group' && (
          <select value={scopeGroupId ?? ''} onChange={(e) => setScopeGroupId(Number(e.target.value) || null)}>
            <option value="">{t('auto.rule.pickGroup')}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        )}

        <label>{t('auto.rule.conditions')}</label>
        <div className="cond-row">
          <input type="checkbox" checked={senderOn} onChange={(e) => setSenderOn(e.target.checked)} />
          <span>{t('auto.rule.senderContains')}</span>
          <input value={sender} onChange={(e) => setSender(e.target.value)} disabled={!senderOn} placeholder={t('auto.rule.senderPlaceholder')} />
        </div>
        <div className="cond-row">
          <input type="checkbox" checked={domainOn} onChange={(e) => setDomainOn(e.target.checked)} />
          <span>{t('auto.rule.domainEquals')}</span>
          <input value={domain} onChange={(e) => setDomain(e.target.value)} disabled={!domainOn} placeholder={t('auto.rule.domainPlaceholder')} />
        </div>
        <div className="cond-row">
          <input type="checkbox" checked={subjectOn} onChange={(e) => setSubjectOn(e.target.checked)} />
          <span>{t('auto.rule.subjectContains')}</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!subjectOn} placeholder={t('auto.rule.subjectPlaceholder')} />
        </div>
        <div className="cond-row">
          <span>{t('auto.rule.attachment')}</span>
          <select value={attachment} onChange={(e) => setAttachment(e.target.value as typeof attachment)}>
            <option value="any">{t('auto.rule.attachmentAny')}</option>
            <option value="yes">{t('auto.rule.attachmentYes')}</option>
            <option value="no">{t('auto.rule.attachmentNo')}</option>
          </select>
        </div>

        <label>{t('auto.rule.actions')}</label>
        {actions.map((a, i) => (
          <div key={i} className="action-row">
            <select
              value={a.type}
              onChange={(e) => {
                const next = [...actions]
                next[i] = defaultForType(e.target.value as RuleAction['type'])
                setActions(next)
              }}
            >
              {actionLabels().map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {a.type === 'move' && (
              <input
                placeholder={t('auto.rule.folderPlaceholder')}
                value={a.folderName}
                onChange={(e) => {
                  const next = [...actions]
                  next[i] = { type: 'move', folderName: e.target.value }
                  setActions(next)
                }}
              />
            )}
            {a.type === 'notify' && (
              <label className="check-label" title={t('auto.rule.urgentHint')}>
                <input
                  type="checkbox"
                  checked={!!a.urgent}
                  onChange={(e) => {
                    const next = [...actions]
                    next[i] = { type: 'notify', urgent: e.target.checked }
                    setActions(next)
                  }}
                />
                {t('auto.rule.urgent')}
              </label>
            )}
            {a.type === 'forward' && (
              <input
                placeholder={t('auto.rule.forwardPlaceholder')}
                value={a.to}
                onChange={(e) => {
                  const next = [...actions]
                  next[i] = { type: 'forward', to: e.target.value }
                  setActions(next)
                }}
              />
            )}
            {a.type === 'webhook' &&
              (webhooks.length ? (
                <select
                  value={a.webhookId ?? ''}
                  onChange={(e) => {
                    const next = [...actions]
                    next[i] = { type: 'webhook', webhookId: Number(e.target.value) || null }
                    setActions(next)
                  }}
                >
                  <option value="">{t('auto.rule.pickWebhook')}</option>
                  {webhooks.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="auth-hint">
                  {t('auto.common.needWebhook')}{' '}
                  <button
                    type="button"
                    className="link-btn inline"
                    onClick={() => {
                      setEditRule(null)
                      useStore.getState().setAutomationOpen(true)
                      useStore.getState().setAutomationTab('webhooks')
                    }}
                  >
                    {t('auto.common.goToWebhooks')}
                  </button>
                </span>
              ))}
            <span
              className="ctx-remove"
              role="button"
              aria-label={t('auto.rule.removeAction')}
              title={t('auto.rule.removeAction')}
              onClick={() => setActions(actions.filter((_, idx) => idx !== i))}
            >
              <svg className="icon sm"><use href="#i-x" /></svg>
            </span>
          </div>
        ))}
        <button type="button" onClick={() => setActions([...actions, { type: 'archive' }])}>
          {t('auto.rule.addAction')}
        </button>

        <label className="sieve-check">
          <input type="checkbox" checked={runOnServer} onChange={(e) => setRunOnServer(e.target.checked)} />
          {t('set.sieve.runOnServer')}
        </label>

        <div className="test-row">
          <button type="button" onClick={() => void runTest()} disabled={testing}>
            {testing ? t('auto.rule.testing') : t('auto.common.test')}
          </button>
          {testResult && (
            <span className="auth-hint">
              <TestSummary total={testResult.samples.length < 50 ? testResult.samples.length : 50} matched={testResult.matchedCount} />
              {testResult.samples.length > 0 && ': ' + testResult.samples.map((s) => s.subject || t('auto.common.noSubject')).join(', ')}
            </span>
          )}
        </div>

        <div className="modal-foot">
          <button onClick={() => setEditRule(null)}>{t('action.cancel')}</button>
          <button className="primary" onClick={() => void save()} disabled={busy}>
            {isNew ? t('auto.common.create') : t('action.save')}
          </button>
        </div>
    </Modal>
  )
}
