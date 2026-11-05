// Ayarlar › Genel: yerelden sunucuya taşıma. Renderer yalnız adres verir, ilerleme ve etiket görür: parola, oturum ve şifreli yük buraya
// gelmez. Onay main'in iletişim kutusundadır, mod kendiliğinden değişmez. Taşınamayanlar burada açıkça yazılır.
import { useEffect, useState } from 'react'
import { t } from '../../../shared/i18n'
import { AUTOMATION_HOLD_PREF, type ImportNotice, type MigrationEvent, type MigrationFailure, type PlanItem } from '../../../shared/importTypes'
import type { MigrationApi, ServerModeApi } from '../platform'
import { rpc } from '../rpcClient'
import { REASON } from './ServerConnect'

const BLOCK_TEXT: Record<NonNullable<PlanItem['blocked']>, string> = {
  vaultLocked: 'set.migrate.reason.vaultLocked',
  vaultRequired: 'set.migrate.reason.vaultRequired',
  vaultConflict: 'set.migrate.reason.vaultConflict',
  oauthReconnect: 'set.migrate.reason.oauthReconnect',
  noPassword: 'set.migrate.reason.noPassword',
  unmappedAccount: 'set.migrate.reason.unmappedAccount',
  invalid: 'set.migrate.reason.invalid',
  duplicateName: 'set.migrate.reason.duplicateName',
  groupConflict: 'set.migrate.reason.groupConflict',
  webhookConflict: 'set.migrate.reason.webhookConflict'
}
const NOTICE_TEXT: Record<ImportNotice, string> = {
  scopeDisabled: 'set.migrate.notice.scopeDisabled',
  groupDropped: 'set.migrate.notice.groupDropped',
  sieveLeft: 'set.migrate.notice.sieveLeft'
}
const FAILURE_TEXT: Record<MigrationFailure, string> = {
  connection: 'set.migrate.connection',
  notAdmin: 'set.migrate.notAdmin',
  localSession: 'set.migrate.localSession'
}
const LIMITS = ['vault', 'vaultServer', 'oauth', 'keys', 'device', 'users', 'queue', 'cache', 'secondDesktop', 'rotated', 'sieve', 'pim', 'smime']

export default function MigrationPanel({ api, serverMode }: { api: MigrationApi; serverMode: ServerModeApi | null }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [event, setEvent] = useState<MigrationEvent | null>(null)
  const [importedTo, setImportedTo] = useState<string | null>(null)
  const [hold, setHold] = useState<string | null>(null)

  useEffect(() => {
    void api.state().then((s) => setImportedTo(s.importedTo?.origin ?? null))
    return api.onEvent((e) => setEvent(e))
  }, [api])
  useEffect(() => {
    void rpc.call('getPrefs', {}).then((p) => setHold(p[AUTOMATION_HOLD_PREF] ?? null)).catch(() => {})
  }, [event?.phase])

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setEvent(null)
    const r = await api.start(address).catch(() => ({ ok: false, reason: 'unreachable' as const }))
    if (!r.ok) setError(t(REASON[r.reason]))
    setBusy(false)
  }
  const setHeld = async (held: boolean): Promise<void> => {
    await rpc.call('setPrefs', { values: { [AUTOMATION_HOLD_PREF]: held ? '1' : '0' } })
    setHold(held ? '1' : '0')
  }

  const address = url.trim() || event?.origin || ''
  const running = busy || event?.phase === 'sending' || event?.phase === 'plan'
  const target = event?.origin ?? importedTo
  return (
    <div className="set-group" data-testid="migration-panel">
      <div className="set-field">
        <div className="sf-l">
          <div className="sf-t">{t('set.migrate.title')}</div>
          <div className="sf-h">{t('set.migrate.hint')}</div>
          {importedTo && event?.phase !== 'done' && <div className="sf-h">{t('set.migrate.importedTo', { origin: importedTo })}</div>}
          {event?.staying && (event.staying.scheduled > 0 || event.staying.pending > 0) && (
            <div className="sf-h">{t('set.migrate.staying', { scheduled: event.staying.scheduled, pending: event.staying.pending })}</div>
          )}
          {running && event && <div className="sf-h" role="status">{t('set.migrate.progress', { done: event.done, total: event.total })}</div>}
          {event?.phase === 'done' && <div className="sf-h" role="status">{t('set.migrate.doneBody', { done: event.done, total: event.total })}</div>}
          {event?.phase === 'paused' && event.reason && <div className="auth-error" role="alert">{t(FAILURE_TEXT[event.reason])}</div>}
          {error && <div className="auth-error" role="alert">{error}</div>}
          {hold === '1' && !running && (event?.phase === 'paused' || !!event?.blocked.length) && <div className="sf-h">{t('set.migrate.automationPaused')}</div>}
        </div>
        <div className="sf-c">
          <input type="url" aria-label={t('set.conn.address')} placeholder={event?.origin ?? 'https://posta.example.com'} value={url} onChange={(e) => setUrl(e.target.value)} disabled={running} />
          <button type="button" disabled={running || !address} onClick={() => void start()}>
            {t(event?.origin ? 'set.migrate.resume' : 'set.migrate.start')}
          </button>
          {event?.phase === 'done' && serverMode && target && (
            <button type="button" onClick={() => void serverMode.connect(target)}>{t('set.migrate.switch')}</button>
          )}
        </div>
      </div>
      {!!event?.blocked.length && (
        <div className="set-field">
          <div className="sf-l">
            <div className="sf-t">{t('set.migrate.blockedTitle')}</div>
            <ul>{event.blocked.map((b) => <li key={b.key} className="sf-h">{b.label}: {t(BLOCK_TEXT[b.blocked ?? 'invalid'])}</li>)}</ul>
          </div>
        </div>
      )}
      {!!event?.notices?.length && (
        <div className="set-field">
          <div className="sf-l">
            <div className="sf-t">{t('set.migrate.noticesTitle')}</div>
            <ul>{event.notices.map((n) => <li key={n.key} className="sf-h">{n.label}: {t(NOTICE_TEXT[n.notice])}</li>)}</ul>
          </div>
        </div>
      )}
      {!!event?.failed.length && (
        <div className="set-field">
          <div className="sf-l">
            <div className="sf-t">{t('set.migrate.failedTitle')}</div>
            <ul>{event.failed.map((f) => <li key={f.key} className="sf-h">{f.label}</li>)}</ul>
          </div>
        </div>
      )}
      <div className="set-field">
        <div className="sf-l">
          <details>
            <summary className="sf-t">{t('set.migrate.limitsTitle')}</summary>
            <ul>{LIMITS.map((k) => <li key={k} className="sf-h">{t(`set.migrate.limit.${k}`)}</li>)}</ul>
          </details>
        </div>
      </div>
      {hold !== null && (
        <div className="set-field">
          <div className="sf-l">
            <div className="sf-t">{t('set.migrate.automationTitle')}</div>
            <div className="sf-h">{t('set.migrate.automationHint')}</div>
          </div>
          <div className="sf-c">
            <input type="checkbox" role="switch" aria-label={t('set.migrate.automationTitle')} checked={hold === '1'} onChange={(e) => void setHeld(e.target.checked)} />
          </div>
        </div>
      )}
    </div>
  )
}
