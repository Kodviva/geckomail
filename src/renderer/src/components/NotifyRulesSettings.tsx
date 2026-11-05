// Ayarlar › Bildirimler: kişiye ait bildirim kuralları (§10.1). Liste yukarı/aşağı düğmeleriyle sıralanır (dokunmatikte
// de çalışır); düzenleyici alan + değer satırları, "VE" satırları ve "VEYA" grupları. Form durumu notifyRuleForm.ts'de.
import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import { t } from '../../../shared/i18n'
import { MAX_CLAUSES, MAX_GROUPS, MAX_RULES, type NotifyField, type NotifyLevel, type NotifyRule } from '../../../shared/notifyRules'
import {
  FIELD_ORDER, addClause, addGroup, emptyForm, formFromRule, moveId, removeClause, removeGroup, ruleFromForm,
  setClauseField, setClauseNot, setClauseValue, type RuleForm
} from '../notifyRuleForm'

const LEVELS: NotifyLevel[] = ['normal', 'urgent', 'silent']

function RuleEditor({ initial, onDone }: { initial: RuleForm; onDone: (saved: boolean) => void }) {
  const accounts = useStore((s) => s.accounts)
  const [form, setForm] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    const r = ruleFromForm(form)
    if (!r.ok) {
      setError(t(r.error === 'name' || r.error === 'groups' || r.error === 'value' ? `set.nr.err.${r.error}` : 'set.nr.err.rule'))
      return
    }
    setError(null)
    setBusy(true)
    try {
      await rpc.call('saveNotifyRule', { rule: r.rule })
      onDone(true)
    } catch {
      setError(t('set.nr.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="set-field set-field-col nr-editor" data-testid="notify-rule-editor">
      <label>
        {t('set.nr.name')}
        <input value={form.name} maxLength={100} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={busy} />
      </label>
      {form.groups.map((g, gi) => (
        <div className="nr-group" key={gi}>
          {gi > 0 && <div className="nr-or">{t('set.nr.or')}</div>}
          {g.map((c, ci) => (
            <div className="nr-clause" key={ci}>
              {ci > 0 && <span className="nr-and">{t('set.nr.and')}</span>}
              <select aria-label={t('set.nr.field')} value={c.field} onChange={(e) => setForm(setClauseField(form, gi, ci, e.target.value as NotifyField))} disabled={busy}>
                {FIELD_ORDER.map((f) => (<option key={f} value={f}>{t(`set.nr.field.${f}`)}</option>))}
              </select>
              <label className="nr-not">
                <input type="checkbox" checked={c.not} onChange={(e) => setForm(setClauseNot(form, gi, ci, e.target.checked))} disabled={busy} />
                {t('set.nr.not')}
              </label>
              {c.field === 'hasAttachment' ? (
                <select aria-label={t('set.nr.value')} value={c.value} onChange={(e) => setForm(setClauseValue(form, gi, ci, e.target.value))} disabled={busy}>
                  <option value="true">{t('set.nr.attachYes')}</option>
                  <option value="false">{t('set.nr.attachNo')}</option>
                </select>
              ) : c.field === 'account' ? (
                <select aria-label={t('set.nr.value')} value={c.value} onChange={(e) => setForm(setClauseValue(form, gi, ci, e.target.value))} disabled={busy}>
                  <option value="">{t('set.nr.pickAccount')}</option>
                  {c.value !== '' && !accounts.some((a) => String(a.id) === c.value) && (
                    <option value={c.value}>{t('set.nr.accountGone', { id: c.value })}</option>
                  )}
                  {accounts.map((a) => (<option key={a.id} value={String(a.id)}>{a.email}</option>))}
                </select>
              ) : (
                <input aria-label={t('set.nr.value')} value={c.value} maxLength={200} onChange={(e) => setForm(setClauseValue(form, gi, ci, e.target.value))} disabled={busy} />
              )}
              <button type="button" aria-label={t('set.nr.removeClause')} onClick={() => setForm(removeClause(form, gi, ci))} disabled={busy || g.length < 2}>✕</button>
            </div>
          ))}
          <div className="nr-row-actions">
            <button type="button" onClick={() => setForm(addClause(form, gi))} disabled={busy || g.length >= MAX_CLAUSES}>{t('set.nr.addClause')}</button>
            {form.groups.length > 1 && <button type="button" onClick={() => setForm(removeGroup(form, gi))} disabled={busy}>{t('set.nr.removeGroup')}</button>}
          </div>
        </div>
      ))}
      <div className="nr-row-actions">
        <button type="button" onClick={() => setForm(addGroup(form))} disabled={busy || form.groups.length >= MAX_GROUPS}>{t('set.nr.addGroup')}</button>
      </div>
      <label>
        {t('set.nr.level')}
        <select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value as NotifyLevel })} disabled={busy}>
          {LEVELS.map((l) => (<option key={l} value={l}>{t(`set.nr.level.${l}`)}</option>))}
        </select>
      </label>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <div className="settings-actions">
        <button type="button" onClick={() => onDone(false)} disabled={busy}>{t('action.cancel')}</button>
        <button type="button" className="primary" onClick={() => void save()} disabled={busy}>{t('action.save')}</button>
      </div>
    </div>
  )
}

