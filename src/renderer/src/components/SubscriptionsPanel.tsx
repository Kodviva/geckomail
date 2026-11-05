// Abonelikler (R29): List-Unsubscribe taşıyan göndericiler, mail sayısına göre. Tek-tık (RFC 8058)
// destekleyenlerden toplu çıkılır; desteklemeyenler (ya da çıkıldığı hâlde gelmeye devam edenler)
// arşivleyen kurala çevrilebilir. İstekler sync sürecinden gider, URL'ler bu ekrana hiç gelmez.
import { useEffect, useMemo, useState } from 'react'
import type { SubscriptionSender } from '../../../shared/rpc'
import { fmtDate, lower, t } from '../../../shared/i18n'
import { rpc } from '../rpcClient'
import { useStore } from '../store'
import Modal from './Modal'
import { adminUi } from '../adminUi'

const RANGES = [30, 90, 365]

function rangeLabel(days: number): string {
  return days === 365 ? t('compose.subs.rangeYear') : t('compose.subs.rangeDays', { count: days })
}

function dateStr(ts: number): string {
  return fmtDate(ts, { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function SubscriptionsPanel() {
  const setOpen = useStore((s) => s.setSubscriptionsOpen)
  const selectedAccountIds = useStore((s) => s.selectedAccountIds)
  const setSearch = useStore((s) => s.setSearch)
  const toast = useStore((s) => s.toast)
  const isAdmin = useStore((s) => adminUi(s.currentUser))
  const [days, setDays] = useState(90)
  const [rows, setRows] = useState<SubscriptionSender[] | null>(null)
  const [filter, setFilter] = useState('')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => {
    try {
      setRows(await rpc.call('listSubscriptions', { accountIds: selectedAccountIds, days }))
    } catch (e) {
      toast(t('compose.subs.loadFailed', { error: (e as Error).message }))
      setRows([])
    }
  }
  useEffect(() => {
    setRows(null)
    void load()
    // gün aralığı ya da hesap seçimi değişince yeniden
  // eslint-disable-next-line react-hooks/exhaustive-deps -- bilinçli: yalnız açılışta / belirtilen değişkenlerle
  }, [days, selectedAccountIds])

  const visible = useMemo(() => {
    const f = lower(filter.trim())
    return (rows ?? []).filter((r) => !f || r.addr.includes(f) || lower(r.name ?? '').includes(f))
  }, [rows, filter])

  const total = useMemo(() => (rows ?? []).reduce((n, r) => n + r.count, 0), [rows])
  const sel = visible.filter((r) => checked.has(r.addr))
  const selOneClick = sel.filter((r) => r.oneClick && !r.unsubscribedAt)

  const toggle = (addr: string): void =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(addr)) next.delete(addr)
      else next.add(addr)
      return next
    })
  const allChecked = visible.length > 0 && visible.every((r) => checked.has(r.addr))
  const toggleAll = (): void => setChecked(allChecked ? new Set() : new Set(visible.map((r) => r.addr)))

  const unsubscribe = async (): Promise<void> => {
    if (!selOneClick.length) return
    const skipped = sel.length - selOneClick.length
    const msg =
      t('compose.subs.confirmUnsub', { count: selOneClick.length }) +
      (skipped ? `\n\n${t('compose.subs.confirmUnsubSkipped', { count: skipped })}` : '')
    if (!window.confirm(msg)) return
    setBusy(true)
    try {
      const res = await rpc.call('unsubscribeSenders', { accountIds: selectedAccountIds, addrs: selOneClick.map((r) => r.addr) })
      const ok = res.filter((r) => r.ok).length
      const bad = res.length - ok
      toast(bad ? t('compose.subs.unsubPartial', { ok, bad }) : t('compose.subs.unsubDone', { count: ok }), bad ? 'error' : 'info')
      setChecked(new Set())
      await load()
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const makeRules = async (): Promise<void> => {
    if (!sel.length) return
    if (!window.confirm(t('compose.subs.confirmRules', { count: sel.length }))) return
    setBusy(true)
    let made = 0
    try {
      const rules = await rpc.call('getRules', {})
      const existing = new Set(rules.map((r) => r.name))
      // kural adı arayüz dilinde; başka dilde oluşturulmuş aynı kural da (gönderici + arşiv) tekrar yazılmaz
      const archived = new Set(
        rules.filter((r) => r.conditions.senderContains && r.actions.some((a) => a.type === 'archive')).map((r) => r.conditions.senderContains!.toLowerCase())
      )
      for (const r of sel) {
        const name = t('compose.subs.ruleName', { addr: r.addr })
        if (existing.has(name) || archived.has(r.addr.toLowerCase())) continue
        await rpc.call('createRule', { name, accountId: null, groupId: null, conditions: { senderContains: r.addr }, actions: [{ type: 'archive' }] })
        made++
      }
      toast(made ? t('compose.subs.rulesMade', { count: made }) : t('compose.subs.rulesExist'), 'info')
      setChecked(new Set())
    } catch (e) {
      toast(t('compose.subs.ruleFailed', { error: (e as Error).message }))
    } finally {
      setBusy(false)
    }
  }

  const showMails = (addr: string): void => {
    setOpen(false)
    setSearch(`from:${addr}`)
  }

  return (
    <Modal onClose={() => setOpen(false)} className="subs">
      <div className="modal-title">{t('compose.subs.title')}</div>
      <div className="subs-top">
        <div className="am-chips" role="group" aria-label={t('compose.subs.rangeAria')}>
          {RANGES.map((d) => (
            <button key={d} type="button" className={`chip ${days === d ? 'on' : ''}`} aria-pressed={days === d} onClick={() => setDays(d)}>
              {rangeLabel(d)}
            </button>
          ))}
        </div>
        <input className="subs-filter" placeholder={t('compose.subs.search')} aria-label={t('compose.subs.search')} value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {rows && (
        <div className="subs-summary">
          {t('compose.subs.senderCount', { count: rows.length })} · {t('compose.common.mailCount', { count: total })} ·{' '}
          {selectedAccountIds ? t('compose.subs.inSelected') : t('compose.subs.inAll')}
        </div>
      )}
      {!rows && <div className="empty-note">{t('state.loading')}</div>}
      {rows && !visible.length && <div className="empty-note">{t('compose.subs.empty')}</div>}
      {visible.length > 0 && (
        <div className="subs-list" role="list">
          <label className="subs-row subs-head">
            <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label={t('compose.subs.selectAll')} />
            <span className="subs-who">{t('compose.subs.colSender')}</span>
            <span className="subs-n">{t('compose.subs.colMail')}</span>
            <span className="subs-last">{t('compose.subs.colLast')}</span>
            <span className="subs-state">{t('compose.subs.colStatus')}</span>
          </label>
          {visible.map((r) => (
            <div key={r.addr} className={`subs-row ${checked.has(r.addr) ? 'checked' : ''}`} role="listitem">
              <input type="checkbox" checked={checked.has(r.addr)} onChange={() => toggle(r.addr)} aria-label={t('compose.subs.selectOne', { addr: r.addr })} />
              <button type="button" className="subs-who" onClick={() => showMails(r.addr)} title={t('compose.subs.showMailsTip')}>
                <span className="subs-name">{r.name || r.addr}</span>
                {r.name && <span className="subs-addr">{r.addr}</span>}
              </button>
              <span className="subs-n">
                {r.count}
                {r.unread > 0 && <small title={t('compose.subs.unreadTip')}> · {t('compose.subs.unread', { count: r.unread })}</small>}
                {r.accounts > 1 && <small title={t('compose.subs.accountsTip')}> · {t('compose.subs.accounts', { count: r.accounts })}</small>}
              </span>
              <span className="subs-last">{dateStr(r.lastDate)}</span>
              <span className="subs-state">
                {r.unsubscribedAt ? (
                  r.sinceUnsubscribed > 0 ? (
                    <span className="subs-tag warn" title={t('compose.subs.unsubscribedOnTip', { date: dateStr(r.unsubscribedAt) })}>
                      {t('compose.subs.unsubscribedMore', { count: r.sinceUnsubscribed })}
                    </span>
                  ) : (
                    <span className="subs-tag ok">{t('compose.subs.unsubscribedOn', { date: dateStr(r.unsubscribedAt) })}</span>
                  )
                ) : r.unsubscribeError ? (
                  <span className="subs-tag bad" title={r.unsubscribeError}>{t('compose.subs.failed')}</span>
                ) : r.oneClick ? (
                  <span className="subs-tag">{t('compose.subs.oneClick')}</span>
                ) : (
                  <span className="subs-tag dim" title={t('compose.subs.ruleOnlyTip')}>{t('compose.subs.ruleOnly')}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="modal-foot">
        <span className="hint">{sel.length ? t('compose.subs.selected', { count: sel.length }) : t('compose.subs.hint')}</span>
        {isAdmin && (
          <button type="button" disabled={busy || !sel.length} onClick={() => void makeRules()} title={t('compose.subs.archiveRuleTip')}>
            <svg className="icon sm"><use href="#i-archive" /></svg> {t('compose.subs.archiveRule')}
          </button>
        )}
        <button type="button" className="primary" disabled={busy || !selOneClick.length} onClick={() => void unsubscribe()}>
          {busy
            ? t('compose.subs.busy')
            : selOneClick.length
              ? t('compose.subs.unsubscribeCount', { count: selOneClick.length })
              : t('compose.subs.unsubscribe')}
        </button>
      </div>
    </Modal>
  )
}
