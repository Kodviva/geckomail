// Ayarlar › Hesaplar: tüm hesapları tek yerden bul, durumunu gör, düzelt — tek tek ya da toplu.
// Satırdaki birincil eylem duruma göre değişir (Şifreyi güncelle / Sunucu ayarları / Düzenle);
// hepsi aynı düzenleme formunu (AccountEdit) açar — form Ayarlar'ın üstünde açılır.
// Toplu işlemler (UX-P1-2): 68 hesap aynı sunucuda — bir port/adres değişikliği tek hamlede.
import { useEffect, useMemo, useState } from 'react'
import type { TlsMode } from '../../../shared/rpc'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import { attention, fmtRelative, needsAction, primaryActionLabel, statusLabel } from '../accountHealth'
import { t } from '../../../shared/i18n'
import { StatusDot } from './StatusDot'
import { adminUi } from '../adminUi'

type Filter = 'all' | 'action' | 'warn' | 'off'

interface BulkServer {
  imapHost: string
  imapPort: string
  imapTls: '' | TlsMode
  smtpHost: string
  smtpPort: string
  smtpTls: '' | TlsMode
}
const EMPTY_BULK: BulkServer = { imapHost: '', imapPort: '', imapTls: '', smtpHost: '', smtpPort: '', smtpTls: '' }