const load = (): Promise<NotifyRule[]> => rpc.call('listNotifyRules', {}).then((l) => [...l].sort((a, b) => a.position - b.position))

export default function NotifyRulesSettings() {
  const toast = useStore((s) => s.toast)
  const [rules, setRules] = useState<NotifyRule[] | null>(null)
  const [editing, setEditing] = useState<RuleForm | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  // ilk yükleme başarısızsa satır içi hata + yeniden dene; sonraki yenilemelerde liste yerinde kalır, bildirim çıkar
  const refresh = useCallback((): Promise<void> => load().then((l) => { setLoadFailed(false); setRules(l) }, () => { if (rules) toast(t('set.nr.loadFailed')); else setLoadFailed(true) }), [toast, rules])

  useEffect(() => { void load().then((l) => { setLoadFailed(false); setRules(l) }, () => setLoadFailed(true)) }, [])

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch {
      toast(t('set.nr.saveFailed'))
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  const move = (index: number, dir: -1 | 1): Promise<void> =>
    act(() => rpc.call('reorderNotifyRules', { ids: moveId((rules ?? []).map((r) => r.id), index, dir) }))
  const toggle = (r: NotifyRule, on: boolean): Promise<void> =>
    act(() => rpc.call('saveNotifyRule', { rule: { ...r, enabled: on } }))
  const remove = (r: NotifyRule): Promise<void> | undefined => {
    if (!window.confirm(t('set.nr.deleteConfirm', { name: r.name }))) return
    return act(() => rpc.call('deleteNotifyRule', { id: r.id }))
  }

  if (!rules) {
    if (!loadFailed) return null
    return (
      <div className="set-group" data-testid="notify-rules">
        <div className="set-field">
          <div className="sf-l"><div className="sf-t">{t('set.nr.title')}</div></div>
          <div className="sf-c">
            <span className="auth-error" role="alert">{t('set.nr.loadFailed')}</span>
            <button type="button" onClick={() => void refresh()}>{t('action.retry')}</button>
          </div>
        </div>
      </div>
    )
  }
  const full = rules.length >= MAX_RULES
  return (
    <div className="set-group" data-testid="notify-rules">
      <div className="set-field">
        <div className="sf-l"><div className="sf-t">{t('set.nr.title')}</div><div className="sf-h">{full ? `${t('set.nr.hint')} ${t('set.nr.limit', { max: MAX_RULES })}` : rules.length ? t('set.nr.hint') : `${t('set.nr.hint')} ${t('set.nr.none')}`}</div></div>
        {!editing && <div className="sf-c"><button type="button" onClick={() => setEditing(emptyForm())} disabled={busy || full}>{t('set.nr.add')}</button></div>}
      </div>
      {editing && (
        <RuleEditor
          // aynı kural yeniden açılırsa form sıfırlansın
          key={editing.id ?? 'yeni'}
          initial={editing}
          onDone={(saved) => { setEditing(null); if (saved) void refresh() }}
        />
      )}
      {rules.map((r, i) => (
        <div className="set-field nr-item" key={r.id} data-testid="notify-rule">
          <div className="sf-l">
            <div className="sf-t">{r.name}</div>
            <div className="sf-h">{t(`set.nr.level.${r.level}`)}</div>
          </div>
          <div className="sf-c">
            <input type="checkbox" aria-label={`${t('set.nr.enabled')}: ${r.name}`} checked={r.enabled} onChange={(e) => void toggle(r, e.target.checked)} disabled={busy} />
            <button type="button" aria-label={`${t('set.nr.up')}: ${r.name}`} onClick={() => void move(i, -1)} disabled={busy || i === 0}>↑</button>
            <button type="button" aria-label={`${t('set.nr.down')}: ${r.name}`} onClick={() => void move(i, 1)} disabled={busy || i === rules.length - 1}>↓</button>
            <button type="button" aria-label={`${t('action.edit')}: ${r.name}`} onClick={() => setEditing(formFromRule(r))} disabled={busy}>{t('action.edit')}</button>
            <button type="button" aria-label={`${t('action.delete')}: ${r.name}`} onClick={() => void remove(r)} disabled={busy}>{t('action.delete')}</button>
          </div>
        </div>
      ))}
    </div>
  )
}