export default function AccountsManager() {
  const accounts = useStore((s) => s.accounts)
  const setEditAccount = useStore((s) => s.setEditAccount)
  const setImportOpen = useStore((s) => s.setImportOpen)
  const refreshAccounts = useStore((s) => s.refreshAccounts)
  const groups = useStore((s) => s.groups)
  const isAdmin = useStore((s) => adminUi(s.currentUser))
  const toast = useStore((s) => s.toast)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>(() => (accounts.some(needsAction) ? 'action' : 'all'))
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulk, setBulk] = useState<BulkServer>(EMPTY_BULK)
  const [busy, setBusy] = useState(false)
  const refreshGroups = useStore((s) => s.refreshGroups)
  useEffect(() => {
    if (isAdmin && !groups.length) void refreshGroups()
  }, [isAdmin, groups.length, refreshGroups])

  const counts = useMemo(
    () => ({
      all: accounts.length,
      action: accounts.filter(needsAction).length,
      warn: accounts.filter((a) => attention(a) === 'warn').length,
      off: accounts.filter((a) => !a.enabled).length
    }),
    [accounts]
  )

  const rows = useMemo(() => {
    const f = q.trim().toLowerCase()
    return accounts
      .filter((a) => !f || a.email.toLowerCase().includes(f) || (a.displayName ?? '').toLowerCase().includes(f) || (a.groupName ?? '').toLowerCase().includes(f))
      .filter((a) =>
        filter === 'action' ? needsAction(a) : filter === 'warn' ? attention(a) === 'warn' : filter === 'off' ? !a.enabled : true
      )
      .sort((a, b) => Number(needsAction(b)) - Number(needsAction(a)) || a.email.localeCompare(b.email))
  }, [accounts, q, filter])

  // görünmeyenler seçimde kalmasın (filtre değişince sürpriz toplu işlem olmasın)
  const visibleIds = new Set(rows.map((r) => r.id))
  const chosen = [...selected].filter((id) => visibleIds.has(id))
  const allChosen = rows.length > 0 && chosen.length === rows.length

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(true)
    try {
      toast(await fn(), 'info')
      await refreshAccounts()
    } catch (e) {
      toast(t('acct.manager.opError', { op: label, error: (e as Error).message }))
    } finally {
      setBusy(false)
    }
  }

  const setEnabled = (enabled: boolean) =>
    run(enabled ? t('acct.manager.opEnable') : t('acct.manager.opDisable'), async () => {
      for (const id of chosen) await rpc.call('setAccountEnabled', { accountId: id, enabled })
      return t(enabled ? 'acct.manager.enabled' : 'acct.manager.disabled', { count: chosen.length })
    })

  const moveToGroup = (groupId: number | null) =>
    run(t('acct.manager.opMoveGroup'), async () => {
      for (const id of chosen) await rpc.call('setAccountGroup', { accountId: id, groupId })
      return groupId
        ? t('acct.manager.movedToGroup', { count: chosen.length, group: groups.find((g) => g.id === groupId)?.name })
        : t('acct.manager.removedFromGroup', { count: chosen.length })
    })

  const retry = () =>
    run(t('acct.manager.opRetry'), async () => {
      const r = await rpc.call('retryAccounts', { accountIds: chosen })
      const msg = t('acct.manager.retrying', { count: r.retried })
      return r.skippedAuthFailed ? `${msg} · ${t('acct.manager.skippedAuth', { count: r.skippedAuthFailed })}` : msg
    })

  const applyBulkServer = () =>
    run(t('acct.manager.opServer'), async () => {
      const patch = {
        ...(bulk.imapHost.trim() ? { imapHost: bulk.imapHost.trim() } : {}),
        ...(bulk.imapPort.trim() ? { imapPort: Number(bulk.imapPort) } : {}),
        ...(bulk.imapTls ? { imapTls: bulk.imapTls } : {}),
        ...(bulk.smtpHost.trim() ? { smtpHost: bulk.smtpHost.trim() } : {}),
        ...(bulk.smtpPort.trim() ? { smtpPort: Number(bulk.smtpPort) } : {}),
        ...(bulk.smtpTls ? { smtpTls: bulk.smtpTls } : {})
      }
      if (!Object.keys(patch).length) throw new Error(t('acct.manager.noFieldsEntered'))
      if (!window.confirm(t('acct.manager.confirmBulkServer', { count: chosen.length }))) return t('acct.manager.cancelled')
      const r = await rpc.call('updateAccountsServer', { accountIds: chosen, patch })
      setBulkOpen(false)
      setBulk(EMPTY_BULK)
      const msg = t('acct.manager.updated', { count: r.updated })
      return r.failed.length ? `${msg} · ${t('acct.manager.failed', { count: r.failed.length, error: r.failed[0].error })}` : msg
    })

  const chip = (id: Filter, label: string) => (
    <button type="button" className={`chip ${filter === id ? 'on' : ''}`} onClick={() => setFilter(id)} aria-pressed={filter === id}>
      {label} <b>{counts[id]}</b>
    </button>
  )

  return (
    <div className="accounts-manager">
      <div className="am-toolbar">
        <input
          className="am-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('acct.manager.searchPlaceholder')}
          aria-label={t('acct.common.searchAccounts')}
          autoFocus
        />
        {isAdmin && (
          <button type="button" onClick={() => setImportOpen(true)}>
            <svg className="icon sm"><use href="#i-plus" /></svg> {t('acct.common.addAccount')}
          </button>
        )}
      </div>
      <div className="am-chips" role="group" aria-label={t('acct.manager.statusFilter')}>
        {chip('all', t('acct.manager.chipAll'))}
        {chip('action', t('acct.manager.chipAction'))}
        {chip('warn', t('acct.manager.chipWarn'))}
        {chip('off', t('acct.manager.chipOff'))}
      </div>

      {chosen.length > 0 && (
        <div className="am-bulk" role="toolbar" aria-label={t('acct.manager.bulkActions')}>
          <b>{t('acct.manager.selected', { count: chosen.length })}</b>
          <button type="button" onClick={() => void setEnabled(false)} disabled={busy}>{t('acct.common.disable')}</button>
          <button type="button" onClick={() => void setEnabled(true)} disabled={busy}>{t('acct.common.enable')}</button>
          <button type="button" onClick={() => void retry()} disabled={busy} title={t('acct.manager.retrySkipTip')}>{t('action.retry')}</button>
          {isAdmin && (
            <select
              value=""
              onChange={(e) => e.target.value && void moveToGroup(e.target.value === 'none' ? null : Number(e.target.value))}
              disabled={busy}
              aria-label={t('acct.manager.moveToGroup')}
            >
              <option value="">{t('acct.manager.moveToGroupOption')}</option>
              <option value="none">{t('acct.common.noGroupOption')}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
          {isAdmin && (
            <button type="button" onClick={() => setBulkOpen((v) => !v)} disabled={busy}>
              {t('acct.manager.changeServer')}
            </button>
          )}
          <button type="button" className="link-btn" onClick={() => setSelected(new Set())}>{t('acct.manager.clearSelection')}</button>
        </div>
      )}

      {bulkOpen && chosen.length > 0 && (
        <div className="server-section am-bulk-server">
          <span className="auth-hint">{t('acct.manager.bulkHint')}</span>
          <div className="cc-row">
            <label>{t('acct.server.imapHost')}<input value={bulk.imapHost} onChange={(e) => setBulk({ ...bulk, imapHost: e.target.value })} spellCheck={false} /></label>
            <label className="port-label">{t('acct.server.port')}<input type="number" value={bulk.imapPort} onChange={(e) => setBulk({ ...bulk, imapPort: e.target.value })} /></label>
            <label className="tls-label">
              {t('acct.server.security')}
              <select value={bulk.imapTls} onChange={(e) => setBulk({ ...bulk, imapTls: e.target.value as BulkServer['imapTls'] })}>
                <option value="">{t('acct.server.unchanged')}</option>
                <option value="tls">SSL/TLS</option>
                <option value="starttls">STARTTLS</option>
              </select>
            </label>
          </div>
          <div className="cc-row">
            <label>{t('acct.server.smtpHost')}<input value={bulk.smtpHost} onChange={(e) => setBulk({ ...bulk, smtpHost: e.target.value })} spellCheck={false} /></label>
            <label className="port-label">{t('acct.server.port')}<input type="number" value={bulk.smtpPort} onChange={(e) => setBulk({ ...bulk, smtpPort: e.target.value })} /></label>
            <label className="tls-label">
              {t('acct.server.security')}
              <select value={bulk.smtpTls} onChange={(e) => setBulk({ ...bulk, smtpTls: e.target.value as BulkServer['smtpTls'] })}>
                <option value="">{t('acct.server.unchanged')}</option>
                <option value="tls">SSL/TLS</option>
                <option value="starttls">STARTTLS</option>
              </select>
            </label>
          </div>
          <div className="modal-foot">
            <span />
            <button type="button" onClick={() => setBulkOpen(false)}>{t('action.cancel')}</button>
            <button type="button" className="primary" onClick={() => void applyBulkServer()} disabled={busy}>
              {t('acct.manager.applyTo', { count: chosen.length })}
            </button>
          </div>
        </div>
      )}

      <div className="am-list">
        {rows.length > 0 && (
          <label className="am-row am-head">
            <input
              type="checkbox"
              checked={allChosen}
              onChange={() => setSelected(allChosen ? new Set() : new Set(rows.map((r) => r.id)))}
              aria-label={t('acct.manager.selectAllAria')}
            />
            <span className="am-head-label">{t('acct.manager.selectAll', { count: rows.length })}</span>
          </label>
        )}
        {rows.map((a) => {
          const act = needsAction(a)
          return (
            <div key={a.id} className={`am-row ${a.enabled ? '' : 'dim'} ${selected.has(a.id) ? 'sel' : ''}`}>
              <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} aria-label={t('acct.manager.selectAccount', { email: a.email })} />
              <span className="acct-color" style={{ background: a.color }} />
              <div className="am-main">
                <div className="am-email">{a.displayName && a.displayName.toLocaleLowerCase('tr-TR') !== a.email.split('@')[0].toLocaleLowerCase('tr-TR') ? `${a.displayName} · ${a.email}` : a.email}</div>
                <div className={`am-status ${act ? 'bad' : ''}`}>
                  <StatusDot a={a} /> {statusLabel(a.status)}
                  {a.statusDetail && a.status !== 'ok' ? ` — ${a.statusDetail}` : ''}
                </div>
              </div>
              <span className="am-group">{a.groupName ?? '—'}</span>
              <span className="am-sync" title={t('acct.common.lastSuccessfulSync')}>{fmtRelative(a.lastSuccessAt)}</span>
              <button type="button" className={act ? 'primary' : ''} onClick={() => setEditAccount(a.id)}>
                {primaryActionLabel(a)}
              </button>
            </div>
          )
        })}
        {!rows.length && <div className="empty-note">{filter === 'action' ? t('acct.manager.noActionNeeded') : t('acct.common.noMatch')}</div>}
      </div>
    </div>
  )
}
